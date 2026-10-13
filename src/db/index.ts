import type { SqlDriver, SqlExecutor } from './driver.js';
import { SqliteDriver } from './sqlite-driver.js';
import { PostgresDriver, type PostgresDriverOptions } from './postgres-driver.js';
import { loadMigrations, runMigrations } from './migrate.js';
import { nowIso } from './time.js';
import type {
  ConnectionAlertRecord,
  ConnectionRecord,
  ConnectionStatus,
  FirmRecord,
  FirmStatus,
  NewConnection,
  TokenUpdate,
  UserAccessLevel,
  UserRecord,
  UserRole,
  UserStatus,
} from './models.js';

export type { SqlDialect, SqlDriver, SqlExecutor } from './driver.js';
export type { PostgresDriverOptions, PostgresSslMode } from './postgres-driver.js';

/** Where the connections database lives: a SQLite file, or a Postgres server. */
export type DatabaseOptions = { sqlitePath: string } | { postgres: PostgresDriverOptions };

/**
 * Additive column backfills for SQLite databases created before the
 * migration runner: CREATE TABLE IF NOT EXISTS in the baseline never adds a
 * column to an existing table, so these run first.
 */
async function legacySqliteBackfill(x: SqlExecutor): Promise<void> {
  const hasUsersTable = await x.get("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'users'");
  if (!hasUsersTable) return; // fresh database — the baseline creates everything
  const columns = await x.all<{ name: string }>('PRAGMA table_info(users)');
  const has = (name: string) => columns.some((c) => c.name === name);
  if (!has('access_level')) {
    await x.exec(
      "ALTER TABLE users ADD COLUMN access_level TEXT NOT NULL DEFAULT 'read_write' CHECK(access_level IN ('read', 'read_write'))"
    );
  }
  if (!has('username')) await x.exec('ALTER TABLE users ADD COLUMN username TEXT');
  if (!has('password_hash')) await x.exec('ALTER TABLE users ADD COLUMN password_hash TEXT');
  if (!has('api_key_encrypted')) await x.exec('ALTER TABLE users ADD COLUMN api_key_encrypted TEXT');
}

/** The single-firm default every row belongs to until firms are introduced. */
const DEFAULT_FIRM_ID = 1;

/** Thrown when a QuickBooks company is already connected under a different firm. */
export class ConnectionOwnedByAnotherFirmError extends Error {
  constructor(public readonly realmId: string) {
    super(
      'This QuickBooks company is already connected to a different account on this server. Disconnect it there first, then connect it here.'
    );
    this.name = 'ConnectionOwnedByAnotherFirmError';
  }
}

/** Open the driver for a DatabaseOptions value, with the main schema's migrations as its init step. */
export function openDatabaseDriver(options: DatabaseOptions): SqlDriver {
  if ('postgres' in options) {
    return new PostgresDriver(options.postgres, (x) => runMigrations(x, loadMigrations('postgres', 'main')).then(() => undefined));
  }
  return new SqliteDriver(options.sqlitePath, async (x) => {
    await legacySqliteBackfill(x);
    await runMigrations(x, loadMigrations('sqlite', 'main'));
  });
}

/**
 * The connections database: QuickBooks authorizations, team members and
 * their client assignments, dashboard sessions, the MCP OAuth server's
 * state, upload tokens and alert history. Every method is written once,
 * in the SQL subset both engines share (see driver.ts).
 */
export class ConnectionDatabase {
  readonly driver: SqlDriver;

  /** `new ConnectionDatabase('/path/to.db')` opens SQLite; pass DatabaseOptions for Postgres. */
  constructor(source: string | DatabaseOptions | SqlDriver) {
    if (typeof source === 'string') this.driver = openDatabaseDriver({ sqlitePath: source });
    else if ('dialect' in source) this.driver = source;
    else this.driver = openDatabaseDriver(source);
  }

  get dialect() {
    return this.driver.dialect;
  }

  private get sql(): SqlDriver {
    return this.driver;
  }

  // ── Connections ─────────────────────────────────────────────────────────

