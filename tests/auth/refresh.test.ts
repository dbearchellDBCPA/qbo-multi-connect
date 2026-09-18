import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { QBOManager } from '../../src/index.js';
import { refreshConnectionTokens, RefreshDaemon } from '../../src/auth/refresh.js';
import { OAuthTokenError } from '../../src/auth/oauth.js';
import { parseAlertsConfig } from '../../src/alerts/config.js';
import type { EmailSender, OutboundEmail } from '../../src/alerts/email.js';

const ENCRYPTION_KEY = 'a'.repeat(64);
const OAUTH = { clientId: 'cid', clientSecret: 'secret', redirectUri: 'http://x/callback' };

function tokenResponse() {
  return {
    ok: true,
    status: 200,
    text: async () => '',
    json: async () => ({
      access_token: 'new-access',
      refresh_token: 'new-refresh',
      token_type: 'bearer',
      expires_in: 3600,
      x_refresh_token_expires_in: 100 * 24 * 3600,
    }),
  };
}

function intuitRejection(status: number, body: string) {
  return { ok: false, status, text: async () => body, json: async () => ({}) };
}

describe('refresh failure handling', () => {
  let qbo: QBOManager;

  beforeEach(async () => {
    qbo = new QBOManager({ dbPath: ':memory:', encryptionKey: ENCRYPTION_KEY });
    const now = Date.now();
    await (qbo as any).tokenStore.storeConnection({
      clientName: 'Acme Corp',
      realmId: 'realm-1',
      accessToken: 'old-access',
      refreshToken: 'old-refresh',
      tokenExpiry: new Date(now + 60 * 1000), // expiring soon
      refreshExpiry: new Date(now + 90 * 24 * 3600 * 1000),
      scopes: ['x'],
    });
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await qbo.close();
  });

  it('transient failures (network error) do NOT mark the connection expired', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('socket hang up')));

    await expect(
      refreshConnectionTokens('realm-1', (qbo as any).tokenStore, OAUTH)
    ).rejects.toThrow('socket hang up');

    const conn = await qbo.getConnection('realm-1');
    expect(conn?.status).toBe('active'); // still retryable next sweep
  });

  it('transient failures (Intuit 5xx) do NOT mark the connection expired', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(intuitRejection(503, 'Service Unavailable')));

    await expect(
      refreshConnectionTokens('realm-1', (qbo as any).tokenStore, OAUTH)
    ).rejects.toThrow(/503/);

    expect((await qbo.getConnection('realm-1'))?.status).toBe('active');
  });

  it('definitive invalid_grant DOES mark the connection expired', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(intuitRejection(400, '{"error":"invalid_grant"}'))
    );

    await expect(
      refreshConnectionTokens('realm-1', (qbo as any).tokenStore, OAUTH)
    ).rejects.toThrow(/invalid_grant/);

    expect((await qbo.getConnection('realm-1'))?.status).toBe('expired');
  });

  it('successful refresh stores rotated tokens', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(tokenResponse()));

    await refreshConnectionTokens('realm-1', (qbo as any).tokenStore, OAUTH);

    const conn = await qbo.getConnection('realm-1');
    expect(conn?.accessToken).toBe('new-access');
    expect(conn?.refreshToken).toBe('new-refresh');
    expect(conn?.status).toBe('active');
  });
});

