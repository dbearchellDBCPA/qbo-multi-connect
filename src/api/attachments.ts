import { resolve, relative, isAbsolute, extname, basename } from 'node:path';
import { QBOClient, formatQboFault } from './client.js';
import { escapeQboString } from '../server/entity-fields.js';

/** QBO rejects individual attachment files larger than this. */
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

/** QBO's /upload endpoint accepts multiple parts; keep batches modest. */
export const MAX_FILES_PER_UPLOAD = 10;

const CONTENT_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.csv': 'text/csv',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

/** Infer the MIME type QBO expects from a file name, or null if unknown. */
export function contentTypeForFile(fileName: string): string | null {
  return CONTENT_TYPES[extname(fileName).toLowerCase()] ?? null;
}

export function supportedExtensions(): string {
  return Object.keys(CONTENT_TYPES).join(', ');
}

/** Extension (with dot) for a MIME type this module knows, or null. */
export function extensionForContentType(contentType: string): string | null {
  const wanted = contentType.toLowerCase().split(';')[0].trim();
  for (const [ext, type] of Object.entries(CONTENT_TYPES)) {
    if (type === wanted) return ext;
  }
  return null;
}

/**
 * Identify a file by its leading bytes — the fallback when neither the
 * file_name argument, the Content-Disposition header nor the URL path carries
 * an extension (a Dropbox temporary link ends in "/file"). Also how an HTML
 * error page masquerading as a download is caught before it is uploaded to
 * QBO as a "PDF".
 */
export function sniffContentType(bytes: Uint8Array): { contentType: string; extension: string } | null {
  const b = bytes;
  const startsWith = (sig: number[]) => sig.every((v, i) => b[i] === v);
  if (startsWith([0x25, 0x50, 0x44, 0x46])) return { contentType: 'application/pdf', extension: '.pdf' }; // %PDF
  if (startsWith([0x89, 0x50, 0x4e, 0x47])) return { contentType: 'image/png', extension: '.png' };
  if (startsWith([0xff, 0xd8, 0xff])) return { contentType: 'image/jpeg', extension: '.jpg' };
  if (startsWith([0x47, 0x49, 0x46, 0x38])) return { contentType: 'image/gif', extension: '.gif' };
  if (startsWith([0x49, 0x49, 0x2a, 0x00]) || startsWith([0x4d, 0x4d, 0x00, 0x2a])) return { contentType: 'image/tiff', extension: '.tif' };
  const head = Buffer.from(b.subarray(0, 512)).toString('latin1').replace(/^\uFEFF/, '').trimStart().toLowerCase();
  if (head.startsWith('<!doctype html') || head.startsWith('<html') || head.startsWith('<head') || head.startsWith('<body')) {
    return { contentType: 'text/html', extension: '.html' };
  }
  return null;
}

/** Pull the file name out of a Content-Disposition header (RFC 6266 / 5987 forms), basename only. */
export function parseContentDispositionFileName(header: string | null | undefined): string | null {
  if (!header) return null;
  let name: string | null = null;
  const star = header.match(/filename\*\s*=\s*([^;]+)/i);
  if (star) {
    const raw = star[1].trim().replace(/^"|"$/g, '');
    const m = raw.match(/^([\w-]+)'[^']*'(.*)$/);
    const encoded = m ? m[2] : raw;
    try {
      name = decodeURIComponent(encoded);
    } catch {
      name = encoded;
    }
  }
  if (!name) {
    const plain = header.match(/filename\s*=\s*("([^"]*)"|([^;]+))/i);
    if (plain) name = (plain[2] ?? plain[3] ?? '').trim();
  }
  if (!name) return null;
  const base = name.split(/[\\/]/).pop()?.trim() ?? '';
  return base !== '' ? base : null;
}

export const REMOTE_FETCH_USER_AGENT = 'Mozilla/5.0 (compatible; qbo-multi-connect/1.0; +https://github.com/dbearchellDBCPA/qbo-multi-connect)';
const REMOTE_FETCH_MAX_REDIRECTS = 5;
const REMOTE_FETCH_TIMEOUT_MS = 60_000;

export interface RemoteFileFetch {
  bytes: Uint8Array;
  /** HTTP status of the final (non-redirect) response. */
  status: number;
  /** Content-Type header of the final response, if any. */
  contentType: string | null;
  /** File name from the final response's Content-Disposition, if any. */
  dispositionFileName: string | null;
  /** The URL that actually served the bytes (after redirects). */
  finalUrl: URL;
  redirects: number;
}

