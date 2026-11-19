import { describe, it, expect, vi, afterEach } from 'vitest';
import { parseInvitesConfig, disabledInvitesConfig } from '../../src/invites/config.js';
import { renderClientInvitationEmail } from '../../src/invites/templates.js';
import { ClientInvites, InvitesNotConfiguredError } from '../../src/invites/client-invites.js';
import { acceptInvitePage, inviteAcceptedPage, inviteInvalidPage } from '../../src/server/invite-pages.js';
import { redactUrlForLog } from '../../src/server/log-redaction.js';
import { ResendEmailSender, EmailSendError, type EmailSender, type OutboundEmail } from '../../src/alerts/email.js';
import { isValidUsername } from '../../src/users.js';
import { APP_NAME, cleanFirmName, cleanVideoUrl, senderWithFirmName, videoEmbedUrl, type FirmBrand } from '../../src/branding.js';

const FIRM: FirmBrand = { name: 'Example CPA', configured: true, source: 'dashboard', displayName: 'Example CPA' };
const NO_FIRM: FirmBrand = { name: 'Your accounting firm', configured: false, source: 'default', displayName: APP_NAME };

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
    // Anything a mail server would deliver to is fine, odd characters included.
    for (const ok of ["o'brien@example.com", 'a&b@example.com', 'first.last!#$%@example.co.uk']) {
      expect(isValidUsername(ok), ok).toBe(true);
    }
    for (const bad of ['a b@example.com', 'ab', `${'x'.repeat(250)}@example.com`, '<x>@example.com', 'Upper@example.com', "o'brien", "o'brien@localhost"]) {
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
    firm: FIRM,
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

  it('is in the firm\'s name: the firm is the brand, the app gets the small print', () => {
    for (const html of [form, inviteInvalidPage(FIRM), inviteAcceptedPage({ firm: FIRM, username: 'j@x.example', connectorUrl: 'https://q.example/mcp', signInUrl: 'https://q.example' })]) {
      expect(html).toContain('<span class="brand-name">Example CPA</span>');
      expect(html).toMatch(/<title>[^<]+ — Example CPA<\/title>/);
      expect(html).toContain(`Secure access from Example CPA, provided through ${APP_NAME}.`);
      // The app's name appears in that one credit line and nowhere else.
      expect(html.split(APP_NAME)).toHaveLength(2);
    }
  });

  it('falls back to the app\'s name until a firm name is set', () => {
    const page = acceptInvitePage({ firm: NO_FIRM, name: 'Jordan', username: 'j@x.example', companyNames: [], minPasswordLength: 8 });
    expect(page).toContain(`<span class="brand-name">${APP_NAME}</span>`);
    expect(page).toContain('<strong>Your accounting firm</strong> has invited you');
    expect(page).not.toContain('provided through');
  });

  it('loads nothing from anywhere else and sends no referrer', () => {
    for (const html of [form, inviteInvalidPage(FIRM), inviteAcceptedPage({ firm: FIRM, username: 'j@x.example', connectorUrl: 'https://q.example/mcp', signInUrl: 'https://q.example' })]) {
      expect(html).toContain('<meta name="referrer" content="no-referrer">');
      expect(html).not.toMatch(/<script/i);
      expect(html).not.toMatch(/(src|href)="https?:\/\//i);
    }
  });

  it('escapes what it shows', () => {
    const hostile = acceptInvitePage({
      firm: { name: '<b>Firm</b>', configured: true, source: 'environment', displayName: '<b>Firm</b>' },
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
      firm: FIRM,
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

describe('firm name', () => {
  it('is cleaned up to something safe for a subject line and a From header', () => {
    expect(cleanFirmName('  David   Example\tCPA LLC ')).toBe('David Example CPA LLC');
    expect(cleanFirmName("O'Neil & Sons, P.C.")).toBe("O'Neil & Sons, P.C.");
    for (const bad of ['', '   ', 'x'.repeat(101), 'Firm <evil@example.com>', 'Line\u0000break', 42, null]) {
      expect(() => cleanFirmName(bad as any), JSON.stringify(bad)).toThrow();
    }
    // A newline can't smuggle a second header in: whitespace collapses to one space.
    expect(cleanFirmName('Firm\r\nBcc: x@example.com')).toBe('Firm Bcc: x@example.com');
  });

  it('is added to a bare sender address; a name set in the dashboard also replaces the sender\'s own', () => {
    const fromEnv: FirmBrand = { ...FIRM, source: 'environment' };
    expect(senderWithFirmName('hello@example-cpa.com', FIRM)).toBe('"Example CPA" <hello@example-cpa.com>');
    expect(senderWithFirmName('hello@example-cpa.com', fromEnv)).toBe('"Example CPA" <hello@example-cpa.com>');
    // Both written in the server settings: the sender stays as written.
    expect(senderWithFirmName('Someone Else <hello@example-cpa.com>', fromEnv)).toBe('Someone Else <hello@example-cpa.com>');
    // Chosen in the dashboard: the inbox shows the same name as the subject.
    expect(senderWithFirmName('Someone Else <hello@example-cpa.com>', FIRM)).toBe('"Example CPA" <hello@example-cpa.com>');
    expect(senderWithFirmName('"Quoted, Name" <hello@example-cpa.com>', FIRM)).toBe('"Example CPA" <hello@example-cpa.com>');
    expect(senderWithFirmName('Example CPA <hello@example-cpa.com>', FIRM)).toBe('Example CPA <hello@example-cpa.com>'); // already right
    expect(senderWithFirmName('<hello@example-cpa.com>', fromEnv)).toBe('"Example CPA" <hello@example-cpa.com>');
    expect(senderWithFirmName('Someone Else <hello@example-cpa.com>', NO_FIRM)).toBe('Someone Else <hello@example-cpa.com>');
    expect(senderWithFirmName('hello@example-cpa.com', NO_FIRM)).toBe('hello@example-cpa.com');
    const quoted: FirmBrand = { ...FIRM, name: 'The "Best" CPA \\ Co' };
    expect(senderWithFirmName('a@b.com', quoted)).toBe('"The Best CPA  Co" <a@b.com>');
  });

  it('records where the configured name came from', () => {
    expect(parseInvitesConfig({ QBO_FIRM_NAME: 'Env Firm', QBO_INVITE_FROM: 'Sender Firm <a@b.com>' })).toMatchObject({ firmName: 'Env Firm', firmNameSource: 'environment' });
    expect(parseInvitesConfig({ QBO_INVITE_FROM: 'Sender Firm <a@b.com>' })).toMatchObject({ firmName: 'Sender Firm', firmNameSource: 'sender' });
    expect(parseInvitesConfig({})).toMatchObject({ firmName: 'Your accounting firm', firmNameSource: 'default' });
    // The environment's name is held to the same shape as the dashboard's.
    expect(parseInvitesConfig({ QBO_FIRM_NAME: '  Env\tFirm\n<b> ' }).firmName).toBe('Env Firm b');
    expect(parseInvitesConfig({ QBO_FIRM_NAME: 'x'.repeat(300) }).firmName).toHaveLength(100);
    expect(parseInvitesConfig({ QBO_FIRM_NAME: ' \t ' })).toMatchObject({ firmNameSource: 'default' });
  });
});

describe('setup walkthrough video', () => {
  const LOOM = 'https://www.loom.com/share/0123456789abcdef0123456789abcdef';
  const EMBED = 'https://www.loom.com/embed/0123456789abcdef0123456789abcdef';

  it('accepts an https link and nothing else', () => {
    expect(cleanVideoUrl(`  ${LOOM}?sid=abc  `)).toBe(`${LOOM}?sid=abc`);
    expect(cleanVideoUrl('https://example.com/videos/setup')).toBe('https://example.com/videos/setup');
    // The limit applies to the link as stored, after it is normalised.
    expect(() => cleanVideoUrl(`https://example.com/${'é'.repeat(200)}`)).toThrow(/at most 500/);
    for (const bad of ['http://www.loom.com/share/abc12345', 'javascript:alert(1)', 'loom.com/share/abc', 'not a link', 'https://user:pw@example.com/v', `https://example.com/${'x'.repeat(500)}`, 7, null]) {
      expect(() => cleanVideoUrl(bad as any), JSON.stringify(bad)).toThrow();
    }
  });

  it('only ever embeds Loom, from its share or embed link', () => {
    expect(videoEmbedUrl(LOOM)).toBe(EMBED);
    expect(videoEmbedUrl(`${LOOM}?sid=1234-abcd`)).toBe(EMBED);
    expect(videoEmbedUrl(EMBED)).toBe(EMBED);
    expect(videoEmbedUrl('https://loom.com/share/0123456789abcdef')).toBe('https://www.loom.com/embed/0123456789abcdef');
    for (const link of [
      'https://example.com/share/0123456789abcdef',
      'https://www.loom.com.evil.example/share/0123456789abcdef',
      'https://evil.example/?x=https://www.loom.com/share/0123456789abcdef',
      'https://www.loom.com/share/../../login',
      'https://www.loom.com/looms/videos',
      'https://www.youtube.com/watch?v=abc',
      'nonsense',
    ]) {
      expect(videoEmbedUrl(link), link).toBeNull();
    }
  });

  it('plays on the page after the password is set, never on the page with the password form', () => {
    const done = inviteAcceptedPage({ firm: FIRM, username: 'j@x.example', connectorUrl: 'https://q.example/mcp', signInUrl: 'https://q.example', video: { url: LOOM, embedUrl: EMBED } });
    expect(done).toContain(`<iframe src="${EMBED}"`);
    expect(done).toContain('referrerpolicy="no-referrer"');
    expect(done).toContain('sandbox="allow-scripts allow-same-origin allow-presentation allow-popups"');
    expect(done).toContain(`href="${LOOM}"`); // and a plain link, in case the player is blocked
    expect(done).not.toMatch(/<script/i);
    // Before the video, the things they need; after it, the written steps.
    expect(done.indexOf('Connector address')).toBeLessThan(done.indexOf('<iframe'));
    expect(done.indexOf('<iframe')).toBeLessThan(done.indexOf('<h2>In Claude</h2>'));

    const form = acceptInvitePage({ firm: FIRM, name: 'J', username: 'j@x.example', companyNames: [], minPasswordLength: 8 });
    expect(form).not.toContain('<iframe');
    expect(form).not.toMatch(/(src|href)="https?:\/\//i);
  });

  it('is only linked when it is not a Loom video, and absent when there is none', () => {
    const other = inviteAcceptedPage({ firm: FIRM, username: 'j@x.example', connectorUrl: 'https://q.example/mcp', signInUrl: 'https://q.example', video: { url: 'https://example.com/v/setup', embedUrl: null } });
    expect(other).not.toContain('<iframe');
    expect(other).toContain('href="https://example.com/v/setup"');
    expect(other).toContain('rel="noopener noreferrer"');
    const none = inviteAcceptedPage({ firm: FIRM, username: 'j@x.example', connectorUrl: 'https://q.example/mcp', signInUrl: 'https://q.example' });
    expect(none).not.toContain('Watch');
    expect(none).not.toContain('<iframe');
  });

  it('is linked from the invitation email, and escaped', () => {
    const withVideo = renderClientInvitationEmail({ ...INVITATION, videoUrl: `${LOOM}?a=1&b=2` });
    expect(withVideo.text).toContain(`Prefer to watch? This short video walks through it: ${LOOM}?a=1&b=2`);
    expect(withVideo.html).toContain(`href="${LOOM}?a=1&amp;b=2"`);
    expect(renderClientInvitationEmail(INVITATION).text).not.toContain('Prefer to watch');
    expect(renderClientInvitationEmail({ ...INVITATION, videoUrl: null }).html).not.toContain('Watch the walkthrough');
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
  const context = { acceptUrl: ACCEPT_URL, expiresAt: INVITATION.expiresAt, connectorUrl: 'https://qbo.example-cpa.com/mcp', companyNames: ['Rivera Landscaping LLC'], firm: FIRM };

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

  it('goes out in the firm\'s name, whatever the firm is called', async () => {
    const sender = new FakeSender();
    const bareSender = parseInvitesConfig({ RESEND_API_KEY: 'k', QBO_INVITE_FROM: 'hello@example-cpa.com' });
    const firm: FirmBrand = { name: 'Rivera & Stone CPA LLC', configured: true, source: 'dashboard', displayName: 'Rivera & Stone CPA LLC' };
    await new ClientInvites(bareSender, sender).deliver(recipient, { ...context, firm });
    const [email] = sender.sent;
    expect(email.from).toBe('"Rivera & Stone CPA LLC" <hello@example-cpa.com>'); // a bare address gains the firm's name
    expect(email.subject).toBe('Rivera & Stone CPA LLC invited you to connect your AI assistant to QuickBooks');
    expect(email.text).toContain('Rivera & Stone CPA LLC has set up a secure, read-only connection');
    expect(email.text).not.toContain(APP_NAME);
    expect(email.html).not.toContain(APP_NAME);
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
