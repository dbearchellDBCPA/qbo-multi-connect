-- ── Bulk transaction-import mapping store ────────────────────────────────────
-- Lives in its OWN SQLite file (<data dir>/qbo-import-index.db, next to
-- QBO_DB_PATH), never inside the connections database: the import index can
-- be deleted and rebuilt from QBO (rebuild_import_index reads the
-- [src:<source_id>] stamp every imported transaction carries in PrivateNote)
-- without ever touching OAuth tokens, users or sessions.
--
-- One row per (company, source_id, QBO transaction). Rows are never dropped:
-- a rollback marks them status='deleted' and a later re-import adds a new
-- live row, so the history of every source_id is kept.
CREATE TABLE IF NOT EXISTS imported_transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client TEXT NOT NULL,              -- client_name at write time (display)
  realm_id TEXT NOT NULL,            -- the key: client names can be renamed
  source_id TEXT NOT NULL,           -- caller's external key, unique per company
  run_id TEXT NOT NULL,
  txn_type TEXT NOT NULL,            -- normalized type (JournalEntry, Check, …)
  qbo_type TEXT NOT NULL,            -- QBO entity (JournalEntry, Purchase, …)
  qbo_id TEXT NOT NULL,
  sync_token TEXT,
  doc_number TEXT,
  txn_date TEXT,
  amount REAL,
  status TEXT NOT NULL CHECK(status IN ('created', 'updated', 'indexed', 'deleted')),
  payload_hash TEXT,                 -- hash of the normalized input row; NULL when recovered by rebuild_import_index
  message TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- At most one LIVE mapping per source_id per company; deleted rows are history.
CREATE UNIQUE INDEX IF NOT EXISTS idx_imported_live_source
  ON imported_transactions(realm_id, source_id) WHERE status != 'deleted';
CREATE INDEX IF NOT EXISTS idx_imported_run ON imported_transactions(realm_id, run_id);
CREATE INDEX IF NOT EXISTS idx_imported_qbo ON imported_transactions(realm_id, qbo_type, qbo_id);
CREATE INDEX IF NOT EXISTS idx_imported_date ON imported_transactions(realm_id, txn_date);
