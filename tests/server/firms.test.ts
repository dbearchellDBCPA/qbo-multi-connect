import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { QBOManager } from '../../src/index.js';
import { signConnectState, verifyConnectState } from '../../src/auth/connect-state.js';
import { resolveAuth, createScopedManager, isRealmAllowed } from '../../src/server/auth.js';
import { usersRoutes } from '../../src/server/routes/users.js';
import { connectionsRoutes } from '../../src/server/routes/connections.js';
import { authRoutes } from '../../src/server/routes/auth.js';
import { firmsRoutes } from '../../src/server/routes/firms.js';
import { connectCallbackRoutes } from '../../src/server/routes/connect-callback.js';
import { testDatabaseConfig, TEST_DIALECT } from '../support/db.js';

const ENCRYPTION_KEY = 'a'.repeat(64);
const MASTER_KEY = 'master-key-for-firm-tests';

async function connect(qbo: QBOManager, firmId: number, clientName: string, realmId: string) {
  await (qbo as any).tokenStore.storeConnection({
    firmId,
    clientName,
    realmId,
    accessToken: `access-${realmId}`,
    refreshToken: `refresh-${realmId}`,
    tokenExpiry: new Date(Date.now() + 60 * 60 * 1000),
    refreshExpiry: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
    scopes: ['com.intuit.quickbooks.accounting'],
  });
}

