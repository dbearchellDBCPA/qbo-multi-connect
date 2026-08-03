import { randomBytes, createHash, scryptSync, timingSafeEqual } from 'node:crypto';
import { encrypt, decrypt } from './crypto/encrypt.js';
import type { ConnectionDatabase } from './db/index.js';
import type { NewUser, User, UserRecord, UserUpdate } from './db/models.js';

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

function toUser(record: UserRecord, realmIds: string[]): User {
  return {
    id: record.id,
    name: record.name,
    email: record.email,
    role: record.role,
    accessLevel: record.access_level,
    username: record.username,
    hasPassword: record.password_hash != null,
    keyPrefix: record.key_prefix,
    status: record.status,
    createdAt: parseUtcDate(record.created_at),
    updatedAt: parseUtcDate(record.updated_at),
    lastUsedAt: record.last_used_at ? parseUtcDate(record.last_used_at) : null,
    realmIds,
  };
}

/**
 * Team member management: each user gets their own API key (stored hashed)
 * and a list of assigned QBO companies. Admin-role users see every company;
 * member-role users see only their assignments.
 */
export class UserService {
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

    const apiKey = generateApiKey();
    const id = await this.db.insertUser({
      name,
      email: input.email?.trim() || null,
      role: input.role ?? 'member',
      accessLevel: input.accessLevel ?? 'read_write',
      username: input.username ? await this.prepareUsername(input.username) : null,
      passwordHash: input.password ? hashPassword(input.password) : null,
      apiKeyHash: hashApiKey(apiKey),
      apiKeyEncrypted: encrypt(apiKey, this.encryptionKey),
      keyPrefix: apiKey.slice(0, KEY_PREFIX_LENGTH),
    });
    if (input.realmIds?.length) {
      await this.db.setUserRealms(id, input.realmIds);
    }
    return { user: (await this.get(id))!, apiKey };
  }

  async get(id: number): Promise<User | null> {
    const record = await this.db.getUserById(id);
    if (!record) return null;
    return toUser(record, await this.db.getUserRealms(id));
  }

  async list(): Promise<User[]> {
    const records = await this.db.getAllUsers();
    return Promise.all(records.map(async (r) => toUser(r, await this.db.getUserRealms(r.id))));
  }

  async update(id: number, fields: UserUpdate): Promise<User | null> {
    if (!(await this.db.getUserById(id))) return null;
    if (fields.name !== undefined && !fields.name.trim()) {
      throw new Error('User name cannot be empty');
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

  /** Replace the user's assigned companies with the given realm IDs. */
  async setClients(id: number, realmIds: string[]): Promise<User | null> {
    if (!(await this.db.getUserById(id))) return null;
    await this.db.setUserRealms(id, realmIds);
    return this.get(id);
  }

  /**
   * Replace the full set of users assigned to a company (edit access from
   * the client side). Members not in the list lose access to that realm.
   */
  async setClientUsers(realmId: string, userIds: number[]): Promise<void> {
    await this.db.setRealmUsers(realmId, userIds);
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
    return toUser(record, await this.db.getUserRealms(record.id));
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
    return toUser(record, await this.db.getUserRealms(record.id));
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
    return toUser(record, await this.db.getUserRealms(record.id));
  }

  /** Remove a disconnected company from every user's assignments. */
  async removeRealmAssignments(realmId: string): Promise<void> {
    await this.db.removeRealmAssignments(realmId);
  }
}
