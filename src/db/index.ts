import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type {
  ActivityEntry,
  ConnectionAlertRecord,
  ConnectionRecord,
  ConnectionStatus,
  NewActivityEntry,
  NewConnection,
  TokenUpdate,
  UserAccessLevel,
  UserAccountType,
  UserRecord,
  UserRole,
  UserStatus,
} from './models.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export class ConnectionDatabase {
  private db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.init();
  }

  /**
   * Initialize database schema
   */
  private init(): void {
    // Column migrations must run BEFORE schema.sql: its CREATE TABLE IF NOT
    // EXISTS never adds columns to an existing table, and the users trigger
    // it (re)creates references columns older databases don't have yet.
    this.migrate();
    const schemaPath = join(__dirname, 'schema.sql');
    const schema = readFileSync(schemaPath, 'utf-8');
    this.db.exec(schema);
  }

  /**
   * Additive column migrations for databases created by earlier versions.
   */
  private migrate(): void {
    const hasUsersTable = this.db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'users'")
      .get();
    if (!hasUsersTable) return; // fresh database — schema.sql creates everything

    const columns = this.db.prepare('PRAGMA table_info(users)').all() as Array<{ name: string }>;
    const has = (name: string) => columns.some((c) => c.name === name);
    if (!has('access_level')) {
      this.db.exec(
        "ALTER TABLE users ADD COLUMN access_level TEXT NOT NULL DEFAULT 'read_write' CHECK(access_level IN ('read', 'read_write'))"
      );
    }
    if (!has('username')) this.db.exec('ALTER TABLE users ADD COLUMN username TEXT');
    if (!has('password_hash')) this.db.exec('ALTER TABLE users ADD COLUMN password_hash TEXT');
    if (!has('api_key_encrypted')) this.db.exec('ALTER TABLE users ADD COLUMN api_key_encrypted TEXT');
    // Client logins. Everyone already in the table is firm staff.
    if (!has('account_type')) {
      this.db.exec(
        "ALTER TABLE users ADD COLUMN account_type TEXT NOT NULL DEFAULT 'staff' CHECK(account_type IN ('staff', 'client'))"
      );
    }

    // Per-company access level. Existing assignments become 'read_write' —
    // members who were read-only stay read-only through users.access_level,
    // which still caps every company, so nobody gains access in the upgrade.
    const hasAssignments = this.db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'user_clients'")
      .get();
    if (hasAssignments) {
      const assignmentColumns = this.db.prepare('PRAGMA table_info(user_clients)').all() as Array<{ name: string }>;
      if (!assignmentColumns.some((c) => c.name === 'access_level')) {
        this.db.exec(
          "ALTER TABLE user_clients ADD COLUMN access_level TEXT NOT NULL DEFAULT 'read_write' CHECK(access_level IN ('read', 'read_write'))"
        );
      }
    }

    // Upload tokens remember who minted them, so one stops working when that
    // member loses write access. Tokens from before this column (they live an
    // hour at most) keep NULL and simply run out their time.
    const hasUploadTokens = this.db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'upload_tokens'")
      .get();
    if (hasUploadTokens) {
      const tokenColumns = this.db.prepare('PRAGMA table_info(upload_tokens)').all() as Array<{ name: string }>;
      if (!tokenColumns.some((c) => c.name === 'user_id')) {
        this.db.exec('ALTER TABLE upload_tokens ADD COLUMN user_id INTEGER REFERENCES users(id) ON DELETE CASCADE');
      }
    }
  }

  /**
   * Insert a connection, or refresh it in place if the realm is already
   * connected (re-authorization / "reconnect"). On conflict the tokens and
   * expiries are replaced and status is reset to 'active', but the existing
   * client_name is preserved so an edited name survives a reconnect. The
   * realm_id is unchanged, so member assignments (keyed on realm_id) are kept.
   */
  async upsertConnection(conn: NewConnection, encryptedAccessToken: string, encryptedRefreshToken: string): Promise<number> {
    const stmt = this.db.prepare(`
      INSERT INTO connections (
        client_name, realm_id, access_token, refresh_token,
        token_expiry, refresh_expiry, scopes, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active')
      ON CONFLICT(realm_id) DO UPDATE SET
        access_token = excluded.access_token,
        refresh_token = excluded.refresh_token,
        token_expiry = excluded.token_expiry,
        refresh_expiry = excluded.refresh_expiry,
        scopes = excluded.scopes,
        status = 'active'
    `);

    stmt.run(
      conn.clientName,
      conn.realmId,
      encryptedAccessToken,
      encryptedRefreshToken,
      conn.tokenExpiry.toISOString(),
      conn.refreshExpiry.toISOString(),
      conn.scopes.join(',')
    );

    const row = this.db.prepare('SELECT id FROM connections WHERE realm_id = ?').get(conn.realmId) as { id: number };
    return row.id;
  }

  /**
   * Rename a connection (the client_name is a display label, not fetched
   * from QuickBooks). No-op if the realm does not exist.
   */
  async renameConnection(realmId: string, clientName: string): Promise<void> {
    this.db.prepare('UPDATE connections SET client_name = ? WHERE realm_id = ?').run(clientName, realmId);
  }

  /**
   * Insert a new connection
   */
  async insertConnection(conn: NewConnection, encryptedAccessToken: string, encryptedRefreshToken: string): Promise<number> {
    const stmt = this.db.prepare(`
      INSERT INTO connections (
        client_name, realm_id, access_token, refresh_token,
        token_expiry, refresh_expiry, scopes
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    const result = stmt.run(
      conn.clientName,
      conn.realmId,
      encryptedAccessToken,
      encryptedRefreshToken,
      conn.tokenExpiry.toISOString(),
      conn.refreshExpiry.toISOString(),
      conn.scopes.join(',')
    );

    return result.lastInsertRowid as number;
  }

  /**
   * Get connection by realm ID
   */
  async getConnectionByRealmId(realmId: string): Promise<ConnectionRecord | null> {
    const stmt = this.db.prepare('SELECT * FROM connections WHERE realm_id = ?');
    return stmt.get(realmId) as ConnectionRecord | null;
  }

  /**
   * Get connection by client name
   */
  async getConnectionByClientName(clientName: string): Promise<ConnectionRecord | null> {
    const stmt = this.db.prepare('SELECT * FROM connections WHERE client_name = ?');
    return stmt.get(clientName) as ConnectionRecord | null;
  }

  /**
   * Get all connections
   */
  async getAllConnections(): Promise<ConnectionRecord[]> {
    const stmt = this.db.prepare('SELECT * FROM connections ORDER BY client_name');
    return stmt.all() as ConnectionRecord[];
  }

  /**
   * Get connections by status
   */
  async getConnectionsByStatus(status: ConnectionStatus): Promise<ConnectionRecord[]> {
    const stmt = this.db.prepare('SELECT * FROM connections WHERE status = ? ORDER BY client_name');
    return stmt.all(status) as ConnectionRecord[];
  }

  /**
   * Update connection tokens
   */
  async updateTokens(realmId: string, encryptedAccessToken: string, encryptedRefreshToken: string, update: TokenUpdate): Promise<void> {
    const stmt = this.db.prepare(`
      UPDATE connections 
      SET access_token = ?, refresh_token = ?, token_expiry = ?, refresh_expiry = ?
      WHERE realm_id = ?
    `);

    stmt.run(
      encryptedAccessToken,
      encryptedRefreshToken,
      update.tokenExpiry.toISOString(),
      update.refreshExpiry.toISOString(),
      realmId
    );
  }

  /**
   * Update connection status
   */
  async updateStatus(realmId: string, status: ConnectionStatus): Promise<void> {
    const stmt = this.db.prepare('UPDATE connections SET status = ? WHERE realm_id = ?');
    stmt.run(status, realmId);
  }

  /**
   * Delete connection
   */
  async deleteConnection(realmId: string): Promise<void> {
    const stmt = this.db.prepare('DELETE FROM connections WHERE realm_id = ?');
    stmt.run(realmId);
  }

  /**
   * Get connections expiring soon (for proactive refresh)
   */
  async getConnectionsExpiringSoon(minutesThreshold: number): Promise<ConnectionRecord[]> {
    const threshold = new Date(Date.now() + minutesThreshold * 60 * 1000).toISOString();
    const stmt = this.db.prepare(`
      SELECT * FROM connections
      WHERE status = 'active' AND token_expiry < ?
      ORDER BY token_expiry
    `);
    return stmt.all(threshold) as ConnectionRecord[];
  }

  /**
   * Connections stuck in 'expired' whose 100-day refresh window is still
   * open — candidates for the daemon's self-heal revival pass.
   */
  async getRevivableConnections(): Promise<ConnectionRecord[]> {
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      SELECT * FROM connections
      WHERE status = 'expired' AND refresh_expiry > ?
      ORDER BY client_name
    `);
    return stmt.all(now) as ConnectionRecord[];
  }

  // ── Users ────────────────────────────────────────────────────────────────

  /**
   * Insert a new user
   */
  async insertUser(fields: {
    name: string;
    email: string | null;
    role: UserRole;
    accountType?: UserAccountType;
    accessLevel: UserAccessLevel;
    username: string | null;
    passwordHash: string | null;
    apiKeyHash: string;
    apiKeyEncrypted: string | null;
    keyPrefix: string;
  }): Promise<number> {
    const stmt = this.db.prepare(`
      INSERT INTO users (name, email, role, account_type, access_level, username, password_hash, api_key_hash, api_key_encrypted, key_prefix)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(
      fields.name,
      fields.email,
      fields.role,
      fields.accountType ?? 'staff',
      fields.accessLevel,
      fields.username,
      fields.passwordHash,
      fields.apiKeyHash,
      fields.apiKeyEncrypted,
      fields.keyPrefix
    );
    return result.lastInsertRowid as number;
  }

  /**
   * Get user by ID
   */
  async getUserById(id: number): Promise<UserRecord | null> {
    const stmt = this.db.prepare('SELECT * FROM users WHERE id = ?');
    return (stmt.get(id) as UserRecord | undefined) ?? null;
  }

  /**
   * Get user by API key hash
   */
  async getUserByKeyHash(apiKeyHash: string): Promise<UserRecord | null> {
    const stmt = this.db.prepare('SELECT * FROM users WHERE api_key_hash = ?');
    return (stmt.get(apiKeyHash) as UserRecord | undefined) ?? null;
  }

  /**
   * Get user by username (callers normalize to lowercase before lookup)
   */
  async getUserByUsername(username: string): Promise<UserRecord | null> {
    const stmt = this.db.prepare('SELECT * FROM users WHERE username = ?');
    return (stmt.get(username) as UserRecord | undefined) ?? null;
  }

  /**
   * Get all users
   */
  async getAllUsers(): Promise<UserRecord[]> {
    const stmt = this.db.prepare('SELECT * FROM users ORDER BY name');
    return stmt.all() as UserRecord[];
  }

  /**
   * Update user fields (only the provided ones)
   */
  async updateUser(
    id: number,
    fields: {
      name?: string;
      email?: string | null;
      role?: UserRole;
      accountType?: UserAccountType;
      accessLevel?: UserAccessLevel;
      username?: string | null;
      status?: UserStatus;
    }
  ): Promise<void> {
    const sets: string[] = [];
    const values: unknown[] = [];
    if (fields.name !== undefined) { sets.push('name = ?'); values.push(fields.name); }
    if (fields.email !== undefined) { sets.push('email = ?'); values.push(fields.email); }
    if (fields.role !== undefined) { sets.push('role = ?'); values.push(fields.role); }
    if (fields.accountType !== undefined) { sets.push('account_type = ?'); values.push(fields.accountType); }
    if (fields.accessLevel !== undefined) { sets.push('access_level = ?'); values.push(fields.accessLevel); }
    if (fields.username !== undefined) { sets.push('username = ?'); values.push(fields.username); }
    if (fields.status !== undefined) { sets.push('status = ?'); values.push(fields.status); }
    if (sets.length === 0) return;
    values.push(id);
    this.db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  }

  /**
   * Set or clear a user's dashboard password hash
   */
  async setUserPassword(id: number, passwordHash: string | null): Promise<void> {
    this.db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(passwordHash, id);
  }

  /**
   * Replace a user's API key hash (key rotation)
   */
  async updateUserKey(id: number, apiKeyHash: string, keyPrefix: string, apiKeyEncrypted: string | null): Promise<void> {
    this.db.prepare('UPDATE users SET api_key_hash = ?, key_prefix = ?, api_key_encrypted = ? WHERE id = ?')
      .run(apiKeyHash, keyPrefix, apiKeyEncrypted, id);
  }

  /**
   * Backfill the encrypted copy of a key created before retrievable storage.
   * Deliberately does NOT touch api_key_hash, so it can't change auth.
   */
  async setUserKeyEncrypted(id: number, apiKeyEncrypted: string): Promise<void> {
    this.db.prepare('UPDATE users SET api_key_encrypted = ? WHERE id = ?').run(apiKeyEncrypted, id);
  }

  /**
   * Record that a user's key was just used
   */
  async touchUserLastUsed(id: number): Promise<void> {
    this.db.prepare("UPDATE users SET last_used_at = datetime('now') WHERE id = ?").run(id);
  }

  /**
   * Delete a user (assignments cascade)
   */
  async deleteUser(id: number): Promise<void> {
    this.db.prepare('DELETE FROM users WHERE id = ?').run(id);
  }

  /**
   * Replace a user's client assignments, each with its own access level
   */
  async setUserAssignments(
    userId: number,
    assignments: Array<{ realmId: string; accessLevel: UserAccessLevel }>
  ): Promise<void> {
    const replaceAll = this.db.transaction((rows: Array<{ realmId: string; accessLevel: UserAccessLevel }>) => {
      this.db.prepare('DELETE FROM user_clients WHERE user_id = ?').run(userId);
      const insert = this.db.prepare(
        'INSERT OR REPLACE INTO user_clients (user_id, realm_id, access_level) VALUES (?, ?, ?)'
      );
      for (const row of rows) insert.run(userId, row.realmId, row.accessLevel);
    });
    replaceAll(assignments);
  }

  /**
   * Replace the full set of members assigned to a realm (edit access from
   * the client side), each with its own access level. Members not in the list
   * lose access to this realm; admins are unaffected since their access is
   * role-based, not row-based, and any row they hold is left as it is unless
   * the list names them.
   */
  async setRealmAssignments(
    realmId: string,
    assignments: Array<{ userId: number; accessLevel: UserAccessLevel }>
  ): Promise<void> {
    const replaceAll = this.db.transaction((rows: Array<{ userId: number; accessLevel: UserAccessLevel }>) => {
      // Only member rows are replaced. An admin's row is dormant (their
      // access is by role) and callers list members only — deleting it here
      // would silently cost them this company if they are ever made a member
      // again.
      this.db
        .prepare("DELETE FROM user_clients WHERE realm_id = ? AND user_id NOT IN (SELECT id FROM users WHERE role = 'admin')")
        .run(realmId);
      const insert = this.db.prepare(
        'INSERT OR REPLACE INTO user_clients (user_id, realm_id, access_level) VALUES (?, ?, ?)'
      );
      for (const row of rows) insert.run(row.userId, realmId, row.accessLevel);
    });
    replaceAll(assignments);
  }

  /**
   * Get a user's assignments (realm + access level), ordered by realm
   */
  async getUserAssignments(userId: number): Promise<Array<{ realmId: string; accessLevel: UserAccessLevel }>> {
    const rows = this.db
      .prepare('SELECT realm_id, access_level FROM user_clients WHERE user_id = ? ORDER BY realm_id')
      .all(userId) as Array<{ realm_id: string; access_level: UserAccessLevel }>;
    return rows.map((r) => ({ realmId: r.realm_id, accessLevel: r.access_level }));
  }

  /**
   * Get the assignments for one realm (user + access level)
   */
  async getRealmAssignments(realmId: string): Promise<Array<{ userId: number; accessLevel: UserAccessLevel }>> {
    const rows = this.db
      .prepare('SELECT user_id, access_level FROM user_clients WHERE realm_id = ? ORDER BY user_id')
      .all(realmId) as Array<{ user_id: number; access_level: UserAccessLevel }>;
    return rows.map((r) => ({ userId: r.user_id, accessLevel: r.access_level }));
  }

  /**
   * Get realm IDs assigned to a user
   */
  async getUserRealms(userId: number): Promise<string[]> {
    return (await this.getUserAssignments(userId)).map((a) => a.realmId);
  }

  /**
   * Remove a realm from every user's assignments (when a company is disconnected)
   */
  async removeRealmAssignments(realmId: string): Promise<void> {
    this.db.prepare('DELETE FROM user_clients WHERE realm_id = ?').run(realmId);
  }

  // ── Activity log ─────────────────────────────────────────────────────────

  async insertActivity(entry: NewActivityEntry): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO activity_log (user_id, user_name, account_type, event, tool, writes, realm_id, client_name, outcome)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        entry.userId,
        entry.userName,
        entry.accountType,
        entry.event,
        entry.tool ?? null,
        entry.writes ? 1 : 0,
        entry.realmId ?? null,
        entry.clientName ?? null,
        entry.outcome
      );
  }

  /** Newest first. `beforeId` pages backwards; filters combine with AND. */
  async listActivity(filter: {
    userId?: number;
    realmId?: string;
    accountType?: 'master' | UserAccountType;
    beforeId?: number;
    limit: number;
  }): Promise<ActivityEntry[]> {
    const where: string[] = [];
    const values: unknown[] = [];
    if (filter.userId !== undefined) { where.push('user_id = ?'); values.push(filter.userId); }
    if (filter.realmId !== undefined) { where.push('realm_id = ?'); values.push(filter.realmId); }
    if (filter.accountType !== undefined) { where.push('account_type = ?'); values.push(filter.accountType); }
    if (filter.beforeId !== undefined) { where.push('id < ?'); values.push(filter.beforeId); }
    const rows = this.db
      .prepare(
        `SELECT * FROM activity_log ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`
      )
      .all(...values, filter.limit) as Array<{
        id: number; at: string; user_id: number | null; user_name: string; account_type: 'master' | UserAccountType;
        event: ActivityEntry['event']; tool: string | null; writes: number; realm_id: string | null;
        client_name: string | null; outcome: ActivityEntry['outcome'];
      }>;
    return rows.map((r) => ({
      id: r.id,
      at: new Date(`${r.at.replace(' ', 'T')}Z`),
      userId: r.user_id,
      userName: r.user_name,
      accountType: r.account_type,
      event: r.event,
      tool: r.tool,
      writes: r.writes === 1,
      realmId: r.realm_id,
      clientName: r.client_name,
      outcome: r.outcome,
    }));
  }

  /** Drop entries older than the retention window. Returns how many went. */
  async purgeActivityOlderThan(days: number): Promise<number> {
    return this.db.prepare("DELETE FROM activity_log WHERE at < datetime('now', ?)").run(`-${Math.floor(days)} days`).changes;
  }

  /** Keep only the newest `maxRows` entries. Returns how many went. */
  async trimActivityTo(maxRows: number): Promise<number> {
    return this.db
      .prepare('DELETE FROM activity_log WHERE id <= (SELECT MAX(id) FROM activity_log) - ?')
      .run(Math.floor(maxRows)).changes;
  }

  // ── Sessions (dashboard sign-in) ─────────────────────────────────────────

  async insertSession(userId: number, tokenHash: string, expiresAtIso: string): Promise<void> {
    this.db.prepare('INSERT INTO sessions (user_id, token_hash, expires_at) VALUES (?, ?, ?)')
      .run(userId, tokenHash, expiresAtIso);
  }

  /**
   * Resolve an unexpired session token hash to its user row.
   */
  async getSessionUser(tokenHash: string): Promise<UserRecord | null> {
    const stmt = this.db.prepare(`
      SELECT u.* FROM sessions s
      JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ? AND s.expires_at > datetime('now')
    `);
    return (stmt.get(tokenHash) as UserRecord | undefined) ?? null;
  }

  async touchSession(tokenHash: string): Promise<void> {
    this.db.prepare("UPDATE sessions SET last_used_at = datetime('now') WHERE token_hash = ?").run(tokenHash);
  }

  async deleteSessionByTokenHash(tokenHash: string): Promise<void> {
    this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
  }

  /**
   * End a user's sessions — all of them, or all except one (used when
   * changing a password from within a session).
   */
  async deleteUserSessions(userId: number, exceptTokenHash?: string): Promise<void> {
    if (exceptTokenHash) {
      this.db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?').run(userId, exceptTokenHash);
    } else {
      this.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
    }
  }

  async purgeExpiredSessions(): Promise<void> {
    this.db.prepare("DELETE FROM sessions WHERE expires_at <= datetime('now')").run();
  }

  // ── Upload tokens (REST attachments endpoint) ────────────────────────────

  async insertUploadToken(
    tokenHash: string,
    realmId: string,
    issuedBy: string,
    expiresAtIso: string,
    userId: number | null = null
  ): Promise<void> {
    this.db.prepare('INSERT INTO upload_tokens (token_hash, realm_id, issued_by, expires_at, user_id) VALUES (?, ?, ?, ?, ?)')
      .run(tokenHash, realmId, issuedBy, expiresAtIso, userId);
  }

  /** Resolve an unexpired upload token hash to its realm binding and issuer. */
  async getUploadToken(tokenHash: string): Promise<{ realm_id: string; expires_at: string; user_id: number | null } | null> {
    const row = this.db.prepare(
      "SELECT realm_id, expires_at, user_id FROM upload_tokens WHERE token_hash = ? AND expires_at > datetime('now')"
    ).get(tokenHash) as { realm_id: string; expires_at: string; user_id: number | null } | undefined;
    return row ?? null;
  }

  async purgeExpiredUploadTokens(): Promise<void> {
    this.db.prepare("DELETE FROM upload_tokens WHERE expires_at <= datetime('now')").run();
  }

  // ── OAuth 2.1 authorization server ───────────────────────────────────────

  async insertOAuthClient(client: {
    clientId: string;
    clientSecretHash: string | null;
    clientName: string | null;
    redirectUris: string[];
    grantTypes: string[];
    scope: string | null;
  }): Promise<void> {
    this.db.prepare(
      'INSERT INTO oauth_clients (client_id, client_secret_hash, client_name, redirect_uris, grant_types, scope) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(
      client.clientId,
      client.clientSecretHash,
      client.clientName,
      JSON.stringify(client.redirectUris),
      JSON.stringify(client.grantTypes),
      client.scope
    );
  }

  async getOAuthClient(clientId: string): Promise<{
    client_id: string;
    client_secret_hash: string | null;
    client_name: string | null;
    redirect_uris: string;
    grant_types: string;
    scope: string | null;
  } | null> {
    const row = this.db.prepare('SELECT * FROM oauth_clients WHERE client_id = ?').get(clientId) as any;
    return row ?? null;
  }

  async insertOAuthCode(row: {
    codeHash: string;
    clientId: string;
    userId: number;
    redirectUri: string;
    codeChallenge: string;
    scope: string | null;
    resource: string | null;
    expiresAt: string;
  }): Promise<void> {
    this.db.prepare(
      'INSERT INTO oauth_auth_codes (code_hash, client_id, user_id, redirect_uri, code_challenge, scope, resource, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(row.codeHash, row.clientId, row.userId, row.redirectUri, row.codeChallenge, row.scope, row.resource, row.expiresAt);
  }

  /** Fetch and immediately delete an auth code — codes are single-use. */
  async consumeOAuthCode(codeHash: string): Promise<{
    client_id: string;
    user_id: number;
    redirect_uri: string;
    code_challenge: string;
    scope: string | null;
    expires_at: string;
  } | null> {
    const row = this.db.prepare('SELECT * FROM oauth_auth_codes WHERE code_hash = ?').get(codeHash) as any;
    if (row) this.db.prepare('DELETE FROM oauth_auth_codes WHERE code_hash = ?').run(codeHash);
    return row ?? null;
  }

  async insertOAuthToken(row: {
    tokenHash: string;
    kind: 'access' | 'refresh';
    clientId: string;
    userId: number;
    scope: string | null;
    expiresAt: string;
  }): Promise<void> {
    this.db.prepare(
      'INSERT INTO oauth_tokens (token_hash, kind, client_id, user_id, scope, expires_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(row.tokenHash, row.kind, row.clientId, row.userId, row.scope, row.expiresAt);
  }

  async getOAuthToken(tokenHash: string, kind: 'access' | 'refresh'): Promise<{
    user_id: number;
    client_id: string;
    scope: string | null;
  } | null> {
    const row = this.db.prepare(
      "SELECT user_id, client_id, scope FROM oauth_tokens WHERE token_hash = ? AND kind = ? AND expires_at > datetime('now')"
    ).get(tokenHash, kind) as any;
    return row ?? null;
  }

  async deleteOAuthToken(tokenHash: string): Promise<void> {
    this.db.prepare('DELETE FROM oauth_tokens WHERE token_hash = ?').run(tokenHash);
  }

  /** Revoke every OAuth token for a user (used when access is withdrawn). */
  async deleteOAuthTokensForUser(userId: number): Promise<void> {
    this.db.prepare('DELETE FROM oauth_tokens WHERE user_id = ?').run(userId);
  }

  async purgeExpiredOAuth(): Promise<void> {
    this.db.prepare("DELETE FROM oauth_tokens WHERE expires_at <= datetime('now')").run();
    this.db.prepare("DELETE FROM oauth_auth_codes WHERE expires_at <= datetime('now')").run();
  }

  // ── Connection alerts (email notifications) ──────────────────────────────

  /** Has this exact break (realm + dedupe key) already been reported? */
  async hasConnectionAlert(realmId: string, kind: ConnectionAlertRecord['kind'], dedupeKey: string): Promise<boolean> {
    const row = this.db
      .prepare('SELECT 1 FROM connection_alerts WHERE realm_id = ? AND kind = ? AND dedupe_key = ?')
      .get(realmId, kind, dedupeKey);
    return row !== undefined;
  }

  /** Record a delivered alert. A duplicate (same realm + kind + key) is ignored. */
  async insertConnectionAlert(row: {
    realmId: string;
    clientName: string;
    kind: ConnectionAlertRecord['kind'];
    dedupeKey: string;
    recipients: string[];
    providerId: string | null;
  }): Promise<void> {
    this.db
      .prepare(
        'INSERT OR IGNORE INTO connection_alerts (realm_id, client_name, kind, dedupe_key, recipients, provider_id) VALUES (?, ?, ?, ?, ?, ?)'
      )
      .run(row.realmId, row.clientName, row.kind, row.dedupeKey, row.recipients.join(', '), row.providerId);
  }

  /** The most recent alert sent, for the dashboard's status line. */
  async getLatestConnectionAlert(): Promise<ConnectionAlertRecord | null> {
    const row = this.db
      .prepare('SELECT * FROM connection_alerts ORDER BY sent_at DESC, id DESC LIMIT 1')
      .get() as ConnectionAlertRecord | undefined;
    return row ?? null;
  }

  /**
   * Close database connection
   */
  async close(): Promise<void> {
    this.db.close();
  }
}
