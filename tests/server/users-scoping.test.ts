import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import Fastify, { type FastifyInstance } from 'fastify';
import { QBOManager } from '../../src/index.js';
import { ConnectionDatabase } from '../../src/db/index.js';
import { hashApiKey, hashPassword, verifyPassword } from '../../src/users.js';
import { resolveAuth, createScopedManager, isRealmAllowed } from '../../src/server/auth.js';
import { usersRoutes } from '../../src/server/routes/users.js';
import { connectionsRoutes } from '../../src/server/routes/connections.js';
import { companyRoutes } from '../../src/server/routes/company.js';
import { authRoutes } from '../../src/server/routes/auth.js';
import { registerMcpRoutes } from '../../src/server/mcp.js';

const ENCRYPTION_KEY = 'a'.repeat(64);
const MASTER_KEY = 'master-key-for-tests';

function makeManager(): QBOManager {
  return new QBOManager({ dbPath: ':memory:', encryptionKey: ENCRYPTION_KEY });
}

async function addConnection(qbo: QBOManager, clientName: string, realmId: string): Promise<void> {
  const future = new Date(Date.now() + 60 * 60 * 1000);
  const farFuture = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000);
  await (qbo as any).tokenStore.storeConnection({
    clientName,
    realmId,
    accessToken: 'access-token',
    refreshToken: 'refresh-token',
    tokenExpiry: future,
    refreshExpiry: farFuture,
    scopes: ['com.intuit.quickbooks.accounting'],
  });
}

describe('UserService', () => {
  let qbo: QBOManager;

  beforeEach(async () => {
    qbo = makeManager();
    await addConnection(qbo, 'Acme Corp', 'realm-1');
    await addConnection(qbo, 'Beta LLC', 'realm-2');
  });

  afterEach(() => qbo.close());

  it('creates a user and returns the plaintext key exactly once', async () => {
    const { user, apiKey } = await qbo.users.create({ name: 'Jane', realmIds: ['realm-1'] });
    expect(apiKey).toMatch(/^qbo_[0-9a-f]{48}$/);
    expect(user.keyPrefix).toBe(apiKey.slice(0, 12));
    expect(user.role).toBe('member');
    expect(user.realmIds).toEqual(['realm-1']);
  });

  it('stores only the hash of the key', async () => {
    const { user, apiKey } = await qbo.users.create({ name: 'Jane' });
    const record = await (qbo as any).db.getUserById(user.id);
    expect(record.api_key_hash).toBe(hashApiKey(apiKey));
    expect(record.api_key_hash).not.toContain(apiKey);
  });

  it('finds active users by key and rejects disabled users', async () => {
    const { user, apiKey } = await qbo.users.create({ name: 'Jane' });
    expect((await qbo.users.findByApiKey(apiKey))?.id).toBe(user.id);

    await qbo.users.update(user.id, { status: 'disabled' });
    expect(await qbo.users.findByApiKey(apiKey)).toBeNull();

    await qbo.users.update(user.id, { status: 'active' });
    expect((await qbo.users.findByApiKey(apiKey))?.id).toBe(user.id);
  });

  it('rejects unknown keys', async () => {
    expect(await qbo.users.findByApiKey('qbo_' + 'f'.repeat(48))).toBeNull();
    expect(await qbo.users.findByApiKey('')).toBeNull();
  });

  it('rotates keys, invalidating the old one immediately', async () => {
    const { user, apiKey: oldKey } = await qbo.users.create({ name: 'Jane' });
    const rotated = (await qbo.users.rotateKey(user.id))!;
    expect(rotated.apiKey).not.toBe(oldKey);
    expect(await qbo.users.findByApiKey(oldKey)).toBeNull();
    expect((await qbo.users.findByApiKey(rotated.apiKey))?.id).toBe(user.id);
  });

  it('replaces client assignments with setClients', async () => {
    const { user } = await qbo.users.create({ name: 'Jane', realmIds: ['realm-1'] });
    await qbo.users.setClients(user.id, ['realm-2']);
    expect((await qbo.users.get(user.id))?.realmIds).toEqual(['realm-2']);
    await qbo.users.setClients(user.id, []);
    expect((await qbo.users.get(user.id))?.realmIds).toEqual([]);
  });

  it('sets the full user set for a client with setClientUsers', async () => {
    const jane = (await qbo.users.create({ name: 'Jane', realmIds: ['realm-1'] })).user;
    const bob = (await qbo.users.create({ name: 'Bob', realmIds: [] })).user;

    // Grant realm-1 to Bob and revoke it from Jane in one call
    await qbo.users.setClientUsers('realm-1', [bob.id]);
    expect((await qbo.users.get(jane.id))?.realmIds).toEqual([]);
    expect((await qbo.users.get(bob.id))?.realmIds).toEqual(['realm-1']);

    // Grant to both
    await qbo.users.setClientUsers('realm-1', [jane.id, bob.id]);
    expect((await qbo.users.get(jane.id))?.realmIds).toEqual(['realm-1']);
    expect((await qbo.users.get(bob.id))?.realmIds).toEqual(['realm-1']);

    // Revoke from everyone
    await qbo.users.setClientUsers('realm-1', []);
    expect((await qbo.users.get(jane.id))?.realmIds).toEqual([]);
    expect((await qbo.users.get(bob.id))?.realmIds).toEqual([]);
  });

  it('setClientUsers only touches the target realm', async () => {
    const jane = (await qbo.users.create({ name: 'Jane', realmIds: ['realm-1', 'realm-2'] })).user;
    await qbo.users.setClientUsers('realm-1', []); // drop realm-1 access for all
    expect((await qbo.users.get(jane.id))?.realmIds).toEqual(['realm-2']); // realm-2 untouched
  });

  it('removes users and cascades their assignments', async () => {
    const { user } = await qbo.users.create({ name: 'Jane', realmIds: ['realm-1', 'realm-2'] });
    expect(await qbo.users.remove(user.id)).toBe(true);
    expect(await qbo.users.get(user.id)).toBeNull();
    expect(await (qbo as any).db.getUserRealms(user.id)).toEqual([]);
  });

  it('drops assignments when a connection is revoked', async () => {
    const { user } = await qbo.users.create({ name: 'Jane', realmIds: ['realm-1', 'realm-2'] });
    await qbo.revokeConnection('realm-1');
    expect((await qbo.users.get(user.id))?.realmIds).toEqual(['realm-2']);
  });
});

