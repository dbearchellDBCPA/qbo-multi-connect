import { createHash } from 'node:crypto';
import { TokenStore } from '../auth/token-store.js';
import { refreshConnectionTokens } from '../auth/refresh.js';
import { decodeStrayEntitiesDeep } from '../server/entity-fields.js';
import type { OAuthConfig } from '../db/models.js';

// Hard ceiling on how long a single QBO HTTP request may run before we abort it.
// Without this, a hung Intuit request blocks the tool call indefinitely.
const REQUEST_TIMEOUT_MS = 60_000;

/**
 * Custom error class for QBO API errors
 */
export class QBOError extends Error {
  constructor(
    message: string,
    public statusCode?: number,
    public response?: unknown
  ) {
    super(message);
    this.name = 'QBOError';
  }
}

/**
 * Core QBO API client
 */
export class QBOClient {
  private baseUrl: string;

  constructor(
    private tokenStore: TokenStore,
    private oauthConfig: OAuthConfig,
    environment: 'sandbox' | 'production' = 'sandbox'
  ) {
    this.baseUrl =
      environment === 'sandbox'
        ? 'https://sandbox-quickbooks.api.intuit.com/v3'
        : 'https://quickbooks.api.intuit.com/v3';
  }

  /**
   * Make authenticated API request
   */
  async request<T>(
    method: string,
    realmId: string,
    endpoint: string,
    options: {
      query?: Record<string, string>;
      body?: unknown;
      headers?: Record<string, string>;
    } = {}
  ): Promise<T> {
    const connection = await this.tokenStore.getConnection(realmId);
    if (!connection) {
      throw new QBOError(`Connection not found: ${realmId}`);
    }

    if (connection.status !== 'active') {
      throw new QBOError(`Connection is not active: ${connection.status}`);
    }

    // Check if token needs refresh (< 5 min remaining)
    const now = Date.now();
    const timeUntilExpiry = connection.tokenExpiry.getTime() - now;
    if (timeUntilExpiry < 5 * 60 * 1000) {
      await refreshConnectionTokens(realmId, this.tokenStore, this.oauthConfig);
      // Re-fetch connection with new token
      const refreshedConnection = await this.tokenStore.getConnection(realmId);
      if (!refreshedConnection) {
        throw new QBOError('Connection lost after refresh');
      }
    }

    // Re-fetch to get potentially refreshed token
    const activeConnection = await this.tokenStore.getConnection(realmId);
    if (!activeConnection) {
      throw new QBOError('Connection not found after potential refresh');
    }

    // Multipart bodies (FormData, used by the /upload attachments endpoint)
    // pass through untouched: no entity decoding, no JSON serialization, and
    // fetch must set the multipart boundary Content-Type itself.
    const isMultipart = typeof FormData !== 'undefined' && options.body instanceof FormData;

    // Normalize write payloads: some MCP clients HTML-escape string args on
    // the first write of a session ("A & B" arrives as "A &amp; B"). This
    // server never escapes, so any standard entity in an outbound body is an
    // upstream artifact — decode it before the payload (and the idempotency
    // hash derived from it) is built.
    const body = !isMultipart && method !== 'GET' && options.body !== undefined
      ? decodeStrayEntitiesDeep(options.body)
      : options.body;

    // Build URL
    const url = new URL(`${this.baseUrl}/company/${realmId}/${endpoint}`);
    if (options.query) {
      Object.entries(options.query).forEach(([key, value]) => {
        url.searchParams.append(key, value);
      });
    }

    // Idempotency for mutating requests. QBO dedupes operations that carry a
    // matching `requestid` within its dedupe window, so if the same create/update
    // is delivered twice (e.g. an MCP transport-level retry, or a client resend
    // after a dropped connection) QBO returns the original result instead of
    // writing a duplicate. The key is a hash of the realm + endpoint + body, so
    // identical payloads collapse to one write.
    // NOTE: two *intentionally* identical entries posted within the dedupe window
    // would also collapse; vary a field (e.g. PrivateNote) if you truly need both.
    // (Multipart uploads are skipped: FormData can't be hashed deterministically.
    // A duplicated upload is recoverable via delete_attachment.)
    if (method !== 'GET' && !isMultipart && !url.searchParams.has('requestid')) {
      const key = createHash('sha256')
        .update(`${realmId}|${endpoint}|${JSON.stringify(body ?? null)}`)
        .digest('hex')
        .slice(0, 40);
      url.searchParams.set('requestid', key);
    }

    // Build headers. For multipart, fetch must generate the boundary header.
    const headers: Record<string, string> = {
      'Authorization': `Bearer ${activeConnection.accessToken}`,
      'Accept': 'application/json',
      ...(isMultipart ? {} : { 'Content-Type': 'application/json' }),
      ...options.headers,
    };

    // Debug tap for write payloads (QBO_DEBUG_HTTP=1): the exact JSON body
    // sent to Intuit, so a mis-built update (e.g. fetched lines leaking into
    // a replacement Line array) is a 30-second diagnosis instead of a
    // ledger forensics session. Off by default — bodies are client
    // financial data and don't belong in logs unasked.
    if (process.env.QBO_DEBUG_HTTP === '1' && method !== 'GET' && !isMultipart) {
      console.error(`[qbo-http] ${method} ${endpoint} realm=${realmId} body=${JSON.stringify(body ?? null)}`);
    }

    // Make request with retry logic for rate limits
    return await this.requestWithRetry(method, url.toString(), headers, body);
  }

