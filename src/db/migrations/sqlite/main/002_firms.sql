-- ── Firms (multi-tenancy) ────────────────────────────────────────────────────
-- Every connection and user belongs to a firm. Firm 1 ("Default") is created
-- here so a single-firm installation keeps working exactly as before: all
-- existing rows land in it, and the master key acts within it unless told
-- otherwise. SQLite cannot add a REFERENCES clause to an existing table
-- without a NULL default, so the foreign key is enforced by the app here;
-- Postgres declares it.
CREATE TABLE IF NOT EXISTS firms (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'suspended')),
  plan TEXT,
  company_limit INTEGER,
  created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

INSERT INTO firms (id, name, slug) VALUES (1, 'Default', 'default') ON CONFLICT DO NOTHING;

ALTER TABLE connections ADD COLUMN firm_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE users ADD COLUMN firm_id INTEGER NOT NULL DEFAULT 1;

CREATE INDEX IF NOT EXISTS idx_connections_firm ON connections(firm_id);
CREATE INDEX IF NOT EXISTS idx_users_firm ON users(firm_id);