describe(`firms (${TEST_DIALECT})`, () => {
  let qbo: QBOManager;
  let app: FastifyInstance;
  let acme: { id: number };
  let globex: { id: number };
  let acmeAdminKey: string;
  let globexAdminKey: string;
  let acmeMemberKey: string;

  beforeEach(async () => {
    qbo = new QBOManager({ ...testDatabaseConfig(), encryptionKey: ENCRYPTION_KEY, clientId: 'cid', clientSecret: 'csec' });
    acme = await qbo.firms.create({ name: 'Acme CPA, LLC' });
    globex = await qbo.firms.create({ name: 'Globex Advisors', companyLimit: 1 });
    await connect(qbo, acme.id, 'Acme Client One', 'acme-1');
    await connect(qbo, acme.id, 'Acme Client Two', 'acme-2');
    await connect(qbo, globex.id, 'Globex Client', 'globex-1');
    acmeAdminKey = (await qbo.users.create({ firmId: acme.id, name: 'Acme Admin', role: 'admin', username: 'admin@acme.test', password: 'correct-horse-1' })).apiKey;
    globexAdminKey = (await qbo.users.create({ firmId: globex.id, name: 'Globex Admin', role: 'admin', username: 'admin@globex.test', password: 'correct-horse-1' })).apiKey;
    acmeMemberKey = (await qbo.users.create({ firmId: acme.id, name: 'Acme Member', role: 'member', realmIds: ['acme-1'] })).apiKey;

    app = Fastify();
    await connectionsRoutes(app, qbo, MASTER_KEY);
    await usersRoutes(app, qbo, MASTER_KEY);
    await authRoutes(app, qbo, MASTER_KEY);
    await firmsRoutes(app, qbo, MASTER_KEY);
    await connectCallbackRoutes(app, qbo, { clientId: 'cid', clientSecret: 'csec', environment: 'sandbox' });
    await app.ready();
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await app.close();
    await qbo.close();
  });

  const as = (key: string) => ({ authorization: `Bearer ${key}` });

  it('the default firm exists and absorbs rows that name no firm', async () => {
    const def = await qbo.firms.get(1);
    expect(def?.slug).toBe('default');
    const { user } = await qbo.users.create({ name: 'Legacy Jane' });
    expect(user.firmId).toBe(1);
    await connect(qbo, 1, 'Legacy Co', 'legacy-1');
    expect((await qbo.getConnection('legacy-1'))?.firmId).toBe(1);
    expect((await qbo.listConnections(1)).map((c) => c.realmId)).toEqual(['legacy-1']);
  });

  it('derives unique slugs and validates explicit ones', async () => {
    expect((await qbo.firms.get(acme.id))?.slug).toBe('acme-cpa-llc');
    const twin = await qbo.firms.create({ name: 'Acme CPA LLC' });
    expect(twin.slug).toBe('acme-cpa-llc-2');
    await expect(qbo.firms.create({ name: 'X', slug: 'Bad Slug!' })).rejects.toThrow(/Slug/);
    await expect(qbo.firms.create({ name: 'X', slug: 'acme-cpa-llc' })).rejects.toThrow(/already taken/);
  });

  it('an admin reaches every company of their firm and none of another firm', async () => {
    const scope = (await resolveAuth(qbo, MASTER_KEY, `Bearer ${acmeAdminKey}`))!;
    expect(scope.firmId).toBe(acme.id);
    expect(scope.allRealms).toBe(true);
    expect(isRealmAllowed(scope, 'acme-1')).toBe(true);
    expect(isRealmAllowed(scope, 'acme-2')).toBe(true);
    expect(isRealmAllowed(scope, 'globex-1')).toBe(false);
    const scoped = createScopedManager(qbo, scope);
    expect((await scoped.listConnections()).map((c) => c.realmId).sort()).toEqual(['acme-1', 'acme-2']);
    expect(await scoped.getConnection('globex-1')).toBeNull();
    // The guard rejects before any call is made, so it throws rather than rejects.
    expect(() => scoped.reports.profitAndLoss('globex-1', { startDate: '2026-01-01', endDate: '2026-01-31' })).toThrow(/not assigned/);
  });

  it('a member sees only assignments, which cannot escape the firm', async () => {
    await (qbo as any).db.setUserRealms(
      (await resolveAuth(qbo, MASTER_KEY, `Bearer ${acmeMemberKey}`))!.userId,
      ['acme-1', 'globex-1'] // a stale/forged assignment outside the firm
    );
    const scope = (await resolveAuth(qbo, MASTER_KEY, `Bearer ${acmeMemberKey}`))!;
    expect([...scope.realmIds]).toEqual(['acme-1']);
    expect(isRealmAllowed(scope, 'globex-1')).toBe(false);
  });

  it('the master key sees every firm, or acts within one via X-QBO-Firm', async () => {
    const all = await app.inject({ method: 'GET', url: '/api/connections', headers: as(MASTER_KEY) });
    expect(all.json().map((c: any) => c.realmId).sort()).toEqual(['acme-1', 'acme-2', 'globex-1']);
    const me = await app.inject({ method: 'GET', url: '/api/me', headers: as(MASTER_KEY) });
    expect(me.json()).toMatchObject({ kind: 'master', allFirms: true, firm: { id: 1, slug: 'default' } });

    const only = await app.inject({ method: 'GET', url: '/api/connections', headers: { ...as(MASTER_KEY), 'x-qbo-firm': String(globex.id) } });
    expect(only.json().map((c: any) => c.realmId)).toEqual(['globex-1']);
    const meG = await app.inject({ method: 'GET', url: '/api/me', headers: { ...as(MASTER_KEY), 'x-qbo-firm': String(globex.id) } });
    expect(meG.json()).toMatchObject({ allFirms: false, firm: { id: globex.id, slug: 'globex-advisors' } });

    const users = await app.inject({ method: 'GET', url: '/api/users', headers: { ...as(MASTER_KEY), 'x-qbo-firm': String(acme.id) } });
    expect(users.json().map((u: any) => u.name).sort()).toEqual(['Acme Admin', 'Acme Member']);
    const everyone = await app.inject({ method: 'GET', url: '/api/users', headers: as(MASTER_KEY) });
    expect(everyone.json()).toHaveLength(3);
  });

  it('/api/me and /api/users are firm-scoped for firm admins', async () => {
    const me = await app.inject({ method: 'GET', url: '/api/me', headers: as(acmeAdminKey) });
    expect(me.json()).toMatchObject({ role: 'admin', allClients: true, allFirms: false, firm: { id: acme.id, name: 'Acme CPA, LLC' } });
    expect(me.json().clients.map((c: any) => c.realmId).sort()).toEqual(['acme-1', 'acme-2']);

    const users = await app.inject({ method: 'GET', url: '/api/users', headers: as(acmeAdminKey) });
    expect(users.json().map((u: any) => u.name).sort()).toEqual(['Acme Admin', 'Acme Member']);
    const globexUsers = await app.inject({ method: 'GET', url: '/api/users', headers: as(globexAdminKey) });
    expect(globexUsers.json().map((u: any) => u.name)).toEqual(['Globex Admin']);
  });

  it('an admin cannot manage, rename, assign or disconnect across the firm boundary', async () => {
    const globexAdminId = (await resolveAuth(qbo, MASTER_KEY, `Bearer ${globexAdminKey}`))!.userId!;
    const patch = await app.inject({ method: 'PATCH', url: `/api/users/${globexAdminId}`, headers: as(acmeAdminKey), payload: { name: 'Hijacked' } });
    expect(patch.statusCode).toBe(404);
    const pw = await app.inject({ method: 'POST', url: `/api/users/${globexAdminId}/password`, headers: as(acmeAdminKey), payload: { password: 'new-password-1' } });
    expect(pw.statusCode).toBe(404);
    const rotate = await app.inject({ method: 'POST', url: `/api/users/${globexAdminId}/rotate-key`, headers: as(acmeAdminKey) });
    expect(rotate.statusCode).toBe(404);
    const del = await app.inject({ method: 'DELETE', url: `/api/users/${globexAdminId}`, headers: as(acmeAdminKey) });
    expect(del.statusCode).toBe(404);
    expect((await qbo.users.get(globexAdminId))?.name).toBe('Globex Admin');

    const rename = await app.inject({ method: 'PATCH', url: '/api/connections/globex-1', headers: as(acmeAdminKey), payload: { clientName: 'Stolen' } });
    expect(rename.statusCode).toBe(404);
    const disconnect = await app.inject({ method: 'DELETE', url: '/api/connections/globex-1', headers: as(acmeAdminKey) });
    expect(disconnect.statusCode).toBe(404);
    expect((await qbo.getConnection('globex-1'))?.clientName).toBe('Globex Client');

    // Assigning a member to another firm's company is rejected as unknown.
    const member = await app.inject({ method: 'POST', url: '/api/users', headers: as(acmeAdminKey), payload: { name: 'New', realmIds: ['globex-1'] } });
    expect(member.statusCode).toBe(400);
    expect(member.json().message).toMatch(/Unknown realm IDs: globex-1/);
    // The reverse direction too: a Globex company cannot be shared with Acme people.
    const acmeMemberId = (await resolveAuth(qbo, MASTER_KEY, `Bearer ${acmeMemberKey}`))!.userId!;
    const share = await app.inject({ method: 'PUT', url: '/api/connections/globex-1/users', headers: as(globexAdminKey), payload: { userIds: [acmeMemberId] } });
    expect(share.statusCode).toBe(400);
    expect(share.json().message).toMatch(/Unknown user IDs/);
  });

  it('users created by a firm admin land in that firm', async () => {
    const created = await app.inject({ method: 'POST', url: '/api/users', headers: as(globexAdminKey), payload: { name: 'Globex Staff', realmIds: ['globex-1'] } });
    expect(created.statusCode).toBe(201);
    expect((await qbo.users.get(created.json().user.id))?.firmId).toBe(globex.id);
    expect(created.json().user.clients).toEqual([{ realmId: 'globex-1', clientName: 'Globex Client' }]);
  });

  it('signs the Intuit connect state with the firm and refuses tampering and expiry', () => {
    const state = signConnectState({ firmId: 7, clientName: 'New Co', issuedBy: 'Jane' }, ENCRYPTION_KEY);
    expect(verifyConnectState(state, ENCRYPTION_KEY)).toEqual({ firmId: 7, clientName: 'New Co', issuedBy: 'Jane' });
    expect(verifyConnectState(state, 'b'.repeat(64))).toBeNull();
    const [v, payload] = state.split('.');
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, 'base64url').toString()), f: 1 })).toString('base64url');
    expect(verifyConnectState(`${v}.${forged}.${state.split('.')[2]}`, ENCRYPTION_KEY)).toBeNull();
    expect(verifyConnectState(state, ENCRYPTION_KEY, Date.now() + 2 * 60 * 60 * 1000)).toBeNull();
    expect(verifyConnectState('New Co', ENCRYPTION_KEY)).toBeNull(); // the old plain-name state
    expect(verifyConnectState(undefined, ENCRYPTION_KEY)).toBeNull();
  });

  it('the connect link from the API carries the firm, and the callback files the company under it', async () => {
    const link = await app.inject({ method: 'POST', url: '/api/connections/auth-url', headers: as(acmeAdminKey), payload: { clientName: 'Acme Client Three' } });
    expect(link.statusCode).toBe(200);
    const state = new URL(link.json().authUrl).searchParams.get('state')!;
    expect(qbo.verifyConnectState(state)).toMatchObject({ firmId: acme.id, clientName: 'Acme Client Three', issuedBy: 'Acme Admin' });

    vi.stubGlobal('fetch', async () =>
      new Response(JSON.stringify({ access_token: 'at', refresh_token: 'rt', token_type: 'bearer', expires_in: 3600, x_refresh_token_expires_in: 8_640_000 }), { status: 200 })
    );
    const cb = await app.inject({ method: 'GET', url: `/callback?code=abc&realmId=acme-3&state=${encodeURIComponent(state)}` });
    expect(cb.statusCode).toBe(200);
    const stored = await qbo.getConnection('acme-3');
    expect(stored).toMatchObject({ firmId: acme.id, clientName: 'Acme Client Three', accessToken: 'at' });
    // …and it is immediately visible to that firm's admin, not to the other firm.
    expect((await app.inject({ method: 'GET', url: '/api/connections', headers: as(acmeAdminKey) })).json().map((c: any) => c.realmId)).toContain('acme-3');
    expect((await app.inject({ method: 'GET', url: '/api/connections', headers: as(globexAdminKey) })).json().map((c: any) => c.realmId)).not.toContain('acme-3');
  });

  it('the callback refuses an unsigned, tampered or expired state', async () => {
    vi.stubGlobal('fetch', async () => { throw new Error('token exchange must not be reached'); });
    const plain = await app.inject({ method: 'GET', url: '/callback?code=abc&realmId=r&state=Plain%20Name' });
    expect(plain.statusCode).toBe(400);
    expect(plain.body).toMatch(/no longer valid/);
    const none = await app.inject({ method: 'GET', url: '/callback?code=abc&realmId=r' });
    expect(none.statusCode).toBe(400);
    const expired = signConnectState({ firmId: acme.id, clientName: 'Old' }, ENCRYPTION_KEY, Date.now() - 3 * 60 * 60 * 1000);
    const late = await app.inject({ method: 'GET', url: `/callback?code=abc&realmId=r&state=${encodeURIComponent(expired)}` });
    expect(late.statusCode).toBe(400);
    expect(await qbo.getConnection('r')).toBeNull();
  });

  it('a company already connected to another firm is not re-homed', async () => {
    vi.stubGlobal('fetch', async () =>
      new Response(JSON.stringify({ access_token: 'at2', refresh_token: 'rt2', token_type: 'bearer', expires_in: 3600, x_refresh_token_expires_in: 8_640_000 }), { status: 200 })
    );
    // Globex (limit 1, already at 1) reconnecting its own company is fine…
    const own = signConnectState({ firmId: globex.id, clientName: 'Globex Client' }, ENCRYPTION_KEY);
    const re = await app.inject({ method: 'GET', url: `/callback?code=abc&realmId=globex-1&state=${encodeURIComponent(own)}` });
    expect(re.statusCode).toBe(200);
    expect((await qbo.getConnection('globex-1'))?.accessToken).toBe('at2');
    // …but Acme's company stays Acme's, tokens untouched.
    const theft = signConnectState({ firmId: globex.id, clientName: 'Mine Now' }, ENCRYPTION_KEY);
    // Lift the limit so the only thing standing in the way is ownership.
    await qbo.firms.update(globex.id, { companyLimit: null });
    const res = await app.inject({ method: 'GET', url: `/callback?code=abc&realmId=acme-1&state=${encodeURIComponent(theft)}` });
    expect(res.statusCode).toBe(409);
    expect(res.body).toMatch(/already connected to a different account/);
    const acme1 = (await qbo.getConnection('acme-1'))!;
    expect(acme1.firmId).toBe(acme.id);
    expect(acme1.clientName).toBe('Acme Client One');
    expect(acme1.accessToken).toBe('access-acme-1');
  });

  it('enforces the company limit when minting a link and at the callback', async () => {
    const link = await app.inject({ method: 'POST', url: '/api/connections/auth-url', headers: as(globexAdminKey), payload: { clientName: 'One Too Many' } });
    expect(link.statusCode).toBe(403);
    expect(link.json().message).toMatch(/up to 1 company/);
    vi.stubGlobal('fetch', async () => { throw new Error('token exchange must not be reached'); });
    const state = signConnectState({ firmId: globex.id, clientName: 'One Too Many' }, ENCRYPTION_KEY);
    const cb = await app.inject({ method: 'GET', url: `/callback?code=abc&realmId=globex-2&state=${encodeURIComponent(state)}` });
    expect(cb.statusCode).toBe(403);
    expect(await qbo.getConnection('globex-2')).toBeNull();
    // A suspended firm cannot connect anything.
    await qbo.firms.update(acme.id, { status: 'suspended' });
    const sus = await app.inject({ method: 'POST', url: '/api/connections/auth-url', headers: as(acmeAdminKey), payload: { clientName: 'X' } });
    expect(sus.statusCode).toBe(403);
    expect(sus.json().message).toMatch(/suspended/);
  });

  it('the operator provisions a firm with its first admin, who then signs in to their own firm', async () => {
    const forbidden = await app.inject({ method: 'POST', url: '/api/firms', headers: as(acmeAdminKey), payload: { name: 'Nope' } });
    expect(forbidden.statusCode).toBe(403);

    const created = await app.inject({
      method: 'POST', url: '/api/firms', headers: as(MASTER_KEY),
      payload: { name: 'Initech Accounting', companyLimit: 10, admin: { name: 'Peter', username: 'peter@initech.test', password: 'correct-horse-1' } },
    });
    expect(created.statusCode).toBe(201);
    const { firm, admin } = created.json();
    expect(firm).toMatchObject({ name: 'Initech Accounting', slug: 'initech-accounting', companyLimit: 10, connectionCount: 0, userCount: 1 });
    expect(admin.user).toMatchObject({ firmId: firm.id, role: 'admin', username: 'peter@initech.test' });
    expect(admin.apiKey).toMatch(/^qbo_/);

    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'peter@initech.test', password: 'correct-horse-1' } });
    expect(login.statusCode).toBe(200);
    const me = await app.inject({ method: 'GET', url: '/api/me', headers: as(login.json().token) });
    expect(me.json()).toMatchObject({ role: 'admin', firm: { id: firm.id, slug: 'initech-accounting' }, clients: [] });

    const list = await app.inject({ method: 'GET', url: '/api/firms', headers: as(MASTER_KEY) });
    expect(list.json().map((f: any) => f.slug)).toEqual(['default', 'acme-cpa-llc', 'globex-advisors', 'initech-accounting']);
    const patched = await app.inject({ method: 'PATCH', url: `/api/firms/${firm.id}`, headers: as(MASTER_KEY), payload: { plan: 'growth', companyLimit: 50 } });
    expect(patched.json()).toMatchObject({ plan: 'growth', companyLimit: 50 });
  });
});
