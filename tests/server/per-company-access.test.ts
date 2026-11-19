import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import Fastify, { type FastifyInstance } from 'fastify';
import { QBOManager } from '../../src/index.js';
import { ConnectionDatabase } from '../../src/db/index.js';
import { effectiveAccessLevel } from '../../src/users.js';
import { resolveAuth, createScopedManager, canWriteRealm, type AuthScope } from '../../src/server/auth.js';
import { ReadOnlyAccessError, assertRequestAllowed, runWithAccess } from '../../src/access-context.js';
import { usersRoutes } from '../../src/server/routes/users.js';
import { connectionsRoutes } from '../../src/server/routes/connections.js';
import { companyRoutes } from '../../src/server/routes/company.js';
import { authRoutes } from '../../src/server/routes/auth.js';
import { registerMcpRoutes } from '../../src/server/mcp.js';

// Access is set per company: a member can hold read & write on one QBO file
// and read-only on another. These tests pin down that a read-only company
// stays unchanged through every door — MCP tools, the REST API, and the
// QuickBooks request layer underneath both.

const ENCRYPTION_KEY = 'a'.repeat(64);
const MASTER_KEY = 'master-key-for-tests';

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

/** Stand-in for Intuit: records every request the server tries to send. */
interface IntuitCall {
  method: string;
  realmId: string;
  path: string;
}
function stubIntuit(): { calls: IntuitCall[]; writes: () => IntuitCall[]; restore: () => void } {
  const realFetch = globalThis.fetch;
  const calls: IntuitCall[] = [];
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = new URL(typeof input === 'string' ? input : input.url ?? String(input));
    if (!url.hostname.endsWith('intuit.com')) return realFetch(input, init);
    const [, realmId, ...rest] = url.pathname.replace('/v3/company', '').split('/');
    calls.push({ method: (init?.method ?? 'GET').toUpperCase(), realmId, path: rest.join('/') });
    return new Response(
      JSON.stringify({
        QueryResponse: {},
        JournalEntry: { Id: '901', SyncToken: '0' },
        Bill: { Id: '902', SyncToken: '1' },
        Class: { Id: '903', Name: 'Probe', SyncToken: '0' },
        CompanyInfo: { CompanyName: 'Stub Co' },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    );
  }) as typeof fetch;
  return { calls, writes: () => calls.filter((c) => c.method !== 'GET'), restore: () => (globalThis.fetch = realFetch) };
}