describe('self-heal revival', () => {
  let qbo: QBOManager;

  async function seed(realmId: string, status: 'active' | 'expired', refreshExpiryMs: number) {
    const now = Date.now();
    await (qbo as any).tokenStore.storeConnection({
      clientName: `Client ${realmId}`,
      realmId,
      accessToken: 'old-access',
      refreshToken: 'old-refresh',
      tokenExpiry: new Date(now - 60 * 1000),
      refreshExpiry: new Date(now + refreshExpiryMs),
      scopes: ['x'],
    });
    if (status === 'expired') await (qbo as any).tokenStore.updateStatus(realmId, 'expired');
  }

  beforeEach(() => {
    qbo = new QBOManager({ dbPath: ':memory:', encryptionKey: ENCRYPTION_KEY });
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await qbo.close();
  });

  it('getRevivableConnections returns only expired connections with a live refresh window', async () => {
    await seed('stuck', 'expired', 30 * 24 * 3600 * 1000); // revivable
    await seed('truly-lapsed', 'expired', -1000); // window closed
    await seed('healthy', 'active', 30 * 24 * 3600 * 1000); // not expired

    const revivable = await (qbo as any).tokenStore.getRevivableConnections();
    expect(revivable.map((c: any) => c.realmId)).toEqual(['stuck']);
  });

  it('revives a stuck connection: refresh succeeds → active with fresh tokens', async () => {
    await seed('stuck', 'expired', 30 * 24 * 3600 * 1000);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(tokenResponse()));

    const daemon = new RefreshDaemon((qbo as any).tokenStore, OAUTH);
    await daemon.revivePass();

    const conn = await qbo.getConnection('stuck');
    expect(conn?.status).toBe('active');
    expect(conn?.accessToken).toBe('new-access');
  });

  it('normal (non-revive) refresh still refuses expired connections', async () => {
    await seed('stuck', 'expired', 30 * 24 * 3600 * 1000);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(tokenResponse()));

    await expect(
      refreshConnectionTokens('stuck', (qbo as any).tokenStore, OAUTH)
    ).rejects.toThrow(/not active/);
  });

  it('invalid_grant during revival parks the realm: no retry spam on later passes', async () => {
    await seed('dead', 'expired', 30 * 24 * 3600 * 1000);
    const fetchSpy = vi.fn().mockResolvedValue(intuitRejection(400, '{"error":"invalid_grant"}'));
    vi.stubGlobal('fetch', fetchSpy);

    const daemon = new RefreshDaemon((qbo as any).tokenStore, OAUTH);
    await daemon.revivePass();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect((await qbo.getConnection('dead'))?.status).toBe('expired');

    await daemon.revivePass();
    await daemon.revivePass();
    expect(fetchSpy).toHaveBeenCalledTimes(1); // parked — not retried
  });

  it('a parked realm is retried again after the company is reconnected (new refresh window)', async () => {
    await seed('dead', 'expired', 30 * 24 * 3600 * 1000);
    const fetchSpy = vi.fn().mockResolvedValue(intuitRejection(400, '{"error":"invalid_grant"}'));
    vi.stubGlobal('fetch', fetchSpy);

    const daemon = new RefreshDaemon((qbo as any).tokenStore, OAUTH);
    await daemon.revivePass();
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // Reconnect: upsert stores fresh tokens with a NEW refresh_expiry, but
    // suppose it lands expired again later — the changed window unparks it.
    const now = Date.now();
    await (qbo as any).tokenStore.storeConnection({
      clientName: 'Client dead',
      realmId: 'dead',
      accessToken: 'reauthed-access',
      refreshToken: 'reauthed-refresh',
      tokenExpiry: new Date(now - 60 * 1000),
      refreshExpiry: new Date(now + 99 * 24 * 3600 * 1000),
      scopes: ['x'],
    });
    await (qbo as any).tokenStore.updateStatus('dead', 'expired');
    fetchSpy.mockResolvedValue(tokenResponse());

    await daemon.revivePass();
    expect(fetchSpy).toHaveBeenCalledTimes(2); // retried because window changed
    expect((await qbo.getConnection('dead'))?.status).toBe('active');
  });

  it('transient failure during revival stays retryable', async () => {
    await seed('stuck', 'expired', 30 * 24 * 3600 * 1000);
    const fetchSpy = vi.fn().mockResolvedValue(intuitRejection(503, 'oops'));
    vi.stubGlobal('fetch', fetchSpy);

    const daemon = new RefreshDaemon((qbo as any).tokenStore, OAUTH);
    await daemon.revivePass();
    await daemon.revivePass();
    expect(fetchSpy).toHaveBeenCalledTimes(2); // retried each pass

    fetchSpy.mockResolvedValue(tokenResponse());
    await daemon.revivePass();
    expect((await qbo.getConnection('stuck'))?.status).toBe('active');
  });
});

describe('OAuthTokenError classification', () => {
  it('flags invalid_grant only for 400s containing invalid_grant', () => {
    expect(new OAuthTokenError('x', 400, '{"error":"invalid_grant"}').isInvalidGrant).toBe(true);
    expect(new OAuthTokenError('x', 400, '{"error":"invalid_request"}').isInvalidGrant).toBe(false);
    expect(new OAuthTokenError('x', 503, 'invalid_grant').isInvalidGrant).toBe(false);
    expect(new OAuthTokenError('x', 401, '{"error":"invalid_client"}').isInvalidGrant).toBe(false);
  });
});