describe('reconnect (re-authorization in place)', () => {
  let qbo: QBOManager;

  beforeEach(async () => {
    qbo = makeManager();
    await addConnection(qbo, 'Acme Corp', 'realm-1');
  });

  afterEach(() => qbo.close());

  async function reAuthorize(realmId: string, clientName: string): Promise<void> {
    // Mirrors what the OAuth callback does after a fresh token exchange.
    const now = Date.now();
    await (qbo as any).tokenStore.storeConnection({
      clientName,
      realmId,
      accessToken: 'new-access',
      refreshToken: 'new-refresh',
      tokenExpiry: new Date(now + 60 * 60 * 1000),
      refreshExpiry: new Date(now + 100 * 24 * 60 * 60 * 1000),
      scopes: ['com.intuit.quickbooks.accounting'],
    });
  }

  it('does not throw when re-authorizing an already-connected realm', async () => {
    await expect(reAuthorize('realm-1', 'Acme Corp')).resolves.not.toThrow();
    // Still exactly one connection for that realm
    expect((await qbo.listConnections()).filter((c) => c.realmId === 'realm-1')).toHaveLength(1);
  });

  it('flips an expired connection back to active and refreshes its tokens', async () => {
    await (qbo as any).tokenStore.updateStatus('realm-1', 'expired');
    expect((await qbo.getConnection('realm-1'))?.status).toBe('expired');

    await reAuthorize('realm-1', 'Acme Corp');

    const conn = await qbo.getConnection('realm-1');
    expect(conn?.status).toBe('active');
    expect(conn?.refreshToken).toBe('new-refresh');
  });

  it('preserves member assignments across a reconnect', async () => {
    const { user } = await qbo.users.create({ name: 'Jane', realmIds: ['realm-1'] });
    await (qbo as any).tokenStore.updateStatus('realm-1', 'expired');

    await reAuthorize('realm-1', 'Acme Corp');

    expect((await qbo.users.get(user.id))?.realmIds).toEqual(['realm-1']);
  });

  it('preserves an edited name across a reconnect', async () => {
    await qbo.renameConnection('realm-1', 'Acme Corporation (edited)');
    await reAuthorize('realm-1', 'Acme Corp'); // callback passes the old state name
    expect((await qbo.getConnection('realm-1'))?.clientName).toBe('Acme Corporation (edited)');
  });
});

describe('rename connection', () => {
  let qbo: QBOManager;

  beforeEach(async () => {
    qbo = makeManager();
    await addConnection(qbo, 'Acme Corp', 'realm-1');
  });

  afterEach(() => qbo.close());

  it('updates the display label without touching realm or assignments', async () => {
    const { user } = await qbo.users.create({ name: 'Jane', realmIds: ['realm-1'] });
    await qbo.renameConnection('realm-1', 'Renamed Co');
    expect((await qbo.getConnection('realm-1'))?.clientName).toBe('Renamed Co');
    expect((await qbo.getConnection('realm-1'))?.realmId).toBe('realm-1');
    expect((await qbo.users.get(user.id))?.realmIds).toEqual(['realm-1']);
  });
});

