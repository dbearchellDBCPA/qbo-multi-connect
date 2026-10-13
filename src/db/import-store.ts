import { existsSync } from 'node:fs';
import type { SqlDriver, SqlExecutor } from './driver.js';
import { SqliteDriver } from './sqlite-driver.js';
import { loadMigrations, runMigrations } from './migrate.js';
import { nowIso } from './time.js';

/** File name of the mapping store inside the server's data directory (SQLite mode). */
export const IMPORT_STORE_FILENAME = 'qbo-import-index.db';

export type StoreStatus = 'created' | 'updated' | 'indexed' | 'deleted';

export interface ImportRecord {
  id: number;
  client: string;
  realm_id: string;
  source_id: string;
  run_id: string;
  txn_type: string;
  qbo_type: string;
  qbo_id: string;
  sync_token: string | null;
  doc_number: string | null;
  txn_date: string | null;
  amount: number | null;
  status: StoreStatus;
  payload_hash: string | null;
  message: string | null;
  created_at: string;
  updated_at: string;
}

export interface NewImportRecord {
  client: string;
  realm_id: string;
  source_id: string;
  run_id: string;
  txn_type: string;
  qbo_type: string;
  qbo_id: string;
  sync_token?: string | null;
  doc_number?: string | null;
  txn_date?: string | null;
  amount?: number | null;
  status: Exclude<StoreStatus, 'deleted'>;
  payload_hash?: string | null;
  message?: string | null;
}

export interface ImportQuery {
  realm_id: string;
  run_id?: string;
  source_ids?: string[];
  txn_type?: string;
  status?: string;
  start_date?: string;
  end_date?: string;
  /** Include status='deleted' history rows (default true for status queries). */
  include_deleted?: boolean;
}

/** Column backfills for SQLite import stores created before the migration runner. */
async function legacySqliteBackfill(x: SqlExecutor): Promise<void> {
  const exists = await x.get(
    "SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'imported_transactions'"
  );
  if (!exists) return; // fresh store — the baseline creates everything
  const columns = await x.all<{ name: string }>('PRAGMA table_info(imported_transactions)');
  const has = (name: string) => columns.some((c) => c.name === name);
  if (!has('message')) await x.exec('ALTER TABLE imported_transactions ADD COLUMN message TEXT');
  if (!has('qbo_type')) await x.exec("ALTER TABLE imported_transactions ADD COLUMN qbo_type TEXT NOT NULL DEFAULT ''");
}

/** Open a standalone SQLite import store (its own file, its own migrations). */
export function openSqliteImportDriver(path: string): SqlDriver {
  return new SqliteDriver(path, async (x) => {
    await legacySqliteBackfill(x);
    await runMigrations(x, loadMigrations('sqlite', 'import'));
  });
}

/**
 * Mapping store for bulk imports: source_id → QBO transaction.
 *
 * In SQLite mode it owns a separate file next to the connections DB (so the
 * index can be deleted and rebuilt from QBO without touching tokens or
 * users). In Postgres mode it shares the platform database's driver; its
 * table is created by the main migrations.
 */
export class ImportStore {
  constructor(
    private readonly sql: SqlDriver,
    /** Whether close() should close the driver (true for a dedicated SQLite file). */
    private readonly ownsDriver: boolean
  ) {}

  static openSqliteFile(path: string): ImportStore {
    return new ImportStore(openSqliteImportDriver(path), true);
  }

  static forDriver(driver: SqlDriver): ImportStore {
    return new ImportStore(driver, false);
  }

  get dialect() {
    return this.sql.dialect;
  }