describe('broken-connection email alerts', () => {
  const DAY = 24 * 3600 * 1000;
  const ALERTS = parseAlertsConfig({
    RESEND_API_KEY: 're_test',
    QBO_ALERT_EMAIL: 'ops@example.com',
    QBO_ALERT_FROM: 'QBO <alerts@example.com>',
  });

  class FakeSender implements EmailSender {
    sent: OutboundEmail[] = [];
    async send(email: OutboundEmail): Promise<{ id: string }> {
      this.sent.push(email);
      return { id: `email_${this.sent.length}` };
    }
  }

  let qbo: QBOManager;
  let sender: FakeSender;

  async function seed(
    realmId: string,
    clientName: string,
    opts: { status?: 'active' | 'expired'; tokenExpiryMs: number; refreshExpiryMs: number }
  ) {
    const now = Date.now();
    await (qbo as any).tokenStore.storeConnection({
      clientName,
      realmId,
      accessToken: 'old-access',
      refreshToken: 'old-refresh',
      tokenExpiry: new Date(now + opts.tokenExpiryMs),
      refreshExpiry: new Date(now + opts.refreshExpiryMs),
      scopes: ['x'],
    });
    if (opts.status === 'expired') await (qbo as any).tokenStore.updateStatus(realmId, 'expired');
  }

  const daemon = () => new RefreshDaemon((qbo as any).tokenStore, OAUTH, undefined, undefined, qbo.alerts);
  const tick = (d: RefreshDaemon) => (d as any).checkAndRefresh() as Promise<void>;

  beforeEach(() => {
    sender = new FakeSender();
    qbo = new QBOManager({
      dbPath: ':memory:',
      encryptionKey: ENCRYPTION_KEY,
      alerts: ALERTS,
      emailSender: sender,
      dashboardUrl: () => 'https://qbo.example.com',
    });
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await qbo.close();
  });

  it('emails once when Intuit rejects a refresh token, and not again on later ticks', async () => {
    await seed('realm-1', 'Acme Corp', { tokenExpiryMs: 60_000, refreshExpiryMs: 90 * DAY });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(intuitRejection(400, '{"error":"invalid_grant"}')));

    const d = daemon();
    await tick(d);
    expect((await qbo.getConnection('realm-1'))?.status).toBe('expired');
    expect(sender.sent).toHaveLength(1);
    expect(sender.sent[0].to).toEqual(['ops@example.com']);
    expect(sender.sent[0].subject).toBe('QuickBooks connection needs reconnecting: Acme Corp');
    expect(sender.sent[0].text).toContain('https://qbo.example.com');

    await tick(d);
    await tick(d);
    expect(sender.sent).toHaveLength(1);
  });

  it('stays quiet after a restart for a break already reported', async () => {
    await seed('realm-1', 'Acme Corp', { tokenExpiryMs: 60_000, refreshExpiryMs: 90 * DAY });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(intuitRejection(400, '{"error":"invalid_grant"}')));
    await tick(daemon());
    expect(sender.sent).toHaveLength(1);

    // A new daemon has an empty parked-realm map: it re-confirms the
    // rejection with Intuit, but the database remembers the alert.
    await tick(daemon());
    expect(sender.sent).toHaveLength(1);
  });

  it('does not email for transient failures', async () => {
    await seed('realm-1', 'Acme Corp', { tokenExpiryMs: 60_000, refreshExpiryMs: 90 * DAY });
    await seed('realm-2', 'Beta LLC', { status: 'expired', tokenExpiryMs: -60_000, refreshExpiryMs: 30 * DAY });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(intuitRejection(503, 'Service Unavailable')));

    const d = daemon();
    await tick(d);
    await tick(d);
    expect((await qbo.getConnection('realm-1'))?.status).toBe('active');
    expect(sender.sent).toHaveLength(0);
  });

  it('reports a connection whose refresh window has already lapsed, without asking Intuit', async () => {
    await seed('realm-1', 'Acme Corp', { status: 'expired', tokenExpiryMs: -60_000, refreshExpiryMs: -1000 });
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    await tick(daemon());
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(sender.sent).toHaveLength(1);
    expect(sender.sent[0].text).toContain('100-day');
  });

  it('reports a company again if it is reconnected and later breaks again', async () => {
    await seed('realm-1', 'Acme Corp', { tokenExpiryMs: 60_000, refreshExpiryMs: 90 * DAY });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(intuitRejection(400, '{"error":"invalid_grant"}')));
    const d = daemon();
    await tick(d);
    expect(sender.sent).toHaveLength(1);

    // Reconnect from the dashboard: fresh tokens and a new 100-day window.
    await seed('realm-1', 'Acme Corp', { tokenExpiryMs: 60_000, refreshExpiryMs: 99 * DAY });
    expect((await qbo.getConnection('realm-1'))?.status).toBe('active');

    // Intuit rejects the new token too: that is a second, distinct break.
    await tick(d);
    expect((await qbo.getConnection('realm-1'))?.status).toBe('expired');
    expect(sender.sent).toHaveLength(2);
    expect(sender.sent[1].subject).toBe('QuickBooks connection needs reconnecting: Acme Corp');

    await tick(d);
    expect(sender.sent).toHaveLength(2);
  });

  it('several companies breaking in one tick share a single email', async () => {
    await seed('realm-1', 'Acme Corp', { tokenExpiryMs: 60_000, refreshExpiryMs: 90 * DAY });
    await seed('realm-2', 'Beta LLC', { tokenExpiryMs: 60_000, refreshExpiryMs: 90 * DAY });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(intuitRejection(400, '{"error":"invalid_grant"}')));

    await tick(daemon());
    expect(sender.sent).toHaveLength(1);
    expect(sender.sent[0].subject).toBe('2 QuickBooks connections need reconnecting');
    expect(sender.sent[0].text).toContain('Acme Corp');
    expect(sender.sent[0].text).toContain('Beta LLC');
  });

  it('is inert when the manager has no alert configuration', async () => {
    const plain = new QBOManager({ dbPath: ':memory:', encryptionKey: ENCRYPTION_KEY });
    expect(plain.alerts.enabled).toBe(false);
    await plain.close();
  });
});
