import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { ImportStore, ImportStoreHandle, IMPORT_STORE_FILENAME, type NewImportRecord } from '../../src/db/import-store.js';
import { openTestImportStore, TEST_DIALECT } from '../support/db.js';

const rec = (over: Partial<NewImportRecord> = {}): NewImportRecord => ({
  client: 'Acme', realm_id: 'R1', source_id: 'ns:1', run_id: 'run-a', txn_type: 'Bill', qbo_type: 'Bill', qbo_id: '10',
  sync_token: '0', doc_number: 'B-1', txn_date: '2026-07-01', amount: 100, status: 'created', payload_hash: 'h1', ...over,
});

describe(`ImportStore (${TEST_DIALECT})`, () => {
  const dirs: string[] = [];
  const stores: ImportStore[] = [];
  const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'qbo-import-store-')); dirs.push(d); return d; };
  const open = () => { const s = openTestImportStore(); stores.push(s); return s; };

  afterEach(async () => {
    for (const s of stores.splice(0)) await s.close();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('upserts one live row per (realm, source_id) and replaces it in place', async () => {
    const store = open();
    await store.upsertLive(rec());
    await store.upsertLive(rec({ status: 'updated', sync_token: '1', amount: 120, payload_hash: 'h2' }));
    const live = await store.getLive('R1', ['ns:1', 'ns:missing']);
    expect(live.size).toBe(1);
    const row = live.get('ns:1')!;
    expect(row).toMatchObject({ status: 'updated', sync_token: '1', amount: 120, payload_hash: 'h2', qbo_id: '10', run_id: 'run-a' });
    expect(await store.query({ realm_id: 'R1' })).toHaveLength(1);
  });

  it('keeps deleted rows as history and lets a new live row take the source_id', async () => {
    const store = open();
    await store.upsertLive(rec());
    const first = (await store.getLive('R1', ['ns:1'])).get('ns:1')!;
    await store.markDeleted(first.id, 'deleted by run run-a');
    expect((await store.getLive('R1', ['ns:1'])).size).toBe(0);
    await store.upsertLive(rec({ qbo_id: '11', run_id: 'run-b' }));
    const all = await store.query({ realm_id: 'R1' });
    expect(all.map((r) => r.status)).toEqual(['deleted', 'created']);
    expect(await store.query({ realm_id: 'R1', include_deleted: false })).toHaveLength(1);
    expect((await store.query({ realm_id: 'R1', status: 'deleted' }))[0].message).toBe('deleted by run run-a');
  });

  it('records ISO timestamps and bumps updated_at on change', async () => {
    const store = open();
    await store.upsertLive(rec());
    const row = (await store.getLive('R1', ['ns:1'])).get('ns:1')!;
    expect(new Date(row.created_at).getTime()).not.toBeNaN();
    expect(row.created_at).toMatch(/T.*Z$/);
    await store.setPayloadHash(row.id, 'abc');
    const after = (await store.getLive('R1', ['ns:1'])).get('ns:1')!;
    expect(after.payload_hash).toBe('abc');
    expect(new Date(after.updated_at).getTime()).toBeGreaterThanOrEqual(new Date(row.updated_at).getTime());
  });

  it('filters by run, type, source_ids and date range, scoped to the realm', async () => {
    const store = open();
    await store.upsertLive(rec());
    await store.upsertLive(rec({ source_id: 'ns:2', txn_type: 'Invoice', qbo_type: 'Invoice', qbo_id: '20', txn_date: '2026-07-15', run_id: 'run-b' }));
    await store.upsertLive(rec({ realm_id: 'R2', source_id: 'ns:1', qbo_id: '30' }));
    expect((await store.query({ realm_id: 'R1', run_id: 'run-b' })).map((r) => r.source_id)).toEqual(['ns:2']);
    expect((await store.query({ realm_id: 'R1', txn_type: 'Bill' })).map((r) => r.qbo_id)).toEqual(['10']);
    expect(await store.query({ realm_id: 'R1', source_ids: ['ns:1', 'ns:2'] })).toHaveLength(2);
    expect((await store.query({ realm_id: 'R1', start_date: '2026-07-10', end_date: '2026-07-31' })).map((r) => r.source_id)).toEqual(['ns:2']);
    expect((await store.getLive('R2', ['ns:1'])).get('ns:1')!.qbo_id).toBe('30');
  });

  it('getLive handles an empty list and more ids than one statement should carry', async () => {
    const store = open();
    expect((await store.getLive('R1', [])).size).toBe(0);
    for (let i = 0; i < 12; i++) await store.upsertLive(rec({ source_id: `bulk:${i}`, qbo_id: String(100 + i) }));
    const ids = Array.from({ length: 1200 }, (_, i) => `bulk:${i}`);
    const live = await store.getLive('R1', ids);
    expect(live.size).toBe(12);
    expect(live.get('bulk:11')!.qbo_id).toBe('111');
  });

  it('fills in a recovered row\'s payload hash', async () => {
    const store = open();
    await store.upsertLive(rec({ status: 'indexed', payload_hash: null }));
    const row = (await store.getLive('R1', ['ns:1'])).get('ns:1')!;
    await store.setPayloadHash(row.id, 'abc');
    expect((await store.getLive('R1', ['ns:1'])).get('ns:1')!.payload_hash).toBe('abc');
  });

  it('wipe() empties the store for one realm or for all', async () => {
    const store = open();
    await store.upsertLive(rec());
    await store.upsertLive(rec({ realm_id: 'R2' }));
    await store.wipe('R1');
    expect(await store.query({ realm_id: 'R1' })).toHaveLength(0);
    expect(await store.query({ realm_id: 'R2' })).toHaveLength(1);
    await store.wipe();
    expect(await store.query({ realm_id: 'R2' })).toHaveLength(0);
  });

  describe.skipIf(TEST_DIALECT !== 'sqlite')('SQLite file mode', () => {
    it('creates its own SQLite file with the imported_transactions table (never touches another DB)', async () => {
      const dir = tmp();
      const path = join(dir, 'nested', IMPORT_STORE_FILENAME);
      const store = ImportStore.openSqliteFile(path);
      await store.query({ realm_id: 'R1' }); // forces the open + migrations
      expect(existsSync(path)).toBe(true);
      const db = new Database(path, { readonly: true });
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r: any) => r.name);
      db.close();
      expect(tables).toContain('imported_transactions');
      expect(tables).toContain('schema_migrations');
      expect(tables).not.toContain('connections');
      await store.close();
    });

    it('reopening an existing file keeps its rows (schema + migrations are idempotent)', async () => {
      const path = join(tmp(), IMPORT_STORE_FILENAME);
      const a = ImportStore.openSqliteFile(path);
      await a.upsertLive(rec());
      await a.close();
      const b = ImportStore.openSqliteFile(path);
      expect((await b.getLive('R1', ['ns:1'])).size).toBe(1);
      await b.close();
    });

    it('adopts a store created before the migration runner (missing columns are added)', async () => {
      const path = join(tmp(), IMPORT_STORE_FILENAME);
      const raw = new Database(path);
      raw.exec(`CREATE TABLE imported_transactions (
        id INTEGER PRIMARY KEY AUTOINCREMENT, client TEXT NOT NULL, realm_id TEXT NOT NULL, source_id TEXT NOT NULL,
        run_id TEXT NOT NULL, txn_type TEXT NOT NULL, qbo_id TEXT NOT NULL, sync_token TEXT, doc_number TEXT, txn_date TEXT,
        amount REAL, status TEXT NOT NULL, payload_hash TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
      raw.prepare("INSERT INTO imported_transactions (client, realm_id, source_id, run_id, txn_type, qbo_id, status) VALUES ('Acme','R1','old:1','run-0','Bill','5','created')").run();
      raw.close();
      const store = ImportStore.openSqliteFile(path);
      const row = (await store.getLive('R1', ['old:1'])).get('old:1')!;
      expect(row.qbo_id).toBe('5');
      expect(row.qbo_type).toBe('');
      expect(row.message).toBeNull();
      await store.close();
    });

    it('ImportStoreHandle opens lazily and starts a fresh store when the file is deleted underneath it', async () => {
      const path = join(tmp(), IMPORT_STORE_FILENAME);
      const h = ImportStoreHandle.forSqliteFile(path);
      expect(existsSync(path)).toBe(false); // lazy
      await h.get().upsertLive(rec());
      expect((await h.get().getLive('R1', ['ns:1'])).size).toBe(1);
      rmSync(path);
      expect((await h.get().getLive('R1', ['ns:1'])).size).toBe(0);
      expect(existsSync(path)).toBe(true);
      await h.close();
    });
  });
});
