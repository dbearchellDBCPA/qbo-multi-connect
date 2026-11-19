import { describe, it, expect, vi, afterEach } from 'vitest';
import { parseInvitesConfig, disabledInvitesConfig } from '../../src/invites/config.js';
import { renderClientInvitationEmail } from '../../src/invites/templates.js';
import { ClientInvites, InvitesNotConfiguredError } from '../../src/invites/client-invites.js';
import { acceptInvitePage, inviteAcceptedPage, inviteInvalidPage } from '../../src/server/invite-pages.js';
import { redactUrlForLog } from '../../src/server/log-redaction.js';
import { ResendEmailSender, EmailSendError, type EmailSender, type OutboundEmail } from '../../src/alerts/email.js';
import { isValidUsername } from '../../src/users.js';

class FakeSender implements EmailSender {
  sent: OutboundEmail[] = [];
  fail = false;
  async send(email: OutboundEmail): Promise<{ id: string }> {
    if (this.fail) throw new EmailSendError('Resend rejected the email (403): domain is not verified', 403);
    this.sent.push(email);
    return { id: `email_${this.sent.length}` };
  }
}

const CONFIGURED = parseInvitesConfig({
  RESEND_API_KEY: 're_test',
  QBO_INVITE_FROM: 'Example CPA <hello@example-cpa.com>',
  QBO_INVITE_REPLY_TO: 'pat@example-cpa.com',
});

const ACCEPT_URL = 'https://qbo.example-cpa.com/invite/qboi_0123456789abcdef';
const INVITATION = {
  firmName: 'Example CPA',
  name: 'Jordan Rivera',
  username: 'jordan@rivera-landscaping.example',
  acceptUrl: ACCEPT_URL,
  expiresAt: new Date('2026-11-26T15:00:00Z'),
  connectorUrl: 'https://qbo.example-cpa.com/mcp',
  companyNames: ['Rivera Landscaping LLC'],
  canReply: true,
};

describe('invites config', () => {
  it('is off until there is a key and a sender, and says what is missing', () => {
    expect(disabledInvitesConfig()).toMatchObject({ enabled: false, missing: ['RESEND_API_KEY', 'QBO_INVITE_FROM'], problems: [] });
    expect(parseInvitesConfig({ RESEND_API_KEY: 're_x' })).toMatchObject({ enabled: false, missing: ['QBO_INVITE_FROM'] });
    expect(parseInvitesConfig({ QBO_INVITE_FROM: 'a@b.com' })).toMatchObject({ enabled: false, missing: ['RESEND_API_KEY'] });
  });

  it('takes the firm name from the sender unless one is given', () => {
    expect(CONFIGURED).toMatchObject({ enabled: true, from: 'Example CPA <hello@example-cpa.com>', firmName: 'Example CPA', replyTo: 'pat@example-cpa.com' });
    expect(parseInvitesConfig({ RESEND_API_KEY: 'k', QBO_INVITE_FROM: 'hello@example-cpa.com' }).firmName).toBe('Your accounting firm');
    expect(parseInvitesConfig({ RESEND_API_KEY: 'k', QBO_INVITE_FROM: 'X <a@b.com>', QBO_FIRM_NAME: 'Rivera & Co.' }).firmName).toBe('Rivera & Co.');
  });

  it('never borrows the alert sender: having alerts set up does not turn client email on', () => {
    const config = parseInvitesConfig({
      RESEND_API_KEY: 'k',
      QBO_ALERT_EMAIL: 'ops@example-cpa.com',
      QBO_ALERT_FROM: 'QBO Multi-Connect <alerts@example-cpa.com>',
    });
    expect(config).toMatchObject({ enabled: false, from: '', missing: ['QBO_INVITE_FROM'] });
    expect(config.firmName).not.toContain('QBO Multi-Connect');
  });

  it('refuses malformed addresses rather than sending from them', () => {
    expect(parseInvitesConfig({ RESEND_API_KEY: 'k', QBO_INVITE_FROM: 'not an address' })).toMatchObject({ enabled: false });
    const badReply = parseInvitesConfig({ RESEND_API_KEY: 'k', QBO_INVITE_FROM: 'a@b.com', QBO_INVITE_REPLY_TO: 'nope' });
    expect(badReply.enabled).toBe(false);
    expect(badReply.problems[0]).toContain('QBO_INVITE_REPLY_TO');
  });
});

