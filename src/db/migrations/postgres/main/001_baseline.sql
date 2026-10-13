-- ── QBO Multi-Connect: platform database (Postgres) ──────────────────────────
-- Same tables as the SQLite baseline, in Postgres types. Timestamps are
-- TIMESTAMPTZ; the driver hands them to the app as ISO-8601 strings so the
-- data layer is engine-agnostic. The bulk-import mapping store lives here
-- too (SQLite keeps it in a separate file), with the same table name.

CREATE TABLE IF NOT EXISTS connections (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  client_name TEXT NOT NULL,
  realm_id TEXT NOT NULL UNIQUE,
  access_token TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  token_expiry TIMESTAMPTZ NOT NULL,
  refresh_expiry TIMESTAMPTZ NOT NULL,
  scopes TEXT NOT NULL,
  status TEXT DEFAULT 'active' CHECK(status IN ('active', 'expired', 'revoked')),
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_connections_realm_id ON connections(realm_id);
CREATE INDEX IF NOT EXISTS idx_connections_status ON connections(status);
CREATE INDEX IF NOT EXISTS idx_connections_token_expiry ON connections(token_expiry);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT,
  role TEXT NOT NULL DEFAULT 'member' CHECK(role IN ('admin', 'member')),
  access_level TEXT NOT NULL DEFAULT 'read_write' CHECK(access_level IN ('read', 'read_write')),
  username TEXT,
  password_hash TEXT,
  api_key_hash TEXT NOT NULL UNIQUE,
  api_key_encrypted TEXT,
  key_prefix TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'disabled')),
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  last_used_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_users_api_key_hash ON users(api_key_hash);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users(username) WHERE username IS NOT NULL;

CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  last_used_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);

CREATE TABLE IF NOT EXISTS user_clients (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  realm_id TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (user_id, realm_id)
);

CREATE INDEX IF NOT EXISTS idx_user_clients_user_id ON user_clients(user_id);
CREATE INDEX IF NOT EXISTS idx_user_clients_realm_id ON user_clients(realm_id);

CREATE TABLE IF NOT EXISTS upload_tokens (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  realm_id TEXT NOT NULL,
  issued_by TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_upload_tokens_hash ON upload_tokens(token_hash);

CREATE TABLE IF NOT EXISTS oauth_clients (
  client_id TEXT PRIMARY KEY,
  client_secret_hash TEXT,
  client_name TEXT,
  redirect_uris TEXT NOT NULL,
  grant_types TEXT NOT NULL,
  scope TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS oauth_auth_codes (
  code_hash TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  redirect_uri TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  scope TEXT,
  resource TEXT,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS oauth_tokens (
  token_hash TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN ('access', 'refresh')),
  client_id TEXT NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scope TEXT,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  last_used_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_oauth_tokens_user ON oauth_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_oauth_codes_user ON oauth_auth_codes(user_id);

CREATE TABLE IF NOT EXISTS connection_alerts (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  realm_id TEXT NOT NULL,
  client_name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('broken')),
  dedupe_key TEXT NOT NULL,
  recipients TEXT NOT NULL,
  provider_id TEXT,
  sent_at TIMESTAMPTZ DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_connection_alerts_dedupe
  ON connection_alerts(realm_id, kind, dedupe_key);

-- ── Bulk transaction-import mapping store ────────────────────────────────────
CREATE TABLE IF NOT EXISTS imported_transactions (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  client TEXT NOT NULL,
  realm_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  txn_type TEXT NOT NULL,
  qbo_type TEXT NOT NULL,
  qbo_id TEXT NOT NULL,
  sync_token TEXT,
  doc_number TEXT,
  txn_date TEXT,
  amount DOUBLE PRECISION,
  status TEXT NOT NULL CHECK(status IN ('created', 'updated', 'indexed', 'deleted')),
  payload_hash TEXT,
  message TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_imported_live_source
  ON imported_transactions(realm_id, source_id) WHERE status <> 'deleted';
CREATE INDEX IF NOT EXISTS idx_imported_run ON imported_transactions(realm_id, run_id);
CREATE INDEX IF NOT EXISTS idx_imported_qbo ON imported_transactions(realm_id, qbo_type, qbo_id);
CREATE INDEX IF NOT EXISTS idx_imported_date ON imported_transactions(realm_id, txn_date);