describe('resolveAuth', () => {
  let qbo: QBOManager;

  beforeEach(async () => {
    qbo = makeManager();
    await addConnection(qbo, 'Acme Corp', 'realm-1');
    await addConnection(qbo, 'Beta LLC', 'realm-2');
  });

  afterEach(() => qbo.close());

  it('resolves the master key to an all-realm admin scope', async () => {
    const scope = (await resolveAuth(qbo, MASTER_KEY, `Bearer ${MASTER_KEY}`))!;
    expect(scope.kind).toBe('master');
    expect(scope.role).toBe('admin');
    expect(scope.allRealms).toBe(true);
    expect(isRealmAllowed(scope, 'anything')).toBe(true);
  });

  it('resolves a member key to their assigned realms only', async () => {
    const { apiKey } = await qbo.users.create({ name: 'Jane', realmIds: ['realm-1'] });
    const scope = (await resolveAuth(qbo, MASTER_KEY, `Bearer ${apiKey}`))!;
    expect(scope.kind).toBe('user');
    expect(scope.role).toBe('member');
    expect(isRealmAllowed(scope, 'realm-1')).toBe(true);
    expect(isRealmAllowed(scope, 'realm-2')).toBe(false);
  });

  it('gives admin-role users all realms', async () => {
    const { apiKey } = await qbo.users.create({ name: 'Boss', role: 'admin' });
    const scope = (await resolveAuth(qbo, MASTER_KEY, `Bearer ${apiKey}`))!;
    expect(scope.allRealms).toBe(true);
    expect(scope.role).toBe('admin');
  });

  it('accepts the ?key= query param and raw header token', async () => {
    const { apiKey } = await qbo.users.create({ name: 'Jane', realmIds: ['realm-1'] });
    expect((await resolveAuth(qbo, MASTER_KEY, undefined, apiKey))?.kind).toBe('user');
    expect((await resolveAuth(qbo, MASTER_KEY, apiKey))?.kind).toBe('user');
  });

  it('rejects missing, wrong, and disabled keys', async () => {
    const { user, apiKey } = await qbo.users.create({ name: 'Jane' });
    expect(await resolveAuth(qbo, MASTER_KEY, undefined)).toBeNull();
    expect(await resolveAuth(qbo, MASTER_KEY, 'Bearer wrong')).toBeNull();
    await qbo.users.update(user.id, { status: 'disabled' });
    expect(await resolveAuth(qbo, MASTER_KEY, `Bearer ${apiKey}`)).toBeNull();
  });

  it('does not treat an empty master key as valid', async () => {
    expect(await resolveAuth(qbo, '', 'Bearer ')).toBeNull();
    expect(await resolveAuth(qbo, '', undefined, '')).toBeNull();
  });

  it('handles duplicated ?key= params (array) without throwing', async () => {
    const { apiKey } = await qbo.users.create({ name: 'Jane', realmIds: ['realm-1'] });
    await expect(resolveAuth(qbo, MASTER_KEY, undefined, ['foo', 'bar'])).resolves.not.toThrow();
    expect(await resolveAuth(qbo, MASTER_KEY, undefined, ['foo', 'bar'])).toBeNull();
    // First element of a duplicated param is honored if it's a real key
    expect((await resolveAuth(qbo, MASTER_KEY, undefined, [apiKey, 'junk']))?.kind).toBe('user');
    // Non-string shapes are ignored, not crashed on
    expect(await resolveAuth(qbo, MASTER_KEY, undefined, { evil: true } as unknown)).toBeNull();
  });

  it('falls back to a valid Authorization header when the query key is stale', async () => {
    const scope = await resolveAuth(qbo, MASTER_KEY, `Bearer ${MASTER_KEY}`, 'stale-rotated-key');
    expect(scope?.kind).toBe('master');
  });
});

describe('user timestamps', () => {
  let qbo: QBOManager;

  beforeEach(async () => {
    qbo = makeManager();
  });

  afterEach(() => qbo.close());

  it('parses SQLite UTC timestamps as UTC', async () => {
    const { user } = await qbo.users.create({ name: 'Jane' });
    (qbo as any).db['db']
      .prepare("UPDATE users SET last_used_at = '2020-01-02 03:04:05' WHERE id = ?")
      .run(user.id);
    expect((await qbo.users.get(user.id))?.lastUsedAt?.toISOString()).toBe('2020-01-02T03:04:05.000Z');
  });

  it('does not clobber updated_at when only last_used_at is touched', async () => {
    const { user, apiKey } = await qbo.users.create({ name: 'Jane' });
    const raw = (qbo as any).db['db'];
    raw.prepare("UPDATE users SET updated_at = '2020-01-01 00:00:00' WHERE id = ?").run(user.id);

    await qbo.users.findByApiKey(apiKey); // touches last_used_at
    const after = raw.prepare('SELECT updated_at, last_used_at FROM users WHERE id = ?').get(user.id);
    expect(after.updated_at).toBe('2020-01-01 00:00:00');
    expect(after.last_used_at).not.toBeNull();

    await qbo.users.update(user.id, { name: 'Janet' }); // admin change DOES bump it
    const bumped = raw.prepare('SELECT updated_at FROM users WHERE id = ?').get(user.id);
    expect(bumped.updated_at).not.toBe('2020-01-01 00:00:00');
  });

  it('throttles last_used_at writes for steady traffic', async () => {
    const { user, apiKey } = await qbo.users.create({ name: 'Jane' });
    const raw = (qbo as any).db['db'];

    await qbo.users.findByApiKey(apiKey);
    const first = raw.prepare('SELECT last_used_at FROM users WHERE id = ?').get(user.id).last_used_at;
    expect(first).not.toBeNull();

    // Within the throttle window: no rewrite even if the stored value is distinctive
    raw.prepare("UPDATE users SET last_used_at = datetime('now', '-10 seconds') WHERE id = ?").run(user.id);
    const marker = raw.prepare('SELECT last_used_at FROM users WHERE id = ?').get(user.id).last_used_at;
    await qbo.users.findByApiKey(apiKey);
    expect(raw.prepare('SELECT last_used_at FROM users WHERE id = ?').get(user.id).last_used_at).toBe(marker);

    // Outside the window: touched again
    raw.prepare("UPDATE users SET last_used_at = '2020-01-01 00:00:00' WHERE id = ?").run(user.id);
    await qbo.users.findByApiKey(apiKey);
    expect(raw.prepare('SELECT last_used_at FROM users WHERE id = ?').get(user.id).last_used_at).not.toBe('2020-01-01 00:00:00');
  });
});

