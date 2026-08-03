import { TokenStore } from './token-store.js';
import { refreshAccessToken, OAuthTokenError } from './oauth.js';
import type { OAuthConfig } from '../db/models.js';

// Per-realm in-flight refresh promises. Intuit rotates the refresh token on
// every refresh and invalidates the previous one, so two concurrent refreshes
// for the same realm race: the loser persists a token Intuit has already
// revoked, knocking the connection offline until the next daemon tick. This map
// collapses concurrent callers onto a single refresh per realm.
// NOTE: this guards races within one process; if you scale to multiple
// instances, refreshes can still race across instances.
const inFlightRefreshes = new Map<string, Promise<void>>();

/**
 * Refresh tokens for a specific connection
 */
export function refreshConnectionTokens(
  realmId: string,
  tokenStore: TokenStore,
  oauthConfig: OAuthConfig,
  options: { revive?: boolean } = {}
): Promise<void> {
  // If a refresh for this realm is already running, await the same promise
  // rather than starting a second, racing refresh.
  const existing = inFlightRefreshes.get(realmId);
  if (existing) {
    return existing;
  }

  const refreshPromise = doRefreshConnectionTokens(realmId, tokenStore, oauthConfig, options).finally(() => {
    inFlightRefreshes.delete(realmId);
  });

  inFlightRefreshes.set(realmId, refreshPromise);
  return refreshPromise;
}

async function doRefreshConnectionTokens(
  realmId: string,
  tokenStore: TokenStore,
  oauthConfig: OAuthConfig,
  options: { revive?: boolean } = {}
): Promise<void> {
  const connection = await tokenStore.getConnection(realmId);
  if (!connection) {
    throw new Error(`Connection not found: ${realmId}`);
  }

  // Normal refreshes only touch active connections. Revival (the daemon's
  // self-heal pass) may also retry 'expired' ones — a connection can end up
  // in that state from a transient failure while its refresh token is still
  // perfectly valid at Intuit.
  const allowedStates = options.revive ? ['active', 'expired'] : ['active'];
  if (!allowedStates.includes(connection.status)) {
    throw new Error(`Connection is not active: ${connection.status}`);
  }

  try {
    const tokenResponse = await refreshAccessToken(connection.refreshToken, oauthConfig);

    const now = Date.now();
    const tokenUpdate = {
      accessToken: tokenResponse.access_token,
      refreshToken: tokenResponse.refresh_token,
      tokenExpiry: new Date(now + tokenResponse.expires_in * 1000),
      refreshExpiry: new Date(now + tokenResponse.x_refresh_token_expires_in * 1000),
    };

    await tokenStore.updateTokens(realmId, tokenUpdate);
    if (connection.status === 'expired') {
      await tokenStore.updateStatus(realmId, 'active');
    }
  } catch (error) {
    // Only a DEFINITIVE rejection from Intuit (invalid_grant: the refresh
    // token itself is dead) marks the connection expired. Transient trouble
    // — network blips, Intuit 5xx, rate limits, a deploy interrupting the
    // sweep — leaves the connection active so the next sweep retries it.
    // (The old behavior of marking expired on ANY failure is what caused
    // mass expiries: one bad sweep permanently knocked out every company
    // whose hourly refresh fell in that window, and expired connections
    // were never retried.)
    if (error instanceof OAuthTokenError && error.isInvalidGrant) {
      await tokenStore.updateStatus(realmId, 'expired');
    }
    throw error;
  }
}

/**
 * Refresh daemon that proactively refreshes tokens
 */
export class RefreshDaemon {
  private intervalId: NodeJS.Timeout | null = null;
  private running = false;

  // Realms whose revival got a definitive invalid_grant, mapped to the
  // refresh_expiry they had at that moment. Retrying those every sweep would
  // spam Intuit for a token only re-authorization can fix — so they're
  // skipped until the stored refresh_expiry changes (i.e. someone
  // reconnected the company, which mints a whole new token).
  private deadRealms = new Map<string, string>();

  constructor(
    private tokenStore: TokenStore,
    private oauthConfig: OAuthConfig,
    private checkIntervalMs: number = 5 * 60 * 1000, // 5 minutes
    private refreshThresholdMinutes: number = 10 // Refresh when < 10 min left
  ) {}

  /**
   * Start the refresh daemon
   */
  start(): void {
    if (this.running) {
      console.warn('Refresh daemon already running');
      return;
    }

    this.running = true;
    console.log(`Refresh daemon started (check every ${this.checkIntervalMs / 1000}s)`);

    // Run immediately, then on interval
    this.checkAndRefresh();

    this.intervalId = setInterval(() => {
      this.checkAndRefresh();
    }, this.checkIntervalMs);
  }

  /**
   * Stop the refresh daemon
   */
  stop(): void {
    if (!this.running) {
      return;
    }

    this.running = false;
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }

    console.log('Refresh daemon stopped');
  }

  /**
   * Check for expiring tokens and refresh them, then attempt to revive
   * connections stuck in 'expired' whose refresh window is still open.
   */
  private async checkAndRefresh(): Promise<void> {
    try {
      const expiringConnections = await this.tokenStore.getConnectionsExpiringSoon(
        this.refreshThresholdMinutes
      );

      if (expiringConnections.length > 0) {
        console.log(`Found ${expiringConnections.length} connections needing refresh`);
      }

      for (const connection of expiringConnections) {
        try {
          await refreshConnectionTokens(connection.realmId, this.tokenStore, this.oauthConfig);
          console.log(`Refreshed tokens for ${connection.clientName} (${connection.realmId})`);
        } catch (error) {
          console.error(
            `Failed to refresh ${connection.clientName} (${connection.realmId}):`,
            error instanceof Error ? error.message : error
          );
        }
      }
    } catch (error) {
      console.error('Error in refresh daemon:', error);
    }

    await this.revivePass();
  }

  /**
   * Self-heal: retry connections marked 'expired' whose 100-day refresh
   * window has not actually lapsed. Their refresh tokens are usually still
   * valid at Intuit (the expired flag came from a transient failure under
   * the old error handling, or an interrupted sweep). Success flips them
   * back to active with fresh tokens; a definitive invalid_grant parks the
   * realm until it is manually reconnected.
   */
  async revivePass(): Promise<void> {
    try {
      const revivable = await this.tokenStore.getRevivableConnections();
      for (const connection of revivable) {
        const refreshExpiryIso = connection.refreshExpiry.toISOString();
        const deadAt = this.deadRealms.get(connection.realmId);
        if (deadAt === refreshExpiryIso) continue; // known-dead; needs re-auth
        if (deadAt) this.deadRealms.delete(connection.realmId); // reconnected since

        try {
          await refreshConnectionTokens(connection.realmId, this.tokenStore, this.oauthConfig, { revive: true });
          console.log(`Revived ${connection.clientName} (${connection.realmId}) — connection is active again`);
        } catch (error) {
          if (error instanceof OAuthTokenError && error.isInvalidGrant) {
            this.deadRealms.set(connection.realmId, refreshExpiryIso);
            console.error(
              `${connection.clientName} (${connection.realmId}) needs re-authorization: Intuit rejected its refresh token (invalid_grant). Use Reconnect in the dashboard.`
            );
          } else {
            console.error(
              `Revival attempt for ${connection.clientName} (${connection.realmId}) failed transiently, will retry:`,
              error instanceof Error ? error.message : error
            );
          }
        }
      }
    } catch (error) {
      console.error('Error in revive pass:', error);
    }
  }

  /**
   * Check if daemon is running
   */
  isRunning(): boolean {
    return this.running;
  }
}
