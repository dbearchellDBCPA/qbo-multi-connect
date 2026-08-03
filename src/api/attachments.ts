import { resolve, relative, isAbsolute, extname } from 'node:path';
import { QBOClient } from './client.js';
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
    const responses: any[] = res?.AttachableResponse ?? [];
    return items.map((item, i) => {
      const r = responses[i];
      if (r?.Attachable) return { fileName: item.fileName, ok: true, attachable: r.Attachable };
      const fault = r?.Fault?.Error?.[0];
      return {
        fileName: item.fileName,
        ok: false,
        error: fault
          ? `${fault.Message ?? 'QBO error'}${fault.Detail ? ` — ${fault.Detail}` : ''}`
          : 'Upload failed: no Attachable returned for this file',
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
