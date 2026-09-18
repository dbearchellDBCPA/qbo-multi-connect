import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { QBOManager } from '../../src/index.js';
import {
  ConnectionAlerts,
  AlertsNotConfiguredError,
  type BrokenConnection,
} from '../../src/alerts/connection-alerts.js';
import { parseAlertsConfig, disabledAlertsConfig } from '../../src/alerts/config.js';
import { EmailSendError, type EmailSender, type OutboundEmail } from '../../src/alerts/email.js';

const ENCRYPTION_KEY = 'a'.repeat(64);
const CONFIG = parseAlertsConfig({
  RESEND_API_KEY: 're_test',
  QBO_ALERT_EMAIL: 'ops@example.com',
  QBO_ALERT_FROM: 'QBO <alerts@example.com>',
});

class FakeSender implements EmailSender {
  sent: OutboundEmail[] = [];
  failWith: Error | null = null;
  async send(email: OutboundEmail): Promise<{ id: string }> {
    if (this.failWith) throw this.failWith;
    this.sent.push(email);
    return { id: `email_${this.sent.length}` };
  }
}

function broken(
  realmId: string,
  clientName: string,
  refreshExpiry: Date,
  reason: BrokenConnection['reason'] = 'invalid_grant'
): BrokenConnection {
  return { realmId, clientName, refreshExpiry, reason };
}

