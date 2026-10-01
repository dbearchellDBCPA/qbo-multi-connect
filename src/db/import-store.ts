import Database from 'better-sqlite3';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** File name of the mapping store inside the server's data directory. */
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

/**
 * SQLite mapping store for bulk imports: source_id → QBO transaction.
 *
 * Same pattern as ConnectionDatabase: additive column migrations first
 * (migrate), then the idempotent schema file. Separate file from the
 * connections DB on purpose — see import-schema.sql.
 */
export class ImportStore {
  private db: Database.Database;

  constructor(readonly path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.init();
  }

  private init(): void {
    this.migrate();
    const schemaPath = join(__dirname, 'import-schema.sql');
    this.db.exec(readFileSync(schemaPath, 'utf-8'));
  }

  /** Additive migrations for stores created by earlier versions (none yet beyond v1). */
  private migrate(): void {
    const exists = this.db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'imported_transactions'")
      .get();
    if (!exists) return; // fresh store — the schema file creates everything
    const columns = this.db.prepare('PRAGMA table_info(imported_transactions)').all() as Array<{ name: string }>;
    const has = (name: string) => columns.some((c) => c.name === name);
    if (!has('message')) this.db.exec('ALTER TABLE imported_transactions ADD COLUMN message TEXT');
    if (!has('qbo_type')) this.db.exec("ALTER TABLE imported_transactions ADD COLUMN qbo_type TEXT NOT NULL DEFAULT ''");
  }

  /** The live (non-deleted) mapping for each source_id, keyed by source_id. */
  getLive(realmId: string, sourceIds: string[]): Map<string, ImportRecord> {
    const out = new Map<string, ImportRecord>();
    const stmt = this.db.prepare(
      "SELECT * FROM imported_transactions WHERE realm_id = ? AND source_id = ? AND status != 'deleted'"
    );
    for (const id of new Set(sourceIds)) {
      const row = stmt.get(realmId, id) as ImportRecord | undefined;
      if (row) out.set(id, row);
    }
    return out;
  }

  /** Insert a live mapping, or replace the live one for that source_id. */
  upsertLive(rec: NewImportRecord): void {
    const tx = this.db.transaction((r: NewImportRecord) => {
      const live = this.db
        .prepare("SELECT id FROM imported_transactions WHERE realm_id = ? AND source_id = ? AND status != 'deleted'")
        .get(r.realm_id, r.source_id) as { id: number } | undefined;
      const values = [
        r.client, r.run_id, r.txn_type, r.qbo_type, r.qbo_id, r.sync_token ?? null, r.doc_number ?? null,
        r.txn_date ?? null, r.amount ?? null, r.status, r.payload_hash ?? null, r.message ?? null,
      ];
      if (live) {
        this.db.prepare(
          `UPDATE imported_transactions SET client = ?, run_id = ?, txn_type = ?, qbo_type = ?, qbo_id = ?, sync_token = ?,
             doc_number = ?, txn_date = ?, amount = ?, status = ?, payload_hash = ?, message = ?, updated_at = CURRENT_TIMESTAMP
           WHERE id = ?`
        ).run(...values, live.id);
      } else {
        this.db.prepare(
          `INSERT INTO imported_transactions (client, run_id, txn_type, qbo_type, qbo_id, sync_token, doc_number, txn_date,
             amount, status, payload_hash, message, realm_id, source_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(...values, r.realm_id, r.source_id);
      }
    });
    tx(rec);
  }

  /** Fill in a recovered row's payload hash once a re-run proved it matches. */
  setPayloadHash(id: number, hash: string): void {
    this.db.prepare('UPDATE imported_transactions SET payload_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(hash, id);
  }

  /** Mark a live row deleted (kept as history). */
  markDeleted(id: number, message: string): void {
    this.db
      .prepare("UPDATE imported_transactions SET status = 'deleted', message = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
      .run(message, id);
  }

  query(q: ImportQuery): ImportRecord[] {
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
    return this.db
      .prepare(`SELECT * FROM imported_transactions WHERE ${where.join(' AND ')} ORDER BY txn_date, id`)
      .all(...params) as ImportRecord[];
  }

  close(): void {
    this.db.close();
  }
}

/**
 * Lazily opened store that survives its file being deleted underneath it:
 * if the file is gone at the next call, the handle (pointing at an unlinked
 * inode) is closed and a fresh, empty store is created at the same path —
 * which is what rebuild_import_index then repopulates.
 */
export class ImportStoreHandle {
  private store: ImportStore | null = null;

  constructor(readonly path: string) {}

  get(): ImportStore {
    if (this.store && this.path !== ':memory:' && !existsSync(this.path)) {
      try { this.store.close(); } catch { /* already gone */ }
      this.store = null;
    }
    if (!this.store) this.store = new ImportStore(this.path);
    return this.store;
  }

  close(): void {
    this.store?.close();
    this.store = null;
  }
}