/** One line for logs and tool output: "HTTP 200, 943,113 bytes, content-type application/pdf, 1 redirect". */
export function describeRemoteFetch(f: RemoteFileFetch): string {
  const parts = [
    `HTTP ${f.status}`,
    `${f.bytes.length.toLocaleString('en-US')} bytes`,
    `content-type ${f.contentType ?? 'none'}`,
  ];
  if (f.redirects > 0) parts.push(`${f.redirects} redirect${f.redirects === 1 ? '' : 's'}`);
  if (f.dispositionFileName) parts.push(`Content-Disposition name "${f.dispositionFileName}"`);
  return parts.join(', ');
}

/**
 * Download a file for attaching. Redirects are followed by hand (up to 5) so
 * every hop passes the SSRF guard — a public URL must not be able to bounce
 * the server into its own network — and the request carries a browser-ish
 * User-Agent, which some file hosts (Dropbox temporary links among them)
 * require before they will serve bytes instead of an HTML page.
 */
export async function fetchRemoteFile(
  rawUrl: string,
  opts: { maxRedirects?: number; timeoutMs?: number } = {}
): Promise<RemoteFileFetch> {
  const maxRedirects = opts.maxRedirects ?? REMOTE_FETCH_MAX_REDIRECTS;
  const timeoutMs = opts.timeoutMs ?? REMOTE_FETCH_TIMEOUT_MS;
  let url = assertSafeUrl(rawUrl);
  for (let hop = 0; ; hop++) {
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'manual',
      headers: { 'User-Agent': REMOTE_FETCH_USER_AGENT, Accept: '*/*' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      await res.arrayBuffer().catch(() => undefined); // drain
      if (!location) throw new Error(`Failed to fetch file_url: HTTP ${res.status} redirect without a Location header`);
      if (hop >= maxRedirects) throw new Error(`Failed to fetch file_url: more than ${maxRedirects} redirects`);
      url = assertSafeUrl(new URL(location, url).toString());
      continue;
    }
    if (!res.ok) {
      const snippet = (await res.text().catch(() => '')).replace(/\s+/g, ' ').trim().slice(0, 200);
      throw new Error(
        `Failed to fetch file_url (HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''} from ${url.host}` +
          `${hop > 0 ? ` after ${hop} redirect${hop === 1 ? '' : 's'}` : ''})${snippet ? `: ${snippet}` : ''}`
      );
    }
    const declared = Number(res.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > MAX_ATTACHMENT_BYTES) {
      throw new Error(`file_url is ${declared.toLocaleString('en-US')} bytes — over QBO's 20 MB attachment limit`);
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    return {
      bytes,
      status: res.status,
      contentType: res.headers.get('content-type'),
      dispositionFileName: parseContentDispositionFileName(res.headers.get('content-disposition')),
      finalUrl: url,
      redirects: hop,
    };
  }
}

/**
 * Pick the attachment's file name, in this order: the file_name argument,
 * the Content-Disposition name, the URL path's basename when it carries a
 * known extension, and finally a name synthesized from the bytes' magic
 * number ("attachment.pdf"). A Dropbox temporary link's path ends in
 * "/file", which has no extension — using it blindly would type the upload
 * wrong or reject it.
 */
export function resolveAttachmentFileName(src: {
  explicit?: string;
  dispositionFileName?: string | null;
  url?: URL | null;
  bytes?: Uint8Array;
}): string {
  if (src.explicit && src.explicit.trim() !== '') return src.explicit.trim();
  if (src.dispositionFileName) return src.dispositionFileName;
  const fromPath = src.url ? basename(src.url.pathname) : '';
  if (fromPath && contentTypeForFile(fromPath)) return fromPath;
  const sniffed = src.bytes ? sniffContentType(src.bytes) : null;
  if (sniffed && sniffed.contentType !== 'text/html') return `attachment${sniffed.extension}`;
  return fromPath || 'attachment';
}

/**
 * Resolve a caller-supplied path against the attachments staging directory,
 * rejecting anything that escapes it. The MCP file_path source reads from the
 * server's own disk; without this check a write-capable API key could
 * exfiltrate server files (e.g. the secrets store) by attaching them to a
 * QBO transaction and downloading them from QBO.
 */
export function resolveAttachmentPath(requested: string, allowedDir: string): string {
  const base = resolve(allowedDir);
  const resolved = resolve(base, requested);
  const rel = relative(base, resolved);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(
      `file_path must be inside the attachments staging directory (${base}). ` +
        'For files that are not on the server, use file_url or the REST upload endpoint.'
    );
  }
  return resolved;
}

/**
 * Validate a caller-supplied URL for server-side fetching. HTTPS only, and
 * obviously-internal hosts are rejected (SSRF guard — the server must not be
 * usable as a proxy into its own network or cloud metadata services).
 */