  /**
   * Insert a connection, or refresh it in place if the realm is already
   * connected (re-authorization / "reconnect"). On conflict the tokens and
   * expiries are replaced and status is reset to 'active', but the existing
   * client_name is preserved so an edited name survives a reconnect. The
   * realm_id is unchanged, so member assignments (keyed on realm_id) are kept.
   */
  async upsertConnection(conn: NewConnection, encryptedAccessToken: string, encryptedRefreshToken: string): Promise<number> {
    const firmId = conn.firmId ?? DEFAULT_FIRM_ID;
    // A realm belongs to one firm. The upsert only refreshes a row owned by
    // the same firm; a conflict with another firm's row updates nothing and
    // is reported, never silently re-homed.
    const row = await this.sql.get<{ id: number }>(
      `INSERT INTO connections (
         firm_id, client_name, realm_id, access_token, refresh_token,
         token_expiry, refresh_expiry, scopes, status, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)
       ON CONFLICT (realm_id) DO UPDATE SET
         access_token = excluded.access_token,
         refresh_token = excluded.refresh_token,
         token_expiry = excluded.token_expiry,
         refresh_expiry = excluded.refresh_expiry,
         scopes = excluded.scopes,
         status = 'active',
         updated_at = excluded.updated_at
       WHERE connections.firm_id = excluded.firm_id
       RETURNING id`,
      [
        firmId,
        conn.clientName,
        conn.realmId,
        encryptedAccessToken,
        encryptedRefreshToken,
        conn.tokenExpiry.toISOString(),
        conn.refreshExpiry.toISOString(),
        conn.scopes.join(','),
        nowIso(),
      ]
    );
    if (!row) throw new ConnectionOwnedByAnotherFirmError(conn.realmId);
    return row.id;
  }

  /**
   * Rename a connection (the client_name is a display label, not fetched
   * from QuickBooks). No-op if the realm does not exist.
   */
  async renameConnection(realmId: string, clientName: string): Promise<void> {
    await this.sql.run('UPDATE connections SET client_name = ?, updated_at = ? WHERE realm_id = ?', [
      clientName,
      nowIso(),
      realmId,
    ]);
  }

  /**
   * Insert a new connection
   */
  async insertConnection(conn: NewConnection, encryptedAccessToken: string, encryptedRefreshToken: string): Promise<number> {
    const row = await this.sql.get<{ id: number }>(
      `INSERT INTO connections (
         firm_id, client_name, realm_id, access_token, refresh_token,
         token_expiry, refresh_expiry, scopes
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       RETURNING id`,
      [
        conn.firmId ?? DEFAULT_FIRM_ID,
        conn.clientName,
        conn.realmId,
        encryptedAccessToken,
        encryptedRefreshToken,
        conn.tokenExpiry.toISOString(),
        conn.refreshExpiry.toISOString(),
        conn.scopes.join(','),
      ]
    );
    return row!.id;
  }

  async getConnectionByRealmId(realmId: string): Promise<ConnectionRecord | null> {
    return (await this.sql.get<ConnectionRecord>('SELECT * FROM connections WHERE realm_id = ?', [realmId])) ?? null;
  }

  /** Client names are unique only within a firm, so the lookup is firm-scoped. */
  async getConnectionByClientName(clientName: string, firmId: number = DEFAULT_FIRM_ID): Promise<ConnectionRecord | null> {
    return (
      (await this.sql.get<ConnectionRecord>('SELECT * FROM connections WHERE firm_id = ? AND client_name = ?', [
        firmId,
        clientName,
      ])) ?? null
    );
  }

  async getAllConnections(): Promise<ConnectionRecord[]> {
    return this.sql.all<ConnectionRecord>('SELECT * FROM connections ORDER BY client_name');
  }

  async getConnectionsForFirm(firmId: number): Promise<ConnectionRecord[]> {
    return this.sql.all<ConnectionRecord>('SELECT * FROM connections WHERE firm_id = ? ORDER BY client_name', [firmId]);
  }

  /** Every realm a firm has connected — the firm boundary for authorization. */
  async getFirmRealmIds(firmId: number): Promise<string[]> {
    const rows = await this.sql.all<{ realm_id: string }>(
      'SELECT realm_id FROM connections WHERE firm_id = ? ORDER BY realm_id',
      [firmId]
    );
    return rows.map((r) => r.realm_id);
  }