  /** The live (non-deleted) mapping for each source_id, keyed by source_id. */
  async getLive(realmId: string, sourceIds: string[]): Promise<Map<string, ImportRecord>> {
    const out = new Map<string, ImportRecord>();
    const ids = [...new Set(sourceIds)];
    if (ids.length === 0) return out;
    // Keep each statement's parameter list bounded (SQLite's default limit is 999).
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500);
      const rows = await this.sql.all<ImportRecord>(
        `SELECT * FROM imported_transactions
         WHERE realm_id = ? AND status != 'deleted' AND source_id IN (${chunk.map(() => '?').join(', ')})`,
        [realmId, ...chunk]
      );
      for (const row of rows) out.set(row.source_id, row);
    }
    return out;
  }

  /** Insert a live mapping, or replace the live one for that source_id. */
  async upsertLive(rec: NewImportRecord): Promise<void> {
    await this.sql.transaction(async (tx) => {
      const live = await tx.get<{ id: number }>(
        "SELECT id FROM imported_transactions WHERE realm_id = ? AND source_id = ? AND status != 'deleted'",
        [rec.realm_id, rec.source_id]
      );
      const values = [
        rec.client, rec.run_id, rec.txn_type, rec.qbo_type, rec.qbo_id, rec.sync_token ?? null, rec.doc_number ?? null,
        rec.txn_date ?? null, rec.amount ?? null, rec.status, rec.payload_hash ?? null, rec.message ?? null,
      ];
      if (live) {
        await tx.run(
          `UPDATE imported_transactions SET client = ?, run_id = ?, txn_type = ?, qbo_type = ?, qbo_id = ?, sync_token = ?,
             doc_number = ?, txn_date = ?, amount = ?, status = ?, payload_hash = ?, message = ?, updated_at = ?
           WHERE id = ?`,
          [...values, nowIso(), live.id]
        );
      } else {
        await tx.run(
          `INSERT INTO imported_transactions (client, run_id, txn_type, qbo_type, qbo_id, sync_token, doc_number, txn_date,
             amount, status, payload_hash, message, realm_id, source_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [...values, rec.realm_id, rec.source_id]
        );
      }
    });
  }

  /** Fill in a recovered row's payload hash once a re-run proved it matches. */
  async setPayloadHash(id: number, hash: string): Promise<void> {
    await this.sql.run('UPDATE imported_transactions SET payload_hash = ?, updated_at = ? WHERE id = ?', [hash, nowIso(), id]);
  }

  /** Mark a live row deleted (kept as history). */
  async markDeleted(id: number, message: string): Promise<void> {
    await this.sql.run(
      "UPDATE imported_transactions SET status = 'deleted', message = ?, updated_at = ? WHERE id = ?",
      [message, nowIso(), id]
    );
  }

  async query(q: ImportQuery): Promise<ImportRecord[]> {
    const where: string[] = ['realm_id = ?'];
    const params: unknown[] = [q.realm_id];
    if (q.run_id) { where.push('run_id = ?'); params.push(q.run_id); }
    if (q.source_ids && q.source_ids.length > 0) {
      where.push(`source_id IN (${q.source_ids.map(() => '?').join(', ')})`);
      params.push(...q.source_ids);
    }
    if (q.txn_type) { where.push('txn_type = ?'); params.push(q.txn_type); }
    if (q.status) { where.push('status = ?'); params.push(q.status); }
    else if (q.include_deleted === false) where.push("status != 'deleted'");
    if (q.start_date) { where.push('txn_date >= ?'); params.push(q.start_date); }
    if (q.end_date) { where.push('txn_date <= ?'); params.push(q.end_date); }
    return this.sql.all<ImportRecord>(
      `SELECT * FROM imported_transactions WHERE ${where.join(' AND ')} ORDER BY txn_date, id`,
      params
    );
  }

  /** Remove every row for a company — the Postgres counterpart of deleting the SQLite file. */
  async wipe(realmId?: string): Promise<void> {
    if (realmId) await this.sql.run('DELETE FROM imported_transactions WHERE realm_id = ?', [realmId]);
    else await this.sql.run('DELETE FROM imported_transactions');
  }

  async close(): Promise<void> {
    if (this.ownsDriver) await this.sql.close();
  }
}

/**
 * Lazily opened store handle.
 *
 * SQLite: survives its file being deleted underneath it — if the file is
 * gone at the next call, the handle (pointing at an unlinked inode) is
 * closed and a fresh, empty store is created at the same path, which is
 * what rebuild_import_index then repopulates.
 *
 * Postgres: wraps the shared platform driver; the table is always there.
 */
export class ImportStoreHandle {
  private store: ImportStore | null = null;
  private readonly path: string | null;
  private readonly shared: SqlDriver | null;

  constructor(source: string | SqlDriver) {
    if (typeof source === 'string') {
      this.path = source;
      this.shared = null;
    } else {
      this.path = null;
      this.shared = source;
    }
  }

  static forSqliteFile(path: string): ImportStoreHandle {
    return new ImportStoreHandle(path);
  }

  static forDriver(driver: SqlDriver): ImportStoreHandle {
    return new ImportStoreHandle(driver);
  }

  get(): ImportStore {
    if (this.shared) {
      if (!this.store) this.store = ImportStore.forDriver(this.shared);
      return this.store;
    }
    const path = this.path!;
    if (this.store && path !== ':memory:' && !existsSync(path)) {
      void this.store.close().catch(() => undefined); // already gone
      this.store = null;
    }
    if (!this.store) this.store = ImportStore.openSqliteFile(path);
    return this.store;
  }

  async close(): Promise<void> {
    await this.store?.close();
    this.store = null;
  }
}
