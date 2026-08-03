import { randomBytes, createHash } from 'node:crypto';
import type { ConnectionDatabase } from './db/index.js';

/** Upload tokens live for one hour — long enough for a large batch job. */
export const UPLOAD_TOKEN_TTL_MS = 60 * 60 * 1000;

export const UPLOAD_TOKEN_PREFIX = 'uplt_';

function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/**
 * Short-lived, realm-bound credentials for the REST attachments endpoint.
 *
 * Why they exist: an agent driving this server through a claude.ai connector
 * cannot see its own API key (the connector config is hidden from it and the
 * server stores only hashes), so it has no way to authenticate a curl upload.
 * create_upload_session lets an already-authenticated MCP caller mint a
 * token that works ONLY for uploading attachments to ONE realm, and only
 * briefly — so handing it to a shell command risks far less than a real key.
 */
export class UploadTokenService {
  constructor(private db: ConnectionDatabase) {}

  /** Issue a token for one realm. Returns the plaintext token (never stored). */
  async issue(realmId: string, issuedBy: string): Promise<{ token: string; expiresAt: Date }> {
    await this.db.purgeExpiredUploadTokens();
    const token = `${UPLOAD_TOKEN_PREFIX}${randomBytes(24).toString('hex')}`;
    const expiresAt = new Date(Date.now() + UPLOAD_TOKEN_TTL_MS);
    await this.db.insertUploadToken(hashToken(token), realmId, issuedBy, expiresAt.toISOString().replace('T', ' ').slice(0, 19));
    return { token, expiresAt };
  }

  /** Validate a token for a specific realm. Realm-first for scope guarding. */
  async validate(realmId: string, token: string): Promise<boolean> {
    if (!token.startsWith(UPLOAD_TOKEN_PREFIX)) return false;
    const row = await this.db.getUploadToken(hashToken(token));
    return row !== null && row.realm_id === realmId;
  }
}

export function looksLikeUploadToken(candidate: string | undefined): boolean {
  return typeof candidate === 'string' && candidate.startsWith(UPLOAD_TOKEN_PREFIX);
}
