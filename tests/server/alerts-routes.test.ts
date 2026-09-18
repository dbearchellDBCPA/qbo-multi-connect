import { describe, it, expect, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { QBOManager } from '../../src/index.js';
import { alertsRoutes } from '../../src/server/routes/alerts.js';
import { parseAlertsConfig, disabledAlertsConfig, type AlertsConfig } from '../../src/alerts/config.js';
import { EmailSendError, type EmailSender, type OutboundEmail } from '../../src/alerts/email.js';

const ENCRYPTION_KEY = 'a'.repeat(64);
const MASTER_KEY = 'master-key-for-tests';
const asMaster = { Authorization: `Bearer ${MASTER_KEY}` };
const CONFIGURED = parseAlertsConfig({
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

describe('alerts routes', () => {
  let qbo: QBOManager;
  let app: FastifyInstance;
  let sender: FakeSender;

  async function build(config: AlertsConfig): Promise<void> {
    sender = new FakeSender();
    qbo = new QBOManager({
      dbPath: ':memory:',
      encryptionKey: ENCRYPTION_KEY,
      alerts: config,
      emailSender: sender,
      dashboardUrl: () => 'https://qbo.example.com',
    });
    app = Fastify({ logger: false });
    await alertsRoutes(app, qbo, MASTER_KEY);
    await app.ready();
  }

  async function memberHeaders(): Promise<Record<string, string>> {
    const { apiKey } = await qbo.users.create({ name: 'Jane' });
    return { Authorization: `Bearer ${apiKey}` };
  }

  afterEach(async () => {
    await app.close();
    await qbo.close();
  });

  it('requires an admin key', async () => {
    await build(CONFIGURED);
    expect((await app.inject({ method: 'GET', url: '/api/alerts' })).statusCode).toBe(401);
    const member = await memberHeaders();
    expect((await app.inject({ method: 'GET', url: '/api/alerts', headers: member })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/api/alerts/test', headers: member })).statusCode).toBe(403);
    expect(sender.sent).toHaveLength(0);
  });

  it('reports a configured setup without leaking the API key', async () => {
    await build(CONFIGURED);
    const res = await app.inject({ method: 'GET', url: '/api/alerts', headers: asMaster });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.enabled).toBe(true);
    expect(body.recipients).toEqual(['ops@example.com']);
    expect(body.from).toBe('QBO <alerts@example.com>');
    expect(body.dashboardUrl).toBe('https://qbo.example.com');
    expect(body.lastAlert).toBeNull();
    expect(res.body).not.toContain('re_test');
  });

  it('reports what is missing when alerts are off', async () => {
    await build(disabledAlertsConfig());
    const body = (await app.inject({ method: 'GET', url: '/api/alerts', headers: asMaster })).json();
    expect(body.enabled).toBe(false);
    expect(body.missing).toEqual(['RESEND_API_KEY', 'QBO_ALERT_EMAIL', 'QBO_ALERT_FROM']);
  });

  it('sends a test email on request', async () => {
    await build(CONFIGURED);
    const res = await app.inject({ method: 'POST', url: '/api/alerts/test', headers: asMaster });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: true, id: 'email_1', recipients: ['ops@example.com'] });
    expect(sender.sent).toHaveLength(1);
    expect(sender.sent[0].to).toEqual(['ops@example.com']);
  });

  it('refuses a test send when alerts are not configured', async () => {
    await build(disabledAlertsConfig());
    const res = await app.inject({ method: 'POST', url: '/api/alerts/test', headers: asMaster });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/RESEND_API_KEY/);
    expect(sender.sent).toHaveLength(0);
  });

  it('passes a provider rejection through as a 502 with its message', async () => {
    await build(CONFIGURED);
    sender.failWith = new EmailSendError('Resend rejected the email (403): domain is not verified', 403);
    const res = await app.inject({ method: 'POST', url: '/api/alerts/test', headers: asMaster });
    expect(res.statusCode).toBe(502);
    expect(res.json().message).toMatch(/domain is not verified/);
  });
});
