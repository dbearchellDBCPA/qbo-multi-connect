-- QBO Connections Schema
CREATE TABLE IF NOT EXISTS connections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_name TEXT NOT NULL,
  realm_id TEXT NOT NULL UNIQUE,
  access_token TEXT NOT NULL,  -- encrypted
  refresh_token TEXT NOT NULL, -- encrypted
  token_expiry DATETIME NOT NULL,
  refresh_expiry DATETIME NOT NULL,
  scopes TEXT NOT NULL,
  status TEXT DEFAULT 'active' CHECK(status IN ('active', 'expired', 'revoked')),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_connections_realm_id ON connections(realm_id);
CREATE INDEX IF NOT EXISTS idx_connections_status ON connections(status);
CREATE INDEX IF NOT EXISTS idx_connections_token_expiry ON connections(token_expiry);

-- Trigger to update updated_at timestamp
CREATE TRIGGER IF NOT EXISTS update_connections_timestamp
AFTER UPDATE ON connections
BEGIN
  UPDATE connections SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
END;

-- Team members. api_key_hash (SHA-256) authenticates requests;
-- api_key_encrypted (AES-256-GCM, same key as the OAuth tokens) lets a
-- signed-in user view their own key/connector URL — NULL for keys created
-- before retrievable storage existed (backfilled on their next key auth).
-- username/password_hash (scrypt) power the dashboard sign-in; both NULL
-- until credentials are set.
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT,
  role TEXT NOT NULL DEFAULT 'member' CHECK(role IN ('admin', 'member')),
  -- 'staff' is a firm team member. 'client' is a login handed to a client so
  -- their own AI assistant can read their own books: always read-only, never
  -- an admin, connector sign-in only (its API key is never accepted).
  account_type TEXT NOT NULL DEFAULT 'staff' CHECK(account_type IN ('staff', 'client')),
  -- Ceiling on what the key may do in QuickBooks: 'read' makes the member
  -- read-only on every company; 'read_write' defers to the per-company level
  -- in user_clients. Admin-role users always act as read_write regardless.
  access_level TEXT NOT NULL DEFAULT 'read_write' CHECK(access_level IN ('read', 'read_write')),
  username TEXT,
  password_hash TEXT,
  api_key_hash TEXT NOT NULL UNIQUE,
  api_key_encrypted TEXT,
  key_prefix TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'disabled')),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  last_used_at DATETIME,
  -- Invitation for a client login: a one-time link on which the client
  -- chooses their own password. Only the link's token hash is stored; it is
  -- cleared when the invitation is accepted or replaced.
  invite_sent_at DATETIME,
  invite_token_hash TEXT,
  invite_expires_at DATETIME,
  invite_accepted_at DATETIME
);

CREATE INDEX IF NOT EXISTS idx_users_api_key_hash ON users(api_key_hash);
CREATE INDEX IF NOT EXISTS idx_users_invite_token_hash ON users(invite_token_hash) WHERE invite_token_hash IS NOT NULL;
-- Usernames are normalized to lowercase before writes; the partial index
-- keeps NULLs (users without dashboard credentials) out of the constraint.
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users(username) WHERE username IS NOT NULL;

-- Only administrative changes bump updated_at; last_used_at touches on every
-- authenticated request must not clobber it. DROP+CREATE keeps databases
-- initialized with an earlier trigger definition consistent.
DROP TRIGGER IF EXISTS update_users_timestamp;
CREATE TRIGGER update_users_timestamp
AFTER UPDATE OF name, email, role, account_type, access_level, username, password_hash, status, api_key_hash ON users
BEGIN
  UPDATE users SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
END;

-- Dashboard sign-in sessions (username/password login). Tokens are stored
-- hashed; rows expire and are purged lazily on login.
CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  expires_at DATETIME NOT NULL,
  last_used_at DATETIME
);

CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);

-- Which QBO companies a member's key may access, and what it may do in each:
-- 'read' is reports and lookups only, 'read_write' is full access. A member
-- whose users.access_level is 'read' is read-only everywhere regardless of
-- the value here. Admins bypass this table.
CREATE TABLE IF NOT EXISTS user_clients (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  realm_id TEXT NOT NULL,
  access_level TEXT NOT NULL DEFAULT 'read_write' CHECK(access_level IN ('read', 'read_write')),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, realm_id)
);