  /**
   * Request with retry logic for rate limits
   */
  private async requestWithRetry<T>(
    method: string,
    url: string,
    headers: Record<string, string>,
    body?: unknown,
    retryCount: number = 0
  ): Promise<T> {
    const maxRetries = 3;

    // Abort the request if it hangs past the timeout so a stuck Intuit call
    // can't block the tool indefinitely.
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let response: Response;
    const isMultipart = typeof FormData !== 'undefined' && body instanceof FormData;
    try {
      response = await fetch(url, {
        method,
        headers,
        body: body ? (isMultipart ? (body as FormData) : JSON.stringify(body)) : undefined,
        signal: controller.signal,
      });
    } catch (err: any) {
      if (err?.name === 'AbortError') {
        throw new QBOError(`QBO API request timed out after ${REQUEST_TIMEOUT_MS}ms`, 408);
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }

    // Handle rate limiting (429). Only auto-retry idempotent reads: retrying a
    // POST is unsafe because QBO may have already committed the write before
    // returning 429, which would create a duplicate. Mutating requests carry a
    // `requestid` (see request()) and are surfaced to the caller instead.
    if (response.status === 429 && method === 'GET' && retryCount < maxRetries) {
      const retryAfter = response.headers.get('Retry-After');
      const delayMs = retryAfter ? parseInt(retryAfter, 10) * 1000 : Math.pow(2, retryCount) * 1000;

      console.warn(`Rate limited, retrying after ${delayMs}ms (attempt ${retryCount + 1}/${maxRetries})`);
      await new Promise(resolve => setTimeout(resolve, delayMs));

      return this.requestWithRetry(method, url, headers, body, retryCount + 1);
    }

    // Handle errors
    if (!response.ok) {
      const errorBody = await response.text();
      let errorMessage: string;
      try {
        const errorJson = JSON.parse(errorBody);
        errorMessage = errorJson.Fault?.Error?.[0]?.Message || errorJson.error || errorBody;
      } catch {
        errorMessage = errorBody;
      }

      throw new QBOError(
        `QBO API error: ${errorMessage}`,
        response.status,
        errorBody
      );
    }

    // Parse response
    const data = await response.json();
    return data as T;
  }

  /**
   * GET request
   */
  async get<T>(realmId: string, endpoint: string, query?: Record<string, string>): Promise<T> {
    return this.request<T>('GET', realmId, endpoint, { query });
  }

  /**
   * POST request
   */
  async post<T>(realmId: string, endpoint: string, body: unknown): Promise<T> {
    return this.request<T>('POST', realmId, endpoint, { body });
  }

  /**
   * Query using QBO SQL-like syntax.
   *
   * The query is percent-encoded explicitly (spaces as %20) rather than via
   * URLSearchParams, whose form-encoding serializes spaces as '+' — Intuit's
   * documented examples use %20, and explicit encoding removes any ambiguity
   * in how the query endpoint decodes '+'.
   */
  async query<T>(realmId: string, queryString: string): Promise<T> {
    return this.request<T>('GET', realmId, `query?query=${encodeURIComponent(queryString)}`);
  }
}