export function assertSafeUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`file_url is not a valid URL: ${raw}`);
  }
  if (url.protocol !== 'https:') {
    throw new Error('file_url must use https://');
  }
  const host = url.hostname.toLowerCase();
  const isPrivate =
    host === 'localhost' ||
    host === '0.0.0.0' ||
    host === '::1' ||
    host === '[::1]' ||
    host === 'metadata.google.internal' ||
    host.endsWith('.internal') ||
    host.endsWith('.local') ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host);
  if (isPrivate) {
    throw new Error(`file_url host "${host}" is not allowed`);
  }
  return url;
}

export interface AttachmentUploadItem {
  fileName: string;
  contentType: string;
  bytes: Uint8Array;
  note?: string;
  includeOnSend?: boolean;
  /** Links the attachment to a QBO entity (e.g. {type:'Purchase', id:'756'}). */
  entityRef?: { type: string; id: string };
}

export interface AttachmentUploadResult {
  fileName: string;
  ok: boolean;
  attachable?: any;
  error?: string;
}

/**
 * QBO Attachable operations. Uploads use POST /upload, a multipart/form-data
 * endpoint pairing a JSON metadata part (file_metadata_NN) with a binary part
 * (file_content_NN) per file.
 */
export class AttachmentsAPI {
  constructor(private client: QBOClient) {}

  async upload(realmId: string, items: AttachmentUploadItem[]): Promise<AttachmentUploadResult[]> {
    if (items.length === 0) return [];
    if (items.length > MAX_FILES_PER_UPLOAD) {
      throw new Error(`At most ${MAX_FILES_PER_UPLOAD} files per upload request`);
    }

    const form = new FormData();
    items.forEach((item, i) => {
      const n = String(i + 1).padStart(2, '0');
      const metadata: any = {
        FileName: item.fileName,
        ContentType: item.contentType,
      };
      if (item.note) metadata.Note = item.note;
      if (item.includeOnSend !== undefined) metadata.IncludeOnSend = item.includeOnSend;
      if (item.entityRef) {
        metadata.AttachableRef = [
          { EntityRef: { value: item.entityRef.id, type: item.entityRef.type } },
        ];
      }
      form.append(
        `file_metadata_${n}`,
        new Blob([JSON.stringify(metadata)], { type: 'application/json' }),
        `metadata_${n}.json`
      );
      // Copy into a fresh Uint8Array so the Blob sees a plain ArrayBuffer
      // (Buffer views can carry byteOffset baggage TS's Blob types reject).
      const view = new Uint8Array(item.bytes);
      form.append(
        `file_content_${n}`,
        new Blob([view.buffer as ArrayBuffer], { type: item.contentType }),
        item.fileName
      );
    });

    const res: any = await this.client.post(realmId, 'upload', form);
    // A 2xx whose body is a top-level Fault (seen when the multipart itself
    // is rejected) applies to every file in the request.
    const topFault = formatQboFault(res);
    if (topFault) {
      console.error(`[qbo-attachments] upload rejected by QBO (realm ${realmId}): ${topFault}`);
      return items.map((item) => ({ fileName: item.fileName, ok: false, error: `QBO rejected the upload: ${topFault}` }));
    }
    const responses: any[] = Array.isArray(res?.AttachableResponse) ? res.AttachableResponse : [];
    return items.map((item, i) => {
      const r = responses[i];
      if (r?.Attachable) return { fileName: item.fileName, ok: true, attachable: r.Attachable };
      const fault = formatQboFault(r);
      // "no Attachable returned" on its own hides the diagnosis; include what QBO actually sent.
      const body = JSON.stringify(r ?? res ?? null);
      const snippet = body.length > 600 ? `${body.slice(0, 600)}…` : body;
      console.error(`[qbo-attachments] no Attachable for "${item.fileName}" (realm ${realmId}, ${item.bytes.length} bytes, ${item.contentType}): ${snippet}`);
      return {
        fileName: item.fileName,
        ok: false,
        error: fault
          ? `QBO error: ${fault}`
          : `Upload failed: QBO returned HTTP 2xx but no Attachable for this file (${item.bytes.length.toLocaleString('en-US')} bytes as ${item.contentType}). QBO response: ${snippet}`,
      };
    });
  }

  /** Fetch an Attachable by Id (for verification or to get its SyncToken). */
  async get(realmId: string, attachableId: string): Promise<any | null> {
    const res: any = await this.client.query(
      realmId,
      `SELECT * FROM Attachable WHERE Id = '${escapeQboString(attachableId)}'`
    );
    return res?.QueryResponse?.Attachable?.[0] ?? null;
  }

  /** Delete an Attachable (removes the file and its links). */
  async remove(realmId: string, attachable: { Id: string; SyncToken: string }): Promise<unknown> {
    return this.client.post(realmId, 'attachable?operation=delete', {
      Id: attachable.Id,
      SyncToken: attachable.SyncToken,
    });
  }
}
