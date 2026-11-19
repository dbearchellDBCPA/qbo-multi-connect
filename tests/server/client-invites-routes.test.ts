import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { QBOManager } from '../../src/index.js';
import { parseInvitesConfig, disabledInvitesConfig, type InvitesConfig } from '../../src/invites/config.js';
import { EmailSendError, type EmailSender, type OutboundEmail } from '../../src/alerts/email.js';
import { usersRoutes } from '../../src/server/routes/users.js';
import { authRoutes } from '../../src/server/routes/auth.js';
import { alertsRoutes } from '../../src/server/routes/alerts.js';
import { oauthRoutes } from '../../src/server/routes/oauth.js';
import { registerMcpRoutes } from '../../src/server/mcp.js';
import { MAX_LOGIN_FAILURES } from '../../src/users.js';

// Creating a client login can email the client everything they need: an
// invitation (address, username, setup steps) and, separately, a password the
// server generates. These tests follow that password from generation to the
// client's inbox to a successful sign-in — and check it goes nowhere else.

const ENCRYPTION_KEY = 'a'.repeat(64);
const MASTER_KEY = 'master-key-for-tests';
const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';
const HOST = { host: 'qbo.example-cpa.com', 'x-forwarded-proto': 'https' };
const asMaster = { ...HOST, authorization: `Bearer ${MASTER_KEY}` };
const PASSWORD_RE = /([A-HJ-NP-Za-km-z2-9]{4}-){4}[A-HJ-NP-Za-km-z2-9]{4}/;

const CONFIGURED = parseInvitesConfig({
  RESEND_API_KEY: 're_test',
  QBO_INVITE_FROM: 'Example CPA <hello@example-cpa.com>',
  QBO_INVITE_REPLY_TO: 'pat@example-cpa.com',
});

class FakeSender implements EmailSender {
  sent: OutboundEmail[] = [];
  failOn: number | 'always' | null = null;
  private attempts = 0;
  async send(email: OutboundEmail): Promise<{ id: string }> {
    this.attempts++;
    if (this.failOn === 'always' || this.failOn === this.attempts) {
      throw new EmailSendError('Resend rejected the email (403): domain is not verified', 403);
    }
    this.sent.push(email);
    return { id: `email_${this.attempts}` };
  }
  /** The password a client would read out of their inbox. */
  lastPassword(): string {
    const email = [...this.sent].reverse().find((e) => e.subject.startsWith('Your password'));
    return email!.text.match(PASSWORD_RE)![0];
  }
}

