import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/** PDF download links live for one hour, same window as upload tokens. */
export const PDF_TTL_MS = 60 * 60 * 1000;
export const PDF_TOKEN_PREFIX = 'pdf_';

export interface StoredPdfMeta {
  token: string;
  fileName: string;
  contentType: string;
  bytes: number;
  realmId: string;
  entityType: string;
  entityId: string;
  createdAt: string;
  expiresAt: string;
}

const TOKEN_RE = new RegExp(`^${PDF_TOKEN_PREFIX}[a-f0-9]{48}$`);

export function isPdfToken(token: string): boolean {
  return TOKEN_RE.test(token);
}

export function pdfDownloadPath(token: string): string {
  return `/downloads/pdf/${encodeURIComponent(token)}`;
}

/**
 * Saves transaction PDFs to a directory and serves them by an unguessable
 * token in the path. The download URL does not carry the Multi-Connect API
 * key (or any Intuit credential) — the token is the capability.
 */
export class PdfDownloadStore {
  constructor(private dir: string) {
    mkdirSync(dir, { recursive: true });
  }

  save(args: {
    buffer: Buffer;
    fileName: string;
    contentType: string;
    realmId: string;
    entityType: string;
    entityId: string;
    now?: Date;
    ttlMs?: number;
  }): StoredPdfMeta {
    this.purgeExpired(args.now);
    const token = `${PDF_TOKEN_PREFIX}${randomBytes(24).toString('hex')}`;
    const now = args.now ?? new Date();
    const expires = new Date(now.getTime() + (args.ttlMs ?? PDF_TTL_MS));
    const meta: StoredPdfMeta = {
      token,
      fileName: args.fileName,
      contentType: args.contentType || 'application/pdf',
      bytes: args.buffer.length,
      realmId: args.realmId,
      entityType: args.entityType,
      entityId: args.entityId,
      createdAt: now.toISOString(),
      expiresAt: expires.toISOString(),
    };
    writeFileSync(this.binPath(token), args.buffer);
    writeFileSync(this.metaPath(token), `${JSON.stringify(meta)}\n`);
    return meta;
  }

  read(token: string, now = new Date()): { meta: StoredPdfMeta; buffer: Buffer } | null {
    if (!isPdfToken(token)) return null;
    const metaFile = this.metaPath(token);
    const binFile = this.binPath(token);
    if (!existsSync(metaFile) || !existsSync(binFile)) return null;
    let meta: StoredPdfMeta;
    try {
      meta = JSON.parse(readFileSync(metaFile, 'utf8')) as StoredPdfMeta;
    } catch {
      return null;
    }
    if (new Date(meta.expiresAt).getTime() <= now.getTime()) {
      this.remove(token);
      return null;
    }
    return { meta, buffer: readFileSync(binFile) };
  }

  purgeExpired(now = new Date()): void {
    if (!existsSync(this.dir)) return;
    for (const name of readdirSync(this.dir)) {
      if (!name.endsWith('.json')) continue;
      const token = name.slice(0, -'.json'.length);
      if (!isPdfToken(token)) continue;
      try {
        const meta = JSON.parse(readFileSync(join(this.dir, name), 'utf8')) as StoredPdfMeta;
        if (new Date(meta.expiresAt).getTime() <= now.getTime()) this.remove(token);
      } catch {
        // leave unreadable meta for inspection; do not delete the PDF blindly
      }
    }
  }

  private binPath(token: string): string {
    return join(this.dir, `${token}.pdf`);
  }

  private metaPath(token: string): string {
    return join(this.dir, `${token}.json`);
  }

  private remove(token: string): void {
    for (const p of [this.binPath(token), this.metaPath(token)]) {
      try { if (existsSync(p)) unlinkSync(p); } catch { /* ignore */ }
    }
  }
}

