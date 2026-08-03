import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import type { ConnectionDatabase } from './db/index.js';

export const AUTH_CODE_TTL_MS = 5 * 60 * 1000; // 5 minutes (spec: short-lived)
export const ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour
export const REFRESH_TOKEN_TTL_MS = 60 * 24 * 60 * 60 * 1000; // 60 days

export const ACCESS_TOKEN_PREFIX = 'qboat_';
export const REFRESH_TOKEN_PREFIX = 'qbort_';

function hash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function randomToken(prefix: string): string {
  return `${prefix}${randomBytes(32).toString('hex')}`;
}

function sqlTime(date: Date): string {
  return date.toISOString().replace('T', ' ').slice(0, 19);
}

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/** PKCE S256: base64url(sha256(verifier)) must equal the stored challenge. */
export function verifyPkce(codeVerifier: string, codeChallenge: string): boolean {
  const computed = createHash('sha256').update(codeVerifier).digest('base64url');
  return safeEqual(computed, codeChallenge);
}

export interface RegisteredClient {
  clientId: string;
  clientSecret?: string;
  clientName: string | null;
  redirectUris: string[];
  grantTypes: string[];
  scope: string | null;
}

export interface IssuedTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  scope: string | null;
}

/**
 * OAuth 2.1 authorization server for the MCP endpoint.
 *
 * Why this exists: a Claude Team workspace can install a given MCP connector
 * only once, so a static ?key= URL forces every member to share one identity.
 * With OAuth, the workspace installs ONE connector and each member signs in
 * with their own dashboard credentials — the access token carries their user
 * id, so the existing per-client scoping applies per person.
 *
 * Implements the MCP authorization profile: RFC 7591 dynamic client
 * registration, RFC 8414 metadata, authorization code + PKCE (S256 only),
 * refresh tokens, and RFC 7009 revocation. Tokens are stored hashed.
 */
export class OAuthServerService {
  constructor(private db: ConnectionDatabase) {}

  // ── Dynamic client registration (RFC 7591) ────────────────────────────────

