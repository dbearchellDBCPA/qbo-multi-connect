import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { QBOManager } from '../../src/index.js';
import { parseInvitesConfig, disabledInvitesConfig, type InvitesConfig } from '../../src/invites/config.js';
import { EmailSendError, type EmailSender, type OutboundEmail } from '../../src/alerts/email.js';
import { usersRoutes } from '../../src/server/routes/users.js';
import { authRoutes } from '../../src/server/routes/auth.js';
import { alertsRoutes } from '../../src/server/routes/alerts.js';
import { oauthRoutes } from '../../src/server/routes/oauth.js';
import { inviteAcceptRoutes } from '../../src/server/routes/invite-accept.js';
import { registerMcpRoutes } from '../../src/server/mcp.js';
import { INVITE_TTL_MS, MAX_LOGIN_FAILURES } from '../../src/users.js';

// Inviting a client: the admin gives a name and an email address; the client
// gets a link, chooses their own password on a page served by this server,
// and that password is what they sign in to the connector with. These tests
// follow that end to end, and check the link behaves like the credential it is.

const ENCRYPTION_KEY = 'a'.repeat(64);
const MASTER_KEY = 'master-key-for-tests';
const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';
const HOST = { host: 'qbo.example-cpa.com', 'x-forwarded-proto': 'https' };
const asMaster = { ...HOST, authorization: `Bearer ${MASTER_KEY}` };
const EMAIL = 'jordan@rivera-landscaping.example';
const CHOSEN = 'correct horse battery staple';
const LINK_RE = /https:\/\/qbo\.example-cpa\.com\/invite\/(qboi_[0-9a-f]{64})/;

const CONFIGURED = parseInvitesConfig({
  RESEND_API_KEY: 're_test',
  QBO_INVITE_FROM: 'Example CPA <hello@example-cpa.com>',
  QBO_INVITE_REPLY_TO: 'pat@example-cpa.com',
});

class FakeSender implements EmailSender {
  sent: OutboundEmail[] = [];
  fail = false;
  async send(email: OutboundEmail): Promise<{ id: string }> {
    if (this.fail) throw new EmailSendError('Resend rejected the email (403): domain is not verified', 403);
    this.sent.push(email);
    return { id: `email_${this.sent.length}` };
  }
  /** The path of the link in the newest invitation, as the client would click it. */
  lastLinkPath(): string {
    return `/invite/${this.sent[this.sent.length - 1].text.match(LINK_RE)![1]}`;
  }
}

