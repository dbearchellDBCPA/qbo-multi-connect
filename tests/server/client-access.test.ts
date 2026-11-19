import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import Fastify, { type FastifyInstance } from 'fastify';
import { QBOManager } from '../../src/index.js';
import {
  effectiveAccessLevel,
  LOGIN_LOCKOUT_MS,
  MAX_LOGIN_FAILURES,
  MAX_LOGIN_LOCKOUT_MS,
} from '../../src/users.js';
import { resolveAuth, canWriteRealm, isRealmAllowed } from '../../src/server/auth.js';
import { CLIENT_TOOLS, CLIENT_EXCLUDED_READ_TOOLS } from '../../src/server/client-tools.js';
import { ACTIVITY_RETENTION_DAYS } from '../../src/activity.js';
import { usersRoutes } from '../../src/server/routes/users.js';
import { connectionsRoutes } from '../../src/server/routes/connections.js';
import { companyRoutes } from '../../src/server/routes/company.js';
import { authRoutes } from '../../src/server/routes/auth.js';
import { oauthRoutes } from '../../src/server/routes/oauth.js';
import { activityRoutes } from '../../src/server/routes/activity.js';
import { registerMcpRoutes } from '../../src/server/mcp.js';

// A client login is handed to someone OUTSIDE the firm so their own AI
// assistant can read their own books. These tests pin down what that login
// can never do, however it is configured or however it tries.

const ENCRYPTION_KEY = 'a'.repeat(64);
const MASTER_KEY = 'master-key-for-tests';
const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';
const PASSWORD = 'correct-horse-battery';

function makeManager(dbPath = ':memory:'): QBOManager {
  return new QBOManager({ dbPath, encryptionKey: ENCRYPTION_KEY });
}

async function addConnection(qbo: QBOManager, clientName: string, realmId: string): Promise<void> {
  await (qbo as any).tokenStore.storeConnection({
    clientName,
    realmId,
    accessToken: 'access-token',
    refreshToken: 'refresh-token',
    tokenExpiry: new Date(Date.now() + 60 * 60 * 1000),
    refreshExpiry: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
    scopes: ['com.intuit.quickbooks.accounting'],
  });
}

