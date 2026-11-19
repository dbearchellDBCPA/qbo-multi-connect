import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { QBOManager } from '../../src/index.js';
import { ConnectionDatabase } from '../../src/db/index.js';
import { parseInvitesConfig, disabledInvitesConfig, type InvitesConfig } from '../../src/invites/config.js';
import { EmailSendError, type EmailSender, type OutboundEmail } from '../../src/alerts/email.js';
import { usersRoutes } from '../../src/server/routes/users.js';
import { authRoutes } from '../../src/server/routes/auth.js';
import { alertsRoutes } from '../../src/server/routes/alerts.js';
import { inviteAcceptRoutes } from '../../src/server/routes/invite-accept.js';
import { accessRequestRoutes, requestSource } from '../../src/server/routes/access-requests.js';
import {
  AccessRequests,
  AccessRequestInputError,
  cleanRequestInput,
  suggestCompany,
  FORM_MAX_AGE_MS,
  MAX_PENDING_REQUESTS,
  MAX_REQUESTS_PER_HOUR,
  MAX_REQUESTS_PER_SOURCE_PER_HOUR,
  NOTICE_INTERVAL_MS,
} from '../../src/access-requests/service.js';
import { renderAccessRequestNotice } from '../../src/access-requests/notice-email.js';

// A firm emails all its clients one link. Each asks for access on a public
// page; nothing happens until an admin approves, and approval sends the
// ordinary invitation. These tests follow that, and check the public page
// can't be used to get in, to find out who is a client, or to flood anyone.

const ENCRYPTION_KEY = 'a'.repeat(64);
const MASTER_KEY = 'master-key-for-tests';
const HOST = { host: 'qbo.example-cpa.com', 'x-forwarded-proto': 'https' };
const asMaster = { ...HOST, authorization: `Bearer ${MASTER_KEY}` };
const NOTIFY = 'owner@example-cpa.com';
const EMAIL = 'jordan@rivera-landscaping.example';

const CONFIGURED = parseInvitesConfig({
  RESEND_API_KEY: 're_test',
  QBO_INVITE_FROM: 'Example CPA <hello@example-cpa.com>',
});

class FakeSender implements EmailSender {
  sent: OutboundEmail[] = [];
  fail = false;
  async send(email: OutboundEmail): Promise<{ id: string }> {
    if (this.fail) throw new EmailSendError('Resend rejected the email (403): domain is not verified', 403);
    this.sent.push(email);
    return { id: `email_${this.sent.length}` };
  }
  to(address: string): OutboundEmail[] {
    return this.sent.filter((email) => email.to.includes(address));
  }
}

describe('what a requester may type', () => {
  it('tidies a name, an email address and a business name', () => {
    expect(cleanRequestInput({ name: '  Jordan \t Rivera ', email: ' Jordan@Rivera-Landscaping.example ', company: 'Rivera\nLandscaping  LLC' })).toEqual({
      name: 'Jordan Rivera',
      email: 'Jordan@Rivera-Landscaping.example',
      emailKey: 'jordan@rivera-landscaping.example',
      company: 'Rivera Landscaping LLC',
    });
    expect(cleanRequestInput({ name: "Zoë O'Brien-Smith Jr.", email: 'z@x.example', company: 'A/C & Heating (East) #2' }).company).toBe('A/C & Heating (East) #2');
  });

  it('refuses anything that could carry a link or markup to the person reviewing it', () => {
    const ok = { name: 'Jordan Rivera', email: EMAIL, company: 'Rivera Landscaping LLC' };
    const bad: Array<[Partial<typeof ok> | Record<string, unknown>, string]> = [
      [{ name: 'Click https://evil.example now' }, 'name'],
      [{ name: 'see www.evil.example' }, 'name'],
      [{ name: '<b>Jordan</b>' }, 'name'],
      [{ name: 'jordan@evil.example' }, 'name'],
      [{ name: 'J' }, 'name'],
      [{ name: 'x'.repeat(81) }, 'name'],
      [{ name: 42 }, 'name'],
      [{ company: 'Pay at http://evil.example' }, 'company'],
      [{ company: '<img src=x>' }, 'company'],
      [{ company: '' }, 'company'],
      [{ company: 'x'.repeat(121) }, 'company'],
      [{ email: 'not-an-address' }, 'email'],
      [{ email: 'Jordan <jordan@x.example>' }, 'email'],
      [{ email: 'a@b' }, 'email'],
      [{ email: `${'a'.repeat(250)}@x.example` }, 'email'],
      [{ email: '' }, 'email'],
    ];
    for (const [change, field] of bad) {
      let caught: unknown;
      try {
        cleanRequestInput({ ...ok, ...change });
      } catch (error) {
        caught = error;
      }
      expect(caught, JSON.stringify(change)).toBeInstanceOf(AccessRequestInputError);
      expect((caught as AccessRequestInputError).field, JSON.stringify(change)).toBe(field);
    }
  });

  it('suggests a company only when exactly one fits what was typed', () => {
    const companies = [
      { realmId: '1', clientName: 'Rivera Landscaping LLC' },
      { realmId: '2', clientName: 'Smith & Sons Plumbing, Inc.' },
      { realmId: '3', clientName: 'Smith Dental' },
    ];
    expect(suggestCompany('rivera landscaping', companies)?.realmId).toBe('1');
    expect(suggestCompany('Rivera Landscaping, L.L.C.', companies)?.realmId).toBe('1');
    expect(suggestCompany('Smith and Sons Plumbing', companies)?.realmId).toBe('2');
    expect(suggestCompany('Rivera', companies)?.realmId).toBe('1');
    expect(suggestCompany('Smith', companies)).toBeNull(); // two fit
    expect(suggestCompany('LLC', companies)).toBeNull(); // nothing left to compare
    expect(suggestCompany('Unrelated Bakery', companies)).toBeNull();
  });

  it('takes the source from the hop the proxy added, not from what the sender claims', () => {
    expect(requestSource({ headers: { 'x-forwarded-for': '1.1.1.1, 2.2.2.2, 203.0.113.9' }, ip: '10.0.0.1' })).toBe('203.0.113.9');
    expect(requestSource({ headers: { 'x-forwarded-for': ['1.1.1.1', '198.51.100.7'] }, ip: '10.0.0.1' })).toBe('198.51.100.7');
    expect(requestSource({ headers: {}, ip: '10.0.0.1' })).toBe('10.0.0.1');
  });
});