  async getConnectionsByStatus(status: ConnectionStatus): Promise<ConnectionRecord[]> {
    return this.sql.all<ConnectionRecord>('SELECT * FROM connections WHERE status = ? ORDER BY client_name', [status]);
  }

  async updateTokens(realmId: string, encryptedAccessToken: string, encryptedRefreshToken: string, update: TokenUpdate): Promise<void> {
    await this.sql.run(
      `UPDATE connections
       SET access_token = ?, refresh_token = ?, token_expiry = ?, refresh_expiry = ?, updated_at = ?
       WHERE realm_id = ?`,
      [
        encryptedAccessToken,
        encryptedRefreshToken,
        update.tokenExpiry.toISOString(),
        update.refreshExpiry.toISOString(),
        nowIso(),
        realmId,
      ]
    );
  }

  async updateStatus(realmId: string, status: ConnectionStatus): Promise<void> {
    await this.sql.run('UPDATE connections SET status = ?, updated_at = ? WHERE realm_id = ?', [status, nowIso(), realmId]);
  }

  async deleteConnection(realmId: string): Promise<void> {
    await this.sql.run('DELETE FROM connections WHERE realm_id = ?', [realmId]);
  }

  /**
   * Get connections expiring soon (for proactive refresh)
   */
  async getConnectionsExpiringSoon(minutesThreshold: number): Promise<ConnectionRecord[]> {
    const threshold = new Date(Date.now() + minutesThreshold * 60 * 1000).toISOString();
    return this.sql.all<ConnectionRecord>(
      `SELECT * FROM connections
       WHERE status = 'active' AND token_expiry < ?
       ORDER BY token_expiry`,
      [threshold]
    );
  }

  /**
   * Connections stuck in 'expired' whose 100-day refresh window is still
   * open — candidates for the daemon's self-heal revival pass.
   */
  async getRevivableConnections(): Promise<ConnectionRecord[]> {
    return this.sql.all<ConnectionRecord>(
      `SELECT * FROM connections
       WHERE status = 'expired' AND refresh_expiry > ?
       ORDER BY client_name`,
      [nowIso()]
    );
  }

  // ── Users ────────────────────────────────────────────────────────────────

  async insertUser(fields: {
    firmId?: number;
    name: string;
    email: string | null;
    role: UserRole;
    accessLevel: UserAccessLevel;
    username: string | null;
    passwordHash: string | null;
    apiKeyHash: string;
    apiKeyEncrypted: string | null;
    keyPrefix: string;
  }): Promise<number> {
    const row = await this.sql.get<{ id: number }>(
      `INSERT INTO users (firm_id, name, email, role, access_level, username, password_hash, api_key_hash, api_key_encrypted, key_prefix)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       RETURNING id`,
      [
        fields.firmId ?? DEFAULT_FIRM_ID,
        fields.name,
        fields.email,
        fields.role,
        fields.accessLevel,
        fields.username,
        fields.passwordHash,
        fields.apiKeyHash,
        fields.apiKeyEncrypted,
        fields.keyPrefix,
      ]
    );
    return row!.id;
  }

  async getUserById(id: number): Promise<UserRecord | null> {
    return (await this.sql.get<UserRecord>('SELECT * FROM users WHERE id = ?', [id])) ?? null;
  }

  async getUserByKeyHash(apiKeyHash: string): Promise<UserRecord | null> {
    return (await this.sql.get<UserRecord>('SELECT * FROM users WHERE api_key_hash = ?', [apiKeyHash])) ?? null;
  }

  /** Get user by username (callers normalize to lowercase before lookup) */
  async getUserByUsername(username: string): Promise<UserRecord | null> {
    return (await this.sql.get<UserRecord>('SELECT * FROM users WHERE username = ?', [username])) ?? null;
  }

  /** All users, or only one firm's. */
  async getAllUsers(firmId?: number): Promise<UserRecord[]> {
    if (firmId !== undefined) {
      return this.sql.all<UserRecord>('SELECT * FROM users WHERE firm_id = ? ORDER BY name', [firmId]);
    }
    return this.sql.all<UserRecord>('SELECT * FROM users ORDER BY name');
  }

