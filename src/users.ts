import { randomBytes, createHash, scryptSync, timingSafeEqual } from 'node:crypto';
import { encrypt, decrypt } from './crypto/encrypt.js';
import type { ConnectionDatabase } from './db/index.js';
import type { ClientAssignment, NewUser, User, UserAccessLevel, UserAccountType, UserRecord, UserUpdate } from './db/models.js';

/** Length of the plaintext prefix stored for display (e.g. "qbo_1a2b3c4d") */
const KEY_PREFIX_LENGTH = 12;

/** Skip the last_used_at write when the key was already seen this recently. */
const LAST_USED_THROTTLE_MS = 60_000;

/** Dashboard sessions live this long; sign-in issues a fresh one. */
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Session tokens are prefixed so they can never be confused with API keys. */
const SESSION_TOKEN_PREFIX = 'qbos_';

/** Lowercase letters, digits and @._- (so an email works as a username). */
const USERNAME_RE = /^[a-z0-9@._-]{3,64}$/;

export const MIN_PASSWORD_LENGTH = 8;

/** Consecutive failed sign-ins before a username is locked… */
export const MAX_LOGIN_FAILURES = 5;
/** …for this long at first, doubling with each further failure… */
export const LOGIN_LOCKOUT_MS = 60_000;
/** …up to this ceiling, so a determined guesser gets a handful of tries an hour. */
export const MAX_LOGIN_LOCKOUT_MS = 15 * 60_000;

/** The result of a password sign-in attempt. */
export type LoginResult =
  | { status: 'ok'; user: User }
  | { status: 'invalid' }
  | { status: 'locked'; retryAfterMs: number };

export function hashApiKey(apiKey: string): string {
  return createHash('sha256').update(apiKey, 'utf8').digest('hex');
}

export function generateApiKey(): string {
  return `qbo_${randomBytes(24).toString('hex')}`;
}

export function normalizeUsername(username: string): string {
  return username.trim().toLowerCase();
}

export function isValidUsername(username: string): boolean {
  return USERNAME_RE.test(username);
}