describe('client invitation emails over HTTP', () => {
  let qbo: QBOManager;
  let app: FastifyInstance;
  let sender: FakeSender;

  async function build(config: InvitesConfig = CONFIGURED): Promise<void> {
    sender = new FakeSender();
    qbo = new QBOManager({ dbPath: ':memory:', encryptionKey: ENCRYPTION_KEY, invites: config, emailSender: sender });
    await (qbo as any).tokenStore.storeConnection({
      clientName: 'Rivera Landscaping LLC',
      realmId: 'realm-1',
      accessToken: 'a',
      refreshToken: 'r',
      tokenExpiry: new Date(Date.now() + 3600e3),
      refreshExpiry: new Date(Date.now() + 90 * 864e5),
      scopes: ['x'],
    });
    app = Fastify({ logger: false });
    await authRoutes(app, qbo, MASTER_KEY);
    await usersRoutes(app, qbo, MASTER_KEY);
    await alertsRoutes(app, qbo, MASTER_KEY);
    await oauthRoutes(app, qbo);
    await registerMcpRoutes(app, qbo, MASTER_KEY);
    await app.ready();
  }

  beforeEach(() => build());
  afterEach(async () => {
    await app.close();
    await qbo.close();
  });

  const NEW_CLIENT = {
    name: 'Jordan Rivera',
    email: 'jordan@rivera-landscaping.example',
    accountType: 'client',
    username: 'jordan.rivera',
    clients: [{ realmId: 'realm-1' }],
    sendInvite: true,
  };
  const createClient = (overrides: Record<string, unknown> = {}) =>
    app.inject({ method: 'POST', url: '/api/users', headers: asMaster, payload: { ...NEW_CLIENT, ...overrides } });

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

  // ── Create with an invitation ──────────────────────────────────────────────

  it('creates the login, emails the invitation and the password separately, and the emailed password signs in', async () => {
    const res = await createClient();
    expect(res.statusCode).toBe(201);
    const { user, apiKey, invite } = res.json();
    expect(apiKey).toBeNull();
    expect(invite).toEqual({ to: 'jordan@rivera-landscaping.example', sent: true, invitationSent: true, passwordSent: true, error: null });
    expect(user).toMatchObject({ accountType: 'client', username: 'jordan.rivera', hasPassword: true });
    expect(new Date(user.inviteSentAt).getTime()).toBeGreaterThan(Date.now() - 60_000);

    expect(sender.sent).toHaveLength(2);
    const [invitation, secret] = sender.sent;
    expect(invitation.to).toEqual(['jordan@rivera-landscaping.example']);
    expect(invitation.from).toBe('Example CPA <hello@example-cpa.com>');
    expect(invitation.replyTo).toBe('pat@example-cpa.com');
    // The address is this deployment's, worked out from the request.
    expect(invitation.text).toContain('Connector address: https://qbo.example-cpa.com/mcp');
    expect(invitation.text).toContain('Username: jordan.rivera');
    expect(invitation.text).toContain('Rivera Landscaping LLC');
    expect(invitation.text).not.toMatch(PASSWORD_RE);
    expect(secret.to).toEqual(['jordan@rivera-landscaping.example']);
    expect(secret.text).not.toContain('jordan.rivera');
    expect(secret.text).not.toContain('qbo.example-cpa.com');

    // What landed in the inbox is what signs in.
    expect(await connectorSignIn('jordan.rivera', sender.lastPassword())).toBeTruthy();
  });

  it('never returns or logs the generated password', async () => {
    const res = await createClient();
    const password = sender.lastPassword();
    expect(res.body).not.toContain(password);
    await connectorSignIn('jordan.rivera', password);
    const everything = JSON.stringify([
      await qbo.activity.list(),
      (qbo as any).db.db.prepare('SELECT * FROM activity_log').all(),
      (await app.inject({ method: 'GET', url: '/api/users', headers: asMaster })).json(),
    ]);
    expect(everything).not.toContain(password);
    // Only its hash is stored.
    const row = (qbo as any).db.db.prepare('SELECT * FROM users WHERE username = ?').get('jordan.rivera');
    expect(JSON.stringify(row)).not.toContain(password);
  });

  it('each invited login gets its own password', async () => {
    await createClient();
    const first = sender.lastPassword();
    await createClient({ name: 'Sam Rivera', email: 'sam@rivera-landscaping.example', username: 'sam.rivera' });
    expect(sender.lastPassword()).not.toBe(first);
  });

  it('refuses an invitation it could not deliver, before creating anything', async () => {
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{ accountType: 'staff' }, /client logins/],
      [{ accountType: undefined }, /client logins/],
      [{ email: null }, /valid email address/],
      [{ email: 'not-an-address' }, /valid email address/],
      [{ username: null }, /username is required/],
      [{ password: 'they-typed-one-too' }, /leave password out/],
      [{ clients: [] }, /Assign a company/],
      [{ clients: undefined }, /Assign a company/],
      [{ sendInvite: 'yes' }, /true or false/],
    ];
    for (const [overrides, message] of cases) {
      const res = await createClient(overrides);
      expect(res.statusCode, JSON.stringify(overrides)).toBe(400);
      expect(res.json().message).toMatch(message);
    }
    expect(await qbo.users.list()).toEqual([]);
    expect(sender.sent).toEqual([]);
  });

  it('says what to configure when invitations are off', async () => {
    await app.close();
    await qbo.close();
    await build(disabledInvitesConfig());
    const res = await createClient();
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain('RESEND_API_KEY and QBO_INVITE_FROM');
    expect(await qbo.users.list()).toEqual([]);
    // Creating one the old way — admin picks the password — still works.
    const manual = await createClient({ sendInvite: false, password: 'a-typed-password-1' });
    expect(manual.statusCode).toBe(201);
    expect(manual.json().invite).toBeUndefined();
    expect(sender.sent).toEqual([]);
  });

  it('keeps the login and reports the failure when the emails cannot be sent', async () => {
    sender.failOn = 'always';
    const res = await createClient();
    expect(res.statusCode).toBe(201);
    const { user, invite } = res.json();
    expect(invite).toMatchObject({ sent: false, invitationSent: false, passwordSent: false });
    expect(invite.error).toContain('domain is not verified');
    expect(user.inviteSentAt).toBeNull();
    expect((await qbo.users.list()).map((u) => u.username)).toEqual(['jordan.rivera']);
  });

  // ── Sending a new invitation ───────────────────────────────────────────────

  it('a new invitation issues a new password and ends everything opened with the old one', async () => {
    const id = (await createClient()).json().user.id;
    const firstPassword = sender.lastPassword();
    const connected = (await connectorSignIn('jordan.rivera', firstPassword))!;
    expect(await tokenWorks(connected)).toBe(true);

    const res = await app.inject({ method: 'POST', url: `/api/users/${id}/invite`, headers: asMaster });
    expect(res.statusCode).toBe(200);
    expect(res.json().invite).toMatchObject({ sent: true });
    expect(res.body).not.toMatch(PASSWORD_RE);
    expect(sender.sent).toHaveLength(4);

    const secondPassword = sender.lastPassword();
    expect(secondPassword).not.toBe(firstPassword);
    expect(await tokenWorks(connected)).toBe(false); // the old connection is gone
    expect(await connectorSignIn('jordan.rivera', firstPassword)).toBeNull(); // the old password is dead
    expect(await connectorSignIn('jordan.rivera', secondPassword)).toBeTruthy();
  });

  it('a new invitation lets a locked-out client straight back in', async () => {
    const id = (await createClient()).json().user.id;
    for (let i = 0; i <= MAX_LOGIN_FAILURES; i++) await connectorSignIn('jordan.rivera', 'wrong-password');
    expect(await connectorSignIn('jordan.rivera', sender.lastPassword())).toBeNull(); // locked
    await app.inject({ method: 'POST', url: `/api/users/${id}/invite`, headers: asMaster });
    expect(await connectorSignIn('jordan.rivera', sender.lastPassword())).toBeTruthy();
  });

  it('changes nothing when a new invitation cannot be delivered', async () => {
    const id = (await createClient()).json().user.id;
    const password = sender.lastPassword();
    const connected = (await connectorSignIn('jordan.rivera', password))!;
    const before = (await qbo.users.get(id))!.inviteSentAt;

    // Sends 1–2 were the original invitation. Send 3 (the new invitation)
    // fails; then send 4 (invitation) goes out and send 5 (the password) fails.
    for (const [failOn, invitationSent] of [[3, false], [5, true]] as const) {
      sender.failOn = failOn;
      const res = await app.inject({ method: 'POST', url: `/api/users/${id}/invite`, headers: asMaster });
      expect(res.statusCode, `send ${failOn} fails`).toBe(502);
      expect(res.json().message).toContain('Nothing was changed');
      expect(res.json().invite).toMatchObject({ sent: false, invitationSent, passwordSent: false });
    }
    // Same password, same connection, same "last sent".
    expect(await tokenWorks(connected)).toBe(true);
    expect(await connectorSignIn('jordan.rivera', password)).toBeTruthy();
    expect((await qbo.users.get(id))!.inviteSentAt).toEqual(before);
  });

  it('sends one invitation per login at a time', async () => {
    const id = (await createClient()).json().user.id;
    const invite = () => app.inject({ method: 'POST', url: `/api/users/${id}/invite`, headers: asMaster });
    const [a, b] = await Promise.all([invite(), invite()]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 409]);
    expect(sender.sent).toHaveLength(4); // the original pair + exactly one new pair
    // …and the one password that went out is the one that works.
    expect(await connectorSignIn('jordan.rivera', sender.lastPassword())).toBeTruthy();
    // Once it has finished, another can be sent.
    expect((await invite()).statusCode).toBe(200);
  });

  it('a username someone failed to sign in with before it existed is not locked on day one', async () => {
    for (let i = 0; i <= MAX_LOGIN_FAILURES; i++) await connectorSignIn('jordan.rivera', 'guess');
    await createClient();
    expect(await connectorSignIn('jordan.rivera', sender.lastPassword())).toBeTruthy();
  });

  it('never tells a client to use an address that only works on the server', async () => {
    const local = { host: 'localhost:3456', authorization: `Bearer ${MASTER_KEY}` };
    const saved = { url: process.env.QBO_PUBLIC_URL, hosts: process.env.QBO_ALLOWED_HOSTS, railway: process.env.RAILWAY_PUBLIC_DOMAIN };
    delete process.env.QBO_PUBLIC_URL;
    delete process.env.QBO_ALLOWED_HOSTS;
    process.env.RAILWAY_PUBLIC_DOMAIN = 'qbo.example-cpa.com';
    try {
      await app.inject({ method: 'POST', url: '/api/users', headers: local, payload: NEW_CLIENT });
      expect(sender.sent[0].text).toContain('Connector address: https://qbo.example-cpa.com/mcp');
      expect(sender.sent[0].text).not.toContain('localhost');
    } finally {
      for (const [key, value] of [['QBO_PUBLIC_URL', saved.url], ['QBO_ALLOWED_HOSTS', saved.hosts], ['RAILWAY_PUBLIC_DOMAIN', saved.railway]] as const) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it('only invites logins it makes sense to invite', async () => {
    const staff = (await qbo.users.create({ name: 'Staff', email: 'staff@example-cpa.com', username: 'staff', password: 'a-typed-password-1' })).user;
    const noEmail = (await qbo.users.create({ name: 'No Email', accountType: 'client', username: 'no.email', password: 'a-typed-password-1', realmIds: ['realm-1'] })).user;
    const noCompany = (await qbo.users.create({ name: 'No Company', email: 'nc@example.com', accountType: 'client', username: 'no.company', password: 'a-typed-password-1' })).user;
    const disabled = (await createClient()).json().user;
    await qbo.users.update(disabled.id, { status: 'disabled' });
    sender.sent.length = 0;

    const invite = (id: number | string) => app.inject({ method: 'POST', url: `/api/users/${id}/invite`, headers: asMaster });
    expect((await invite(staff.id)).json().message).toMatch(/client logins/);
    expect((await invite(noEmail.id)).json().message).toMatch(/valid email address/);
    expect((await invite(disabled.id)).json().message).toMatch(/disabled/);
    expect((await invite(noCompany.id)).json().message).toMatch(/Assign a company/);
    for (const id of [staff.id, noEmail.id, disabled.id, noCompany.id]) expect((await invite(id)).statusCode).toBe(400);
    expect((await invite(99999)).statusCode).toBe(404);
    expect((await invite('abc')).statusCode).toBe(404);
    expect(sender.sent).toEqual([]);
  });

  it('is for admins only', async () => {
    const id = (await createClient()).json().user.id;
    const member = await qbo.users.create({ name: 'Member' });
    const memberAuth = { ...HOST, authorization: `Bearer ${member.apiKey}` };
    const clientSession = (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'jordan.rivera', password: sender.lastPassword() } })).json().token;
    const clientAuth = { ...HOST, authorization: `Bearer ${clientSession}` };
    sender.sent.length = 0;

    for (const headers of [memberAuth, clientAuth]) {
      expect((await app.inject({ method: 'POST', url: `/api/users/${id}/invite`, headers })).statusCode).toBe(403);
      expect((await app.inject({ method: 'POST', url: '/api/users', headers, payload: { ...NEW_CLIENT, username: 'x.y' } })).statusCode).toBe(403);
      expect((await app.inject({ method: 'GET', url: '/api/invites', headers })).statusCode).toBe(403);
    }
    expect((await app.inject({ method: 'GET', url: '/api/invites', headers: HOST })).statusCode).toBe(401);
    expect(sender.sent).toEqual([]);
  });

  it('reports whether invitations are on, and from whom', async () => {
    const on = (await app.inject({ method: 'GET', url: '/api/invites', headers: asMaster })).json();
    expect(on).toMatchObject({ enabled: true, from: 'Example CPA <hello@example-cpa.com>', firmName: 'Example CPA', replyTo: 'pat@example-cpa.com' });
    expect(JSON.stringify(on)).not.toContain('re_test');

    await app.close();
    await qbo.close();
    await build(disabledInvitesConfig());
    const off = (await app.inject({ method: 'GET', url: '/api/invites', headers: asMaster })).json();
    expect(off).toMatchObject({ enabled: false, missing: ['RESEND_API_KEY', 'QBO_INVITE_FROM'] });
  });
});
