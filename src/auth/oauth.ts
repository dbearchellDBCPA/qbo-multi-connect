import type { OAuthConfig, IntuitTokenResponse } from '../db/models.js';

/**
 * Typed failure from Intuit's token endpoint, so callers can distinguish a
 * DEFINITIVE rejection (invalid_grant — the refresh token is dead and only
 * re-authorization can fix it) from transient trouble (network errors, 5xx,
 * rate limits) that simply deserves a retry.
 */
export class OAuthTokenError extends Error {
  constructor(
    message: string,
    public statusCode: number,
    public body: string
  ) {
    super(message);
    this.name = 'OAuthTokenError';
  }

  /** True when Intuit rejected the refresh token itself. */
  get isInvalidGrant(): boolean {
    return this.statusCode === 400 && /invalid_grant/i.test(this.body);
  }
}

/**
 * Generate Intuit OAuth authorization URL
 */
export function generateAuthUrl(config: OAuthConfig, state?: string): string {
  const params = new URLSearchParams({
    client_id: config.clientId,
    response_type: 'code',
    scope: 'com.intuit.quickbooks.accounting',
    redirect_uri: config.redirectUri,
    ...(state && { state }),
  });

  const baseUrl = 'https://appcenter.intuit.com/connect/oauth2';
  return `${baseUrl}?${params.toString()}`;
}

/**
 * Exchange authorization code for access and refresh tokens
 */
export async function exchangeCodeForTokens(
  code: string,
  config: OAuthConfig
): Promise<IntuitTokenResponse> {
  const tokenEndpoint = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';

  const credentials = Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64');

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: config.redirectUri,
  });

  const response = await fetch(tokenEndpoint, {
    method: 'POST',
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': `Basic ${credentials}`,
    },
    body: body.toString(),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Token exchange failed: ${response.status} ${errorText}`);
  }

  const data = await response.json();
  return data as IntuitTokenResponse;
}

/**
 * Refresh access token using refresh token
 */
export async function refreshAccessToken(
  refreshToken: string,
  config: OAuthConfig
): Promise<IntuitTokenResponse> {
  const tokenEndpoint = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';

  const credentials = Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64');

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  });

  const response = await fetch(tokenEndpoint, {
    method: 'POST',
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': `Basic ${credentials}`,
    },
    body: body.toString(),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new OAuthTokenError(`Token refresh failed: ${response.status} ${errorText}`, response.status, errorText);
  }

  const data = await response.json();
  return data as IntuitTokenResponse;
}

/**
 * Revoke tokens (disconnect)
 */
export async function revokeToken(
  token: string,
  config: OAuthConfig
): Promise<void> {
  const revokeEndpoint = 'https://developer.api.intuit.com/v2/oauth2/tokens/revoke';

  const credentials = Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64');

  const body = new URLSearchParams({
    token,
  });

  const response = await fetch(revokeEndpoint, {
    method: 'POST',
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': `Basic ${credentials}`,
    },
    body: body.toString(),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Token revocation failed: ${response.status} ${errorText}`);
  }
}