// ── Passwords (scrypt, node built-in — no external hashing dependency) ──────
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 64;

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const derived = scryptSync(password, salt, SCRYPT_KEYLEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  return `scrypt:${SCRYPT_N}:${SCRYPT_R}:${SCRYPT_P}:${salt.toString('base64')}:${derived.toString('base64')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split(':');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, nStr, rStr, pStr, saltB64, hashB64] = parts;
  const salt = Buffer.from(saltB64, 'base64');
  const expected = Buffer.from(hashB64, 'base64');
  const derived = scryptSync(password, salt, expected.length, {
    N: Number(nStr),
    r: Number(rStr),
    p: Number(pStr),
  });
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

// Verified against when a login names an unknown user, so "no such username"
// and "wrong password" take comparable time.
const DUMMY_PASSWORD_HASH = hashPassword('dummy-timing-equalizer');

/**
 * SQLite's CURRENT_TIMESTAMP / datetime('now') store "YYYY-MM-DD HH:MM:SS"
 * in UTC without a zone marker; new Date() would parse that as LOCAL time.
 */
function parseUtcDate(value: string): Date {
  return new Date(value.includes('T') ? value : `${value.replace(' ', 'T')}Z`);
}

/** The level new assignments get when none is given. */
export const DEFAULT_ASSIGNMENT_LEVEL: UserAccessLevel = 'read_write';

/**
 * The level a new assignment gets when the caller doesn't choose one: read &
 * write, unless the member is read-only everywhere. Storing 'read' for those
 * means lifting the member-wide cap later doesn't quietly hand them write
 * access to companies that were only ever added as read-only.
 */
function defaultLevelFor(memberLevel: UserAccessLevel | undefined): UserAccessLevel {
  return memberLevel === 'read' ? 'read' : DEFAULT_ASSIGNMENT_LEVEL;
}

/**
 * What a user may actually do in one company: null when it isn't assigned to
 * them, otherwise the per-company level capped by the user-level ceiling.
 * Admins reach every company with full access. A client login is read-only
 * on its assigned companies no matter what else is stored on it — that rule
 * is checked first so no combination of other fields can widen it.
 */
export function effectiveAccessLevel(
  user: Pick<User, 'role' | 'accessLevel' | 'assignments'> & { accountType?: UserAccountType },
  realmId: string
): UserAccessLevel | null {
  const assignment = user.assignments.find((a) => a.realmId === realmId);
  if (user.accountType === 'client') return assignment ? 'read' : null;
  if (user.role === 'admin') return 'read_write';
  if (!assignment) return null;
  return user.accessLevel === 'read' ? 'read' : assignment.accessLevel;
}

/** Whether the user has the admin role AND is a kind of account that may hold it. */
export function isAdminUser(user: Pick<User, 'role'> & { accountType?: UserAccountType }): boolean {
  return user.role === 'admin' && user.accountType !== 'client';
}

function toUser(record: UserRecord, assignments: ClientAssignment[]): User {
  const realmIds = assignments.map((a) => a.realmId);
  return {
    id: record.id,
    name: record.name,
    email: record.email,
    role: record.role,
    accountType: record.account_type ?? 'staff',
    accessLevel: record.access_level,
    username: record.username,
    hasPassword: record.password_hash != null,
    keyPrefix: record.key_prefix,
    status: record.status,
    createdAt: parseUtcDate(record.created_at),
    updatedAt: parseUtcDate(record.updated_at),
    lastUsedAt: record.last_used_at ? parseUtcDate(record.last_used_at) : null,
    realmIds,
    assignments,
  };
}

/**
 * Team member management: each user gets their own API key (stored hashed)
 * and a list of assigned QBO companies, each with its own access level
 * (read-only or read & write). Admin-role users see every company with full
 * access; member-role users see only their assignments.
 */
export class UserService {
  /** Failed sign-ins per username. In memory: a restart clears every lock. */
  private loginFailures = new Map<string, { fails: number; lockedUntil: number }>();

  constructor(
    private db: ConnectionDatabase,
    private encryptionKey: string
  ) {}

  /** Validate + normalize a username, ensuring it isn't taken by another user. */
  private async prepareUsername(raw: string, forUserId?: number): Promise<string> {
    const username = normalizeUsername(raw);
    if (!isValidUsername(username)) {
      throw new Error('Username must be 3-64 characters: letters, digits, @ . _ -');
    }
    const existing = await this.db.getUserByUsername(username);
    if (existing && existing.id !== forUserId) {
      throw new Error(`Username "${username}" is already taken`);
    }
    return username;
  }

  /**
   * Create a user. The plaintext API key is returned AND stored encrypted
   * (same AES-256-GCM key as the OAuth tokens) so the member can view it
   * again after signing in; authentication still checks only the hash.
   */
  async create(input: NewUser): Promise<{ user: User; apiKey: string }> {
    const name = input.name?.trim();
    if (!name) throw new Error('User name is required');
    if (input.password && input.password.length < MIN_PASSWORD_LENGTH) {
      throw new Error(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
    }
    const isClient = input.accountType === 'client';
    if (isClient && input.role === 'admin') {
      throw new Error('A client login cannot be an admin');
    }
    if (isClient && input.accessLevel === 'read_write') {
      throw new Error('A client login is always read-only');
    }
    if (isClient) {
      // Stored read-only as well as enforced read-only, so the data itself
      // says the same thing the account type does.
      input = {
        ...input,
        accessLevel: 'read',
        assignments: (input.assignments ?? (input.realmIds ?? []).map((realmId) => ({ realmId, accessLevel: 'read' as const })))
          .map((a) => ({ realmId: a.realmId, accessLevel: 'read' as const })),
      };
    }

    const apiKey = generateApiKey();
    const id = await this.db.insertUser({
      name,
      email: input.email?.trim() || null,
      role: input.role ?? 'member',
      accountType: input.accountType ?? 'staff',
      accessLevel: input.accessLevel ?? 'read_write',
      username: input.username ? await this.prepareUsername(input.username) : null,
      passwordHash: input.password ? hashPassword(input.password) : null,
      apiKeyHash: hashApiKey(apiKey),
      apiKeyEncrypted: encrypt(apiKey, this.encryptionKey),
      keyPrefix: apiKey.slice(0, KEY_PREFIX_LENGTH),
    });
    const assignments =
      input.assignments ??
      (input.realmIds ?? []).map((realmId) => ({ realmId, accessLevel: defaultLevelFor(input.accessLevel) }));
    if (assignments.length) {
      await this.db.setUserAssignments(id, assignments);
    }
    return { user: (await this.get(id))!, apiKey };
  }

  async get(id: number): Promise<User | null> {
    const record = await this.db.getUserById(id);
    if (!record) return null;
    return toUser(record, await this.db.getUserAssignments(id));
  }

  async list(): Promise<User[]> {
    const records = await this.db.getAllUsers();
    return Promise.all(records.map(async (r) => toUser(r, await this.db.getUserAssignments(r.id))));
  }

  async update(id: number, fields: UserUpdate): Promise<User | null> {
    const existing = await this.db.getUserById(id);
    if (!existing) return null;
    if (fields.name !== undefined && !fields.name.trim()) {
      throw new Error('User name cannot be empty');
    }
    // A client login stays a read-only member whatever else is being edited,
    // and turning a staff account into one drops it to read-only.
    const becomesClient = (fields.accountType ?? existing.account_type) === 'client';
    if (becomesClient) {
      if ((fields.role ?? existing.role) === 'admin') {
        throw new Error('A client login cannot be an admin');
      }
      if (fields.accessLevel === 'read_write') {
        throw new Error('A client login is always read-only');
      }
      fields = { ...fields, accessLevel: 'read' };
    }
    let username: string | null | undefined = fields.username;
    if (typeof username === 'string' && username.trim()) {
      username = await this.prepareUsername(username, id);
    } else if (typeof username === 'string') {
      username = null; // blank string clears the username
    }
    await this.db.updateUser(id, {
      ...fields,
      name: fields.name?.trim(),
      email: fields.email === undefined ? undefined : fields.email?.trim() || null,
      username,
    });
    return this.get(id);
  }

  /**
   * Replace the user's assigned companies with the given realm IDs. A company
   * that stays assigned keeps its access level; a newly assigned one gets the
   * default (read & write, or read-only for a read-only-everywhere member).
   * Use setAssignments to choose levels.
   */
  async setClients(id: number, realmIds: string[]): Promise<User | null> {
    const record = await this.db.getUserById(id);
    if (!record) return null;
    const current = new Map((await this.db.getUserAssignments(id)).map((a) => [a.realmId, a.accessLevel]));
    const fallback = defaultLevelFor(record.access_level);
    await this.db.setUserAssignments(
      id,
      realmIds.map((realmId) => ({ realmId, accessLevel: current.get(realmId) ?? fallback }))
    );
    return this.get(id);
  }

  /** Replace the user's assigned companies, each with an explicit access level. */
  async setAssignments(id: number, assignments: ClientAssignment[]): Promise<User | null> {
    const record = await this.db.getUserById(id);
    if (!record) return null;
    await this.db.setUserAssignments(
      id,
      record.account_type === 'client'
        ? assignments.map((a) => ({ realmId: a.realmId, accessLevel: 'read' as const }))
        : assignments
    );
    return this.get(id);
  }

  /**
   * Replace the full set of users assigned to a company (edit access from
   * the client side). Members not in the list lose access to that realm; a
   * member who stays keeps their level, a newly added one gets the default
   * (read & write, or read-only for a read-only-everywhere member). Use
   * setClientAssignments to choose levels.
   */
  async setClientUsers(realmId: string, userIds: number[]): Promise<void> {
    const current = new Map((await this.db.getRealmAssignments(realmId)).map((a) => [a.userId, a.accessLevel]));
    const assignments = [];
    for (const userId of userIds) {
      const fallback = defaultLevelFor((await this.db.getUserById(userId))?.access_level);
      assignments.push({ userId, accessLevel: current.get(userId) ?? fallback });
    }
    await this.db.setRealmAssignments(realmId, assignments);
  }

  /** Replace the users assigned to a company, each with an explicit access level. */
  async setClientAssignments(
    realmId: string,
    assignments: Array<{ userId: number; accessLevel: UserAccessLevel }>
  ): Promise<void> {
    const stored = [];
    for (const a of assignments) {
      const isClient = (await this.db.getUserById(a.userId))?.account_type === 'client';
      stored.push({ userId: a.userId, accessLevel: isClient ? ('read' as const) : a.accessLevel });
    }
    await this.db.setRealmAssignments(realmId, stored);
  }

  /**
   * Rotate a user's API key. The old key stops working immediately; the new
   * key is returned and stored encrypted for later self-service viewing.
   */
  async rotateKey(id: number): Promise<{ user: User; apiKey: string } | null> {
    if (!(await this.db.getUserById(id))) return null;
    const apiKey = generateApiKey();
    await this.db.updateUserKey(
      id,
      hashApiKey(apiKey),
      apiKey.slice(0, KEY_PREFIX_LENGTH),
      encrypt(apiKey, this.encryptionKey)
    );
    return { user: (await this.get(id))!, apiKey };
  }

  /**
   * The user's own plaintext API key, decrypted — or null for keys created
   * before retrievable storage (those backfill on their next key auth).
   */
  async getApiKey(id: number): Promise<string | null> {
    const record = await this.db.getUserById(id);
    if (record?.account_type === 'client') return null; // client logins have no usable key
    if (!record?.api_key_encrypted) return null;
    try {
      return decrypt(record.api_key_encrypted, this.encryptionKey);
    } catch {
      return null; // encryption key changed since storage — treat as legacy
    }
  }

  // ── Passwords & sessions (dashboard sign-in) ───────────────────────────────

  /** Set (or clear, with null) a user's dashboard password. */
  async setPassword(id: number, password: string | null): Promise<boolean> {
    if (!(await this.db.getUserById(id))) return false;
    if (password != null && password.length < MIN_PASSWORD_LENGTH) {
      throw new Error(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
    }
    await this.db.setUserPassword(id, password == null ? null : hashPassword(password));
    return true;
  }

  /** Check a password against a user's stored hash. */
  async checkPassword(id: number, password: string): Promise<boolean> {
    const record = await this.db.getUserById(id);
    if (!record?.password_hash) return false;
    return verifyPassword(password, record.password_hash);
  }

  /**
   * Verify a username/password pair. Returns the user for active accounts
   * with matching credentials; null otherwise (unknown, disabled, or wrong
   * password — indistinguishable to the caller by design).
   */
  async verifyLogin(username: string, password: string): Promise<User | null> {
    const record = await this.db.getUserByUsername(normalizeUsername(username));
    if (!record?.password_hash || record.status !== 'active') {
      verifyPassword(password, DUMMY_PASSWORD_HASH); // equalize timing
      return null;
    }
    if (!verifyPassword(password, record.password_hash)) return null;
    return toUser(record, await this.db.getUserAssignments(record.id));
  }

  /**
   * verifyLogin behind a brute-force lock, shared by every place a password
   * can be tried (the dashboard and the connector sign-in page), so guesses
   * against one don't get a fresh allowance on the other.
   *
   * After MAX_LOGIN_FAILURES consecutive failures the username is locked for
   * LOGIN_LOCKOUT_MS, doubling with each further failure up to
   * MAX_LOGIN_LOCKOUT_MS. A locked username is refused without checking the
   * password — even the right one — and a successful sign-in clears the count.
   */
  async login(username: string, password: string): Promise<LoginResult> {
    const key = normalizeUsername(username);
    const entry = this.loginFailures.get(key);
    const now = Date.now();
    if (entry && entry.lockedUntil > now) {
      return { status: 'locked', retryAfterMs: entry.lockedUntil - now };
    }

    const user = await this.verifyLogin(key, password);
    if (user) {
      this.loginFailures.delete(key);
      return { status: 'ok', user };
    }

    const fails = (entry?.fails ?? 0) + 1;
    const overBy = fails - MAX_LOGIN_FAILURES;
    const lockMs = overBy < 0 ? 0 : Math.min(LOGIN_LOCKOUT_MS * 2 ** overBy, MAX_LOGIN_LOCKOUT_MS);
    this.loginFailures.set(key, { fails, lockedUntil: lockMs ? now + lockMs : 0 });
    // Usernames are attacker-chosen, so the table is bounded: once it grows
    // large, entries that are neither locked nor recent are dropped.
    if (this.loginFailures.size > 10_000) {
      for (const [name, e] of this.loginFailures) {
        if (e.lockedUntil <= now) this.loginFailures.delete(name);
      }
    }
    // The attempt that trips the lock is still just "wrong password"; the
    // lock is what the NEXT attempt meets.
    return { status: 'invalid' };
  }

  /** Clear a username's failed sign-in count (an admin resetting the password). */
  clearLoginFailures(username: string | null | undefined): void {
    if (username) this.loginFailures.delete(normalizeUsername(username));
  }

  /** Issue a dashboard session for a user. The token is stored hashed. */
  async createSession(userId: number): Promise<{ token: string; expiresAt: Date }> {
    await this.db.purgeExpiredSessions();
    const token = `${SESSION_TOKEN_PREFIX}${randomBytes(32).toString('hex')}`;
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
    await this.db.insertSession(userId, hashApiKey(token), expiresAt.toISOString());
    return { token, expiresAt };
  }

  /**
   * Resolve a session token to its user. Returns null for unknown/expired
   * sessions and for disabled users.
   */
  async findBySessionToken(token: string): Promise<User | null> {
    if (typeof token !== 'string' || !token.startsWith(SESSION_TOKEN_PREFIX)) return null;
    const tokenHash = hashApiKey(token);
    const record = await this.db.getSessionUser(tokenHash);
    if (!record || record.status !== 'active') return null;
    await this.db.touchSession(tokenHash);
    return toUser(record, await this.db.getUserAssignments(record.id));
  }

  /** End one session (sign out). No-op for non-session tokens. */
  async deleteSession(token: string): Promise<void> {
    if (typeof token !== 'string' || !token.startsWith(SESSION_TOKEN_PREFIX)) return;
    await this.db.deleteSessionByTokenHash(hashApiKey(token));
  }

  /** End a user's sessions, optionally sparing the one making the change. */
  async deleteSessions(userId: number, exceptToken?: string): Promise<void> {
    const exceptHash =
      exceptToken && exceptToken.startsWith(SESSION_TOKEN_PREFIX) ? hashApiKey(exceptToken) : undefined;
    await this.db.deleteUserSessions(userId, exceptHash);
  }

  async remove(id: number): Promise<boolean> {
    if (!(await this.db.getUserById(id))) return false;
    await this.db.deleteUser(id);
    return true;
  }

  /**
   * Look up an active user by plaintext API key. Returns null for unknown
   * keys and for disabled users. Updates last_used_at on success, throttled
   * so steady traffic doesn't turn every read into a DB write.
   */
  async findByApiKey(apiKey: string): Promise<User | null> {
    if (!apiKey || typeof apiKey !== 'string') return null;
    const record = await this.db.getUserByKeyHash(hashApiKey(apiKey));
    if (!record || record.status !== 'active') return null;
    // Client logins sign in through the connector with a username and
    // password. Their row has a key only because the column requires one; it
    // is never accepted, so there is no long-lived secret to leak in a URL.
    if (record.account_type === 'client') return null;
    // Keys created before retrievable storage have no encrypted copy; the
    // key itself just authenticated (hash matched), so store one now — after
    // this, the member can view their key from the dashboard too.
    if (!record.api_key_encrypted) {
      await this.db.setUserKeyEncrypted(record.id, encrypt(apiKey, this.encryptionKey));
    }
    const lastUsed = record.last_used_at ? parseUtcDate(record.last_used_at).getTime() : 0;
    if (Date.now() - lastUsed > LAST_USED_THROTTLE_MS) {
      await this.db.touchUserLastUsed(record.id);
    }
    return toUser(record, await this.db.getUserAssignments(record.id));
  }

  /**
   * Note that a user just reached the server through the connector sign-in.
   * API keys do this inside findByApiKey; this is the same throttled write
   * for OAuth access tokens, so "last used" is true for people (and client
   * logins) who never touch a key.
   */
  async touchLastUsed(user: User): Promise<void> {
    if (Date.now() - (user.lastUsedAt?.getTime() ?? 0) > LAST_USED_THROTTLE_MS) {
      await this.db.touchUserLastUsed(user.id);
    }
  }

  /** Remove a disconnected company from every user's assignments. */
  async removeRealmAssignments(realmId: string): Promise<void> {
    await this.db.removeRealmAssignments(realmId);
  }
}