describe('per-company access levels — storage and resolution', () => {
  let qbo: QBOManager;

  beforeEach(async () => {
    qbo = makeManager();
    await addConnection(qbo, 'Acme Corp', 'realm-1');
    await addConnection(qbo, 'Beta LLC', 'realm-2');
    await addConnection(qbo, 'Gamma Inc', 'realm-3');
  });

  afterEach(() => qbo.close());

  it('stores a level per assigned company', async () => {
    const { user } = await qbo.users.create({
      name: 'Mixed',
      assignments: [
        { realmId: 'realm-1', accessLevel: 'read_write' },
        { realmId: 'realm-2', accessLevel: 'read' },
      ],
    });
    expect(user.realmIds).toEqual(['realm-1', 'realm-2']);
    expect(user.assignments).toEqual([
      { realmId: 'realm-1', accessLevel: 'read_write' },
      { realmId: 'realm-2', accessLevel: 'read' },
    ]);
    expect(effectiveAccessLevel(user, 'realm-1')).toBe('read_write');
    expect(effectiveAccessLevel(user, 'realm-2')).toBe('read');
    expect(effectiveAccessLevel(user, 'realm-3')).toBeNull();
  });

  it('the realmIds shorthand assigns read & write', async () => {
    const { user } = await qbo.users.create({ name: 'Plain', realmIds: ['realm-1'] });
    expect(user.assignments).toEqual([{ realmId: 'realm-1', accessLevel: 'read_write' }]);
  });

  it('a read-only member is read-only everywhere, whatever the per-company level says', async () => {
    const { user } = await qbo.users.create({
      name: 'Capped',
      accessLevel: 'read',
      assignments: [{ realmId: 'realm-1', accessLevel: 'read_write' }],
    });
    expect(effectiveAccessLevel(user, 'realm-1')).toBe('read');
  });

  it('admins have full access to every company', async () => {
    const { user } = await qbo.users.create({ name: 'Boss', role: 'admin', accessLevel: 'read' });
    expect(effectiveAccessLevel(user, 'realm-3')).toBe('read_write');
  });

  it('setClients keeps the level of companies that stay assigned', async () => {
    const { user } = await qbo.users.create({
      name: 'Mixed',
      assignments: [
        { realmId: 'realm-1', accessLevel: 'read' },
        { realmId: 'realm-2', accessLevel: 'read_write' },
      ],
    });
    const updated = await qbo.users.setClients(user.id, ['realm-1', 'realm-3']);
    expect(updated?.assignments).toEqual([
      { realmId: 'realm-1', accessLevel: 'read' }, // kept
      { realmId: 'realm-3', accessLevel: 'read_write' }, // new → default
    ]);
  });

  it('setClientUsers keeps the level of members who stay; setClientAssignments sets levels', async () => {
    const jane = (await qbo.users.create({ name: 'Jane', assignments: [{ realmId: 'realm-1', accessLevel: 'read' }] })).user;
    const bob = (await qbo.users.create({ name: 'Bob' })).user;

    await qbo.users.setClientUsers('realm-1', [jane.id, bob.id]);
    expect((await qbo.users.get(jane.id))?.assignments).toEqual([{ realmId: 'realm-1', accessLevel: 'read' }]);
    expect((await qbo.users.get(bob.id))?.assignments).toEqual([{ realmId: 'realm-1', accessLevel: 'read_write' }]);

    await qbo.users.setClientAssignments('realm-1', [
      { userId: jane.id, accessLevel: 'read_write' },
      { userId: bob.id, accessLevel: 'read' },
    ]);
    expect((await qbo.users.get(jane.id))?.assignments).toEqual([{ realmId: 'realm-1', accessLevel: 'read_write' }]);
    expect((await qbo.users.get(bob.id))?.assignments).toEqual([{ realmId: 'realm-1', accessLevel: 'read' }]);
  });

  it('a company added to a read-only-everywhere member is stored read-only', async () => {
    // Otherwise lifting the member-wide cap later would hand out write access
    // to companies that were only ever added as read-only.
    const { user } = await qbo.users.create({ name: 'Capped', accessLevel: 'read', realmIds: ['realm-1'] });
    expect(user.assignments).toEqual([{ realmId: 'realm-1', accessLevel: 'read' }]);

    const widened = await qbo.users.setClients(user.id, ['realm-1', 'realm-2']);
    expect(widened?.assignments).toEqual([
      { realmId: 'realm-1', accessLevel: 'read' },
      { realmId: 'realm-2', accessLevel: 'read' },
    ]);

    await qbo.users.setClientUsers('realm-3', [user.id]);
    const uncapped = await qbo.users.update(user.id, { accessLevel: 'read_write' });
    expect(uncapped?.assignments.map((a) => a.accessLevel)).toEqual(['read', 'read', 'read']);
    expect(effectiveAccessLevel(uncapped!, 'realm-3')).toBe('read');
  });

  it('editing a company\'s members leaves an admin\'s own assignment alone', async () => {
    const jane = (await qbo.users.create({ name: 'Jane', assignments: [{ realmId: 'realm-1', accessLevel: 'read' }] })).user;
    const bob = (await qbo.users.create({ name: 'Bob', realmIds: ['realm-1'] })).user;
    await qbo.users.update(jane.id, { role: 'admin' });

    // The dashboard only lists members, so Jane is not in what it sends back.
    await qbo.users.setClientAssignments('realm-1', [{ userId: bob.id, accessLevel: 'read' }]);
    await qbo.users.setClientUsers('realm-1', []);

    const demoted = await qbo.users.update(jane.id, { role: 'member' });
    expect(demoted?.assignments).toEqual([{ realmId: 'realm-1', accessLevel: 'read' }]);
    expect((await qbo.users.get(bob.id))?.assignments).toEqual([]);
  });

  it('resolveAuth builds a per-company write set', async () => {
    const mixed = await qbo.users.create({
      name: 'Mixed',
      assignments: [
        { realmId: 'realm-1', accessLevel: 'read_write' },
        { realmId: 'realm-2', accessLevel: 'read' },
      ],
    });
    const scope = (await resolveAuth(qbo, MASTER_KEY, `Bearer ${mixed.apiKey}`))!;
    expect(scope.canWrite).toBe(true); // can write somewhere → write tools are listed
    expect(scope.allWrite).toBe(false);
    expect(canWriteRealm(scope, 'realm-1')).toBe(true);
    expect(canWriteRealm(scope, 'realm-2')).toBe(false);
    expect(canWriteRealm(scope, 'realm-3')).toBe(false); // not assigned at all

    const allRead = await qbo.users.create({ name: 'Viewer', assignments: [{ realmId: 'realm-1', accessLevel: 'read' }] });
    const viewer = (await resolveAuth(qbo, MASTER_KEY, `Bearer ${allRead.apiKey}`))!;
    expect(viewer.canWrite).toBe(false);
    expect(canWriteRealm(viewer, 'realm-1')).toBe(false);

    const master = (await resolveAuth(qbo, MASTER_KEY, `Bearer ${MASTER_KEY}`))!;
    expect(master.allWrite).toBe(true);
    expect(canWriteRealm(master, 'realm-3')).toBe(true);

    const admin = await qbo.users.create({ name: 'Boss', role: 'admin' });
    expect(canWriteRealm((await resolveAuth(qbo, MASTER_KEY, `Bearer ${admin.apiKey}`))!, 'realm-3')).toBe(true);
  });

  it('upgrading a database from before per-company levels grants nobody new access', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'qbo-migrate-'));
    const dbPath = join(dir, 'old.db');
    try {
      // Build a current database, then strip the column to recreate the
      // previous release's user_clients table with real rows in it.
      const seed = makeManager(dbPath);
      await addConnection(seed, 'Acme Corp', 'realm-1');
      const writer = await seed.users.create({ name: 'Writer', realmIds: ['realm-1'] });
      const reader = await seed.users.create({ name: 'Reader', accessLevel: 'read', realmIds: ['realm-1'] });
      seed.close();

      const raw = new Database(dbPath);
      raw.exec('ALTER TABLE user_clients DROP COLUMN access_level');
      expect((raw.prepare('PRAGMA table_info(user_clients)').all() as any[]).map((c) => c.name)).not.toContain('access_level');
      // …and the previous release's upload_tokens table, with a live token in it.
      raw.exec('DROP TABLE upload_tokens');
      raw.exec(`CREATE TABLE upload_tokens (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        token_hash TEXT NOT NULL UNIQUE,
        realm_id TEXT NOT NULL,
        issued_by TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        expires_at DATETIME NOT NULL
      )`);
      raw.prepare("INSERT INTO upload_tokens (token_hash, realm_id, issued_by, expires_at) VALUES ('h', 'realm-1', 'Writer', datetime('now', '+30 minutes'))").run();
      raw.close();

      const upgraded = makeManager(dbPath);
      try {
        const writerScope = (await resolveAuth(upgraded, MASTER_KEY, `Bearer ${writer.apiKey}`))!;
        const readerScope = (await resolveAuth(upgraded, MASTER_KEY, `Bearer ${reader.apiKey}`))!;
        expect(canWriteRealm(writerScope, 'realm-1')).toBe(true); // unchanged
        expect(canWriteRealm(readerScope, 'realm-1')).toBe(false); // still read-only
        expect(readerScope.canWrite).toBe(false);
        expect((await upgraded.users.get(writer.user.id))?.assignments).toEqual([
          { realmId: 'realm-1', accessLevel: 'read_write' },
        ]);
        // The in-flight token survives the upgrade, and new ones record who minted them.
        expect(await (upgraded as any).db.getUploadToken('h')).toMatchObject({ realm_id: 'realm-1', user_id: null });
        const { token } = await upgraded.uploadTokens.issue('realm-1', 'Writer', writer.user.id);
        expect(await upgraded.uploadTokens.resolve('realm-1', token)).toEqual({ userId: writer.user.id });
      } finally {
        upgraded.close();
      }

      // Re-opening an already-upgraded database is a no-op.
      const again = new ConnectionDatabase(dbPath);
      expect(await again.getUserAssignments(writer.user.id)).toEqual([{ realmId: 'realm-1', accessLevel: 'read_write' }]);
      await again.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('QuickBooks request backstop', () => {
  let qbo: QBOManager;
  let intuit: ReturnType<typeof stubIntuit>;
  let scope: AuthScope;

  beforeEach(async () => {
    intuit = stubIntuit();
    qbo = makeManager();
    await addConnection(qbo, 'Acme Corp', 'realm-1');
    await addConnection(qbo, 'Beta LLC', 'realm-2');
    const mixed = await qbo.users.create({
      name: 'Mixed',
      assignments: [
        { realmId: 'realm-1', accessLevel: 'read_write' },
        { realmId: 'realm-2', accessLevel: 'read' },
      ],
    });
    scope = (await resolveAuth(qbo, MASTER_KEY, `Bearer ${mixed.apiKey}`))!;
  });

  afterEach(() => {
    intuit.restore();
    qbo.close();
  });

  it('refuses any non-GET request for a read-only company before it reaches the network', async () => {
    const scoped = createScopedManager(qbo, scope);
    await expect(scoped.journalEntries.create('realm-2', { Line: [] } as any)).rejects.toBeInstanceOf(ReadOnlyAccessError);
    await expect(scoped.transactions.createInvoice('realm-2', {})).rejects.toBeInstanceOf(ReadOnlyAccessError);
    await expect(scoped.transactions.deleteCustomer('realm-2', { Id: '1', SyncToken: '0' })).rejects.toBeInstanceOf(ReadOnlyAccessError);
    await expect(scoped.batch.execute('realm-2', [{ bId: '1', operation: 'create', entity: 'Class', payload: {} }] as any)).rejects.toBeInstanceOf(ReadOnlyAccessError);
    expect(intuit.calls).toEqual([]);
  });

  it('still lets the same member read that company and write to the other', async () => {
    const scoped = createScopedManager(qbo, scope);
    await scoped.company.getInfo('realm-2');
    await scoped.transactions.rawQuery('realm-2', 'SELECT * FROM Invoice');
    await scoped.journalEntries.create('realm-1', { Line: [] } as any);
    expect(intuit.calls.map((c) => `${c.method} ${c.realmId}`)).toEqual(['GET realm-2', 'GET realm-2', 'POST realm-1']);
  });

  it('will not mint an upload token (a write credential) for a read-only company', async () => {
    const scoped = createScopedManager(qbo, scope);
    expect(() => scoped.uploadTokens.issue('realm-2', 'Mixed')).toThrow(ReadOnlyAccessError);
    const { token } = await scoped.uploadTokens.issue('realm-1', 'Mixed');
    expect(token).toMatch(/^uplt_/);
  });

  it('an access context only authorizes writes to its own company', () => {
    runWithAccess({ realmId: 'realm-1', canWrite: true, who: 'x' }, () => {
      expect(() => assertRequestAllowed('POST', 'realm-1')).not.toThrow();
      expect(() => assertRequestAllowed('POST', 'realm-2')).toThrow(ReadOnlyAccessError);
      expect(() => assertRequestAllowed('GET', 'realm-2')).not.toThrow();
    });
    runWithAccess({ realmId: 'realm-1', canWrite: false, who: 'x' }, () => {
      expect(() => assertRequestAllowed('GET', 'realm-1')).not.toThrow();
      for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'post']) {
        expect(() => assertRequestAllowed(method, 'realm-1')).toThrow(ReadOnlyAccessError);
      }
    });
  });

  it('the server acting for itself (no access context) is not restricted', async () => {
    await qbo.journalEntries.create('realm-2', { Line: [] } as any);
    expect(intuit.writes()).toHaveLength(1);
  });

  it('the context survives awaits inside a call and does not leak into later calls', async () => {
    const scoped = createScopedManager(qbo, scope);
    // A denied call followed by an unrestricted root call: the denial must
    // not stick to the event loop.
    await expect(scoped.journalEntries.create('realm-2', { Line: [] } as any)).rejects.toBeInstanceOf(ReadOnlyAccessError);
    await qbo.journalEntries.create('realm-2', { Line: [] } as any);
    // Interleaved: a slow allowed write and a denied write started together.
    const [allowed, denied] = await Promise.allSettled([
      scoped.journalEntries.create('realm-1', { Line: [] } as any),
      scoped.journalEntries.create('realm-2', { Line: [] } as any),
    ]);
    expect(allowed.status).toBe('fulfilled');
    expect(denied.status).toBe('rejected');
    expect(intuit.writes().map((c) => c.realmId)).toEqual(['realm-2', 'realm-1']);
  });
});

