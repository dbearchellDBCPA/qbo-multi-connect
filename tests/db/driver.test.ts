import { describe, it, expect, afterEach } from 'vitest';
import { toPostgresPlaceholders, normalizeParams, type SqlDriver } from '../../src/db/driver.js';
import { ConnectionDatabase } from '../../src/db/index.js';
import { openTestDriver, TEST_DIALECT } from '../support/db.js';

describe('placeholder rewriting', () => {
  it('numbers ? placeholders for Postgres and leaves quoted ones alone', () => {
    expect(toPostgresPlaceholders('SELECT * FROM t WHERE a = ? AND b IN (?, ?)')).toBe(
      'SELECT * FROM t WHERE a = $1 AND b IN ($2, $3)'
    );
    expect(toPostgresPlaceholders("SELECT '?' AS q, ? AS p FROM t WHERE note = 'why?'")).toBe(
      "SELECT '?' AS q, $1 AS p FROM t WHERE note = 'why?'"
    );
  });

  it('binds undefined as NULL', () => {
    expect(normalizeParams(['a', undefined, null, 0])).toEqual(['a', null, null, 0]);
  });
});

describe(`SqlDriver (${TEST_DIALECT})`, () => {
  const drivers: SqlDriver[] = [];
  const open = () => { const d = openTestDriver(); drivers.push(d); return d; };
  afterEach(async () => { for (const d of drivers.splice(0)) await d.close(); });

  it('runs the baseline migration exactly once and records it', async () => {
    const d = open();
    const { runMigrations, loadMigrations } = await import('../../src/db/migrate.js');
    const expected = loadMigrations(TEST_DIALECT, 'main').map((m) => m.name);
    expect(expected[0]).toBe('001_baseline');
    const rows = await d.all<{ name: string }>('SELECT name FROM schema_migrations ORDER BY name');
    expect(rows.map((r) => r.name)).toEqual(expected);
    // Re-running the migrations against the same database is a no-op.
    const applied = await runMigrations(d, loadMigrations(TEST_DIALECT, 'main'));
    expect(applied).toEqual([]);
  });

  it('INSERT … RETURNING, ON CONFLICT DO NOTHING and affected-row counts behave the same on both engines', async () => {
    const d = open();
    const inserted = await d.get<{ id: number }>(
      "INSERT INTO users (name, api_key_hash, key_prefix) VALUES (?, ?, ?) RETURNING id",
      ['Jane', 'hash-1', 'qbo_1']
    );
    expect(typeof inserted!.id).toBe('number');
    const ignored = await d.run(
      "INSERT INTO user_clients (user_id, realm_id) VALUES (?, ?) ON CONFLICT DO NOTHING",
      [inserted!.id, 'R1']
    );
    expect(ignored).toBe(1);
    const again = await d.run(
      "INSERT INTO user_clients (user_id, realm_id) VALUES (?, ?) ON CONFLICT DO NOTHING",
      [inserted!.id, 'R1']
    );
    expect(again).toBe(0);
    expect(await d.run('UPDATE users SET name = ? WHERE id = ?', ['Janet', inserted!.id])).toBe(1);
    expect(await d.run('UPDATE users SET name = ? WHERE id = ?', ['Nobody', -1])).toBe(0);
  });

  it('rolls a transaction back when the callback throws', async () => {
    const d = open();
    await expect(
      d.transaction(async (tx) => {
        await tx.run("INSERT INTO users (name, api_key_hash, key_prefix) VALUES (?, ?, ?)", ['A', 'hash-a', 'qbo_a']);
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');
    expect(await d.all('SELECT id FROM users')).toHaveLength(0);
    await d.transaction(async (tx) => {
      await tx.run("INSERT INTO users (name, api_key_hash, key_prefix) VALUES (?, ?, ?)", ['B', 'hash-b', 'qbo_b']);
    });
    expect(await d.all('SELECT id FROM users')).toHaveLength(1);
  });

  it('hands timestamps to the app as ISO-8601 strings, defaults included', async () => {
    const d = open();
    const db = new ConnectionDatabase(d);
    const id = await db.insertUser({
      name: 'Jane', email: null, role: 'member', accessLevel: 'read_write', username: null, passwordHash: null,
      apiKeyHash: 'hash-2', apiKeyEncrypted: null, keyPrefix: 'qbo_2',
    });
    const user = (await db.getUserById(id))!;
    expect(user.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);
    expect(user.last_used_at).toBeNull();
    await db.touchUserLastUsed(id);
    const touched = (await db.getUserById(id))!;
    expect(touched.last_used_at).toMatch(/Z$/);
    expect(touched.updated_at).toBe(user.updated_at); // a touch is not an administrative change
    await new Promise((resolve) => setTimeout(resolve, 5)); // past the millisecond the row was created in
    await db.updateUser(id, { name: 'Janet' });
    const renamed = (await db.getUserById(id))!;
    expect(new Date(renamed.updated_at).getTime()).toBeGreaterThanOrEqual(new Date(user.updated_at).getTime());
    expect(renamed.updated_at).not.toBe(user.updated_at);
  });

  it('consumes an OAuth code exactly once', async () => {
    const d = open();
    const db = new ConnectionDatabase(d);
    const userId = await db.insertUser({
      name: 'Jane', email: null, role: 'member', accessLevel: 'read_write', username: null, passwordHash: null,
      apiKeyHash: 'hash-3', apiKeyEncrypted: null, keyPrefix: 'qbo_3',
    });
    await db.insertOAuthCode({
      codeHash: 'code-1', clientId: 'c1', userId, redirectUri: 'https://x/cb', codeChallenge: 'ch', scope: null,
      resource: null, expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const first = await db.consumeOAuthCode('code-1');
    expect(first?.user_id).toBe(userId);
    expect(await db.consumeOAuthCode('code-1')).toBeNull();
  });
});

describe.skipIf(TEST_DIALECT !== 'sqlite')('adopting a SQLite database written by the previous release', () => {
  // The pre-migration-runner schema, as the current production release
  // creates it: CURRENT_TIMESTAMP defaults, updated_at triggers, and OAuth
  // expiries stored as "YYYY-MM-DD HH:MM:SS".
  const LEGACY_SCHEMA = `
    CREATE TABLE connections (
      id INTEGER PRIMARY KEY AUTOINCREMENT, client_name TEXT NOT NULL, realm_id TEXT NOT NULL UNIQUE,
      access_token TEXT NOT NULL, refresh_token TEXT NOT NULL, token_expiry DATETIME NOT NULL, refresh_expiry DATETIME NOT NULL,
      scopes TEXT NOT NULL, status TEXT DEFAULT 'active' CHECK(status IN ('active', 'expired', 'revoked')),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP);
    CREATE TRIGGER update_connections_timestamp AFTER UPDATE ON connections
      BEGIN UPDATE connections SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id; END;
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, email TEXT,
      role TEXT NOT NULL DEFAULT 'member' CHECK(role IN ('admin', 'member')),
      access_level TEXT NOT NULL DEFAULT 'read_write' CHECK(access_level IN ('read', 'read_write')),
      username TEXT, password_hash TEXT, api_key_hash TEXT NOT NULL UNIQUE, api_key_encrypted TEXT, key_prefix TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'disabled')),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP, last_used_at DATETIME);
    CREATE TRIGGER update_users_timestamp AFTER UPDATE OF name, email, role, access_level, username, password_hash, status, api_key_hash ON users
      BEGIN UPDATE users SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id; END;
    CREATE TABLE oauth_tokens (
      token_hash TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('access', 'refresh')), client_id TEXT NOT NULL,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, scope TEXT, expires_at DATETIME NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP, last_used_at DATETIME);
  `;

  it('keeps rows readable, normalizes legacy expiries, drops the triggers and records the baseline', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const Database = (await import('better-sqlite3')).default;
    const dir = mkdtempSync(join(tmpdir(), 'qbo-adopt-'));
    const path = join(dir, 'legacy.db');
    try {
      const raw = new Database(path);
      raw.exec(LEGACY_SCHEMA);
      raw.prepare(
        "INSERT INTO connections (client_name, realm_id, access_token, refresh_token, token_expiry, refresh_expiry, scopes) VALUES ('Acme', 'R1', 'enc-a', 'enc-r', '2026-10-13T20:00:00.000Z', '2027-01-21T20:00:00.000Z', 'com.intuit.quickbooks.accounting')"
      ).run();
      raw.prepare("INSERT INTO users (name, api_key_hash, key_prefix) VALUES ('Old Jane', 'hash-old', 'qbo_old')").run();
      const future = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);
      raw.prepare(
        "INSERT INTO oauth_tokens (token_hash, kind, client_id, user_id, scope, expires_at) VALUES ('tok-1', 'access', 'c1', 1, NULL, ?)"
      ).run(future);
      raw.close();

      const db = new ConnectionDatabase(path);
      // Every migration ran once and is recorded.
      const { loadMigrations } = await import('../../src/db/migrate.js');
      const expected = loadMigrations('sqlite', 'main').map((m) => m.name);
      const applied = await db.driver.all<{ name: string }>('SELECT name FROM schema_migrations ORDER BY name');
      expect(applied.map((r) => r.name)).toEqual(expected);
      // The legacy rows now belong to the default firm.
      expect((await db.getConnectionByRealmId('R1'))?.firm_id).toBe(1);
      expect((await db.getAllUsers())[0].firm_id).toBe(1);
      expect((await db.getFirmById(1))?.slug).toBe('default');
      // Triggers are gone; the app sets updated_at itself now.
      const triggers = await db.driver.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'trigger'");
      expect(triggers).toEqual([]);
      // Legacy rows still read, and the legacy OAuth expiry now compares correctly against ISO "now".
      expect((await db.getConnectionByRealmId('R1'))?.client_name).toBe('Acme');
      expect((await db.getAllUsers())[0].name).toBe('Old Jane');
      const token = await db.getOAuthToken('tok-1', 'access');
      expect(token?.user_id).toBe(1);
      const stored = await db.driver.get<{ expires_at: string }>("SELECT expires_at FROM oauth_tokens WHERE token_hash = 'tok-1'");
      expect(stored!.expires_at).toMatch(/T.*Z$/);
      // updated_at is maintained by the statements, in ISO.
      await db.renameConnection('R1', 'Acme Holdings');
      const conn = (await db.getConnectionByRealmId('R1'))!;
      expect(conn.client_name).toBe('Acme Holdings');
      expect(conn.updated_at).toMatch(/T.*Z$/);
      // Reopening applies nothing new.
      await db.close();
      const again = new ConnectionDatabase(path);
      expect((await again.driver.all('SELECT name FROM schema_migrations')).length).toBe(expected.length);
      await again.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