describe('ConnectionAlerts', () => {
  let qbo: QBOManager;
  let sender: FakeSender;
  let alerts: ConnectionAlerts;
  const window1 = new Date('2026-12-01T00:00:00.000Z');
  const now = new Date('2026-09-18T15:04:00.000Z');

  beforeEach(() => {
    qbo = new QBOManager({ dbPath: ':memory:', encryptionKey: ENCRYPTION_KEY });
    sender = new FakeSender();
    alerts = new ConnectionAlerts((qbo as any).db, CONFIG, sender, () => 'https://qbo.example.com', () => now);
  });

  afterEach(async () => {
    vi.useRealTimers();
    await qbo.close();
  });

  it('emails once about a break, naming the client and the fix', async () => {
    await alerts.notifyBroken([broken('realm-1', 'Acme Corp', window1)]);

    expect(sender.sent).toHaveLength(1);
    const email = sender.sent[0];
    expect(email.to).toEqual(['ops@example.com']);
    expect(email.from).toBe('QBO <alerts@example.com>');
    expect(email.subject).toBe('QuickBooks connection needs reconnecting: Acme Corp');
    expect(email.text).toContain('Acme Corp (company ID realm-1)');
    expect(email.text).toContain('invalid_grant');
    expect(email.text).toContain('https://qbo.example.com');
    expect(email.text).toContain('Reconnect');
    expect(email.html).toContain('Acme Corp');
    expect(email.idempotencyKey).toMatch(/^[0-9a-f]{64}$/);
  });

  it('escapes client names in the HTML version', async () => {
    await alerts.notifyBroken([broken('realm-1', 'Smith & Sons <LLC>', window1)]);
    expect(sender.sent[0].html).toContain('Smith &amp; Sons &lt;LLC&gt;');
    expect(sender.sent[0].html).not.toContain('<LLC>');
    expect(sender.sent[0].text).toContain('Smith & Sons <LLC>');
  });

  it('does not report the same break twice', async () => {
    await alerts.notifyBroken([broken('realm-1', 'Acme Corp', window1)]);
    await alerts.notifyBroken([broken('realm-1', 'Acme Corp', window1)]);
    await alerts.notifyBroken([broken('realm-1', 'Acme Corp', window1, 'refresh_window_lapsed')]);
    expect(sender.sent).toHaveLength(1);
  });

  it('stays quiet after a restart (a fresh instance on the same database)', async () => {
    await alerts.notifyBroken([broken('realm-1', 'Acme Corp', window1)]);
    const restarted = new ConnectionAlerts((qbo as any).db, CONFIG, sender, () => null, () => now);
    await restarted.notifyBroken([broken('realm-1', 'Acme Corp', window1)]);
    expect(sender.sent).toHaveLength(1);
  });

  it('reports a later break of a reconnected company (new refresh window)', async () => {
    await alerts.notifyBroken([broken('realm-1', 'Acme Corp', window1)]);
    const window2 = new Date('2027-01-15T00:00:00.000Z');
    await alerts.notifyBroken([broken('realm-1', 'Acme Corp', window2)]);
    expect(sender.sent).toHaveLength(2);
  });

  it('batches several breaks into one email and skips the ones already reported', async () => {
    await alerts.notifyBroken([broken('realm-1', 'Acme Corp', window1)]);
    await alerts.notifyBroken([
      broken('realm-1', 'Acme Corp', window1),
      broken('realm-2', 'Beta LLC', window1, 'refresh_window_lapsed'),
      broken('realm-3', 'Gamma Inc', window1),
    ]);

    expect(sender.sent).toHaveLength(2);
    const second = sender.sent[1];
    expect(second.subject).toBe('2 QuickBooks connections need reconnecting');
    expect(second.text).toContain('Beta LLC');
    expect(second.text).toContain('Gamma Inc');
    expect(second.text).not.toContain('Acme Corp');
    expect(second.text).toContain('100-day');
  });

  it('records nothing when the send fails, and retries after the backoff', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(now);
    sender.failWith = new EmailSendError('Resend rejected the email (500): boom', 500);

    await alerts.notifyBroken([broken('realm-1', 'Acme Corp', window1)]);
    expect(sender.sent).toHaveLength(0);
    expect((await alerts.status()).lastError).toMatch(/boom/);
    expect((await alerts.status()).lastAlert).toBeNull();

    sender.failWith = null;
    await alerts.notifyBroken([broken('realm-1', 'Acme Corp', window1)]);
    expect(sender.sent).toHaveLength(0); // still inside the 15-minute backoff

    vi.setSystemTime(new Date(now.getTime() + 16 * 60 * 1000));
    await alerts.notifyBroken([broken('realm-1', 'Acme Corp', window1)]);
    expect(sender.sent).toHaveLength(1);
    const status = await alerts.status();
    expect(status.lastError).toBeNull();
    expect(status.lastAlert?.clientName).toBe('Acme Corp');
    expect(status.lastAlert?.realmId).toBe('realm-1');
    expect(status.lastAlert?.sentAt).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
  });

  it('is a no-op when alerts are not configured', async () => {
    const off = new ConnectionAlerts((qbo as any).db, disabledAlertsConfig(), sender);
    expect(off.enabled).toBe(false);
    await off.notifyBroken([broken('realm-1', 'Acme Corp', window1)]);
    expect(sender.sent).toHaveLength(0);
    await expect(off.sendTest()).rejects.toBeInstanceOf(AlertsNotConfiguredError);
    await expect(off.sendTest()).rejects.toThrow(/RESEND_API_KEY/);
  });

  it('sends a test email to the configured recipients', async () => {
    const result = await alerts.sendTest();
    expect(result.recipients).toEqual(['ops@example.com']);
    expect(sender.sent).toHaveLength(1);
    expect(sender.sent[0].subject).toMatch(/^Test:/);
    expect(sender.sent[0].text).toContain('https://qbo.example.com');
    expect(sender.sent[0].text).toContain('ops@example.com');
  });

  it('a successful test clears an earlier delivery failure and its backoff', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(now);
    sender.failWith = new EmailSendError('boom');
    await alerts.notifyBroken([broken('realm-1', 'Acme Corp', window1)]);
    sender.failWith = null;

    await alerts.sendTest();
    expect((await alerts.status()).lastError).toBeNull();

    await alerts.notifyBroken([broken('realm-1', 'Acme Corp', window1)]);
    expect(sender.sent.map((e) => e.subject)).toEqual([
      'Test: QuickBooks connection alerts are working',
      'QuickBooks connection needs reconnecting: Acme Corp',
    ]);
  });

  it('status() reports the configuration without the API key', async () => {
    const status = await alerts.status();
    expect(status.enabled).toBe(true);
    expect(status.provider).toBe('resend');
    expect(status.recipients).toEqual(['ops@example.com']);
    expect(status.from).toBe('QBO <alerts@example.com>');
    expect(status.dashboardUrl).toBe('https://qbo.example.com');
    expect(status.lastAlert).toBeNull();
    expect(JSON.stringify(status)).not.toContain('re_test');
  });
});