describe('per-company access over MCP and REST', () => {
  let qbo: QBOManager;
  let app: FastifyInstance;
  let baseUrl: string;
  let intuit: ReturnType<typeof stubIntuit>;
  let mixedKey: string;
  let mixedId: number;
  let viewerKey: string;
  const routes: Array<{ method: string; url: string }> = [];

  beforeEach(async () => {
    intuit = stubIntuit();
    qbo = makeManager();
    await addConnection(qbo, 'Acme Corp', 'realm-1');
    await addConnection(qbo, 'Beta LLC', 'realm-2');
    await addConnection(qbo, 'Gamma Inc', 'realm-3');
    const mixed = await qbo.users.create({
      name: 'Mixed',
      username: 'mixed',
      password: 'correct-horse-battery',
      assignments: [
        { realmId: 'realm-1', accessLevel: 'read_write' },
        { realmId: 'realm-2', accessLevel: 'read' },
      ],
    });
    mixedKey = mixed.apiKey;
    mixedId = mixed.user.id;
    viewerKey = (
      await qbo.users.create({ name: 'Viewer', assignments: [{ realmId: 'realm-1', accessLevel: 'read' }] })
    ).apiKey;

    routes.length = 0;
    app = Fastify({ logger: false });
    app.addHook('onRoute', (route) => {
      for (const method of [route.method].flat()) routes.push({ method: String(method), url: route.url });
    });
    await authRoutes(app, qbo, MASTER_KEY);
    await connectionsRoutes(app, qbo, MASTER_KEY);
    await companyRoutes(app, qbo, MASTER_KEY);
    await usersRoutes(app, qbo, MASTER_KEY);
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

  async function mcp(key: string, method: string, params: unknown): Promise<any> {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${key}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
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

  // ── MCP ────────────────────────────────────────────────────────────────────

  it('a member who can write somewhere sees the write tools; one who cannot does not', async () => {
    const mixedTools = (await mcp(mixedKey, 'tools/list', {})).result.tools.map((t: any) => t.name);
    const viewerTools = (await mcp(viewerKey, 'tools/list', {})).result.tools.map((t: any) => t.name);
    expect(mixedTools).toContain('create_journal_entry');
    expect(viewerTools).not.toContain('create_journal_entry');
    expect(viewerTools).toContain('get_profit_and_loss');
  });

  it('list_clients tells the member which companies are read-only', async () => {
    const text = toolText(await mcp(mixedKey, 'tools/call', { name: 'list_clients', arguments: {} }));
    expect(text).toContain('• Acme Corp (realmId: realm-1)\n');
    expect(text).toContain('• Beta LLC (realmId: realm-2) — read-only');
    expect(text).not.toContain('Gamma');
    // The master key writes everywhere, so nothing is marked.
    expect(toolText(await mcp(MASTER_KEY, 'tools/call', { name: 'list_clients', arguments: {} }))).not.toContain('read-only');
  });

  it('refuses a write tool on a read-only company without touching QuickBooks', async () => {
    const res = await mcp(mixedKey, 'tools/call', {
      name: 'create_class',
      arguments: { client_name: 'Beta LLC', name: 'Should not exist' },
    });
    expect(res.result.isError).toBe(true);
    expect(toolText(res)).toContain('Read-only access');
    expect(toolText(res)).toContain('nothing was changed');
    expect(intuit.calls).toEqual([]);
  });

  it('runs the same write tool on a company the member may change', async () => {
    const res = await mcp(mixedKey, 'tools/call', {
      name: 'create_class',
      arguments: { client_name: 'Acme Corp', name: 'Projects' },
    });
    expect(res.result.isError).toBeFalsy();
    expect(intuit.writes()).toEqual([{ method: 'POST', realmId: 'realm-1', path: 'class' }]);
  });

  it('still reads a read-only company', async () => {
    const res = await mcp(mixedKey, 'tools/call', { name: 'get_company_info', arguments: { client_name: 'Beta LLC' } });
    expect(toolText(res)).toContain('Stub Co');
    expect(intuit.writes()).toEqual([]);
  });

  it('every write tool refuses a read-only company', async () => {
    const tools = (await mcp(mixedKey, 'tools/list', {})).result.tools as any[];
    const writeTools = tools.filter((t) => t.annotations?.readOnlyHint === false);
    expect(writeTools.length).toBeGreaterThan(70);
    const leaked: string[] = [];
    let denied = 0;
    for (const tool of writeTools) {
      // Fill required arguments with plausible values so the call gets past
      // schema validation and reaches the access check.
      const args: Record<string, unknown> = {};
      const fill = (schema: any, key: string): unknown => {
        if (key === 'client_name') return 'Beta LLC';
        if (schema?.enum) return schema.enum[0];
        if (schema?.type === 'number' || schema?.type === 'integer') return 1;
        if (schema?.type === 'boolean') return false;
        if (schema?.type === 'array') return [];
        if (schema?.type === 'object') return {};
        return /date/.test(key) ? '2026-10-31' : '1';
      };
      for (const key of tool.inputSchema?.required ?? []) args[key] = fill(tool.inputSchema.properties?.[key], key);
      const res = await mcp(mixedKey, 'tools/call', { name: tool.name, arguments: args });
      const text = res.error ? String(res.error.message) : toolText(res);
      if (/Read-only access/.test(text)) denied++;
      else if (!/Invalid arguments|Input validation/i.test(text)) leaked.push(`${tool.name}: ${text.slice(0, 80)}`);
    }
    expect(leaked).toEqual([]);
    // A handful of bulk tools reject the synthesized arguments at schema
    // validation, before the access check; the rest must be refused by it.
    expect(denied).toBeGreaterThanOrEqual(65);
    expect(intuit.writes()).toEqual([]);
  }, 60_000);

  it('an exact client name wins over a longer name that contains it', async () => {
    await addConnection(qbo, 'Acme Corp Holdings', 'realm-4');
    await addConnection(qbo, 'Acme', 'realm-5');
    for (const [name, realm] of [['Acme Corp', 'realm-1'], ['Acme Corp Holdings', 'realm-4'], ['Acme', 'realm-5']]) {
      intuit.calls.length = 0;
      await mcp(MASTER_KEY, 'tools/call', { name: 'get_company_info', arguments: { client_name: name } });
      expect(intuit.calls.map((c) => c.realmId), name).toEqual([realm]);
    }
  });

  it('a partial client name works only when it points at one company', async () => {
    await addConnection(qbo, 'Smith Dental', 'realm-6');
    await addConnection(qbo, 'Smith Dental Group', 'realm-7');
    const info = (name: string) =>
      mcp(MASTER_KEY, 'tools/call', { name: 'get_company_info', arguments: { client_name: name } }).then(toolText);

    intuit.calls.length = 0;
    expect(await info('Smith')).toContain('Client not found'); // two candidates → no guessing
    expect(await info('Smith Dental Group LLC')).toContain('Client not found'); // contains both names
    expect(intuit.calls).toEqual([]);

    await info('gamma'); // one candidate → resolved
    await info('Smith Dental Group'); // exact
    expect(intuit.calls.map((c) => c.realmId)).toEqual(['realm-3', 'realm-7']);
  });

  it('only callers who see every company can list the shared staging directory', async () => {
    const names = async (key: string) => (await mcp(key, 'tools/list', {})).result.tools.map((t: any) => t.name);
    const admin = await qbo.users.create({ name: 'Boss', role: 'admin' });
    expect(await names(MASTER_KEY)).toContain('list_staging_files');
    expect(await names(admin.apiKey)).toContain('list_staging_files');
    expect(await names(mixedKey)).not.toContain('list_staging_files');
    expect(await names(viewerKey)).not.toContain('list_staging_files');
  });

  // ── REST ───────────────────────────────────────────────────────────────────

  it('REST write routes follow the per-company level', async () => {
    const auth = { authorization: `Bearer ${mixedKey}` };
    const allowed = await app.inject({ method: 'POST', url: '/api/company/realm-1/journal-entries', headers: auth, payload: { Line: [] } });
    expect(allowed.statusCode).toBe(201);
    expect(intuit.writes()).toEqual([{ method: 'POST', realmId: 'realm-1', path: 'journalentry' }]);

    intuit.calls.length = 0;
    for (const [method, url, payload] of [
      ['POST', '/api/company/realm-2/journal-entries', { Line: [] }],
      ['PUT', '/api/company/realm-2/journal-entries', { Id: '1', SyncToken: '0', Line: [] }],
      ['PUT', '/api/company/realm-2/bills', { Id: '1', SyncToken: '0' }],
    ] as const) {
      const res = await app.inject({ method, url, headers: auth, payload });
      expect(res.statusCode, `${method} ${url}`).toBe(403);
      expect(res.json().message).toContain('read-only');
    }
    // An unassigned company still looks nonexistent rather than forbidden.
    const hidden = await app.inject({ method: 'POST', url: '/api/company/realm-3/journal-entries', headers: auth, payload: { Line: [] } });
    expect(hidden.statusCode).toBe(404);
    expect(intuit.calls).toEqual([]);
  });

  it('a read-only login cannot write over REST with its key or its dashboard session', async () => {
    const reader = await qbo.users.create({
      name: 'Reader',
      accessLevel: 'read',
      username: 'reader',
      password: 'correct-horse-battery',
      realmIds: ['realm-1'],
    });
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'reader', password: 'correct-horse-battery' },
    });
    for (const credential of [reader.apiKey, login.json().token as string]) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/company/realm-1/journal-entries',
        headers: { authorization: `Bearer ${credential}` },
        payload: { Line: [] },
      });
      expect(res.statusCode).toBe(403);
    }
    expect(intuit.calls).toEqual([]);
  });

  it('no REST route that changes a company is open to a read-only key', async () => {
    // Walks every registered non-GET route under /api/company/:realmId, so a
    // write route added later is covered without anyone remembering to.
    const writeRoutes = routes.filter((r) => r.url.startsWith('/api/company/:realmId') && !['GET', 'HEAD', 'OPTIONS'].includes(r.method));
    expect(writeRoutes.length).toBeGreaterThanOrEqual(4);
    for (const route of writeRoutes) {
      const res = await app.inject({
        method: route.method as any,
        url: route.url.replace(':realmId', 'realm-1'),
        headers: { authorization: `Bearer ${viewerKey}`, 'content-type': 'application/json' },
        payload: { Id: '1', SyncToken: '0', Line: [] },
      });
      expect(res.statusCode, `${route.method} ${route.url}`).toBe(403);
    }
    expect(intuit.calls).toEqual([]);
  });

  it('an upload token stops working when the member who minted it loses write access', async () => {
    const upload = (token: string) => {
      const boundary = 'b-upload';
      return app.inject({
        method: 'POST',
        url: '/api/company/realm-1/attachments',
        headers: { authorization: `Bearer ${token}`, 'content-type': `multipart/form-data; boundary=${boundary}` },
        payload:
          `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="x.png"\r\n` +
          `Content-Type: image/png\r\n\r\nx\r\n--${boundary}--\r\n`,
      });
    };
    const scope = (await resolveAuth(qbo, MASTER_KEY, `Bearer ${mixedKey}`))!;
    const { token } = await createScopedManager(qbo, scope).uploadTokens.issue('realm-1', scope.userName, scope.userId);
    const masterToken = (await qbo.uploadTokens.issue('realm-1', 'Master key')).token;

    expect((await upload(token)).statusCode).not.toBe(401); // accepted while they can write

    // Made read-only for this company → the token is dead at once.
    await qbo.users.setAssignments(mixedId, [{ realmId: 'realm-1', accessLevel: 'read' }]);
    expect((await upload(token)).statusCode).toBe(401);

    // Restored, then disabled.
    await qbo.users.setAssignments(mixedId, [{ realmId: 'realm-1', accessLevel: 'read_write' }]);
    expect((await upload(token)).statusCode).not.toBe(401);
    await qbo.users.update(mixedId, { status: 'disabled' });
    expect((await upload(token)).statusCode).toBe(401);

    // Re-enabled, then unassigned from the company altogether.
    await qbo.users.update(mixedId, { status: 'active' });
    await qbo.users.setAssignments(mixedId, []);
    expect((await upload(token)).statusCode).toBe(401);

    // Removing the member removes their tokens with them.
    await qbo.users.setAssignments(mixedId, [{ realmId: 'realm-1', accessLevel: 'read_write' }]);
    await qbo.users.remove(mixedId);
    expect((await upload(token)).statusCode).toBe(401);

    // A token minted with the master key has no member behind it to lose access.
    expect((await upload(masterToken)).statusCode).not.toBe(401);
  });

  it('REST read routes still work for a read-only company', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/company/realm-2/info',
      headers: { authorization: `Bearer ${mixedKey}` },
    });
    expect(res.statusCode).toBe(200);
    expect(intuit.calls).toEqual([{ method: 'GET', realmId: 'realm-2', path: 'companyinfo/realm-2' }]);
  });

  // ── Managing levels over the API ───────────────────────────────────────────

  it('/api/me reports what the caller can do in each company', async () => {
    const me = (await app.inject({ method: 'GET', url: '/api/me', headers: { authorization: `Bearer ${mixedKey}` } })).json();
    expect(me.canWrite).toBe(true);
    expect(me.clients).toEqual([
      { realmId: 'realm-1', clientName: 'Acme Corp', canWrite: true },
      { realmId: 'realm-2', clientName: 'Beta LLC', canWrite: false },
    ]);
  });

  it('creates and edits per-company levels over HTTP', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/users',
      headers: asMaster,
      payload: { name: 'Pat', clients: [{ realmId: 'realm-1', accessLevel: 'read' }, { realmId: 'realm-3' }] },
    });
    expect(created.statusCode).toBe(201);
    const pat = created.json().user;
    expect(pat.clients).toEqual([
      { realmId: 'realm-1', clientName: 'Acme Corp', accessLevel: 'read', effectiveAccessLevel: 'read' },
      { realmId: 'realm-3', clientName: 'Gamma Inc', accessLevel: 'read_write', effectiveAccessLevel: 'read_write' },
    ]);

    // Capping the member to read-only shows through effectiveAccessLevel.
    const capped = await app.inject({ method: 'PATCH', url: `/api/users/${pat.id}`, headers: asMaster, payload: { accessLevel: 'read' } });
    expect(capped.json().user.clients.map((c: any) => c.effectiveAccessLevel)).toEqual(['read', 'read']);
    expect(capped.json().user.clients.map((c: any) => c.accessLevel)).toEqual(['read', 'read_write']);

    // The older realmIds form keeps levels for companies that stay. Pat is
    // read-only everywhere right now, so the newly added company is stored
    // read-only too; once the cap is lifted a new one gets read & write.
    const kept = await app.inject({ method: 'PATCH', url: `/api/users/${pat.id}`, headers: asMaster, payload: { realmIds: ['realm-1', 'realm-2'] } });
    expect(kept.json().user.clients.map((c: any) => [c.realmId, c.accessLevel])).toEqual([
      ['realm-1', 'read'],
      ['realm-2', 'read'],
    ]);
    const uncapped = await app.inject({
      method: 'PATCH',
      url: `/api/users/${pat.id}`,
      headers: asMaster,
      payload: { accessLevel: 'read_write', realmIds: ['realm-1', 'realm-2', 'realm-3'] },
    });
    expect(uncapped.json().user.clients.map((c: any) => [c.realmId, c.accessLevel])).toEqual([
      ['realm-1', 'read'],
      ['realm-2', 'read'],
      ['realm-3', 'read_write'],
    ]);
  });

  it('rejects malformed per-company levels', async () => {
    for (const clients of [
      [{ realmId: 'realm-1', accessLevel: 'admin' }],
      [{ realmId: 'realm-1' }, { realmId: 'realm-1', accessLevel: 'read' }],
      [{ accessLevel: 'read' }],
      'realm-1',
    ]) {
      const res = await app.inject({ method: 'POST', url: '/api/users', headers: asMaster, payload: { name: 'Bad', clients } });
      expect(res.statusCode, JSON.stringify(clients)).toBe(400);
    }
    const unknown = await app.inject({
      method: 'POST',
      url: '/api/users',
      headers: asMaster,
      payload: { name: 'Bad', clients: [{ realmId: 'nope', accessLevel: 'read' }] },
    });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json().message).toContain('nope');
  });

  it('sets levels from the company side, and members cannot change them', async () => {
    const withLevels = await app.inject({
      method: 'PUT',
      url: '/api/connections/realm-2/users',
      headers: asMaster,
      payload: { users: [{ userId: mixedId, accessLevel: 'read_write' }] },
    });
    expect(withLevels.statusCode).toBe(200);
    expect((await qbo.users.get(mixedId))?.assignments).toContainEqual({ realmId: 'realm-2', accessLevel: 'read_write' });

    // The older userIds form keeps the level just set.
    await app.inject({ method: 'PUT', url: '/api/connections/realm-2/users', headers: asMaster, payload: { userIds: [mixedId] } });
    expect((await qbo.users.get(mixedId))?.assignments).toContainEqual({ realmId: 'realm-2', accessLevel: 'read_write' });

    const bad = await app.inject({
      method: 'PUT',
      url: '/api/connections/realm-2/users',
      headers: asMaster,
      payload: { users: [{ userId: mixedId, accessLevel: 'owner' }] },
    });
    expect(bad.statusCode).toBe(400);

    // A member cannot raise their own access.
    const selfServe = await app.inject({
      method: 'PUT',
      url: '/api/connections/realm-2/users',
      headers: { authorization: `Bearer ${viewerKey}` },
      payload: { users: [{ userId: mixedId, accessLevel: 'read_write' }] },
    });
    expect(selfServe.statusCode).toBe(403);
    const selfPatch = await app.inject({
      method: 'PATCH',
      url: `/api/users/${mixedId}`,
      headers: { authorization: `Bearer ${mixedKey}` },
      payload: { clients: [{ realmId: 'realm-2', accessLevel: 'read_write' }] },
    });
    expect(selfPatch.statusCode).toBe(403);
  });

  it('a level change takes effect on the next request', async () => {
    const call = () => mcp(mixedKey, 'tools/call', { name: 'create_class', arguments: { client_name: 'Beta LLC', name: 'X' } });
    expect((await call()).result.isError).toBe(true);
    await qbo.users.setAssignments(mixedId, [{ realmId: 'realm-2', accessLevel: 'read_write' }]);
    expect((await call()).result.isError).toBeFalsy();
    await qbo.users.setAssignments(mixedId, [{ realmId: 'realm-2', accessLevel: 'read' }]);
    expect((await call()).result.isError).toBe(true);
    expect(intuit.writes()).toHaveLength(1);
  });
});