describe('createScopedManager', () => {
  let qbo: QBOManager;

  beforeEach(async () => {
    qbo = makeManager();
    await addConnection(qbo, 'Acme Corp', 'realm-1');
    await addConnection(qbo, 'Beta LLC', 'realm-2');
  });

  afterEach(() => qbo.close());

  async function memberScope(realmIds: string[]) {
    const { apiKey } = await qbo.users.create({ name: 'Jane', realmIds });
    return (await resolveAuth(qbo, MASTER_KEY, `Bearer ${apiKey}`))!;
  }

  it('filters listConnections to assigned realms', async () => {
    const scoped = createScopedManager(qbo, await memberScope(['realm-2']));
    const names = (await scoped.listConnections()).map((c) => c.clientName);
    expect(names).toEqual(['Beta LLC']);
  });

  it('shows everything to the master scope', async () => {
    const scope = (await resolveAuth(qbo, MASTER_KEY, `Bearer ${MASTER_KEY}`))!;
    const scoped = createScopedManager(qbo, scope);
    expect(await scoped.listConnections()).toHaveLength(2);
  });

  it('blocks API namespace calls for unassigned realms', async () => {
    const scoped = createScopedManager(qbo, await memberScope(['realm-1']));
    const spy = vi.fn().mockResolvedValue({ CompanyName: 'Acme' });
    (qbo.company as any).getInfo = spy;

    await expect(scoped.company.getInfo('realm-1')).resolves.toEqual({ CompanyName: 'Acme' });
    expect(() => scoped.company.getInfo('realm-2')).toThrow(/not assigned/i);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('guards every namespace exposed to MCP tools', async () => {
    const scoped = createScopedManager(qbo, await memberScope([]));
    expect(() => (scoped.reports as any).profitAndLoss('realm-1', {})).toThrow(/not assigned/i);
    expect(() => (scoped.transactions as any).queryInvoices('realm-1', {})).toThrow(/not assigned/i);
    expect(() => (scoped.journalEntries as any).create('realm-1', {})).toThrow(/not assigned/i);
    expect(() => (scoped.accounts as any).getAll('realm-1')).toThrow(/not assigned/i);
    expect(() => (scoped.banking as any).getDeposit('realm-1', '1')).toThrow(/not assigned/i);
    expect(() => (scoped.lists as any).getItems('realm-1')).toThrow(/not assigned/i);
    expect(await scoped.getConnection('realm-1')).toBeNull();
  });
});

describe('HTTP routes', () => {
  let qbo: QBOManager;
  let app: FastifyInstance;
  let baseUrl: string;
  let memberKey: string;
  let memberId: number;

  beforeEach(async () => {
    qbo = makeManager();
    await addConnection(qbo, 'Acme Corp', 'realm-1');
    await addConnection(qbo, 'Beta LLC', 'realm-2');
    const created = await qbo.users.create({ name: 'Jane', realmIds: ['realm-1'] });
    memberKey = created.apiKey;
    memberId = created.user.id;

    app = Fastify({ logger: false });
    await connectionsRoutes(app, qbo, MASTER_KEY);
    await companyRoutes(app, qbo, MASTER_KEY);
    await usersRoutes(app, qbo, MASTER_KEY);
    await registerMcpRoutes(app, qbo, MASTER_KEY);
    // Real listener: the MCP transport's socket handling (destroySoon) is
    // incompatible with inject()'s mock sockets. API-route tests still inject.
    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address();
    baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  });

  afterEach(async () => {
    await app.close();
    qbo.close();
  });

  const asMaster = { authorization: `Bearer ${MASTER_KEY}` };
  const asMember = () => ({ authorization: `Bearer ${memberKey}` });

  it('rejects unauthenticated requests', async () => {
    for (const url of ['/api/connections', '/api/me', '/api/users']) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode).toBe(401);
    }
  });

  it('filters /api/connections by scope', async () => {
    const masterRes = await app.inject({ method: 'GET', url: '/api/connections', headers: asMaster });
    expect(masterRes.json()).toHaveLength(2);

    const memberRes = await app.inject({ method: 'GET', url: '/api/connections', headers: asMember() });
    const visible = memberRes.json();
    expect(visible).toHaveLength(1);
    expect(visible[0].clientName).toBe('Acme Corp');
  });

  it('describes the caller via /api/me', async () => {
    const masterMe = (await app.inject({ method: 'GET', url: '/api/me', headers: asMaster })).json();
    expect(masterMe.kind).toBe('master');
    expect(masterMe.allClients).toBe(true);

    const memberMe = (await app.inject({ method: 'GET', url: '/api/me', headers: asMember() })).json();
    expect(memberMe.kind).toBe('user');
    expect(memberMe.name).toBe('Jane');
    expect(memberMe.clients).toEqual([{ realmId: 'realm-1', clientName: 'Acme Corp' }]);
  });

  it('hides unassigned companies from member data routes', async () => {
    (qbo.company as any).getInfo = vi.fn().mockResolvedValue({ CompanyName: 'Acme' });

    const allowed = await app.inject({ method: 'GET', url: '/api/company/realm-1/info', headers: asMember() });
    expect(allowed.statusCode).toBe(200);

    const denied = await app.inject({ method: 'GET', url: '/api/company/realm-2/info', headers: asMember() });
    expect(denied.statusCode).toBe(404);

    const masterOk = await app.inject({ method: 'GET', url: '/api/company/realm-2/info', headers: asMaster });
    expect(masterOk.statusCode).toBe(200);
  });

  it('locks user management and connection writes to admins', async () => {
    const routes = [
      { method: 'GET' as const, url: '/api/users' },
      { method: 'POST' as const, url: '/api/users', body: { name: 'X' } },
      { method: 'PATCH' as const, url: `/api/users/${memberId}`, body: { name: 'X' } },
      { method: 'POST' as const, url: `/api/users/${memberId}/rotate-key` },
      { method: 'DELETE' as const, url: `/api/users/${memberId}` },
      { method: 'POST' as const, url: '/api/connections/auth-url', body: { clientName: 'X' } },
      { method: 'DELETE' as const, url: '/api/connections/realm-1' },
    ];
    for (const route of routes) {
      const res = await app.inject({
        method: route.method,
        url: route.url,
        headers: asMember(),
        ...(route.body ? { payload: route.body } : {}),
      });
      expect(res.statusCode, `${route.method} ${route.url}`).toBe(403);
    }
  });

  it('renames a connection (admin only)', async () => {
    const denied = await app.inject({
      method: 'PATCH',
      url: '/api/connections/realm-1',
      headers: asMember(),
      payload: { clientName: 'Hacked' },
    });
    expect(denied.statusCode).toBe(403);

    const ok = await app.inject({
      method: 'PATCH',
      url: '/api/connections/realm-1',
      headers: asMaster,
      payload: { clientName: 'Acme Renamed' },
    });
    expect(ok.statusCode).toBe(200);

    const list = (await app.inject({ method: 'GET', url: '/api/connections', headers: asMaster })).json();
    expect(list.find((c: any) => c.realmId === 'realm-1').clientName).toBe('Acme Renamed');
  });

  it('edits a client’s user access (admin only)', async () => {
    const bob = (await qbo.users.create({ name: 'Bob', realmIds: [] })).user;

    // Member can't edit access
    const denied = await app.inject({
      method: 'PUT',
      url: '/api/connections/realm-1/users',
      headers: asMember(),
      payload: { userIds: [bob.id] },
    });
    expect(denied.statusCode).toBe(403);

    // Admin grants realm-1 to Bob and revokes from Jane (the member)
    const ok = await app.inject({
      method: 'PUT',
      url: '/api/connections/realm-1/users',
      headers: asMaster,
      payload: { userIds: [bob.id] },
    });
    expect(ok.statusCode).toBe(200);
    expect((await qbo.users.get(bob.id))?.realmIds).toEqual(['realm-1']);
    expect((await qbo.users.get(memberId))?.realmIds).toEqual([]);
  });

  it('validates the user access payload', async () => {
    const badBody = await app.inject({
      method: 'PUT',
      url: '/api/connections/realm-1/users',
      headers: asMaster,
      payload: { userIds: 'nope' },
    });
    expect(badBody.statusCode).toBe(400);

    const unknownUser = await app.inject({
      method: 'PUT',
      url: '/api/connections/realm-1/users',
      headers: asMaster,
      payload: { userIds: [99999] },
    });
    expect(unknownUser.statusCode).toBe(400);

    const missingRealm = await app.inject({
      method: 'PUT',
      url: '/api/connections/realm-nope/users',
      headers: asMaster,
      payload: { userIds: [] },
    });
    expect(missingRealm.statusCode).toBe(404);
  });

  it('rejects an empty rename and unknown realm', async () => {
    const empty = await app.inject({
      method: 'PATCH',
      url: '/api/connections/realm-1',
      headers: asMaster,
      payload: { clientName: '  ' },
    });
    expect(empty.statusCode).toBe(400);

    const missing = await app.inject({
      method: 'PATCH',
      url: '/api/connections/realm-does-not-exist',
      headers: asMaster,
      payload: { clientName: 'X' },
    });
    expect(missing.statusCode).toBe(404);
  });

  it('creates users with assignments over HTTP and returns the key once', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/users',
      headers: asMaster,
      payload: { name: 'Bob', email: 'bob@x.com', realmIds: ['realm-2'] },
    });
    expect(res.statusCode).toBe(201);
    const { user, apiKey } = res.json();
    expect(apiKey).toMatch(/^qbo_/);
    expect(user.clients).toEqual([{ realmId: 'realm-2', clientName: 'Beta LLC' }]);

    const list = (await app.inject({ method: 'GET', url: '/api/users', headers: asMaster })).json();
    expect(list.map((u: any) => u.name).sort()).toEqual(['Bob', 'Jane']);
    expect(JSON.stringify(list)).not.toContain(apiKey);
  });

  it('rejects assignments to unknown realms', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/users',
      headers: asMaster,
      payload: { name: 'Bob', realmIds: ['realm-999'] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain('realm-999');
  });

  it('updates assignments and status via PATCH', async () => {
    const patch = await app.inject({
      method: 'PATCH',
      url: `/api/users/${memberId}`,
      headers: asMaster,
      payload: { realmIds: ['realm-1', 'realm-2'], status: 'disabled' },
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json().user.clients).toHaveLength(2);

    // Disabled member's key stops working
    const res = await app.inject({ method: 'GET', url: '/api/connections', headers: asMember() });
    expect(res.statusCode).toBe(401);
  });

  it('requires a valid key on /mcp', async () => {
    const noKey = await app.inject({ method: 'POST', url: '/mcp', payload: {} });
    expect(noKey.statusCode).toBe(401);

    const badKey = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { authorization: 'Bearer nope' },
      payload: {},
    });
    expect(badKey.statusCode).toBe(401);

    const queryKey = await fetch(`${baseUrl}/mcp?key=${memberKey}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: '{}',
    });
    expect(queryKey.status).not.toBe(401);
    await queryKey.text().catch(() => {});
  });

  it('returns 401 (not 500) for duplicated ?key= params', async () => {
    for (const url of ['/api/connections?key=foo&key=bar', '/mcp?key=foo&key=bar']) {
      const res = await app.inject({ method: url.startsWith('/mcp') ? 'POST' : 'GET', url, payload: url.startsWith('/mcp') ? {} : undefined });
      expect(res.statusCode, url).toBe(401);
    }
  });

  it('honors a valid Authorization header despite a stale ?key=', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/connections?key=stale-old-key',
      headers: asMaster,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveLength(2);
  });
});

describe('per-member access levels (read / read_write)', () => {
  let qbo: QBOManager;

  beforeEach(async () => {
    qbo = makeManager();
    await addConnection(qbo, 'Acme Corp', 'realm-1');
  });

  afterEach(() => qbo.close());

  it('defaults new users to read_write', async () => {
    const { user } = await qbo.users.create({ name: 'Jane' });
    expect(user.accessLevel).toBe('read_write');
  });

  it('creates and updates read-only users', async () => {
    const { user } = await qbo.users.create({ name: 'Reader', accessLevel: 'read' });
    expect(user.accessLevel).toBe('read');
    expect((await qbo.users.update(user.id, { accessLevel: 'read_write' }))?.accessLevel).toBe('read_write');
    expect((await qbo.users.update(user.id, { accessLevel: 'read' }))?.accessLevel).toBe('read');
  });

  it('resolveAuth maps access levels to canWrite', async () => {
    const writer = await qbo.users.create({ name: 'Writer', realmIds: ['realm-1'] });
    const reader = await qbo.users.create({ name: 'Reader', accessLevel: 'read', realmIds: ['realm-1'] });
    const adminReader = await qbo.users.create({ name: 'AdminReader', role: 'admin', accessLevel: 'read' });

    expect((await resolveAuth(qbo, MASTER_KEY, `Bearer ${MASTER_KEY}`))?.canWrite).toBe(true);
    expect((await resolveAuth(qbo, MASTER_KEY, `Bearer ${writer.apiKey}`))?.canWrite).toBe(true);
    expect((await resolveAuth(qbo, MASTER_KEY, `Bearer ${reader.apiKey}`))?.canWrite).toBe(false);
    // Admins always write — they could grant themselves access anyway.
    expect((await resolveAuth(qbo, MASTER_KEY, `Bearer ${adminReader.apiKey}`))?.canWrite).toBe(true);
  });

  it('adds the access_level column to databases created before it existed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'qbo-migrate-'));
    const dbPath = join(dir, 'old.db');
    try {
      // Recreate the pre-access_level users table by hand, with a row in it.
      const raw = new Database(dbPath);
      raw.exec(`CREATE TABLE users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        email TEXT,
        role TEXT NOT NULL DEFAULT 'member' CHECK(role IN ('admin', 'member')),
        api_key_hash TEXT NOT NULL UNIQUE,
        key_prefix TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'disabled')),
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        last_used_at DATETIME
      )`);
      raw.prepare(
        "INSERT INTO users (name, role, api_key_hash, key_prefix) VALUES ('Old Jane', 'member', 'hash-1', 'qbo_old')"
      ).run();
      raw.close();

      // Booting the real database class must migrate without losing the row.
      const db = new ConnectionDatabase(dbPath);
      const record = (await db.getAllUsers())[0];
      expect(record.name).toBe('Old Jane');
      expect(record.access_level).toBe('read_write');
      await db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('access level over HTTP and MCP', () => {
  let qbo: QBOManager;
  let app: FastifyInstance;
  let baseUrl: string;
  let writerKey: string;
  let readerKey: string;
  let readerId: number;

  beforeEach(async () => {
    qbo = makeManager();
    await addConnection(qbo, 'Acme Corp', 'realm-1');
    const writer = await qbo.users.create({ name: 'Writer', realmIds: ['realm-1'] });
    const reader = await qbo.users.create({ name: 'Reader', accessLevel: 'read', realmIds: ['realm-1'] });
    writerKey = writer.apiKey;
    readerKey = reader.apiKey;
    readerId = reader.user.id;

    app = Fastify({ logger: false });
    await connectionsRoutes(app, qbo, MASTER_KEY);
    await companyRoutes(app, qbo, MASTER_KEY);
    await usersRoutes(app, qbo, MASTER_KEY);
    await registerMcpRoutes(app, qbo, MASTER_KEY);
    // The MCP transport manages raw sockets (timers call socket.destroySoon,
    // which inject()'s mock sockets lack) — use a real listener for /mcp.
    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address();
    baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  });

  afterEach(async () => {
    await app.close();
    qbo.close();
  });

  const asMaster = { authorization: `Bearer ${MASTER_KEY}` };

  // The /mcp endpoint is stateless streamable-HTTP: each POST gets a fresh
  // server, and responses may arrive as JSON or as an SSE stream.
  async function mcpToolNames(key: string): Promise<string[]> {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${key}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    const chunks = text.trimStart().startsWith('{')
      ? [text]
      : text
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trim());
    for (const chunk of chunks) {
      const parsed = JSON.parse(chunk);
      if (parsed?.result?.tools) return parsed.result.tools.map((t: { name: string }) => t.name);
      if (parsed?.error) throw new Error(`MCP error: ${parsed.error.message}`);
    }
    throw new Error(`No tools/list result in response: ${text.slice(0, 200)}`);
  }

  it('accepts accessLevel on create and PATCH, and rejects invalid values', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/users',
      headers: asMaster,
      payload: { name: 'Ro', accessLevel: 'read' },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().user.accessLevel).toBe('read');

    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/users/${readerId}`,
      headers: asMaster,
      payload: { accessLevel: 'read_write' },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().user.accessLevel).toBe('read_write');

    const invalid = await app.inject({
      method: 'POST',
      url: '/api/users',
      headers: asMaster,
      payload: { name: 'Bad', accessLevel: 'admin' },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().message).toContain('accessLevel');
  });

  it('reports canWrite via /api/me', async () => {
    const masterMe = (await app.inject({ method: 'GET', url: '/api/me', headers: asMaster })).json();
    expect(masterMe.canWrite).toBe(true);

    const writerMe = (await app.inject({
      method: 'GET', url: '/api/me', headers: { authorization: `Bearer ${writerKey}` },
    })).json();
    expect(writerMe.canWrite).toBe(true);

    const readerMe = (await app.inject({
      method: 'GET', url: '/api/me', headers: { authorization: `Bearer ${readerKey}` },
    })).json();
    expect(readerMe.canWrite).toBe(false);
  });

  it('hides every write tool from read-only keys on /mcp', async () => {
    const writerTools = await mcpToolNames(writerKey);
    const readerTools = await mcpToolNames(readerKey);

    const isRead = (name: string) =>
      name.startsWith('get_') || name.startsWith('list_') || name === 'query_transactions';

    // Writer sees both kinds.
    expect(writerTools).toContain('create_journal_entry');
    expect(writerTools).toContain('delete_invoice');
    expect(writerTools).toContain('get_profit_and_loss');

    // Reader sees only reads — and ALL of the reads the writer sees.
    expect(readerTools.length).toBeGreaterThan(0);
    expect(readerTools.every(isRead)).toBe(true);
    expect(readerTools.sort()).toEqual(writerTools.filter(isRead).sort());
    expect(readerTools).toContain('list_clients');
    expect(readerTools).toContain('get_general_ledger');
    expect(readerTools).toContain('query_transactions');
  });

  it('keeps full tools for the master key', async () => {
    const tools = await mcpToolNames(MASTER_KEY);
    expect(tools).toContain('create_journal_entry');
    expect(tools).toContain('get_profit_and_loss');
  });
});

