import { describe, it, expect, vi, afterEach } from 'vitest';
import { parseInvitesConfig, disabledInvitesConfig } from '../../src/invites/config.js';
import { renderClientInvitationEmail, renderClientPasswordEmail } from '../../src/invites/templates.js';
import { ClientInvites, InvitesNotConfiguredError } from '../../src/invites/client-invites.js';
import { ResendEmailSender, EmailSendError, type EmailSender, type OutboundEmail } from '../../src/alerts/email.js';
import { generatePassword, MIN_PASSWORD_LENGTH } from '../../src/users.js';

class FakeSender implements EmailSender {
  sent: OutboundEmail[] = [];
  /** Fail the Nth send (1-based), or every send when `always`. */
  failOn: number | 'always' | null = null;
  async send(email: OutboundEmail): Promise<{ id: string }> {
    const n = this.sent.length + 1;
    if (this.failOn === 'always' || this.failOn === n) {
      if (this.failOn !== 'always') this.failOn = null;
      throw new EmailSendError('Resend rejected the email (403): domain is not verified', 403);
    }
    this.sent.push(email);
    return { id: `email_${n}` };
  }
}

const CONFIGURED = parseInvitesConfig({
  RESEND_API_KEY: 're_test',
  QBO_INVITE_FROM: 'Example CPA <hello@example-cpa.com>',
  QBO_INVITE_REPLY_TO: 'pat@example-cpa.com',
});

const INVITATION = {
  firmName: 'Example CPA',
  name: 'Jordan Rivera',
  username: 'jordan.rivera',
  connectorUrl: 'https://qbo.example-cpa.com/mcp',
  signInUrl: 'https://qbo.example-cpa.com',
  companyNames: ['Rivera Landscaping LLC'],
  canReply: true,
};
const PASSWORD = 'Kp7m-Qx4R-Ln9t-Vb2s-Hc6d';

describe('invites config', () => {
  it('is off until there is a key and a sender, and says what is missing', () => {
    expect(disabledInvitesConfig()).toMatchObject({ enabled: false, missing: ['RESEND_API_KEY', 'QBO_INVITE_FROM'], problems: [] });
    expect(parseInvitesConfig({ RESEND_API_KEY: 're_x' })).toMatchObject({ enabled: false, missing: ['QBO_INVITE_FROM'] });
    expect(parseInvitesConfig({ QBO_INVITE_FROM: 'a@b.com' })).toMatchObject({ enabled: false, missing: ['RESEND_API_KEY'] });
  });

  it('takes the firm name from the sender unless one is given', () => {
    expect(CONFIGURED).toMatchObject({ enabled: true, from: 'Example CPA <hello@example-cpa.com>', firmName: 'Example CPA', replyTo: 'pat@example-cpa.com', usingAlertSender: false });
    expect(parseInvitesConfig({ RESEND_API_KEY: 'k', QBO_INVITE_FROM: 'hello@example-cpa.com' }).firmName).toBe('Your accounting firm');
    expect(parseInvitesConfig({ RESEND_API_KEY: 'k', QBO_INVITE_FROM: 'X <a@b.com>', QBO_FIRM_NAME: 'Rivera & Co.' }).firmName).toBe('Rivera & Co.');
  });

  it('falls back to the alert sender, and flags that it did', () => {
    const config = parseInvitesConfig({ RESEND_API_KEY: 'k', QBO_ALERT_FROM: 'QBO Alerts <alerts@example-cpa.com>' });
    expect(config).toMatchObject({ enabled: true, from: 'QBO Alerts <alerts@example-cpa.com>', usingAlertSender: true, replyTo: null });
  });

  it('refuses malformed addresses rather than sending from them', () => {
    expect(parseInvitesConfig({ RESEND_API_KEY: 'k', QBO_INVITE_FROM: 'not an address' })).toMatchObject({ enabled: false });
    const badReply = parseInvitesConfig({ RESEND_API_KEY: 'k', QBO_INVITE_FROM: 'a@b.com', QBO_INVITE_REPLY_TO: 'nope' });
    expect(badReply.enabled).toBe(false);
    expect(badReply.problems[0]).toContain('QBO_INVITE_REPLY_TO');
  });
});

describe('generated passwords', () => {
  it('are long, grouped for reading, and free of look-alike characters', () => {
    for (let i = 0; i < 200; i++) {
      const password = generatePassword();
      expect(password).toMatch(/^([A-HJ-NP-Za-km-z2-9]{4}-){4}[A-HJ-NP-Za-km-z2-9]{4}$/);
      expect(password).not.toMatch(/[0O1lI]/);
      expect(password.length).toBeGreaterThanOrEqual(MIN_PASSWORD_LENGTH);
    }
  });

  it('do not repeat', () => {
    const seen = new Set(Array.from({ length: 2_000 }, () => generatePassword()));
    expect(seen.size).toBe(2_000);
  });
});