describe('inviting a client by link', () => {
  let qbo: QBOManager;
  let app: FastifyInstance;
  let sender: FakeSender;

  async function build(config: InvitesConfig = CONFIGURED): Promise<void> {
    sender = new FakeSender();
    qbo = new QBOManager({ dbPath: ':memory:', encryptionKey: ENCRYPTION_KEY, invites: config, emailSender: sender });
    for (const [clientName, realmId] of [['Rivera Landscaping LLC', 'realm-1'], ['Other Client Inc', 'realm-2']]) {
      await (qbo as any).tokenStore.storeConnection({
        clientName,
        realmId,
        accessToken: 'a',
        refreshToken: 'r',
        tokenExpiry: new Date(Date.now() + 3600e3),
        refreshExpiry: new Date(Date.now() + 90 * 864e5),
        scopes: ['x'],
      });
    }
    app = Fastify({ logger: false });
    await authRoutes(app, qbo, MASTER_KEY);
    await usersRoutes(app, qbo, MASTER_KEY);
    await alertsRoutes(app, qbo, MASTER_KEY);
    await inviteAcceptRoutes(app, qbo); // before OAuth on purpose: either order must work
    await oauthRoutes(app, qbo);
    await registerMcpRoutes(app, qbo, MASTER_KEY);
    await app.ready();
  }

  beforeEach(() => build());
  afterEach(async () => {
    vi.useRealTimers();
    await app.close();
    await qbo.close();
  });

  // The whole request an admin makes: a name, an email, and whose books.
  const INVITE = { name: 'Jordan Rivera', email: EMAIL, accountType: 'client', clients: [{ realmId: 'realm-1' }], sendInvite: true };
  const invite = (overrides: Record<string, unknown> = {}) =>
    app.inject({ method: 'POST', url: '/api/users', headers: asMaster, payload: { ...INVITE, ...overrides } });
  const reinvite = (id: number | string, headers: Record<string, string> = asMaster) =>
    app.inject({ method: 'POST', url: `/api/users/${id}/invite`, headers });
  const openLink = (path: string) => app.inject({ method: 'GET', url: path, headers: HOST });
  const accept = (path: string, password = CHOSEN, confirm = password) =>
    app.inject({ method: 'POST', url: path, headers: { ...HOST, 'content-type': 'application/x-www-form-urlencoded' }, payload: new URLSearchParams({ password, confirm }).toString() });

  /** Sign in through the connector the way an AI assistant would. Returns the access token, or null. */
  async function connectorSignIn(username: string, password: string): Promise<string | null> {
    const client = (await app.inject({ method: 'POST', url: '/oauth/register', headers: HOST, payload: { client_name: 'Claude', redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none' } })).json();
    const verifier = randomBytes(32).toString('base64url');
    const authorize = await app.inject({
      method: 'POST',
      url: '/oauth/authorize',
      headers: HOST,
      payload: { client_id: client.client_id, redirect_uri: REDIRECT, response_type: 'code', code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', state: 's', username, password },
    });
    if (authorize.statusCode !== 302) return null;
    const code = new URL(authorize.headers.location as string).searchParams.get('code')!;
    const token = await app.inject({ method: 'POST', url: '/oauth/token', headers: HOST, payload: { grant_type: 'authorization_code', client_id: client.client_id, code, code_verifier: verifier, redirect_uri: REDIRECT } });
    return token.json().access_token;
  }
  const tokenWorks = async (token: string) => (await qbo.oauth.verifyAccessToken(token)) !== null;

  // ── The invitation ─────────────────────────────────────────────────────────

  it('needs only a name, an email and a company: the email becomes the username', async () => {
    const res = await invite();
    expect(res.statusCode).toBe(201);
    const { user, apiKey, invite: result } = res.json();
    expect(apiKey).toBeNull();
    expect(user).toMatchObject({ accountType: 'client', username: EMAIL, email: EMAIL, hasPassword: false, accessLevel: 'read' });
    expect(user.clients).toEqual([{ realmId: 'realm-1', clientName: 'Rivera Landscaping LLC', accessLevel: 'read', effectiveAccessLevel: 'read' }]);
    expect(result).toMatchObject({ to: EMAIL, sent: true, error: null });
    expect(new Date(result.expiresAt).getTime()).toBeGreaterThan(Date.now() + INVITE_TTL_MS - 60_000);
    expect(new Date(user.inviteExpiresAt).getTime()).toBeGreaterThan(Date.now());
    expect(user.inviteAcceptedAt).toBeNull();

    expect(sender.sent).toHaveLength(1);
    const [email] = sender.sent;
    expect(email.to).toEqual([EMAIL]);
    expect(email.from).toBe('Example CPA <hello@example-cpa.com>');
    expect(email.text).toMatch(LINK_RE);
    expect(email.text).toContain('Connector address: https://qbo.example-cpa.com/mcp');
    expect(email.text).toContain(`Your username: ${EMAIL}`);
    expect(email.text).toContain('Rivera Landscaping LLC');
  });

  it('the link exists in the email and nowhere else', async () => {
    const res = await invite();
    const token = sender.lastLinkPath().split('/').pop()!;
    expect(res.json().invite.link).toBeUndefined();
    expect(res.body).not.toContain(token);
    const everywhere = JSON.stringify([
      (await app.inject({ method: 'GET', url: '/api/users', headers: asMaster })).json(),
      await qbo.activity.list(),
      (qbo as any).db.db.prepare('SELECT * FROM users').all(), // only its hash is stored
    ]);
    expect(everywhere).not.toContain(token);
  });

  it('cannot be signed in to until the invitation is accepted', async () => {
    await invite();
    for (const guess of ['', ' ', 'password', EMAIL]) {
      expect(await connectorSignIn(EMAIL, guess)).toBeNull();
    }
  });

  it('normalizes the email into the username, and takes an explicit username when given one', async () => {
    const mixed = (await invite({ email: 'Jordan.Rivera@Rivera-Landscaping.EXAMPLE' })).json().user;
    expect(mixed.username).toBe('jordan.rivera@rivera-landscaping.example');
    const named = (await invite({ email: 'sam@rivera-landscaping.example', username: 'sam.rivera' })).json().user;
    expect(named.username).toBe('sam.rivera');
    const plus = (await invite({ email: 'pat+books@rivera-landscaping.example' })).json().user;
    expect(plus.username).toBe('pat+books@rivera-landscaping.example');
  });

  it('refuses an invitation that makes no sense, before creating anything', async () => {
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{ accountType: 'staff' }, /client logins/],
      [{ accountType: undefined }, /client logins/],
      [{ email: null }, /valid email address/],
      [{ email: 'not-an-address' }, /valid email address/],
      [{ email: "o'brien@example.com" }, /can't be used as a username/],
      [{ password: 'they-typed-one-too' }, /leave password out/],
      [{ clients: [] }, /Assign a company/],
      [{ clients: undefined }, /Assign a company/],
      [{ sendInvite: 'yes' }, /true or false/],
    ];
    for (const [overrides, message] of cases) {
      const res = await invite(overrides);
      expect(res.statusCode, JSON.stringify(overrides)).toBe(400);
      expect(res.json().message).toMatch(message);
    }
    expect(await qbo.users.list()).toEqual([]);
    expect(sender.sent).toEqual([]);
  });

  it('says so when that email already has a login', async () => {
    await invite();
    const again = await invite();
    expect(again.statusCode).toBe(400);
    expect(again.json().message).toMatch(/already taken/);
    expect(sender.sent).toHaveLength(1);
  });

  // ── Accepting it ───────────────────────────────────────────────────────────

  it('the link opens a page to choose a password, and that password connects the assistant', async () => {
    const id = (await invite()).json().user.id;
    const link = sender.lastLinkPath();

    const page = await openLink(link);
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('Welcome, Jordan Rivera');
    expect(page.body).toContain('Rivera Landscaping LLC');
    expect(page.body).toContain(`value="${EMAIL}"`);
    expect(page.body).toContain('Example CPA');

    const done = await accept(link);
    expect(done.statusCode).toBe(200);
    expect(done.body).toContain('Your password is set');
    expect(done.body).toContain('https://qbo.example-cpa.com/mcp');
    expect(done.body).toContain(EMAIL);
    expect(done.body).not.toContain(CHOSEN); // never echoed back

    const user = (await qbo.users.get(id))!;
    expect(user.hasPassword).toBe(true);
    expect(user.inviteExpiresAt).toBeNull();
    expect(user.inviteAcceptedAt!.getTime()).toBeGreaterThan(Date.now() - 60_000);

    // The one place the password is used: the connector's sign-in page.
    const token = await connectorSignIn(EMAIL, CHOSEN);
    expect(token).toBeTruthy();
    expect(await connectorSignIn(EMAIL, 'something else entirely')).toBeNull();
    // …and it reaches their own company, read-only, and nothing else.
    const scope = (await qbo.users.get(id))!;
    expect(scope.realmIds).toEqual(['realm-1']);
  });

  it('opening the link does not use it up (mail scanners open links first)', async () => {
    await invite();
    const link = sender.lastLinkPath();
    for (let i = 0; i < 5; i++) expect((await openLink(link)).statusCode).toBe(200);
    expect((await app.inject({ method: 'HEAD', url: link, headers: HOST })).statusCode).toBeLessThan(500);
    expect((await accept(link)).statusCode).toBe(200);
  });

  it('works once', async () => {
    await invite();
    const link = sender.lastLinkPath();
    expect((await accept(link)).statusCode).toBe(200);

    const reopened = await openLink(link);
    expect(reopened.statusCode).toBe(410);
    expect(reopened.body).toContain("can't be used");
    // Someone who finds the email later cannot change the password with it.
    expect((await accept(link, 'an attacker chose this one')).statusCode).toBe(410);
    expect(await connectorSignIn(EMAIL, 'an attacker chose this one')).toBeNull();
    expect(await connectorSignIn(EMAIL, CHOSEN)).toBeTruthy();
  });

  it('two submissions of the same link at once set exactly one password', async () => {
    await invite();
    const link = sender.lastLinkPath();
    const [a, b] = await Promise.all([accept(link, 'first password here'), accept(link, 'second password here')]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 410]);
    const worked = [await connectorSignIn(EMAIL, 'first password here'), await connectorSignIn(EMAIL, 'second password here')].filter(Boolean);
    expect(worked).toHaveLength(1);
  });

  it('expires', async () => {
    await invite();
    const link = sender.lastLinkPath();
    (qbo as any).db.db.prepare("UPDATE users SET invite_expires_at = datetime('now', '-1 minute')").run();
    expect((await openLink(link)).statusCode).toBe(410);
    expect((await accept(link)).statusCode).toBe(410);
    expect(await connectorSignIn(EMAIL, CHOSEN)).toBeNull();
  });

  it('rejects links that were never issued, without saying anything useful', async () => {
    await invite();
    for (const path of ['/invite/qboi_' + '0'.repeat(64), '/invite/nonsense', '/invite/qboi_', `/invite/${'x'.repeat(5000)}`]) {
      const res = await openLink(path);
      // 410 from the route; an absurdly long one never reaches it (404).
      expect([404, 410], path.slice(0, 30)).toContain(res.statusCode);
      expect(res.body).not.toContain('Jordan');
      expect([404, 410]).toContain((await accept(path)).statusCode);
    }
    expect((await openLink('/invite/qboi_' + '0'.repeat(64))).statusCode).toBe(410);
  });

  it('holds the person to a usable password, and keeps the link good while they retry', async () => {
    await invite();
    const link = sender.lastLinkPath();
    const mismatch = await accept(link, CHOSEN, 'not the same thing');
    expect(mismatch.statusCode).toBe(400);
    expect(mismatch.body).toMatch(/not the same/);
    const short = await accept(link, 'short');
    expect(short.statusCode).toBe(400);
    expect(short.body).toMatch(/at least 8 characters/);
    expect((await accept(link, 'x'.repeat(300))).statusCode).toBe(400);
    const empty = await app.inject({ method: 'POST', url: link, headers: { ...HOST, 'content-type': 'application/x-www-form-urlencoded' }, payload: '' });
    expect(empty.statusCode).toBe(400);
    // None of that consumed the link or set anything.
    expect((await qbo.users.list())[0].hasPassword).toBe(false);
    expect((await accept(link)).statusCode).toBe(200);
  });

  it('serves the pages so the link cannot leak: no caching, no referrer, no framing', async () => {
    await invite();
    const link = sender.lastLinkPath();
    for (const res of [await openLink(link), await openLink('/invite/nope'), await accept(link)]) {
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.headers['referrer-policy']).toBe('no-referrer');
      expect(res.headers['x-frame-options']).toBe('DENY');
      expect(res.headers['content-type']).toContain('text/html');
      expect(res.body).not.toMatch(/<script/i);
    }
  });

  it('a disabled login\'s link does not work, even if it is re-enabled', async () => {
    const id = (await invite()).json().user.id;
    const link = sender.lastLinkPath();
    await app.inject({ method: 'PATCH', url: `/api/users/${id}`, headers: asMaster, payload: { status: 'disabled' } });
    expect((await openLink(link)).statusCode).toBe(410);
    await app.inject({ method: 'PATCH', url: `/api/users/${id}`, headers: asMaster, payload: { status: 'active' } });
    expect((await accept(link)).statusCode).toBe(410);
  });

  it('correcting the email address kills the link that went to the wrong one', async () => {
    const id = (await invite({ email: 'jordon@rivera-landscaping.example' })).json().user.id; // typo
    const wrongInbox = sender.lastLinkPath();
    await app.inject({ method: 'PATCH', url: `/api/users/${id}`, headers: asMaster, payload: { email: EMAIL, username: EMAIL } });
    expect((await accept(wrongInbox, 'the wrong person chose this')).statusCode).toBe(410);

    expect((await reinvite(id)).json().invite).toMatchObject({ to: EMAIL, sent: true });
    expect(sender.sent[1].to).toEqual([EMAIL]);
    expect((await accept(sender.lastLinkPath())).statusCode).toBe(200);
    expect(await connectorSignIn(EMAIL, CHOSEN)).toBeTruthy();
  });

  it('an admin choosing the password directly withdraws the link', async () => {
    const id = (await invite()).json().user.id;
    const link = sender.lastLinkPath();
    await app.inject({ method: 'POST', url: `/api/users/${id}/password`, headers: asMaster, payload: { password: 'admin-chose-this-1' } });
    expect((await accept(link)).statusCode).toBe(410);
    expect(await connectorSignIn(EMAIL, 'admin-chose-this-1')).toBeTruthy();
  });

  // ── Inviting again (also: "I forgot my password") ──────────────────────────

  it('a new invitation replaces the old link, and the old password works until it is accepted', async () => {
    const id = (await invite()).json().user.id;
    const firstLink = sender.lastLinkPath();
    await accept(firstLink);
    const connected = (await connectorSignIn(EMAIL, CHOSEN))!;

    const res = await reinvite(id);
    expect(res.statusCode).toBe(200);
    expect(res.json().invite).toMatchObject({ to: EMAIL, sent: true });
    expect(res.json().invite.link).toBeUndefined();
    const secondLink = sender.lastLinkPath();
    expect(secondLink).not.toBe(firstLink);

    // Nothing has changed for the client yet.
    expect(await tokenWorks(connected)).toBe(true);
    expect(await connectorSignIn(EMAIL, CHOSEN)).toBeTruthy();

    // They accept: new password in, old password and old connections out.
    expect((await accept(secondLink, 'a brand new passphrase')).statusCode).toBe(200);
    expect(await tokenWorks(connected)).toBe(false);
    expect(await connectorSignIn(EMAIL, CHOSEN)).toBeNull();
    expect(await connectorSignIn(EMAIL, 'a brand new passphrase')).toBeTruthy();
  });

  it('each new invitation retires the one before it', async () => {
    const id = (await invite()).json().user.id;
    const first = sender.lastLinkPath();
    await reinvite(id);
    const second = sender.lastLinkPath();
    expect((await openLink(first)).statusCode).toBe(410);
    expect((await openLink(second)).statusCode).toBe(200);
  });

  it('accepting a new invitation lets a locked-out client straight back in', async () => {
    const id = (await invite()).json().user.id;
    await accept(sender.lastLinkPath());
    for (let i = 0; i <= MAX_LOGIN_FAILURES; i++) await connectorSignIn(EMAIL, 'wrong-password');
    expect(await connectorSignIn(EMAIL, CHOSEN)).toBeNull(); // locked
    await reinvite(id);
    await accept(sender.lastLinkPath(), 'a brand new passphrase');
    expect(await connectorSignIn(EMAIL, 'a brand new passphrase')).toBeTruthy();
  });

  it('sends one invitation per login at a time', async () => {
    const id = (await invite()).json().user.id;
    const [a, b] = await Promise.all([reinvite(id), reinvite(id)]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 409]);
    expect(sender.sent).toHaveLength(2); // the first invitation + exactly one more
    expect((await openLink(sender.lastLinkPath())).statusCode).toBe(200); // and its link is live
    expect((await reinvite(id)).statusCode).toBe(200);
  });

  it('only invites logins it makes sense to invite', async () => {
    const staff = (await qbo.users.create({ name: 'Staff', email: 'staff@example-cpa.com', username: 'staff', password: 'a-typed-password-1' })).user;
    const noEmail = (await qbo.users.create({ name: 'No Email', accountType: 'client', username: 'no.email', password: 'a-typed-password-1', realmIds: ['realm-1'] })).user;
    const noCompany = (await qbo.users.create({ name: 'No Company', email: 'nc@example.com', accountType: 'client', username: 'no.company', password: 'a-typed-password-1' })).user;
    const disabled = (await invite()).json().user;
    await qbo.users.update(disabled.id, { status: 'disabled' });
    sender.sent.length = 0;

    expect((await reinvite(staff.id)).json().message).toMatch(/client logins/);
    expect((await reinvite(noEmail.id)).json().message).toMatch(/valid email address/);
    expect((await reinvite(noCompany.id)).json().message).toMatch(/Assign a company/);
    expect((await reinvite(disabled.id)).json().message).toMatch(/disabled/);
    for (const id of [staff.id, noEmail.id, noCompany.id, disabled.id]) expect((await reinvite(id)).statusCode).toBe(400);
    expect((await reinvite(99999)).statusCode).toBe(404);
    expect((await reinvite('abc')).statusCode).toBe(404);
    expect(sender.sent).toEqual([]);
  });

  it('a login typed in by hand can be invited later', async () => {
    const manual = (await qbo.users.create({ name: 'Sam Rivera', email: 'sam@rivera-landscaping.example', accountType: 'client', username: 'sam.rivera', password: 'a-typed-password-1', realmIds: ['realm-1'] })).user;
    expect((await reinvite(manual.id)).json().invite.sent).toBe(true);
    expect(sender.sent[0].text).toContain('Your username: sam.rivera');
    await accept(sender.lastLinkPath());
    expect(await connectorSignIn('sam.rivera', CHOSEN)).toBeTruthy();
  });

  // ── When the email can't go out ────────────────────────────────────────────

  it('hands the admin the link when the email is rejected', async () => {
    sender.fail = true;
    const res = await invite();
    expect(res.statusCode).toBe(201);
    const { user, invite: result } = res.json();
    expect(result).toMatchObject({ to: EMAIL, sent: false });
    expect(result.error).toContain('domain is not verified');
    expect(result.link).toMatch(LINK_RE);
    expect(user.username).toBe(EMAIL);
    // The link the admin was given works like any other.
    expect((await accept(new URL(result.link).pathname)).statusCode).toBe(200);
    expect(await connectorSignIn(EMAIL, CHOSEN)).toBeTruthy();
  });

  it('with email not set up at all, inviting still works — as a link to pass on', async () => {
    await app.close();
    await qbo.close();
    await build(disabledInvitesConfig());
    const res = await invite();
    expect(res.statusCode).toBe(201);
    const result = res.json().invite;
    expect(result).toMatchObject({ to: EMAIL, sent: false, error: null });
    expect(result.link).toMatch(LINK_RE);
    expect(sender.sent).toEqual([]);

    const page = await openLink(new URL(result.link).pathname);
    expect(page.body).toContain('Your accounting firm'); // no firm name configured
    expect((await accept(new URL(result.link).pathname)).statusCode).toBe(200);

    const status = (await app.inject({ method: 'GET', url: '/api/invites', headers: asMaster })).json();
    expect(status).toMatchObject({ enabled: false, missing: ['RESEND_API_KEY', 'QBO_INVITE_FROM'] });
  });

  it('never points a client at an address that only works on the server', async () => {
    const local = { host: 'localhost:3456', authorization: `Bearer ${MASTER_KEY}` };
    const saved = { url: process.env.QBO_PUBLIC_URL, hosts: process.env.QBO_ALLOWED_HOSTS, railway: process.env.RAILWAY_PUBLIC_DOMAIN };
    delete process.env.QBO_PUBLIC_URL;
    delete process.env.QBO_ALLOWED_HOSTS;
    process.env.RAILWAY_PUBLIC_DOMAIN = 'qbo.example-cpa.com';
    try {
      await app.inject({ method: 'POST', url: '/api/users', headers: local, payload: INVITE });
      expect(sender.sent[0].text).toMatch(LINK_RE);
      expect(sender.sent[0].text).toContain('Connector address: https://qbo.example-cpa.com/mcp');
      expect(sender.sent[0].text).not.toContain('localhost');
    } finally {
      for (const [key, value] of [['QBO_PUBLIC_URL', saved.url], ['QBO_ALLOWED_HOSTS', saved.hosts], ['RAILWAY_PUBLIC_DOMAIN', saved.railway]] as const) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  // ── Who may do what ────────────────────────────────────────────────────────

  it('only admins can invite; the accept page needs nothing but the link', async () => {
    const id = (await invite()).json().user.id;
    const link = sender.lastLinkPath();
    const member = await qbo.users.create({ name: 'Member' });
    const memberAuth = { ...HOST, authorization: `Bearer ${member.apiKey}` };
    sender.sent.length = 0;

    expect((await reinvite(id, memberAuth)).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/api/users', headers: memberAuth, payload: { ...INVITE, email: 'x@y.example' } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/api/invites', headers: memberAuth })).statusCode).toBe(403);
    expect((await reinvite(id, HOST)).statusCode).toBe(401);
    expect(sender.sent).toEqual([]);

    // The client, once in, cannot invite anyone either.
    await accept(link);
    const session = (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: EMAIL, password: CHOSEN } })).json().token;
    expect((await reinvite(id, { ...HOST, authorization: `Bearer ${session}` })).statusCode).toBe(403);
  });

  it('an invited login is still an ordinary client login: editable while it waits', async () => {
    const id = (await invite()).json().user.id;
    // Renaming it, or changing its company, must not fail for lack of a password.
    const renamed = await app.inject({ method: 'PATCH', url: `/api/users/${id}`, headers: asMaster, payload: { name: 'Jordan A. Rivera', clients: [{ realmId: 'realm-2' }] } });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json().user).toMatchObject({ name: 'Jordan A. Rivera', hasPassword: false });
    expect((await openLink(sender.lastLinkPath())).body).toContain('Other Client Inc'); // link survives; shows the new company
    // But it still can't be made into something a client login must never be.
    for (const payload of [{ role: 'admin' }, { accessLevel: 'read_write' }]) {
      expect((await app.inject({ method: 'PATCH', url: `/api/users/${id}`, headers: asMaster, payload })).statusCode).toBe(400);
    }
  });
});