describe('asking for access', () => {
  let qbo: QBOManager;
  let app: FastifyInstance;
  let sender: FakeSender;
  let memberKey: string;

  async function build(config: InvitesConfig = CONFIGURED, withSender = true): Promise<void> {
    sender = new FakeSender();
    qbo = new QBOManager({
      dbPath: ':memory:',
      encryptionKey: ENCRYPTION_KEY,
      invites: config,
      ...(withSender ? { emailSender: sender } : {}),
      dashboardUrl: () => 'https://qbo.example-cpa.com',
    });
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
    memberKey = (await qbo.users.create({ name: 'Staff Member', email: 'staff@example-cpa.com', role: 'member', realmIds: ['realm-1'] })).apiKey;
    app = Fastify({ logger: false });
    await authRoutes(app, qbo, MASTER_KEY);
    await usersRoutes(app, qbo, MASTER_KEY);
    await alertsRoutes(app, qbo, MASTER_KEY);
    await inviteAcceptRoutes(app, qbo);
    await accessRequestRoutes(app, qbo, MASTER_KEY);
    await app.ready();
  }

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    await build();
  });
  afterEach(async () => {
    vi.useRealTimers();
    await app.close();
    await qbo.close();
  });

  const settings = (payload: Record<string, unknown>, headers: Record<string, string> = asMaster) =>
    app.inject({ method: 'PUT', url: '/api/access-requests/settings', headers, payload });
  const open = async () => expect((await settings({ enabled: true, notifyEmail: NOTIFY })).statusCode).toBe(200);
  const page = (headers: Record<string, string> = HOST) => app.inject({ method: 'GET', url: '/request-access', headers });
  const tokenFrom = (html: string) => html.match(/name="t" value="([^"]+)"/)![1];
  const post = (fields: Record<string, string>, source = '203.0.113.5') =>
    app.inject({
      method: 'POST',
      url: '/request-access',
      headers: { ...HOST, 'x-forwarded-for': source, 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams(fields).toString(),
    });
  const REQUEST = { name: 'Jordan Rivera', email: EMAIL, company: 'Rivera Landscaping' };
  /** Load the form, wait like a person would, and send it. */
  async function ask(fields: Record<string, string> = {}, source?: string) {
    const token = tokenFrom((await page()).body);
    vi.advanceTimersByTime(5_000);
    const res = await post({ ...REQUEST, ...fields, t: token }, source);
    await qbo.accessRequests.idle();
    return res;
  }
  const list = async () => (await app.inject({ method: 'GET', url: '/api/access-requests', headers: asMaster })).json();
  const approve = (id: number | string, realmId: unknown = 'realm-1', headers: Record<string, string> = asMaster) =>
    app.inject({ method: 'POST', url: `/api/access-requests/${id}/approve`, headers, payload: { realmId } });
  const decline = (id: number | string, headers: Record<string, string> = asMaster) =>
    app.inject({ method: 'POST', url: `/api/access-requests/${id}/decline`, headers });
  const clientLogins = async () => (await qbo.users.list()).filter((u) => u.accountType === 'client');

  // ── The public page ──────────────────────────────────────────────────────

  it('is closed until an admin opens it', async () => {
    const closed = await page();
    expect(closed.statusCode).toBe(404);
    expect(closed.body).toContain("Requests aren't open right now");
    expect(closed.body).not.toContain('<form');

    const res = await post({ ...REQUEST, t: 'anything' });
    expect(res.statusCode).toBe(404);
    expect((await list()).pending).toEqual([]);
    expect((await list()).enabled).toBe(false);

    // …and can be closed again.
    await open();
    const opened = await page();
    expect(opened.statusCode).toBe(200);
    await settings({ enabled: false });
    expect((await page()).statusCode).toBe(404);
    // A form loaded while it was open can't be sent after it closes.
    vi.advanceTimersByTime(5_000);
    expect((await post({ ...REQUEST, t: tokenFrom(opened.body) })).statusCode).toBe(404);
    expect((await list()).pending).toEqual([]);
  });

  it('shows a self-contained form in the firm\'s name', async () => {
    await open();
    const res = await page();
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('<strong>Example CPA</strong>');
    expect(res.body).toContain('Request access — Example CPA</title>');
    expect(res.body).toContain('read-only');
    for (const field of ['name="name"', 'name="email"', 'name="company"', 'name="website"', 'name="t"']) expect(res.body).toContain(field);
    expect(res.body).not.toMatch(/<script/i);
    expect(res.body).not.toMatch(/(src|href|action)="https?:\/\//i);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['x-robots-tag']).toContain('noindex');

    // An easy address to give out lands on it.
    const short = await app.inject({ method: 'GET', url: '/invite', headers: HOST });
    expect(short.statusCode).toBe(302);
    expect(short.headers.location).toBe('/request-access');
  });

  it('a request waits for review: no login, no email to the requester, a notice to the firm', async () => {
    await open();
    const res = await ask();
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Thanks, Jordan Rivera');
    expect(res.body).toContain(EMAIL);

    const state = await list();
    expect(state.pending).toHaveLength(1);
    expect(state.pending[0]).toMatchObject({ name: 'Jordan Rivera', email: EMAIL, company: 'Rivera Landscaping', status: 'pending', suggestedRealmId: 'realm-1', existingLogin: null });
    expect(state.url).toBe('https://qbo.example-cpa.com/request-access');
    expect(await clientLogins()).toEqual([]);

    expect(sender.to(EMAIL)).toEqual([]); // nothing goes to the address a stranger typed
    expect(sender.sent).toHaveLength(1);
    const notice = sender.sent[0];
    expect(notice.to).toEqual([NOTIFY]);
    expect(notice.from).toBe('Example CPA <hello@example-cpa.com>');
    expect(notice.subject).toBe('A client is asking for access');
    expect(notice.text).toContain(`1. Jordan Rivera — ${EMAIL}`);
    expect(notice.text).toContain('Business: Rivera Landscaping');
    expect(notice.text).toContain('https://qbo.example-cpa.com');
    expect(notice.text).toContain('not verified');
  });

  it('answers everyone the same way, so the page reveals nothing about who is already a client', async () => {
    await open();
    // An address that already has a client login…
    await app.inject({ method: 'POST', url: '/api/users', headers: asMaster, payload: { name: 'Known Client', email: 'known@client.example', accountType: 'client', clients: [{ realmId: 'realm-2' }], sendInvite: true } });
    const known = await ask({ name: 'Same Name', email: 'known@client.example' });
    // …one that has never been seen…
    const stranger = await ask({ name: 'Same Name', email: 'new@client.example' }, '203.0.113.6');
    // …and one asking a second time.
    const again = await ask({ name: 'Same Name', email: 'new@client.example' }, '203.0.113.6');
    const strip = (body: string) => body.replace(/known@client\.example|new@client\.example/g, 'ADDRESS');
    for (const res of [known, stranger, again]) expect(res.statusCode).toBe(200);
    expect(strip(known.body)).toBe(strip(stranger.body));
    expect(again.body).toBe(stranger.body);
  });

  it('keeps one waiting request per address, with what was typed last', async () => {
    await open();
    await ask({ company: 'Rivera' });
    await ask({ name: 'Jordan A. Rivera', email: EMAIL.toUpperCase(), company: 'Rivera Landscaping LLC' });
    const { pending } = await list();
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ name: 'Jordan A. Rivera', company: 'Rivera Landscaping LLC' });
    expect(sender.sent).toHaveLength(1); // the firm is not told twice about one person
  });

  it('asks for a correction, keeping what was typed and escaping it', async () => {
    await open();
    const bad = await ask({ name: 'Jordan "J" Rivera', email: 'not-an-address', company: 'Rivera & Co' });
    expect(bad.statusCode).toBe(400);
    expect(bad.body).toContain('That email address does not look right');
    expect(bad.body).toContain('value="Jordan &quot;J&quot; Rivera"');
    expect(bad.body).toContain('value="Rivera &amp; Co"');

    const markup = await ask({ name: '<script>alert(1)</script>' });
    expect(markup.statusCode).toBe(400);
    expect(markup.body).toContain('Please enter just your name');
    expect(markup.body).not.toContain('<script>alert(1)</script>');
    expect(markup.body).toContain('&lt;script&gt;');

    expect((await ask({ company: 'visit https://evil.example' })).statusCode).toBe(400);
    expect((await list()).pending).toEqual([]);
    expect(sender.sent).toEqual([]);
  });

  it('quietly drops a submission that fills in the field people never see', async () => {
    await open();
    const res = await ask({ website: 'https://spam.example' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Thanks, Jordan Rivera'); // told the same as everyone else
    expect((await list()).pending).toEqual([]);
    expect(sender.sent).toEqual([]);
  });

  it('only takes a form this server handed out, a believable time ago', async () => {
    await open();
    const stored = async () => (await list()).pending.length;

    // No form was ever loaded, or the token was made up.
    for (const t of ['', 'nonsense', `${Date.now() - 5000}.${'0'.repeat(64)}`, `${Date.now() - 5000}.zz`]) {
      const res = await post({ ...REQUEST, t });
      expect(res.statusCode, t).toBe(400);
      expect(res.body).toContain('Please press Request access again');
      expect(res.body).toContain('value="Jordan Rivera"'); // nothing they typed is lost
    }
    expect(await stored()).toBe(0);

    // Sent the instant the page loaded.
    const instant = tokenFrom((await page()).body);
    expect((await post({ ...REQUEST, t: instant })).statusCode).toBe(400);
    expect(await stored()).toBe(0);

    // Left open overnight.
    const old = tokenFrom((await page()).body);
    vi.advanceTimersByTime(FORM_MAX_AGE_MS + 1000);
    const stale = await post({ ...REQUEST, t: old });
    expect(stale.statusCode).toBe(400);
    expect(stale.body).toContain('open for a long time');
    expect(await stored()).toBe(0);

    // The form it hands back works.
    const fresh = tokenFrom(stale.body);
    vi.advanceTimersByTime(3000);
    expect((await post({ ...REQUEST, t: fresh })).statusCode).toBe(200);
    expect(await stored()).toBe(1);

    // A token from another server (or before a restart) is not accepted.
    const other = new AccessRequests(new ConnectionDatabase(':memory:'), { sender: null, from: null, fallbackRecipients: [] });
    const foreign = other.formToken();
    vi.advanceTimersByTime(3000);
    expect(qbo.accessRequests.checkFormToken(foreign)).toBe('invalid');
    expect(other.checkFormToken(foreign)).toBe('ok');
  });

  it('bounds how much one address can send', async () => {
    await open();
    for (let i = 0; i < MAX_REQUESTS_PER_SOURCE_PER_HOUR; i++) {
      expect((await ask({ email: `person${i}@client.example` }, '198.51.100.20')).statusCode).toBe(200);
    }
    const over = await ask({ email: 'one-more@client.example' }, '198.51.100.20');
    expect(over.statusCode).toBe(429);
    expect(over.body).toContain("We can't take your request just now");
    // Claiming to be someone else in the header does not help…
    expect((await ask({ email: 'one-more@client.example' }, '9.9.9.9, 198.51.100.20')).statusCode).toBe(429);
    // …and other people are unaffected.
    expect((await ask({ email: 'someone-else@client.example' }, '198.51.100.21')).statusCode).toBe(200);
    expect((await list()).pending).toHaveLength(MAX_REQUESTS_PER_SOURCE_PER_HOUR + 1);

    // An hour later the address may ask again.
    vi.advanceTimersByTime(61 * 60_000);
    expect((await ask({ email: 'one-more@client.example' }, '198.51.100.20')).statusCode).toBe(200);
  });

  it('bounds how many requests can arrive in an hour, and how many can wait', async () => {
    await open();
    const submit = (i: number) => qbo.accessRequests.submit({ name: 'Some Person', email: `p${i}@client.example`, company: 'Some Company' }, `10.1.${Math.floor(i / 250)}.${i % 250}`);
    for (let i = 0; i < MAX_REQUESTS_PER_HOUR; i++) expect(await submit(i)).toBe('received');
    expect(await submit(MAX_REQUESTS_PER_HOUR)).toBe('busy');
    // Someone already waiting can still correct their details.
    expect(await qbo.accessRequests.submit({ name: 'Renamed Person', email: 'p0@client.example', company: 'Some Company' }, '10.9.9.9')).toBe('received');
    expect(await qbo.accessRequests.pendingCount()).toBe(MAX_REQUESTS_PER_HOUR);

    // Hour by hour the queue can fill, but only so far.
    let next = MAX_REQUESTS_PER_HOUR + 1;
    while ((await qbo.accessRequests.pendingCount()) < MAX_PENDING_REQUESTS) {
      vi.advanceTimersByTime(61 * 60_000);
      for (let i = 0; i < MAX_REQUESTS_PER_HOUR && (await qbo.accessRequests.pendingCount()) < MAX_PENDING_REQUESTS; i++) await submit(next++);
    }
    vi.advanceTimersByTime(61 * 60_000);
    expect(await submit(next++)).toBe('busy');
    expect((await ask({ email: 'late@client.example' })).statusCode).toBe(429);

    // Clearing the queue reopens the page.
    const cleared = await app.inject({ method: 'POST', url: '/api/access-requests/decline-all', headers: asMaster });
    expect(cleared.json()).toEqual({ success: true, declined: MAX_PENDING_REQUESTS });
    vi.advanceTimersByTime(61 * 60_000);
    expect((await ask({ email: 'late@client.example' })).statusCode).toBe(200);
    await qbo.accessRequests.idle();
  });

  // ── Reviewing ────────────────────────────────────────────────────────────

  it('only an admin can see or decide requests', async () => {
    await open();
    await ask();
    const { id } = (await list()).pending[0];
    const asMember = { ...HOST, authorization: `Bearer ${memberKey}` };
    for (const headers of [HOST, asMember]) {
      const expected = headers === HOST ? 401 : 403;
      expect((await app.inject({ method: 'GET', url: '/api/access-requests', headers })).statusCode).toBe(expected);
      expect((await approve(id, 'realm-1', headers)).statusCode).toBe(expected);
      expect((await decline(id, headers)).statusCode).toBe(expected);
      expect((await settings({ enabled: false }, headers)).statusCode).toBe(expected);
      expect((await app.inject({ method: 'POST', url: '/api/access-requests/decline-all', headers })).statusCode).toBe(expected);
    }
    expect((await list()).pending).toHaveLength(1);
    expect((await list()).enabled).toBe(true);
  });

  it('approving creates a read-only client login for the company the admin chose and sends the invitation', async () => {
    await open();
    await ask(); // typed "Rivera Landscaping", which suggests realm-1
    const { id } = (await list()).pending[0];

    // The admin's choice is what counts, not what the requester typed.
    const res = await approve(id, 'realm-2');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ outcome: 'invited', invite: { to: EMAIL, sent: true } });
    expect(res.json().invite.link).toBeUndefined(); // it went by email, so the admin never holds it

    const [login] = await clientLogins();
    expect(login).toMatchObject({ name: 'Jordan Rivera', email: EMAIL, username: EMAIL, accountType: 'client', role: 'member', accessLevel: 'read', hasPassword: false });
    expect(login.assignments).toEqual([{ realmId: 'realm-2', accessLevel: 'read' }]);
    expect(res.json().userId).toBe(login.id);

    const invitation = sender.to(EMAIL);
    expect(invitation).toHaveLength(1);
    expect(invitation[0].subject).toContain('invited you');
    expect(invitation[0].text).toMatch(/https:\/\/qbo\.example-cpa\.com\/invite\/qboi_[0-9a-f]{64}/);
    expect(invitation[0].text).toContain('Other Client Inc');

    const state = await list();
    expect(state.pending).toEqual([]);
    expect(state.recent[0]).toMatchObject({ id, status: 'approved', decidedBy: 'Master key', userId: login.id, realmId: 'realm-2', clientName: 'Other Client Inc' });

    // The link works like any invitation: they choose a password and can sign in.
    const path = new URL(invitation[0].text.match(/https:\/\/\S+\/invite\/qboi_[0-9a-f]{64}/)![0]).pathname;
    const accepted = await app.inject({ method: 'POST', url: path, headers: { ...HOST, 'content-type': 'application/x-www-form-urlencoded' }, payload: new URLSearchParams({ password: 'correct horse battery staple', confirm: 'correct horse battery staple', agree: 'on' }).toString() });
    expect(accepted.statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/api/auth/login', headers: HOST, payload: { username: EMAIL, password: 'correct horse battery staple' } })).statusCode).toBe(200);
  });

  it('a request can only be decided once', async () => {
    await open();
    await ask();
    await ask({ email: 'second@client.example' }, '203.0.113.6');
    const [first, second] = (await list()).pending;

    // Two approvals arriving together: one login, one invitation.
    const both = await Promise.all([approve(first.id), approve(first.id)]);
    expect(both.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    expect(await clientLogins()).toHaveLength(1);
    expect(sender.to(EMAIL)).toHaveLength(1);
    expect((await decline(first.id)).statusCode).toBe(409);
    expect((await approve(first.id)).json().message).toContain('already approved by Master key');

    expect((await decline(second.id)).json()).toEqual({ success: true });
    expect((await decline(second.id)).statusCode).toBe(409);
    expect((await approve(second.id)).statusCode).toBe(409);
    expect((await approve(second.id)).json().message).toContain('already declined');
    expect(sender.to('second@client.example')).toEqual([]); // declining tells the requester nothing
    expect(await clientLogins()).toHaveLength(1);
    expect((await list()).recent.map((r: any) => r.status).sort()).toEqual(['approved', 'declined']);
  });

  it('refuses an approval without a real company or a real request, and leaves the request waiting', async () => {
    await open();
    await ask();
    const { id } = (await list()).pending[0];
    for (const realm of [null, '', 'realm-nope', 7, { realmId: 'realm-1' }]) {
      expect((await approve(id, realm)).statusCode, JSON.stringify(realm)).toBe(400);
    }
    for (const bad of ['999', 'abc', '1e3', '-1', '0x1']) expect((await approve(bad)).statusCode, bad).toBe(404);
    expect((await decline('999')).statusCode).toBe(404);
    expect((await list()).pending).toHaveLength(1);
    expect(await clientLogins()).toEqual([]);
    // No body at all.
    expect((await app.inject({ method: 'POST', url: `/api/access-requests/${id}/approve`, headers: asMaster })).statusCode).toBe(400);
  });

  it('adds the company to a login the person already has, rather than making a second one', async () => {
    await open();
    // They already have a login for one company, with a password.
    const created = (await app.inject({ method: 'POST', url: '/api/users', headers: asMaster, payload: { name: 'Jordan Rivera', email: EMAIL, username: EMAIL, password: 'an existing password', accountType: 'client', clients: [{ realmId: 'realm-2' }] } })).json();
    await ask();
    const [request] = (await list()).pending;
    expect(request.existingLogin).toMatchObject({ id: created.user.id, accountType: 'client', status: 'active', hasPassword: true, companies: [{ realmId: 'realm-2', clientName: 'Other Client Inc' }] });

    const res = await approve(request.id, 'realm-1');
    expect(res.json()).toEqual({ outcome: 'added', userId: created.user.id, invite: null });
    const [login] = await clientLogins();
    expect(login.realmIds.sort()).toEqual(['realm-1', 'realm-2']);
    expect(login.assignments.every((a) => a.accessLevel === 'read')).toBe(true);
    expect(sender.to(EMAIL)).toEqual([]); // they keep their password; nothing to send
    expect(await qbo.users.verifyLogin(EMAIL, 'an existing password')).not.toBeNull();

    // Asking again for a company they already have changes nothing.
    await ask();
    const again = await approve((await list()).pending[0].id, 'realm-1');
    expect(again.json()).toMatchObject({ outcome: 'already', invite: null });
    expect((await clientLogins())[0].realmIds.sort()).toEqual(['realm-1', 'realm-2']);
  });

  it('re-sends the invitation when the existing login has never chosen a password', async () => {
    await open();
    await app.inject({ method: 'POST', url: '/api/users', headers: asMaster, payload: { name: 'Jordan Rivera', email: EMAIL, accountType: 'client', clients: [{ realmId: 'realm-2' }], sendInvite: true } });
    expect(sender.to(EMAIL)).toHaveLength(1);
    await ask();
    const res = await approve((await list()).pending[0].id, 'realm-1');
    expect(res.json()).toMatchObject({ outcome: 'added', invite: { sent: true } });
    const invitations = sender.to(EMAIL);
    expect(invitations).toHaveLength(2);
    expect(invitations[1].text).toContain('Rivera Landscaping LLC');
    expect(invitations[1].text).toContain('Other Client Inc');
  });

  it('will not turn a team member\'s address, or a disabled login, into client access', async () => {
    await open();
    await ask({ email: 'staff@example-cpa.com' });
    const [staffRequest] = (await list()).pending;
    expect(staffRequest.existingLogin).toMatchObject({ accountType: 'staff', name: 'Staff Member' });
    const refused = await approve(staffRequest.id);
    expect(refused.statusCode).toBe(409);
    expect(refused.json().message).toContain('a team member');
    expect((await list()).pending).toHaveLength(1); // back in the queue, to be declined
    expect(await clientLogins()).toEqual([]);

    const created = (await app.inject({ method: 'POST', url: '/api/users', headers: asMaster, payload: { name: 'Gone Client', email: 'gone@client.example', username: 'gone@client.example', password: 'an existing password', accountType: 'client', clients: [{ realmId: 'realm-2' }] } })).json();
    await app.inject({ method: 'PATCH', url: `/api/users/${created.user.id}`, headers: asMaster, payload: { status: 'disabled' } });
    await ask({ email: 'gone@client.example' }, '203.0.113.6');
    const goneRequest = (await list()).pending.find((r: any) => r.email === 'gone@client.example');
    const disabled = await approve(goneRequest.id, 'realm-1');
    expect(disabled.statusCode).toBe(409);
    expect(disabled.json().message).toContain('disabled');
    expect((await qbo.users.get(created.user.id))!.realmIds).toEqual(['realm-2']);
    expect((await list()).pending).toHaveLength(2);
    expect(sender.to('gone@client.example')).toEqual([]);
  });

  it('hands the admin the invitation link when it could not be emailed', async () => {
    await open();
    await ask();
    sender.fail = true;
    const res = await approve((await list()).pending[0].id);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ outcome: 'invited', invite: { sent: false, error: expect.stringContaining('not verified') } });
    expect(res.json().invite.link).toMatch(/^https:\/\/qbo\.example-cpa\.com\/invite\/qboi_[0-9a-f]{64}$/);
    expect(await clientLogins()).toHaveLength(1);
    expect((await list()).pending).toEqual([]);
  });

  // ── Settings and notices ─────────────────────────────────────────────────

  it('lets an admin say who is told, and refuses an address that is not one', async () => {
    expect((await list()).notice).toMatchObject({ recipients: [], source: 'none', available: false });

    const set = await settings({ notifyEmail: ' Owner@Example-CPA.com, delegate@example-cpa.com ' });
    expect(set.json().notice).toMatchObject({ recipients: ['Owner@Example-CPA.com', 'delegate@example-cpa.com'], source: 'settings', available: true, reason: null });
    expect(set.json().enabled).toBe(false); // only what was sent changes

    for (const notifyEmail of ['not-an-address', 'a@b.example, nope', 'Owner <owner@example-cpa.com>', 'a@x.example,b@x.example,c@x.example,d@x.example,e@x.example,f@x.example', 7]) {
      const res = await settings({ enabled: true, notifyEmail });
      expect(res.statusCode, JSON.stringify(notifyEmail)).toBe(400);
    }
    for (const enabled of ['yes', 1, null]) expect((await settings({ enabled })).statusCode).toBe(400);
    const state = await list();
    expect(state.enabled).toBe(false); // a refused address did not flip the switch
    expect(state.notice.recipients).toEqual(['Owner@Example-CPA.com', 'delegate@example-cpa.com']);

    // Blank clears it.
    expect((await settings({ notifyEmail: '' })).json().notice).toMatchObject({ recipients: [], source: 'none' });
  });

  it('says why a notice cannot be sent when email is not set up', async () => {
    await app.close();
    await qbo.close();
    await build(disabledInvitesConfig(), false);
    await open();
    expect((await list()).notice).toMatchObject({ available: false, reason: expect.stringContaining('RESEND_API_KEY') });
    expect((await ask()).statusCode).toBe(200); // requests still arrive
    expect((await list()).pending).toHaveLength(1);
    // …and can still be approved: the admin is given the link.
    const res = await approve((await list()).pending[0].id);
    expect(res.json().invite.link).toMatch(/\/invite\/qboi_/);
  });
});