describe('invitation and password emails', () => {
  const invitation = renderClientInvitationEmail(INVITATION);
  const password = renderClientPasswordEmail({ firmName: 'Example CPA', name: 'Jordan Rivera', password: PASSWORD, canReply: true });

  it('the invitation says where and who, and how to set up both assistants', () => {
    expect(invitation.subject).toBe('Connect your AI assistant to your QuickBooks data — Example CPA');
    for (const body of [invitation.text, invitation.html]) {
      expect(body).toContain('https://qbo.example-cpa.com/mcp');
      expect(body).toContain('jordan.rivera');
      expect(body).toContain('Rivera Landscaping LLC');
      expect(body).toContain('Jordan Rivera');
      expect(body).toMatch(/separate email/);
      expect(body).toMatch(/Add custom connector/); // Claude
      expect(body).toMatch(/Add custom MCP server/); // ChatGPT
      expect(body).toMatch(/read-only/i);
    }
    expect(invitation.text).toContain('SET IT UP IN CLAUDE');
    expect(invitation.text).toContain('SET IT UP IN CHATGPT');
    expect(invitation.text).not.toContain('**'); // bold markers never leak into plain text
    expect(invitation.html).toContain('<strong>Customize → Connectors</strong>');
  });

  it('the password email carries the password and nothing that says where to use it', () => {
    expect(password.subject).toBe('Your password for the QuickBooks connector — Example CPA');
    for (const body of [password.text, password.html]) {
      expect(body).toContain(PASSWORD);
      expect(body).not.toContain('jordan.rivera');
      expect(body).not.toContain('qbo.example-cpa.com');
      expect(body).not.toContain('/mcp');
      expect(body).not.toMatch(/https?:\/\//);
    }
  });

  it('neither email holds both halves', () => {
    expect(invitation.text + invitation.html).not.toContain(PASSWORD);
  });

  it('escapes everything that comes from the database or the environment', () => {
    const hostile = renderClientInvitationEmail({
      ...INVITATION,
      firmName: 'A & B <CPAs>',
      name: '<script>alert(1)</script>',
      username: 'x"><img src=x>',
      companyNames: ['Smith & Sons <LLC>'],
    });
    expect(hostile.html).not.toContain('<script>');
    expect(hostile.html).not.toContain('<img');
    expect(hostile.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(hostile.html).toContain('Smith &amp; Sons &lt;LLC&gt;');
    expect(hostile.text).toContain('Smith & Sons <LLC>'); // plain text stays plain

    const secret = renderClientPasswordEmail({ firmName: 'A & B', name: '<b>x</b>', password: 'a<b>&c', canReply: false });
    expect(secret.html).toContain('a&lt;b&gt;&amp;c');
    expect(secret.html).not.toContain('<b>x</b>');
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

describe('ClientInvites.deliver', () => {
  const recipient = { name: 'Jordan Rivera', email: 'jordan@rivera-landscaping.example', username: 'jordan.rivera' };
  const context = { connectorUrl: 'https://qbo.example-cpa.com/mcp', signInUrl: 'https://qbo.example-cpa.com', companyNames: ['Rivera Landscaping LLC'] };

  it('sends the invitation, then the password, as two separate emails', async () => {
    const sender = new FakeSender();
    const outcome = await new ClientInvites(CONFIGURED, sender).deliver(recipient, PASSWORD, context);
    expect(outcome).toEqual({ to: recipient.email, sent: true, invitationSent: true, passwordSent: true, error: null });
    expect(sender.sent).toHaveLength(2);
    const [first, second] = sender.sent;
    for (const email of sender.sent) {
      expect(email.from).toBe('Example CPA <hello@example-cpa.com>');
      expect(email.to).toEqual([recipient.email]);
      expect(email.replyTo).toBe('pat@example-cpa.com');
    }
    expect(first.subject).toContain('Connect your AI assistant');
    expect(first.text).toContain('jordan.rivera');
    expect(first.text).not.toContain(PASSWORD);
    expect(second.subject).toContain('Your password');
    expect(second.text).toContain(PASSWORD);
    expect(second.text).not.toContain('jordan.rivera');
    // Distinct idempotency keys, sharing one attempt id.
    expect(first.idempotencyKey).toMatch(/^client-invite\/.+\/invitation$/);
    expect(second.idempotencyKey).toBe(first.idempotencyKey!.replace(/invitation$/, 'password'));
  });

  it('a re-send is a new attempt, never deduplicated against the last one', async () => {
    const sender = new FakeSender();
    const invites = new ClientInvites(CONFIGURED, sender);
    await invites.deliver(recipient, PASSWORD, context);
    await invites.deliver(recipient, PASSWORD, context);
    expect(new Set(sender.sent.map((e) => e.idempotencyKey)).size).toBe(4);
  });

  it('does not send the password when the invitation fails', async () => {
    const sender = new FakeSender();
    sender.failOn = 1;
    const outcome = await new ClientInvites(CONFIGURED, sender).deliver(recipient, PASSWORD, context);
    expect(outcome).toMatchObject({ sent: false, invitationSent: false, passwordSent: false });
    expect(outcome.error).toContain('invitation email could not be sent');
    expect(outcome.error).toContain('domain is not verified');
    expect(sender.sent).toHaveLength(0);
  });

  it('reports a password email that fails after the invitation went out', async () => {
    const sender = new FakeSender();
    sender.failOn = 2;
    const outcome = await new ClientInvites(CONFIGURED, sender).deliver(recipient, PASSWORD, context);
    expect(outcome).toMatchObject({ sent: false, invitationSent: true, passwordSent: false });
    expect(outcome.error).toContain('password email could not be');
    expect(JSON.stringify(outcome)).not.toContain(PASSWORD);
  });

  it('refuses to run unconfigured, and says what is needed', async () => {
    const off = new ClientInvites(disabledInvitesConfig(), null);
    expect(off.enabled).toBe(false);
    expect(off.whyDisabled()).toContain('RESEND_API_KEY and QBO_INVITE_FROM');
    await expect(off.deliver(recipient, PASSWORD, context)).rejects.toBeInstanceOf(InvitesNotConfiguredError);
    // Configured but with no transport is also off.
    expect(new ClientInvites(CONFIGURED, null).enabled).toBe(false);
  });

  it('reports its status without the API key', () => {
    const status = new ClientInvites(CONFIGURED, new FakeSender()).status();
    expect(status).toEqual({
      enabled: true,
      provider: 'resend',
      from: 'Example CPA <hello@example-cpa.com>',
      usingAlertSender: false,
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