describe('an email address as a username', () => {
  it('accepts ordinary and plus-addressed emails, and long ones', () => {
    for (const ok of ['jordan@rivera-landscaping.example', 'jordan+qbo@example.com', 'a.b_c-d@sub.example.co', `${'x'.repeat(200)}@example.com`]) {
      expect(isValidUsername(ok), ok).toBe(true);
    }
    for (const bad of ['a b@example.com', "o'brien@example.com", 'ab', `${'x'.repeat(250)}@example.com`, '<x>@example.com']) {
      expect(isValidUsername(bad), bad).toBe(false);
    }
  });
});

describe('the invitation email', () => {
  const invitation = renderClientInvitationEmail(INVITATION);

  it('leads with the accept link, and says when it expires', () => {
    expect(invitation.subject).toBe('Example CPA invited you to connect your AI assistant to QuickBooks');
    expect(invitation.text).toContain(ACCEPT_URL);
    expect(invitation.html).toContain(`href="${ACCEPT_URL}"`);
    for (const body of [invitation.text, invitation.html]) {
      expect(body).toMatch(/choose your password/i);
      expect(body).toContain('Thursday, November 26');
      expect(body).toMatch(/works once/);
    }
    // Step 1 comes before the connect steps.
    expect(invitation.text.indexOf(ACCEPT_URL)).toBeLessThan(invitation.text.indexOf('Connector address'));
  });

  it('carries no password — there isn\'t one yet', () => {
    for (const body of [invitation.text, invitation.html]) {
      expect(body).not.toMatch(/^\s*Password:/im); // no "Password: …" line
      expect(body).not.toMatch(/temporary password/i);
      expect(body).toMatch(/Nobody else will know it/);
    }
  });

  it('says where and who, and how to set up both assistants', () => {
    for (const body of [invitation.text, invitation.html]) {
      expect(body).toContain('https://qbo.example-cpa.com/mcp');
      expect(body).toContain('jordan@rivera-landscaping.example');
      expect(body).toContain('Rivera Landscaping LLC');
      expect(body).toContain('Jordan Rivera');
      expect(body).toMatch(/Add custom connector/); // Claude
      expect(body).toMatch(/Add custom MCP server/); // ChatGPT
      expect(body).toMatch(/read-only/i);
    }
    expect(invitation.text).not.toContain('**'); // bold markers never leak into plain text
    expect(invitation.html).toContain('<strong>Customize → Connectors</strong>');
  });

  it('escapes everything that comes from the database or the environment', () => {
    const hostile = renderClientInvitationEmail({
      ...INVITATION,
      firmName: 'A & B <CPAs>',
      name: '<script>alert(1)</script>',
      username: 'x"><img src=x>',
      acceptUrl: 'https://qbo.example-cpa.com/invite/a"onmouseover="x',
      companyNames: ['Smith & Sons <LLC>'],
    });
    expect(hostile.html).not.toContain('<script>');
    expect(hostile.html).not.toContain('<img');
    expect(hostile.html).not.toContain('"onmouseover="');
    expect(hostile.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(hostile.html).toContain('Smith &amp; Sons &lt;LLC&gt;');
    expect(hostile.text).toContain('Smith & Sons <LLC>'); // plain text stays plain
  });

  it('keeps every inline style intact — no quote inside a style attribute', async () => {
    // A double quote in a font name ends style="…" early and silently drops
    // the rest (font stack, text colour); mail clients then fall back to Times.
    const { renderTestEmail } = await import('../../src/alerts/templates.js');
    const alert = renderTestEmail({ dashboardUrl: 'https://qbo.example-cpa.com', recipients: ['a@example.com'], now: new Date() });
    for (const html of [invitation.html, alert.html]) {
      const bodyStyle = html.match(/<body style="([^"]*)"/)![1];
      expect(bodyStyle).toContain('sans-serif');
      expect(bodyStyle).toMatch(/color:#[0-9a-f]{6};$/);
      for (const [, style] of html.matchAll(/style="([^"]*)"/g)) expect(style.trim().endsWith(';')).toBe(true);
    }
  });

  it('names several companies readably, and copes with none', () => {
    const many = renderClientInvitationEmail({ ...INVITATION, companyNames: ['Acme', 'Beta', 'Gamma'] });
    expect(many.text).toContain('Acme, Beta and Gamma');
    expect(renderClientInvitationEmail({ ...INVITATION, companyNames: [] }).text).toContain('your QuickBooks Online company');
  });

  it('only invites a reply when a reply will reach someone', () => {
    expect(invitation.text).toContain('Just reply to this email');
    const noReply = renderClientInvitationEmail({ ...INVITATION, canReply: false });
    expect(noReply.text).not.toContain('reply to this email');
    expect(noReply.text).toContain('Contact Example CPA');
  });
});

describe('the accept pages', () => {
  const form = acceptInvitePage({
    firmName: 'Example CPA',
    name: 'Jordan Rivera',
    username: 'jordan@rivera-landscaping.example',
    companyNames: ['Rivera Landscaping LLC'],
    minPasswordLength: 8,
  });

  it('asks for a password twice and shows who it is for', () => {
    expect(form).toContain('Welcome, Jordan Rivera');
    expect(form).toContain('Rivera Landscaping LLC');
    expect(form).toContain('value="jordan@rivera-landscaping.example"');
    expect(form.match(/type="password"/g)).toHaveLength(2);
    expect(form).toContain('autocomplete="new-password"');
    expect(form).toMatch(/<form method="POST">/); // posts back to the same link
  });

  it('loads nothing from anywhere else and sends no referrer', () => {
    for (const html of [form, inviteInvalidPage('Example CPA'), inviteAcceptedPage({ firmName: 'Example CPA', username: 'j@x.example', connectorUrl: 'https://q.example/mcp', signInUrl: 'https://q.example' })]) {
      expect(html).toContain('<meta name="referrer" content="no-referrer">');
      expect(html).not.toMatch(/<script/i);
      expect(html).not.toMatch(/(src|href)="https?:\/\//i);
    }
  });

  it('escapes what it shows', () => {
    const hostile = acceptInvitePage({
      firmName: '<b>Firm</b>',
      name: '<script>x</script>',
      username: '"><input name=evil>',
      companyNames: ['A <i>B</i>'],
      minPasswordLength: 8,
      error: '<img src=x onerror=1>',
    });
    for (const fragment of ['<script>x', '<input name=evil', '<img src=x', '<i>B</i>', '<b>Firm</b>']) {
      expect(hostile).not.toContain(fragment);
    }
  });

  it('after accepting, shows the connector address, the username, and both sets of steps — but no password', () => {
    const done = inviteAcceptedPage({
      firmName: 'Example CPA',
      username: 'jordan@rivera-landscaping.example',
      connectorUrl: 'https://qbo.example-cpa.com/mcp',
      signInUrl: 'https://qbo.example-cpa.com',
    });
    expect(done).toContain('https://qbo.example-cpa.com/mcp');
    expect(done).toContain('jordan@rivera-landscaping.example');
    expect(done).toMatch(/Add custom connector/);
    expect(done).toMatch(/Add custom MCP server/);
    expect(done).toContain('The one you just chose');
  });
});

describe('request log redaction', () => {
  it('keeps invitation tokens and API keys out of the log', () => {
    expect(redactUrlForLog('/invite/qboi_abcdef0123456789')).toBe('/invite/[REDACTED]');
    expect(redactUrlForLog('/invite/qboi_abcdef0123456789?utm=x')).toBe('/invite/[REDACTED]?utm=x');
    expect(redactUrlForLog('/mcp?key=qbo_secret&x=1')).toBe('/mcp?key=[REDACTED]&x=1');
    expect(redactUrlForLog('/api/users/7/invite')).toBe('/api/users/7/invite'); // not a token
    expect(redactUrlForLog('/api/me')).toBe('/api/me');
  });
});

describe('ClientInvites.deliver', () => {
  const recipient = { name: 'Jordan Rivera', email: 'jordan@rivera-landscaping.example', username: 'jordan@rivera-landscaping.example' };
  const context = { acceptUrl: ACCEPT_URL, expiresAt: INVITATION.expiresAt, connectorUrl: 'https://qbo.example-cpa.com/mcp', companyNames: ['Rivera Landscaping LLC'] };

  it('sends one email, with the link, from the configured sender', async () => {
    const sender = new FakeSender();
    const delivery = await new ClientInvites(CONFIGURED, sender).deliver(recipient, context);
    expect(delivery).toEqual({ to: recipient.email, sent: true, error: null });
    expect(sender.sent).toHaveLength(1);
    const [email] = sender.sent;
    expect(email.from).toBe('Example CPA <hello@example-cpa.com>');
    expect(email.to).toEqual([recipient.email]);
    expect(email.replyTo).toBe('pat@example-cpa.com');
    expect(email.text).toContain(ACCEPT_URL);
    expect(email.idempotencyKey).toMatch(/^client-invite\/.+/);
  });

  it('a re-send is a new send, never deduplicated against the last one', async () => {
    const sender = new FakeSender();
    const invites = new ClientInvites(CONFIGURED, sender);
    await invites.deliver(recipient, context);
    await invites.deliver(recipient, context);
    expect(new Set(sender.sent.map((e) => e.idempotencyKey)).size).toBe(2);
  });

  it('reports a delivery failure with the provider\'s reason — and never the link', async () => {
    const sender = new FakeSender();
    sender.fail = true;
    const delivery = await new ClientInvites(CONFIGURED, sender).deliver(recipient, context);
    expect(delivery).toMatchObject({ sent: false });
    expect(delivery.error).toContain('domain is not verified');
    expect(JSON.stringify(delivery)).not.toContain('qboi_');
  });

  it('refuses to send unconfigured, and says what is needed', async () => {
    const off = new ClientInvites(disabledInvitesConfig(), null);
    expect(off.enabled).toBe(false);
    expect(off.whyDisabled()).toContain('RESEND_API_KEY and QBO_INVITE_FROM');
    await expect(off.deliver(recipient, context)).rejects.toBeInstanceOf(InvitesNotConfiguredError);
    expect(new ClientInvites(CONFIGURED, null).enabled).toBe(false); // configured but no transport
  });

  it('reports its status without the API key', () => {
    const status = new ClientInvites(CONFIGURED, new FakeSender()).status();
    expect(status).toEqual({
      enabled: true,
      provider: 'resend',
      from: 'Example CPA <hello@example-cpa.com>',
      replyTo: 'pat@example-cpa.com',
      firmName: 'Example CPA',
      missing: [],
      problems: [],
    });
    expect(JSON.stringify(status)).not.toContain('re_test');
  });
});

describe('ResendEmailSender reply-to', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('passes reply_to to Resend when set, and omits it otherwise', async () => {
    const fetchSpy = vi.fn().mockImplementation(async () => new Response(JSON.stringify({ id: 'e1' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);
    const message = { from: 'A <a@example.com>', to: ['b@example.com'], subject: 'S', text: 'T' };
    const sender = new ResendEmailSender('re_secret');
    await sender.send({ ...message, replyTo: 'pat@example.com' });
    await sender.send(message);
    expect(JSON.parse(fetchSpy.mock.calls[0][1].body).reply_to).toBe('pat@example.com');
    expect(JSON.parse(fetchSpy.mock.calls[1][1].body)).not.toHaveProperty('reply_to');
  });
});
