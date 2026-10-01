import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { ImportStore, ImportStoreHandle, IMPORT_STORE_FILENAME, type NewImportRecord } from '../../src/db/import-store.js';

const rec = (over: Partial<NewImportRecord> = {}): NewImportRecord => ({
  client: 'Co', realm_id: 'R1', source_id: 'ns:1', run_id: 'run-a', txn_type: 'Bill', qbo_type: 'Bill', qbo_id: '10',
  sync_token: '0', doc_number: 'B1', txn_date: '2026-07-01', amount: 100, status: 'created', payload_hash: 'h1', ...over,
});

describe('ImportStore', () => {
  const dirs: string[] = [];
  const tmp = () => {
    const d = mkdtempSync(join(tmpdir(), 'import-store-'));
    dirs.push(d);
    return d;
  };
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('creates its own SQLite file with the imported_transactions table (never touches another DB)', () => {
    const dir = tmp();
    const path = join(dir, 'nested', IMPORT_STORE_FILENAME);
    const store = new ImportStore(path);
    expect(existsSync(path)).toBe(true);
    const db = new Database(path, { readonly: true });
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r: any) => r.name);
    db.close();
    expect(tables).toContain('imported_transactions');
    expect(tables).not.toContain('connections');
    store.close();
  });

  it('upserts one live row per (realm, source_id) and replaces it in place', () => {
    const store = new ImportStore(':memory:');
    store.upsertLive(rec());
    store.upsertLive(rec({ status: 'updated', sync_token: '1', amount: 120, payload_hash: 'h2' }));
    const live = store.getLive('R1', ['ns:1', 'ns:missing']);
    expect(live.size).toBe(1);
    const row = live.get('ns:1')!;
    expect(row).toMatchObject({ status: 'updated', sync_token: '1', amount: 120, payload_hash: 'h2', qbo_id: '10', run_id: 'run-a' });
    expect(store.query({ realm_id: 'R1' })).toHaveLength(1);
  });

  it('keeps deleted rows as history and allows the source_id to be imported again', () => {
    const store = new ImportStore(':memory:');
    store.upsertLive(rec());
    const first = store.getLive('R1', ['ns:1']).get('ns:1')!;
    store.markDeleted(first.id, 'deleted by run run-a');
    expect(store.getLive('R1', ['ns:1']).size).toBe(0);
    store.upsertLive(rec({ qbo_id: '11', run_id: 'run-b' }));
    const all = store.query({ realm_id: 'R1' });
    expect(all.map((r) => [r.qbo_id, r.status])).toEqual([['10', 'deleted'], ['11', 'created']]);
    expect(store.query({ realm_id: 'R1', include_deleted: false })).toHaveLength(1);
    expect(store.query({ realm_id: 'R1', status: 'deleted' })[0].message).toBe('deleted by run run-a');
  });

  it('the partial unique index refuses two live rows for one source_id', () => {
    const store = new ImportStore(':memory:');
    store.upsertLive(rec());
    const db = (store as any).db as Database.Database;
    expect(() => db.prepare(
      "INSERT INTO imported_transactions (client, realm_id, source_id, run_id, txn_type, qbo_type, qbo_id, status) VALUES ('Co','R1','ns:1','x','Bill','Bill','99','created')"
    ).run()).toThrow(/UNIQUE/);
  });

  it('separates companies by realm and filters by run, type, ids, status and dates', () => {
    const store = new ImportStore(':memory:');
    store.upsertLive(rec());
    store.upsertLive(rec({ source_id: 'ns:2', txn_type: 'Invoice', qbo_type: 'Invoice', qbo_id: '20', txn_date: '2026-07-15', run_id: 'run-b' }));
    store.upsertLive(rec({ realm_id: 'R2', source_id: 'ns:1', qbo_id: '30' }));
    expect(store.query({ realm_id: 'R1', run_id: 'run-b' }).map((r) => r.source_id)).toEqual(['ns:2']);
    expect(store.query({ realm_id: 'R1', txn_type: 'Bill' }).map((r) => r.qbo_id)).toEqual(['10']);
    expect(store.query({ realm_id: 'R1', source_ids: ['ns:1', 'ns:2'] })).toHaveLength(2);
    expect(store.query({ realm_id: 'R1', start_date: '2026-07-10', end_date: '2026-07-31' }).map((r) => r.source_id)).toEqual(['ns:2']);
    expect(store.getLive('R2', ['ns:1']).get('ns:1')!.qbo_id).toBe('30');
  });

  it('setPayloadHash fills a recovered (indexed) row', () => {
    const store = new ImportStore(':memory:');
    store.upsertLive(rec({ status: 'indexed', payload_hash: null }));
    const row = store.getLive('R1', ['ns:1']).get('ns:1')!;
    store.setPayloadHash(row.id, 'abc');
    expect(store.getLive('R1', ['ns:1']).get('ns:1')!.payload_hash).toBe('abc');
  });

  it('reopening an existing file keeps its rows (schema + migrations are idempotent)', () => {
    const path = join(tmp(), IMPORT_STORE_FILENAME);
    const a = new ImportStore(path);
    a.upsertLive(rec());
    a.close();
    const b = new ImportStore(path);
    expect(b.getLive('R1', ['ns:1']).size).toBe(1);
    b.close();
  });

  it('ImportStoreHandle opens lazily and starts a fresh store when the file is deleted underneath it', () => {
    const path = join(tmp(), IMPORT_STORE_FILENAME);
    const h = new ImportStoreHandle(path);
    expect(existsSync(path)).toBe(false); // lazy
    h.get().upsertLive(rec());
    expect(h.get().getLive('R1', ['ns:1']).size).toBe(1);
    rmSync(path);
    expect(h.get().getLive('R1', ['ns:1']).size).toBe(0);
    expect(existsSync(path)).toBe(true);
    h.close();
  });
});