CREATE INDEX IF NOT EXISTS idx_user_clients_user_id ON user_clients(user_id);
CREATE INDEX IF NOT EXISTS idx_user_clients_realm_id ON user_clients(realm_id);

-- Short-lived tokens minted by create_upload_session so an agent can push
-- file bytes to the REST attachments endpoint without knowing an API key.
-- Bound to one realm; stored hashed. user_id is the member who minted it
-- (NULL for the master key): the token only works while that member still
-- has read & write access to the realm.
CREATE TABLE IF NOT EXISTS upload_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token_hash TEXT NOT NULL UNIQUE,
  realm_id TEXT NOT NULL,
  issued_by TEXT,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  expires_at DATETIME NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_upload_tokens_hash ON upload_tokens(token_hash);

-- ── OAuth 2.1 authorization server (per-user MCP connector sign-in) ──────────
-- Lets one shared connector in a Claude workspace authenticate each user
-- individually: the MCP client registers itself (RFC 7591), the user signs in
-- with their dashboard credentials, and the resulting access token carries
-- THEIR identity, so client scoping applies per person.

-- Clients registered dynamically by MCP hosts (Claude, Claude Desktop, …).
CREATE TABLE IF NOT EXISTS oauth_clients (
  client_id TEXT PRIMARY KEY,
  client_secret_hash TEXT,
  client_name TEXT,
  redirect_uris TEXT NOT NULL,       -- JSON array
  grant_types TEXT NOT NULL,         -- JSON array
  scope TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Short-lived authorization codes (PKCE S256 required).
CREATE TABLE IF NOT EXISTS oauth_auth_codes (
  code_hash TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  redirect_uri TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  scope TEXT,
  resource TEXT,
  expires_at DATETIME NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Access and refresh tokens, stored hashed and bound to a user.
CREATE TABLE IF NOT EXISTS oauth_tokens (
  token_hash TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN ('access', 'refresh')),
  client_id TEXT NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scope TEXT,
  expires_at DATETIME NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  last_used_at DATETIME
);

CREATE INDEX IF NOT EXISTS idx_oauth_tokens_user ON oauth_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_oauth_codes_user ON oauth_auth_codes(user_id);

-- ── Settings an admin changes from the dashboard ─────────────────────────────
-- Small, named values that belong to this deployment rather than to its
-- environment — e.g. the firm's name as clients see it.
CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- ── Activity log ─────────────────────────────────────────────────────────────
-- One row per MCP tool call and per sign-in: who, which tool, which company,
-- whether it could change data, and how it ended. Arguments and results are
-- deliberately NOT recorded — they are client financial data. user_id has no
-- foreign key so history survives a login being removed.
CREATE TABLE IF NOT EXISTS activity_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  user_id INTEGER,
  user_name TEXT NOT NULL,
  account_type TEXT NOT NULL CHECK(account_type IN ('master', 'staff', 'client')),
  event TEXT NOT NULL CHECK(event IN ('tool_call', 'sign_in', 'sign_in_failed', 'locked_out')),
  tool TEXT,
  writes INTEGER NOT NULL DEFAULT 0,
  realm_id TEXT,
  client_name TEXT,
  outcome TEXT NOT NULL CHECK(outcome IN ('ok', 'denied', 'error'))
);

CREATE INDEX IF NOT EXISTS idx_activity_log_at ON activity_log(at);
CREATE INDEX IF NOT EXISTS idx_activity_log_user ON activity_log(user_id, id);
CREATE INDEX IF NOT EXISTS idx_activity_log_realm ON activity_log(realm_id, id);

-- ── Email alerts for broken connections ──────────────────────────────────────
-- One row per alert email the provider accepted. dedupe_key is the
-- refresh_expiry the connection had when it broke: the same break is never
-- reported twice (across restarts too), while a reconnect mints a new
-- refresh window and so a later break gets a fresh alert.
CREATE TABLE IF NOT EXISTS connection_alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  realm_id TEXT NOT NULL,
  client_name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('broken')),
  dedupe_key TEXT NOT NULL,
  recipients TEXT NOT NULL,
  provider_id TEXT,
  sent_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_connection_alerts_dedupe
  ON connection_alerts(realm_id, kind, dedupe_key);