interface IntuitCall {
  method: string;
  realmId: string;
}
function stubIntuit(): { calls: IntuitCall[]; restore: () => void } {
  const realFetch = globalThis.fetch;
  const calls: IntuitCall[] = [];
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = new URL(typeof input === 'string' ? input : input.url ?? String(input));
    if (!url.hostname.endsWith('intuit.com')) return realFetch(input, init);
    calls.push({ method: (init?.method ?? 'GET').toUpperCase(), realmId: url.pathname.split('/')[3] });
    return new Response(JSON.stringify({ QueryResponse: {}, CompanyInfo: { CompanyName: 'Stub Co' } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = realFetch) };
}

describe('client logins — what the account can be', () => {
  let qbo: QBOManager;

  beforeEach(async () => {
    qbo = makeManager();
    await addConnection(qbo, 'Acme Corp', 'realm-1');
    await addConnection(qbo, 'Beta LLC', 'realm-2');
  });
  afterEach(() => qbo.close());

  it('is always stored and resolved read-only', async () => {
    const { user } = await qbo.users.create({
      name: 'Acme Owner',
      accountType: 'client',
      // Even an explicit request for write access is stored as read.
      assignments: [{ realmId: 'realm-1', accessLevel: 'read_write' }],
    });
    expect(user.accountType).toBe('client');
    expect(user.role).toBe('member');
    expect(user.accessLevel).toBe('read');
    expect(user.assignments).toEqual([{ realmId: 'realm-1', accessLevel: 'read' }]);
    expect(effectiveAccessLevel(user, 'realm-1')).toBe('read');
    expect(effectiveAccessLevel(user, 'realm-2')).toBeNull();
  });

  it('cannot be created as an admin or with write access', async () => {
    await expect(qbo.users.create({ name: 'X', accountType: 'client', role: 'admin' })).rejects.toThrow(/cannot be an admin/);
    await expect(qbo.users.create({ name: 'X', accountType: 'client', accessLevel: 'read_write' })).rejects.toThrow(/always read-only/);
  });

  it('cannot be edited into an admin or given write access', async () => {
    const { user } = await qbo.users.create({ name: 'Acme Owner', accountType: 'client', realmIds: ['realm-1'] });
    await expect(qbo.users.update(user.id, { role: 'admin' })).rejects.toThrow(/cannot be an admin/);
    await expect(qbo.users.update(user.id, { accessLevel: 'read_write' })).rejects.toThrow(/always read-only/);

    // Assignment edits from either side are stored read-only.
    const viaUser = await qbo.users.setAssignments(user.id, [{ realmId: 'realm-2', accessLevel: 'read_write' }]);
    expect(viaUser?.assignments).toEqual([{ realmId: 'realm-2', accessLevel: 'read' }]);
    await qbo.users.setClientAssignments('realm-1', [{ userId: user.id, accessLevel: 'read_write' }]);
    expect((await qbo.users.get(user.id))?.assignments).toContainEqual({ realmId: 'realm-1', accessLevel: 'read' });
  });

  it('turning a staff account into a client login drops it to read-only; an admin cannot be converted', async () => {
    const staff = (await qbo.users.create({ name: 'Temp', realmIds: ['realm-1'] })).user;
    const converted = await qbo.users.update(staff.id, { accountType: 'client' });
    expect(converted?.accessLevel).toBe('read');
    expect(effectiveAccessLevel(converted!, 'realm-1')).toBe('read');

    const admin = (await qbo.users.create({ name: 'Boss', role: 'admin' })).user;
    await expect(qbo.users.update(admin.id, { accountType: 'client' })).rejects.toThrow(/cannot be an admin/);
  });

  it('stays read-only and non-admin even if its database row is tampered with', async () => {
    const created = await qbo.users.create({
      name: 'Acme Owner',
      accountType: 'client',
      username: 'acme',
      password: PASSWORD,
      realmIds: ['realm-1'],
    });
    const raw = (qbo as any).db.db as Database.Database;
    raw.prepare("UPDATE users SET role = 'admin', access_level = 'read_write' WHERE id = ?").run(created.user.id);
    raw.prepare("UPDATE user_clients SET access_level = 'read_write' WHERE user_id = ?").run(created.user.id);

    const { token } = await qbo.users.createSession(created.user.id);
    const scope = (await resolveAuth(qbo, MASTER_KEY, `Bearer ${token}`))!;
    expect(scope.accountType).toBe('client');
    expect(scope.role).toBe('member');
    expect(scope.allRealms).toBe(false);
    expect(scope.allWrite).toBe(false);
    expect(scope.canWrite).toBe(false);
    expect(canWriteRealm(scope, 'realm-1')).toBe(false);
    expect(isRealmAllowed(scope, 'realm-2')).toBe(false);
  });

  it('has no usable API key', async () => {
    const { user, apiKey } = await qbo.users.create({ name: 'Acme Owner', accountType: 'client', realmIds: ['realm-1'] });
    expect(await qbo.users.findByApiKey(apiKey)).toBeNull();
    expect(await resolveAuth(qbo, MASTER_KEY, `Bearer ${apiKey}`)).toBeNull();
    expect(await resolveAuth(qbo, MASTER_KEY, undefined, apiKey)).toBeNull(); // ?key= URL form
    expect(await qbo.users.getApiKey(user.id)).toBeNull();
    // Rotating doesn't make the new one work either.
    const rotated = await qbo.users.rotateKey(user.id);
    expect(await resolveAuth(qbo, MASTER_KEY, `Bearer ${rotated!.apiKey}`)).toBeNull();
    // Staff keys are unaffected.
    const staff = await qbo.users.create({ name: 'Staff', realmIds: ['realm-1'] });
    expect(await resolveAuth(qbo, MASTER_KEY, `Bearer ${staff.apiKey}`)).not.toBeNull();
  });

  it('upgrading a database from before client logins leaves everyone as staff', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'qbo-migrate-'));
    const dbPath = join(dir, 'old.db');
    try {
      const seed = makeManager(dbPath);
      await addConnection(seed, 'Acme Corp', 'realm-1');
      const jane = await seed.users.create({ name: 'Jane', realmIds: ['realm-1'] });
      seed.close();

      const raw = new Database(dbPath);
      raw.exec('DROP TRIGGER update_users_timestamp');
      raw.exec('ALTER TABLE users DROP COLUMN account_type');
      raw.exec('DROP TABLE activity_log');
      raw.close();

      const upgraded = makeManager(dbPath);
      try {
        expect((await upgraded.users.get(jane.user.id))?.accountType).toBe('staff');
        expect((await resolveAuth(upgraded, MASTER_KEY, `Bearer ${jane.apiKey}`))?.canWrite).toBe(true);
        expect(await upgraded.activity.list()).toEqual([]);
        // The timestamp trigger (recreated on boot) still works with the new column.
        await upgraded.users.update(jane.user.id, { name: 'Jane Smith' });
        expect((await upgraded.users.get(jane.user.id))?.name).toBe('Jane Smith');
      } finally {
        upgraded.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('sign-in lockout', () => {
  let qbo: QBOManager;

  beforeEach(async () => {
    qbo = makeManager();
    await qbo.users.create({ name: 'Acme Owner', accountType: 'client', username: 'acme', password: PASSWORD });
  });
  afterEach(() => {
    vi.useRealTimers();
    qbo.close();
  });

  const failTimes = async (n: number) => {
    for (let i = 0; i < n; i++) await qbo.users.login('acme', 'wrong-password');
  };

  it('locks a username after repeated failures — even for the right password', async () => {
    await failTimes(MAX_LOGIN_FAILURES - 1);
    expect((await qbo.users.login('acme', 'wrong-password')).status).toBe('invalid'); // the tripping attempt
    const locked = await qbo.users.login('ACME ', PASSWORD); // normalized: same username
    expect(locked.status).toBe('locked');
    expect(locked.status === 'locked' && locked.retryAfterMs).toBeLessThanOrEqual(LOGIN_LOCKOUT_MS);
  });

  it('a successful sign-in before the limit resets the count', async () => {
    await failTimes(MAX_LOGIN_FAILURES - 1);
    expect((await qbo.users.login('acme', PASSWORD)).status).toBe('ok');
    await failTimes(MAX_LOGIN_FAILURES - 1);
    expect((await qbo.users.login('acme', PASSWORD)).status).toBe('ok');
  });

  it('each further failure doubles the lock, up to a ceiling', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    await failTimes(MAX_LOGIN_FAILURES);
    const waits: number[] = [];
    for (let round = 0; round < 8; round++) {
      const locked = await qbo.users.login('acme', PASSWORD);
      expect(locked.status).toBe('locked');
      const wait = locked.status === 'locked' ? locked.retryAfterMs : 0;
      waits.push(wait);
      vi.advanceTimersByTime(wait + 1);
      expect((await qbo.users.login('acme', 'wrong-password')).status).toBe('invalid'); // lock over; fails again
    }
    expect(waits.slice(0, 4)).toEqual([LOGIN_LOCKOUT_MS, 2 * LOGIN_LOCKOUT_MS, 4 * LOGIN_LOCKOUT_MS, 8 * LOGIN_LOCKOUT_MS]);
    expect(Math.max(...waits)).toBe(MAX_LOGIN_LOCKOUT_MS);
    // Waiting it out and using the right password gets back in and clears the count.
    const last = await qbo.users.login('acme', PASSWORD);
    vi.advanceTimersByTime((last.status === 'locked' ? last.retryAfterMs : 0) + 1);
    expect((await qbo.users.login('acme', PASSWORD)).status).toBe('ok');
    expect((await qbo.users.login('acme', 'wrong-password')).status).toBe('invalid');
  });

  it('guessing unknown usernames is throttled the same way and reveals nothing', async () => {
    for (let i = 0; i < MAX_LOGIN_FAILURES; i++) {
      expect((await qbo.users.login('nobody', 'x')).status).toBe('invalid');
    }
    expect((await qbo.users.login('nobody', 'x')).status).toBe('locked');
  });
});

describe('client logins — over the connector, REST, and the activity log', () => {
  let qbo: QBOManager;
  let app: FastifyInstance;
  let baseUrl: string;
  let intuit: ReturnType<typeof stubIntuit>;
  let clientId: number;
  let staffKey: string;
  let staffId: number;

  beforeEach(async () => {
    intuit = stubIntuit();
    qbo = makeManager();
    await addConnection(qbo, 'Acme Corp', 'realm-1');
    await addConnection(qbo, 'Beta LLC', 'realm-2');
    clientId = (
      await qbo.users.create({
        name: 'Acme Owner',
        accountType: 'client',
        username: 'acme.owner',
        password: PASSWORD,
        realmIds: ['realm-1'],
      })
    ).user.id;
    const staff = await qbo.users.create({
      name: 'Jordan Staff',
      username: 'jordan',
      password: PASSWORD,
      assignments: [
        { realmId: 'realm-1', accessLevel: 'read_write' },
        { realmId: 'realm-2', accessLevel: 'read' },
      ],
    });
    staffKey = staff.apiKey;
    staffId = staff.user.id;

    app = Fastify({ logger: false });
    await authRoutes(app, qbo, MASTER_KEY);
    await connectionsRoutes(app, qbo, MASTER_KEY);
    await companyRoutes(app, qbo, MASTER_KEY);
    await usersRoutes(app, qbo, MASTER_KEY);
    await activityRoutes(app, qbo, MASTER_KEY);
    await oauthRoutes(app, qbo);
    await registerMcpRoutes(app, qbo, MASTER_KEY);
    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address();
    baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  });

  afterEach(async () => {
    intuit.restore();
    await app.close();
    qbo.close();
  });

  const asMaster = { authorization: `Bearer ${MASTER_KEY}` };

  /** Walk the real connector sign-in: register, authorize with a password, exchange the code. */
  async function connectorSignIn(username: string, password: string) {
    const oauthClient = (
      await app.inject({
        method: 'POST',
        url: '/oauth/register',
        payload: { client_name: 'Claude', redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none' },
      })
    ).json();
    const verifier = randomBytes(32).toString('base64url');
    const authorize = await app.inject({
      method: 'POST',
      url: '/oauth/authorize',
      payload: {
        client_id: oauthClient.client_id,
        redirect_uri: REDIRECT,
        response_type: 'code',
        code_challenge: createHash('sha256').update(verifier).digest('base64url'),
        code_challenge_method: 'S256',
        state: 's',
        username,
        password,
      },
    });
    if (authorize.statusCode !== 302) return { authorize, accessToken: null as string | null };
    const code = new URL(authorize.headers.location as string).searchParams.get('code')!;
    const token = await app.inject({
      method: 'POST',
      url: '/oauth/token',
      payload: { grant_type: 'authorization_code', client_id: oauthClient.client_id, code, code_verifier: verifier, redirect_uri: REDIRECT },
    });
    return { authorize, accessToken: token.json().access_token as string };
  }

  async function mcp(credential: string, method: string, params: unknown, viaQueryKey = false): Promise<any> {
    const res = await fetch(`${baseUrl}/mcp${viaQueryKey ? `?key=${credential}` : ''}`, {
      method: 'POST',
      headers: {
        ...(viaQueryKey ? {} : { authorization: `Bearer ${credential}` }),
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    if (res.status !== 200) return { httpStatus: res.status };
    const text = await res.text();
    const chunks = text.trimStart().startsWith('{')
      ? [text]
      : text.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim());
    for (const chunk of chunks) {
      const parsed = JSON.parse(chunk);
      if (parsed.result || parsed.error) return parsed;
    }
    throw new Error(`No JSON-RPC result in: ${text.slice(0, 200)}`);
  }
  const toolText = (r: any): string => r.result.content.map((c: any) => c.text).join('\n');

  // ── The connector ──────────────────────────────────────────────────────────

  it('signs in through the connector and sees exactly the client tool list', async () => {
    const { accessToken } = await connectorSignIn('acme.owner', PASSWORD);
    expect(accessToken).toBeTruthy();
    const tools = (await mcp(accessToken!, 'tools/list', {})).result.tools as any[];
    expect(tools.map((t) => t.name).sort()).toEqual([...CLIENT_TOOLS].sort());
    expect(tools.every((t) => t.annotations?.readOnlyHint === true)).toBe(true);
  });

  it('every read-only tool is either offered to clients or deliberately withheld', async () => {
    // If this fails you added (or renamed) a read-only tool. Decide whether
    // people outside the firm should have it, then list it in CLIENT_TOOLS or
    // CLIENT_EXCLUDED_READ_TOOLS in src/server/client-tools.ts.
    const all = (await mcp(MASTER_KEY, 'tools/list', {})).result.tools as any[];
    const readOnly = all.filter((t) => t.annotations?.readOnlyHint === true).map((t) => t.name);
    const undecided = readOnly.filter((n) => !CLIENT_TOOLS.has(n) && !CLIENT_EXCLUDED_READ_TOOLS.has(n));
    expect(undecided).toEqual([]);
    // …and neither list names a tool that doesn't exist or isn't read-only.
    const stale = [...CLIENT_TOOLS, ...CLIENT_EXCLUDED_READ_TOOLS].filter((n) => !readOnly.includes(n));
    expect(stale).toEqual([]);
    expect([...CLIENT_TOOLS].filter((n) => CLIENT_EXCLUDED_READ_TOOLS.has(n))).toEqual([]);
  });

  it('reaches its own company and nothing else', async () => {
    const { accessToken } = await connectorSignIn('acme.owner', PASSWORD);
    const list = toolText(await mcp(accessToken!, 'tools/call', { name: 'list_clients', arguments: {} }));
    expect(list).toContain('Acme Corp');
    expect(list).toContain('read-only');
    expect(list).not.toContain('Beta');

    expect(toolText(await mcp(accessToken!, 'tools/call', { name: 'get_company_info', arguments: { client_name: 'Acme Corp' } }))).toContain('Stub Co');
    expect(toolText(await mcp(accessToken!, 'tools/call', { name: 'get_company_info', arguments: { client_name: 'Beta LLC' } }))).toContain('Client not found');
    expect(intuit.calls).toEqual([{ method: 'GET', realmId: 'realm-1' }]);
  });

  it('cannot call a write tool or a withheld tool', async () => {
    const { accessToken } = await connectorSignIn('acme.owner', PASSWORD);
    for (const name of ['create_journal_entry', 'delete_invoice', 'send_transaction_email', 'create_upload_session', ...CLIENT_EXCLUDED_READ_TOOLS]) {
      const res = await mcp(accessToken!, 'tools/call', { name, arguments: { client_name: 'Acme Corp' } });
      expect(toolText(res), name).toMatch(/not found/i);
    }
    expect(intuit.calls).toEqual([]);
  });

  it('cannot connect with an API-key URL', async () => {
    const { apiKey } = await qbo.users.rotateKey(clientId).then((r) => r!);
    expect((await mcp(apiKey, 'tools/list', {})).httpStatus).toBe(401);
    expect((await mcp(apiKey, 'tools/list', {}, true)).httpStatus).toBe(401);
  });

  it('is cut off as soon as the login is disabled', async () => {
    const { accessToken } = await connectorSignIn('acme.owner', PASSWORD);
    expect((await mcp(accessToken!, 'tools/list', {})).result).toBeTruthy();
    await qbo.users.update(clientId, { status: 'disabled' });
    expect((await mcp(accessToken!, 'tools/list', {})).httpStatus).toBe(401);
    expect((await connectorSignIn('acme.owner', PASSWORD)).authorize.statusCode).toBe(401);
  });

  // ── REST and the dashboard API ─────────────────────────────────────────────

  it('cannot change anything or manage anything over REST', async () => {
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'acme.owner', password: PASSWORD } });
    const auth = { authorization: `Bearer ${login.json().token}` };
    const expectStatus = async (method: string, url: string, status: number, payload: unknown = {}) => {
      const res = await app.inject({ method: method as any, url, headers: auth, payload: payload as any });
      expect(res.statusCode, `${method} ${url}`).toBe(status);
    };
    await expectStatus('POST', '/api/company/realm-1/journal-entries', 403, { Line: [] });
    await expectStatus('PUT', '/api/company/realm-1/bills', 403, { Id: '1', SyncToken: '0' });
    await expectStatus('GET', '/api/company/realm-2/info', 404);
    await expectStatus('GET', '/api/users', 403);
    await expectStatus('POST', '/api/users', 403, { name: 'Sneaky', role: 'admin' });
    await expectStatus('PATCH', `/api/users/${clientId}`, 403, { accountType: 'staff' });
    await expectStatus('PUT', '/api/connections/realm-1/users', 403, { users: [{ userId: clientId, accessLevel: 'read_write' }] });
    await expectStatus('DELETE', '/api/connections/realm-1', 403);
    await expectStatus('GET', '/api/activity', 403);
    expect(intuit.calls).toEqual([]);

    const me = (await app.inject({ method: 'GET', url: '/api/me', headers: auth })).json();
    expect(me).toMatchObject({ accountType: 'client', role: 'member', canWrite: false, allClients: false });
    expect(me.clients).toEqual([{ realmId: 'realm-1', clientName: 'Acme Corp', canWrite: false }]);
    expect((await app.inject({ method: 'GET', url: '/api/me/key', headers: auth })).json()).toEqual({ apiKey: null, keyPrefix: null, retrievable: false });
  });

  it('admins create and edit client logins over HTTP, and never get a key back for one', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/users',
      headers: asMaster,
      payload: { name: 'Beta Owner', accountType: 'client', username: 'beta.owner', password: PASSWORD, clients: [{ realmId: 'realm-2', accessLevel: 'read_write' }] },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().apiKey).toBeNull();
    const user = created.json().user;
    expect(user).toMatchObject({ accountType: 'client', role: 'member', accessLevel: 'read' });
    expect(user.clients).toEqual([{ realmId: 'realm-2', clientName: 'Beta LLC', accessLevel: 'read', effectiveAccessLevel: 'read' }]);

    for (const payload of [{ role: 'admin' }, { accessLevel: 'read_write' }]) {
      const res = await app.inject({ method: 'PATCH', url: `/api/users/${user.id}`, headers: asMaster, payload });
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
    }
    const bad = await app.inject({ method: 'POST', url: '/api/users', headers: asMaster, payload: { name: 'X', accountType: 'vendor' } });
    expect(bad.statusCode).toBe(400);
    const adminClient = await app.inject({ method: 'POST', url: '/api/users', headers: asMaster, payload: { name: 'X', accountType: 'client', role: 'admin' } });
    expect(adminClient.statusCode).toBe(400);

    const rotated = await app.inject({ method: 'POST', url: `/api/users/${user.id}/rotate-key`, headers: asMaster });
    expect(rotated.json().apiKey).toBeNull();
  });

  // ── Lockout on the connector sign-in page ──────────────────────────────────

  it('locks the connector sign-in page after repeated failures, shared with the dashboard', async () => {
    for (let i = 0; i < MAX_LOGIN_FAILURES; i++) {
      expect((await connectorSignIn('acme.owner', 'wrong-password')).authorize.statusCode).toBe(401);
    }
    const locked = await connectorSignIn('acme.owner', PASSWORD);
    expect(locked.authorize.statusCode).toBe(429);
    expect(locked.authorize.body).toContain('Too many failed sign-ins');
    expect(locked.accessToken).toBeNull();

    // Same username, other door: still locked.
    const dashboard = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'acme.owner', password: PASSWORD } });
    expect(dashboard.statusCode).toBe(429);
    expect(Number(dashboard.headers['retry-after'])).toBeGreaterThan(0);

    // An admin resetting the password lets them straight back in.
    await app.inject({ method: 'POST', url: `/api/users/${clientId}/password`, headers: asMaster, payload: { password: 'a-brand-new-password' } });
    expect((await connectorSignIn('acme.owner', 'a-brand-new-password')).accessToken).toBeTruthy();
  });

  // ── Activity log ───────────────────────────────────────────────────────────

  it('records who called which tool on which company, and how it ended', async () => {
    const { accessToken } = await connectorSignIn('acme.owner', PASSWORD);
    await mcp(accessToken!, 'tools/call', { name: 'get_company_info', arguments: { client_name: 'acme corp' } });
    await mcp(staffKey, 'tools/call', { name: 'create_class', arguments: { client_name: 'Beta LLC', name: 'Nope' } });
    await mcp(MASTER_KEY, 'tools/call', { name: 'list_clients', arguments: {} });

    const log = await qbo.activity.list();
    expect(log.map((e) => [e.userName, e.accountType, e.event, e.tool, e.writes, e.clientName, e.outcome])).toEqual([
      ['Master key', 'master', 'tool_call', 'list_clients', false, null, 'ok'],
      ['Jordan Staff', 'staff', 'tool_call', 'create_class', true, 'Beta LLC', 'denied'],
      ['Acme Owner', 'client', 'tool_call', 'get_company_info', false, 'Acme Corp', 'ok'],
      ['Acme Owner', 'client', 'sign_in', 'connector', false, null, 'ok'],
    ]);
    expect(log[2]).toMatchObject({ userId: clientId, realmId: 'realm-1' });
    expect(log[0].at.getTime()).toBeGreaterThan(Date.now() - 60_000);
  });

  it('never stores what was asked or what came back', async () => {
    await mcp(staffKey, 'tools/call', {
      name: 'query_transactions',
      arguments: { client_name: 'Acme Corp', query: "SELECT * FROM Invoice WHERE DocNumber = 'SECRET-MARKER-123'" },
    });
    const raw = ((qbo as any).db.db as Database.Database).prepare('SELECT * FROM activity_log').all();
    expect(raw).toHaveLength(1);
    expect(JSON.stringify(raw)).not.toContain('SECRET-MARKER');
    expect(JSON.stringify(raw)).not.toContain('Stub Co');
  });

  it('records failed sign-ins and lockouts', async () => {
    for (let i = 0; i <= MAX_LOGIN_FAILURES; i++) await connectorSignIn('acme.owner', 'wrong-password');
    const events = (await qbo.activity.list()).map((e) => [e.event, e.tool, e.userName, e.outcome]);
    expect(events[0]).toEqual(['locked_out', 'connector', 'acme.owner', 'denied']);
    expect(events.filter((e) => e[0] === 'sign_in_failed')).toHaveLength(MAX_LOGIN_FAILURES);
  });

  it('a logging failure never fails the call being logged', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    (qbo as any).db.insertActivity = async () => {
      throw new Error('disk full');
    };
    const res = await mcp(staffKey, 'tools/call', { name: 'get_company_info', arguments: { client_name: 'Acme Corp' } });
    expect(toolText(res)).toContain('Stub Co');
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('serves the log to admins only, with filters and paging', async () => {
    const { accessToken } = await connectorSignIn('acme.owner', PASSWORD);
    for (let i = 0; i < 3; i++) await mcp(accessToken!, 'tools/call', { name: 'get_company_info', arguments: { client_name: 'Acme Corp' } });
    await mcp(staffKey, 'tools/call', { name: 'get_company_info', arguments: { client_name: 'Beta LLC' } });

    const get = async (query: string, headers = asMaster) => app.inject({ method: 'GET', url: `/api/activity${query}`, headers });
    expect((await get('', { authorization: `Bearer ${staffKey}` })).statusCode).toBe(403);

    const all = (await get('')).json();
    expect(all).toHaveLength(5); // 1 sign-in + 3 client calls + 1 staff call
    expect(all[0]).toMatchObject({ userName: 'Jordan Staff', tool: 'get_company_info', clientName: 'Beta LLC', outcome: 'ok' });

    expect((await get(`?userId=${staffId}`)).json()).toHaveLength(1);
    expect((await get('?realmId=realm-1')).json()).toHaveLength(3);
    expect((await get('?accountType=client')).json()).toHaveLength(4);
    expect((await get(`?accountType=client&userId=${staffId}`)).json()).toHaveLength(0);

    const page1 = (await get('?limit=2')).json();
    const page2 = (await get(`?limit=2&before=${page1[1].id}`)).json();
    expect(page1.map((e: any) => e.id).concat(page2.map((e: any) => e.id))).toEqual(all.slice(0, 4).map((e: any) => e.id));

    for (const bad of ['?userId=abc', '?limit=0', '?before=-1', '?accountType=robot']) {
      expect((await get(bad)).statusCode, bad).toBe(400);
    }
  });

  it('drops entries older than the retention window', async () => {
    const raw = (qbo as any).db.db as Database.Database;
    const insertAt = (daysAgo: number) =>
      raw
        .prepare("INSERT INTO activity_log (at, user_name, account_type, event, outcome) VALUES (datetime('now', ?), 'old', 'staff', 'sign_in', 'ok')")
        .run(`-${daysAgo} days`);
    insertAt(ACTIVITY_RETENTION_DAYS + 5);
    insertAt(ACTIVITY_RETENTION_DAYS - 5);
    // The first record after startup also sweeps.
    await qbo.activity.record({ userId: null, userName: 'new', accountType: 'master', event: 'sign_in', outcome: 'ok' });
    expect((await qbo.activity.list()).map((e) => e.userName)).toEqual(['new', 'old']);
  });
});