  /**
   * Update user fields (only the provided ones). Administrative changes bump
   * updated_at; last_used_at touches (below) deliberately do not.
   */
  async updateUser(
    id: number,
    fields: {
      name?: string;
      email?: string | null;
      role?: UserRole;
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
    if (fields.accessLevel !== undefined) { sets.push('access_level = ?'); values.push(fields.accessLevel); }
    if (fields.username !== undefined) { sets.push('username = ?'); values.push(fields.username); }
    if (fields.status !== undefined) { sets.push('status = ?'); values.push(fields.status); }
    if (sets.length === 0) return;
    sets.push('updated_at = ?');
    values.push(nowIso(), id);
    await this.sql.run(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`, values);
  }

  /** Set or clear a user's dashboard password hash */
  async setUserPassword(id: number, passwordHash: string | null): Promise<void> {
    await this.sql.run('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?', [passwordHash, nowIso(), id]);
  }

  /** Replace a user's API key hash (key rotation) */
  async updateUserKey(id: number, apiKeyHash: string, keyPrefix: string, apiKeyEncrypted: string | null): Promise<void> {
    await this.sql.run(
      'UPDATE users SET api_key_hash = ?, key_prefix = ?, api_key_encrypted = ?, updated_at = ? WHERE id = ?',
      [apiKeyHash, keyPrefix, apiKeyEncrypted, nowIso(), id]
    );
  }

  /**
   * Backfill the encrypted copy of a key created before retrievable storage.
   * Deliberately does NOT touch api_key_hash, so it can't change auth.
   */
  async setUserKeyEncrypted(id: number, apiKeyEncrypted: string): Promise<void> {
    await this.sql.run('UPDATE users SET api_key_encrypted = ? WHERE id = ?', [apiKeyEncrypted, id]);
  }

  /** Record that a user's key was just used */
  async touchUserLastUsed(id: number): Promise<void> {
    await this.sql.run('UPDATE users SET last_used_at = ? WHERE id = ?', [nowIso(), id]);
  }

  /** Delete a user (assignments cascade) */
  async deleteUser(id: number): Promise<void> {
    await this.sql.run('DELETE FROM users WHERE id = ?', [id]);
  }

  /** Replace a user's client assignments */
  async setUserRealms(userId: number, realmIds: string[]): Promise<void> {
    await this.sql.transaction(async (tx) => {
      await tx.run('DELETE FROM user_clients WHERE user_id = ?', [userId]);
      for (const realmId of realmIds) {
        await tx.run('INSERT INTO user_clients (user_id, realm_id) VALUES (?, ?) ON CONFLICT DO NOTHING', [userId, realmId]);
      }
    });
  }

  /**
   * Replace the full set of users assigned to a realm (edit access from the
   * client side). Members not in the list lose access to this realm; admins
   * are unaffected since their access is role-based, not row-based.
   */
  async setRealmUsers(realmId: string, userIds: number[]): Promise<void> {
    await this.sql.transaction(async (tx) => {
      await tx.run('DELETE FROM user_clients WHERE realm_id = ?', [realmId]);
      for (const userId of userIds) {
        await tx.run('INSERT INTO user_clients (user_id, realm_id) VALUES (?, ?) ON CONFLICT DO NOTHING', [userId, realmId]);
      }
    });
  }

  /** Get realm IDs assigned to a user */
  async getUserRealms(userId: number): Promise<string[]> {
    const rows = await this.sql.all<{ realm_id: string }>(
      'SELECT realm_id FROM user_clients WHERE user_id = ? ORDER BY realm_id',
      [userId]
    );
    return rows.map((r) => r.realm_id);
  }

  /** Remove a realm from every user's assignments (when a company is disconnected) */
  async removeRealmAssignments(realmId: string): Promise<void> {
    await this.sql.run('DELETE FROM user_clients WHERE realm_id = ?', [realmId]);
  }

  // ── Firms ────────────────────────────────────────────────────────────────

  async insertFirm(fields: { name: string; slug: string; plan: string | null; companyLimit: number | null }): Promise<number> {
    const row = await this.sql.get<{ id: number }>(
      'INSERT INTO firms (name, slug, plan, company_limit) VALUES (?, ?, ?, ?) RETURNING id',
      [fields.name, fields.slug, fields.plan, fields.companyLimit]
    );
    return row!.id;
  }

  async getFirmById(id: number): Promise<FirmRecord | null> {
    return (await this.sql.get<FirmRecord>('SELECT * FROM firms WHERE id = ?', [id])) ?? null;
  }

  async getFirmBySlug(slug: string): Promise<FirmRecord | null> {
    return (await this.sql.get<FirmRecord>('SELECT * FROM firms WHERE slug = ?', [slug])) ?? null;
  }

  async getAllFirms(): Promise<FirmRecord[]> {
    return this.sql.all<FirmRecord>('SELECT * FROM firms ORDER BY id');
  }

  async updateFirm(
    id: number,
    fields: { name?: string; slug?: string; status?: FirmStatus; plan?: string | null; companyLimit?: number | null }
  ): Promise<void> {
    const sets: string[] = [];
    const values: unknown[] = [];
    if (fields.name !== undefined) { sets.push('name = ?'); values.push(fields.name); }
    if (fields.slug !== undefined) { sets.push('slug = ?'); values.push(fields.slug); }
    if (fields.status !== undefined) { sets.push('status = ?'); values.push(fields.status); }
    if (fields.plan !== undefined) { sets.push('plan = ?'); values.push(fields.plan); }
    if (fields.companyLimit !== undefined) { sets.push('company_limit = ?'); values.push(fields.companyLimit); }
    if (sets.length === 0) return;
    sets.push('updated_at = ?');
    values.push(nowIso(), id);
    await this.sql.run(`UPDATE firms SET ${sets.join(', ')} WHERE id = ?`, values);
  }

  // ── Sessions (dashboard sign-in) ─────────────────────────────────────────

  async insertSession(userId: number, tokenHash: string, expiresAtIso: string): Promise<void> {
    await this.sql.run('INSERT INTO sessions (user_id, token_hash, expires_at) VALUES (?, ?, ?)', [
      userId,
      tokenHash,
      expiresAtIso,
    ]);
  }

  /** Resolve an unexpired session token hash to its user row. */
  async getSessionUser(tokenHash: string): Promise<UserRecord | null> {
    const row = await this.sql.get<UserRecord>(
      `SELECT u.* FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ? AND s.expires_at > ?`,
      [tokenHash, nowIso()]
    );
    return row ?? null;
  }

  async touchSession(tokenHash: string): Promise<void> {
    await this.sql.run('UPDATE sessions SET last_used_at = ? WHERE token_hash = ?', [nowIso(), tokenHash]);
  }

  async deleteSessionByTokenHash(tokenHash: string): Promise<void> {
    await this.sql.run('DELETE FROM sessions WHERE token_hash = ?', [tokenHash]);
  }

  /**
   * End a user's sessions — all of them, or all except one (used when
   * changing a password from within a session).
   */
  async deleteUserSessions(userId: number, exceptTokenHash?: string): Promise<void> {
    if (exceptTokenHash) {
      await this.sql.run('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?', [userId, exceptTokenHash]);
    } else {
      await this.sql.run('DELETE FROM sessions WHERE user_id = ?', [userId]);
    }
  }

  async purgeExpiredSessions(): Promise<void> {
    await this.sql.run('DELETE FROM sessions WHERE expires_at <= ?', [nowIso()]);
  }

  // ── Upload tokens (REST attachments endpoint) ────────────────────────────

  async insertUploadToken(tokenHash: string, realmId: string, issuedBy: string, expiresAtIso: string): Promise<void> {
    await this.sql.run('INSERT INTO upload_tokens (token_hash, realm_id, issued_by, expires_at) VALUES (?, ?, ?, ?)', [
      tokenHash,
      realmId,
      issuedBy,
      expiresAtIso,
    ]);
  }

  /** Resolve an unexpired upload token hash to its realm binding. */
  async getUploadToken(tokenHash: string): Promise<{ realm_id: string; expires_at: string } | null> {
    const row = await this.sql.get<{ realm_id: string; expires_at: string }>(
      'SELECT realm_id, expires_at FROM upload_tokens WHERE token_hash = ? AND expires_at > ?',
      [tokenHash, nowIso()]
    );
    return row ?? null;
  }

  async purgeExpiredUploadTokens(): Promise<void> {
    await this.sql.run('DELETE FROM upload_tokens WHERE expires_at <= ?', [nowIso()]);
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
    await this.sql.run(
      'INSERT INTO oauth_clients (client_id, client_secret_hash, client_name, redirect_uris, grant_types, scope) VALUES (?, ?, ?, ?, ?, ?)',
      [
        client.clientId,
        client.clientSecretHash,
        client.clientName,
        JSON.stringify(client.redirectUris),
        JSON.stringify(client.grantTypes),
        client.scope,
      ]
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
    return (await this.sql.get<any>('SELECT * FROM oauth_clients WHERE client_id = ?', [clientId])) ?? null;
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
    await this.sql.run(
      'INSERT INTO oauth_auth_codes (code_hash, client_id, user_id, redirect_uri, code_challenge, scope, resource, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [row.codeHash, row.clientId, row.userId, row.redirectUri, row.codeChallenge, row.scope, row.resource, row.expiresAt]
    );
  }

  /** Fetch and delete an auth code in one statement — codes are single-use. */
  async consumeOAuthCode(codeHash: string): Promise<{
    client_id: string;
    user_id: number;
    redirect_uri: string;
    code_challenge: string;
    scope: string | null;
    expires_at: string;
  } | null> {
    return (await this.sql.get<any>('DELETE FROM oauth_auth_codes WHERE code_hash = ? RETURNING *', [codeHash])) ?? null;
  }

  async insertOAuthToken(row: {
    tokenHash: string;
    kind: 'access' | 'refresh';
    clientId: string;
    userId: number;
    scope: string | null;
    expiresAt: string;
  }): Promise<void> {
    await this.sql.run(
      'INSERT INTO oauth_tokens (token_hash, kind, client_id, user_id, scope, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
      [row.tokenHash, row.kind, row.clientId, row.userId, row.scope, row.expiresAt]
    );
  }

  async getOAuthToken(tokenHash: string, kind: 'access' | 'refresh'): Promise<{
    user_id: number;
    client_id: string;
    scope: string | null;
  } | null> {
    return (
      (await this.sql.get<any>(
        'SELECT user_id, client_id, scope FROM oauth_tokens WHERE token_hash = ? AND kind = ? AND expires_at > ?',
        [tokenHash, kind, nowIso()]
      )) ?? null
    );
  }

  async deleteOAuthToken(tokenHash: string): Promise<void> {
    await this.sql.run('DELETE FROM oauth_tokens WHERE token_hash = ?', [tokenHash]);
  }

  /** Revoke every OAuth token for a user (used when access is withdrawn). */
  async deleteOAuthTokensForUser(userId: number): Promise<void> {
    await this.sql.run('DELETE FROM oauth_tokens WHERE user_id = ?', [userId]);
  }

  async purgeExpiredOAuth(): Promise<void> {
    const now = nowIso();
    await this.sql.run('DELETE FROM oauth_tokens WHERE expires_at <= ?', [now]);
    await this.sql.run('DELETE FROM oauth_auth_codes WHERE expires_at <= ?', [now]);
  }

  // ── Connection alerts (email notifications) ──────────────────────────────

  /** Has this exact break (realm + dedupe key) already been reported? */
  async hasConnectionAlert(realmId: string, kind: ConnectionAlertRecord['kind'], dedupeKey: string): Promise<boolean> {
    const row = await this.sql.get(
      'SELECT 1 AS ok FROM connection_alerts WHERE realm_id = ? AND kind = ? AND dedupe_key = ?',
      [realmId, kind, dedupeKey]
    );
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
    await this.sql.run(
      `INSERT INTO connection_alerts (realm_id, client_name, kind, dedupe_key, recipients, provider_id)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT DO NOTHING`,
      [row.realmId, row.clientName, row.kind, row.dedupeKey, row.recipients.join(', '), row.providerId]
    );
  }

  /** The most recent alert sent, for the dashboard's status line. */
  async getLatestConnectionAlert(): Promise<ConnectionAlertRecord | null> {
    return (
      (await this.sql.get<ConnectionAlertRecord>(
        'SELECT * FROM connection_alerts ORDER BY sent_at DESC, id DESC LIMIT 1'
      )) ?? null
    );
  }

  /**
   * Close database connection
   */
  async close(): Promise<void> {
    await this.driver.close();
  }
}