describe('telling the firm about requests', () => {
  let db: ConnectionDatabase;
  let sender: FakeSender;
  let requests: AccessRequests;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-02T15:00:00Z'));
    db = new ConnectionDatabase(':memory:');
    sender = new FakeSender();
    requests = new AccessRequests(db, { sender, from: 'alerts@example-cpa.com', fallbackRecipients: ['fallback@example-cpa.com'], dashboardUrl: () => 'https://qbo.example-cpa.com' });
    await requests.setEnabled(true);
  });
  afterEach(async () => {
    requests.stop();
    await requests.idle();
    vi.useRealTimers();
    await db.close();
  });

  let n = 0;
  const ask = async (name = `Person ${++n}`) => {
    expect(await requests.submit({ name, email: `${name.toLowerCase().replace(/\W+/g, '.')}@client.example`, company: `${name} Co` }, `10.0.0.${n}`)).toBe('received');
    await requests.idle();
  };

  it('sends the first at once, then gathers what follows into one email per interval', async () => {
    await ask('First Person');
    expect(sender.sent).toHaveLength(1);
    expect(sender.sent[0].to).toEqual(['fallback@example-cpa.com']); // no address set: the alert recipients
    expect(sender.sent[0].subject).toBe('A client is asking for access');

    await vi.advanceTimersByTimeAsync(60_000);
    await ask('Second Person');
    await ask('Third Person');
    expect(sender.sent).toHaveLength(1); // held back

    await vi.advanceTimersByTimeAsync(NOTICE_INTERVAL_MS);
    await requests.idle();
    expect(sender.sent).toHaveLength(2);
    expect(sender.sent[1].subject).toBe('2 clients are asking for access');
    expect(sender.sent[1].text).toContain('Second Person');
    expect(sender.sent[1].text).toContain('Third Person');
    expect(sender.sent[1].text).not.toContain('First Person'); // already reported
    expect(sender.sent[1].text).toContain('3 requests are waiting in all');

    // Nothing new, nothing sent.
    await vi.advanceTimersByTimeAsync(3 * NOTICE_INTERVAL_MS);
    expect(sender.sent).toHaveLength(2);
  });

  it('uses the address set in the dashboard, and skips requests already handled', async () => {
    await requests.setNotifyEmail('owner@example-cpa.com');
    await ask('First Person');
    expect(sender.sent[0].to).toEqual(['owner@example-cpa.com']);
    await ask('Second Person');
    const [, second] = await requests.pending();
    await requests.decline(second.id, 'Admin');
    await vi.advanceTimersByTimeAsync(NOTICE_INTERVAL_MS + 1000);
    await requests.idle();
    expect(sender.sent).toHaveLength(1); // the only unreported request was declined meanwhile
  });

  it('retries a failed notice after the interval, not on every request', async () => {
    sender.fail = true;
    await ask('First Person');
    await ask('Second Person');
    expect(sender.sent).toEqual([]);
    expect((await requests.noticeStatus()).lastError).toContain('not verified');

    sender.fail = false;
    await vi.advanceTimersByTimeAsync(NOTICE_INTERVAL_MS + 1000);
    await requests.idle();
    expect(sender.sent).toHaveLength(1);
    expect(sender.sent[0].subject).toBe('2 clients are asking for access');
    expect((await requests.noticeStatus()).lastError).toBeNull();
  });

  it('reports requests left unreported by a restart', async () => {
    const quiet = new AccessRequests(db, { sender: null, from: null, fallbackRecipients: [] });
    await quiet.submit({ name: 'Before Restart', email: 'before@client.example', company: 'Before Co' }, '10.0.0.1');
    await quiet.idle();
    requests.scheduleNotice(); // what the server does when it starts
    await requests.idle();
    expect(sender.sent).toHaveLength(1);
    expect(sender.sent[0].text).toContain('Before Restart');
  });

  it('escapes what a stranger typed, and never links it', () => {
    const email = renderAccessRequestNotice([{ name: 'A & B <i>', email: 'a@b.example', company: '"Quoted" Co', createdAt: new Date('2026-03-02T15:00:00Z') }], { dashboardUrl: 'https://qbo.example-cpa.com', waiting: 1 });
    expect(email.html).toContain('A &amp; B &lt;i&gt;');
    expect(email.html).toContain('&quot;Quoted&quot; Co');
    expect(email.html.match(/href="/g)).toHaveLength(1); // only the dashboard button
    expect(email.html).toContain('href="https://qbo.example-cpa.com"');
    expect(email.text).toContain('Mar 2, 2026');
    expect(email.subject).not.toContain('A & B'); // the subject carries nothing a stranger typed
  });
});