  async registerClient(input: {
    clientName?: string | null;
    redirectUris: string[];
    grantTypes?: string[];
    scope?: string | null;
    /** 'none' for public clients (PKCE), otherwise a secret is issued. */
    tokenEndpointAuthMethod?: string;
  }): Promise<RegisteredClient & { clientSecret?: string }> {
    if (!Array.isArray(input.redirectUris) || input.redirectUris.length === 0) {
      throw new Error('redirect_uris is required');
    }
    for (const uri of input.redirectUris) {
      let parsed: URL;
      try {
        parsed = new URL(uri);
      } catch {
        throw new Error(`Invalid redirect_uri: ${uri}`);
      }
      // Allow https anywhere, and http only for loopback (native clients).
      const isLoopback = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(parsed.hostname);
      if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && isLoopback)) {
        throw new Error(`redirect_uri must use https (or http on loopback): ${uri}`);
      }
    }

    const clientId = `qboc_${randomBytes(16).toString('hex')}`;
    const isPublic = (input.tokenEndpointAuthMethod ?? 'none') === 'none';
    const clientSecret = isPublic ? undefined : randomToken('qbocs_');

    await this.db.insertOAuthClient({
      clientId,
      clientSecretHash: clientSecret ? hash(clientSecret) : null,
      clientName: input.clientName ?? null,
      redirectUris: input.redirectUris,
      grantTypes: input.grantTypes?.length ? input.grantTypes : ['authorization_code', 'refresh_token'],
      scope: input.scope ?? null,
    });

    return {
      clientId,
      clientSecret,
      clientName: input.clientName ?? null,
      redirectUris: input.redirectUris,
      grantTypes: input.grantTypes?.length ? input.grantTypes : ['authorization_code', 'refresh_token'],
      scope: input.scope ?? null,
    };
  }

  async getClient(clientId: string): Promise<RegisteredClient | null> {
    const row = await this.db.getOAuthClient(clientId);
    if (!row) return null;
    return {
      clientId: row.client_id,
      clientName: row.client_name,
      redirectUris: JSON.parse(row.redirect_uris),
      grantTypes: JSON.parse(row.grant_types),
      scope: row.scope,
    };
  }

  /** Confirm a client secret (confidential clients only). */
  async checkClientSecret(clientId: string, secret: string | undefined): Promise<boolean> {
    const row = await this.db.getOAuthClient(clientId);
    if (!row) return false;
    if (!row.client_secret_hash) return true; // public client — PKCE is the proof
    return secret != null && safeEqual(hash(secret), row.client_secret_hash);
  }

  // ── Authorization codes ───────────────────────────────────────────────────

  async createAuthCode(input: {
    clientId: string;
    userId: number;
    redirectUri: string;
    codeChallenge: string;
    scope?: string | null;
    resource?: string | null;
  }): Promise<string> {
    const code = randomToken('qboac_');
    await this.db.insertOAuthCode({
      codeHash: hash(code),
      clientId: input.clientId,
      userId: input.userId,
      redirectUri: input.redirectUri,
      codeChallenge: input.codeChallenge,
      scope: input.scope ?? null,
      resource: input.resource ?? null,
      expiresAt: sqlTime(new Date(Date.now() + AUTH_CODE_TTL_MS)),
    });
    return code;
  }

  /**
   * Exchange an authorization code for tokens. Enforces single use, expiry,
   * client binding, redirect_uri match, and PKCE.
   */
  async exchangeAuthCode(input: {
    code: string;
    clientId: string;
    codeVerifier: string;
    redirectUri?: string;
  }): Promise<IssuedTokens> {
    const row = await this.db.consumeOAuthCode(hash(input.code)); // single-use
    if (!row) throw new Error('invalid_grant: authorization code not found or already used');
    if (new Date(`${row.expires_at.replace(' ', 'T')}Z`).getTime() < Date.now()) {
      throw new Error('invalid_grant: authorization code expired');
    }
    if (row.client_id !== input.clientId) throw new Error('invalid_grant: code was issued to a different client');
    if (input.redirectUri && input.redirectUri !== row.redirect_uri) {
      throw new Error('invalid_grant: redirect_uri does not match the authorization request');
    }
    if (!input.codeVerifier || !verifyPkce(input.codeVerifier, row.code_challenge)) {
      throw new Error('invalid_grant: PKCE verification failed');
    }
    return this.issueTokens(input.clientId, row.user_id, row.scope);
  }

  async refresh(input: { refreshToken: string; clientId: string }): Promise<IssuedTokens> {
    const row = await this.db.getOAuthToken(hash(input.refreshToken), 'refresh');
    if (!row) throw new Error('invalid_grant: refresh token not found or expired');
    if (row.client_id !== input.clientId) throw new Error('invalid_grant: refresh token belongs to a different client');
    // Rotate: the presented refresh token is consumed as part of the exchange.
    await this.db.deleteOAuthToken(hash(input.refreshToken));
    return this.issueTokens(input.clientId, row.user_id, row.scope);
  }

  private async issueTokens(clientId: string, userId: number, scope: string | null): Promise<IssuedTokens> {
    await this.db.purgeExpiredOAuth();
    const accessToken = randomToken(ACCESS_TOKEN_PREFIX);
    const refreshToken = randomToken(REFRESH_TOKEN_PREFIX);
    await this.db.insertOAuthToken({
      tokenHash: hash(accessToken),
      kind: 'access',
      clientId,
      userId,
      scope,
      expiresAt: sqlTime(new Date(Date.now() + ACCESS_TOKEN_TTL_MS)),
    });
    await this.db.insertOAuthToken({
      tokenHash: hash(refreshToken),
      kind: 'refresh',
      clientId,
      userId,
      scope,
      expiresAt: sqlTime(new Date(Date.now() + REFRESH_TOKEN_TTL_MS)),
    });
    return { accessToken, refreshToken, expiresIn: Math.floor(ACCESS_TOKEN_TTL_MS / 1000), scope };
  }

  /** Resolve an access token to its user id, or null when invalid/expired. */
  async verifyAccessToken(token: string): Promise<{ userId: number; clientId: string } | null> {
    if (!token.startsWith(ACCESS_TOKEN_PREFIX)) return null;
    const row = await this.db.getOAuthToken(hash(token), 'access');
    return row ? { userId: row.user_id, clientId: row.client_id } : null;
  }

  /** RFC 7009 revocation — accepts either token kind. */
  async revoke(token: string): Promise<void> {
    await this.db.deleteOAuthToken(hash(token));
  }

  /** Drop every OAuth token belonging to a user (e.g. when disabled). */
  async revokeAllForUser(userId: number): Promise<void> {
    await this.db.deleteOAuthTokensForUser(userId);
  }
}

export function looksLikeOAuthAccessToken(candidate: string | undefined): boolean {
  return typeof candidate === 'string' && candidate.startsWith(ACCESS_TOKEN_PREFIX);
}