describe('username/password sign-in', () => {
  let qbo: QBOManager;
  let app: FastifyInstance;
  let janeKey: string;
  let janeId: number;

  beforeEach(async () => {
    qbo = makeManager();
    await addConnection(qbo, 'Acme Corp', 'realm-1');
    const jane = await qbo.users.create({
      name: 'Jane',
      username: 'Jane.Smith', // normalizes to lowercase
      password: 'correct-horse-1',
      realmIds: ['realm-1'],
    });
    janeKey = jane.apiKey;
    janeId = jane.user.id;

    app = Fastify({ logger: false });
    await connectionsRoutes(app, qbo, MASTER_KEY);
    await companyRoutes(app, qbo, MASTER_KEY);
    await usersRoutes(app, qbo, MASTER_KEY);
    await authRoutes(app, qbo, MASTER_KEY);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    qbo.close();
  });

  const asMaster = { authorization: `Bearer ${MASTER_KEY}` };

  async function login(username: string, password: string) {
    return app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password } });
  }

  it('hashes and verifies passwords', async () => {
    const hash = hashPassword('a-strong-password');
    expect(hash).toMatch(/^scrypt:/);
    expect(hash).not.toContain('a-strong-password');
    expect(verifyPassword('a-strong-password', hash)).toBe(true);
    expect(verifyPassword('wrong', hash)).toBe(false);
  });

  it('logs in with username/password and the session token authenticates requests', async () => {
    const res = await login('jane.smith', 'correct-horse-1');
    expect(res.statusCode).toBe(200);
    const { token, expiresAt } = res.json();
    expect(token).toMatch(/^qbos_/);
    expect(new Date(expiresAt).getTime()).toBeGreaterThan(Date.now());

    const meRes = await app.inject({ method: 'GET', url: '/api/me', headers: { authorization: `Bearer ${token}` } });
    expect(meRes.statusCode).toBe(200);
    const meData = meRes.json();
    expect(meData.name).toBe('Jane');
    expect(meData.username).toBe('jane.smith');
    expect(meData.hasPassword).toBe(true);
    expect(meData.clients).toEqual([{ realmId: 'realm-1', clientName: 'Acme Corp' }]);
  });

  it('login is case-insensitive on username and rejects bad credentials', async () => {
    expect((await login('JANE.SMITH', 'correct-horse-1')).statusCode).toBe(200);
    expect((await login('jane.smith', 'wrong-password')).statusCode).toBe(401);
    expect((await login('nobody', 'correct-horse-1')).statusCode).toBe(401);
  });

  it('rejects disabled users even with correct credentials', async () => {
    await qbo.users.update(janeId, { status: 'disabled' });
    expect((await login('jane.smith', 'correct-horse-1')).statusCode).toBe(401);
  });

  it('throttles after repeated failures', async () => {
    for (let i = 0; i < 5; i++) {
      expect((await login('jane.smith', 'wrong')).statusCode).toBe(401);
    }
    expect((await login('jane.smith', 'correct-horse-1')).statusCode).toBe(429);
  });

  it('logout invalidates the session token', async () => {
    const { token } = (await login('jane.smith', 'correct-horse-1')).json();
    const auth = { authorization: `Bearer ${token}` };
    expect((await app.inject({ method: 'GET', url: '/api/me', headers: auth })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/api/auth/logout', headers: auth })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/me', headers: auth })).statusCode).toBe(401);
  });

  it('expired sessions stop authenticating', async () => {
    const { token } = (await login('jane.smith', 'correct-horse-1')).json();
    (qbo as any).db.db
      .prepare("UPDATE sessions SET expires_at = datetime('now', '-1 minute')")
      .run();
    const res = await app.inject({ method: 'GET', url: '/api/me', headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(401);
  });

  it('serves the caller their own API key via /api/me/key', async () => {
    // Session-authenticated: decrypted from storage.
    const { token } = (await login('jane.smith', 'correct-horse-1')).json();
    const viaSession = await app.inject({ method: 'GET', url: '/api/me/key', headers: { authorization: `Bearer ${token}` } });
    expect(viaSession.json()).toMatchObject({ apiKey: janeKey, retrievable: true });

    // Key-authenticated: echoed back.
    const viaKey = await app.inject({ method: 'GET', url: '/api/me/key', headers: { authorization: `Bearer ${janeKey}` } });
    expect(viaKey.json().apiKey).toBe(janeKey);

    // Master: the master key itself.
    const viaMaster = await app.inject({ method: 'GET', url: '/api/me/key', headers: asMaster });
    expect(viaMaster.json().apiKey).toBe(MASTER_KEY);
  });

  it('backfills retrievable storage for legacy keys on key auth', async () => {
    // Simulate a key created before api_key_encrypted existed.
    (qbo as any).db.db.prepare('UPDATE users SET api_key_encrypted = NULL WHERE id = ?').run(janeId);
    const { token } = (await login('jane.smith', 'correct-horse-1')).json();
    const before = await app.inject({ method: 'GET', url: '/api/me/key', headers: { authorization: `Bearer ${token}` } });
    expect(before.json()).toMatchObject({ apiKey: null, retrievable: false });

    // One authenticated request with the key itself heals it…
    await app.inject({ method: 'GET', url: '/api/me', headers: { authorization: `Bearer ${janeKey}` } });
    const after = await app.inject({ method: 'GET', url: '/api/me/key', headers: { authorization: `Bearer ${token}` } });
    expect(after.json()).toMatchObject({ apiKey: janeKey, retrievable: true });
  });

  it('key rotation updates the retrievable copy', async () => {
    const rotated = (await qbo.users.rotateKey(janeId))!;
    expect(await qbo.users.getApiKey(janeId)).toBe(rotated.apiKey);
  });

  it('self-service password change requires the current password and ends other sessions', async () => {
    const sessionA = (await login('jane.smith', 'correct-horse-1')).json().token;
    const sessionB = (await login('jane.smith', 'correct-horse-1')).json().token;

    const wrongCurrent = await app.inject({
      method: 'POST',
      url: '/api/me/password',
      headers: { authorization: `Bearer ${sessionA}` },
      payload: { currentPassword: 'nope', newPassword: 'brand-new-pass-2' },
    });
    expect(wrongCurrent.statusCode).toBe(403);

    const ok = await app.inject({
      method: 'POST',
      url: '/api/me/password',
      headers: { authorization: `Bearer ${sessionA}` },
      payload: { currentPassword: 'correct-horse-1', newPassword: 'brand-new-pass-2' },
    });
    expect(ok.statusCode).toBe(200);

    // The changing session survives; the other one is revoked.
    expect((await app.inject({ method: 'GET', url: '/api/me', headers: { authorization: `Bearer ${sessionA}` } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/me', headers: { authorization: `Bearer ${sessionB}` } })).statusCode).toBe(401);

    expect((await login('jane.smith', 'correct-horse-1')).statusCode).toBe(401);
    expect((await login('jane.smith', 'brand-new-pass-2')).statusCode).toBe(200);
  });

  it('admins set member credentials over HTTP; members cannot', async () => {
    const bob = (await app.inject({
      method: 'POST',
      url: '/api/users',
      headers: asMaster,
      payload: { name: 'Bob', realmIds: ['realm-1'] },
    })).json();

    const setUsername = await app.inject({
      method: 'PATCH',
      url: `/api/users/${bob.user.id}`,
      headers: asMaster,
      payload: { username: 'bob' },
    });
    expect(setUsername.statusCode).toBe(200);

    const setPassword = await app.inject({
      method: 'POST',
      url: `/api/users/${bob.user.id}/password`,
      headers: asMaster,
      payload: { password: 'bobs-password-9' },
    });
    expect(setPassword.statusCode).toBe(200);
    expect((await login('bob', 'bobs-password-9')).statusCode).toBe(200);

    // A member key cannot reset passwords.
    const denied = await app.inject({
      method: 'POST',
      url: `/api/users/${bob.user.id}/password`,
      headers: { authorization: `Bearer ${janeKey}` },
      payload: { password: 'hax-hax-hax-1' },
    });
    expect(denied.statusCode).toBe(403);
  });

  it('enforces username uniqueness (case-insensitive) and format', async () => {
    const dupe = await app.inject({
      method: 'POST',
      url: '/api/users',
      headers: asMaster,
      payload: { name: 'Dupe', username: 'JANE.smith' },
    });
    expect(dupe.statusCode).toBe(400);
    expect(dupe.json().message).toContain('already taken');

    const badFormat = await app.inject({
      method: 'POST',
      url: '/api/users',
      headers: asMaster,
      payload: { name: 'Bad', username: 'no spaces allowed' },
    });
    expect(badFormat.statusCode).toBe(400);

    const shortPassword = await app.inject({
      method: 'POST',
      url: '/api/users',
      headers: asMaster,
      payload: { name: 'Short', password: 'tiny' },
    });
    expect(shortPassword.statusCode).toBe(400);
  });

  it('create-with-credentials logs in immediately', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/users',
      headers: asMaster,
      payload: { name: 'Cara', username: 'cara', password: 'caras-password-7', realmIds: ['realm-1'] },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().user.username).toBe('cara');
    expect(created.json().user.hasPassword).toBe(true);
    expect((await login('cara', 'caras-password-7')).statusCode).toBe(200);
  });
});
