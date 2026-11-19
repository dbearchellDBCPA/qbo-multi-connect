import { timingSafeEqual } from 'node:crypto';
import type { QBOManager } from '../index.js';
import type { Connection, User } from '../db/models.js';
import { effectiveAccessLevel, isAdminUser } from '../users.js';
import { ReadOnlyAccessError, runWithAccess } from '../access-context.js';

/**
 * Resolved identity for a request. The master QBO_API_KEY and admin-role
 * users get `allRealms: true`; member users get the explicit realm set
 * assigned to them in the dashboard.
 */
export interface AuthScope {
  kind: 'master' | 'user';
  userId: number | null;
  userName: string;
  role: 'admin' | 'member';
  /**
   * 'master' for the master key, otherwise the kind of login. A 'client'
   * scope is a client reading their own books: read-only, never admin.
   */
  accountType: 'master' | 'staff' | 'client';
  allRealms: boolean;
  realmIds: Set<string>;
  /**
   * Whether the key may change data in at least one company — which is what
   * decides whether the MCP write tools are listed at all. Which company a
   * given write may touch is a separate question: see canWriteRealm.
   */
  canWrite: boolean;
  /**
   * Write access to every company: the master key and admin-role users (an
   * admin could grant themselves write access anyway, so restricting them
   * would only be decorative).
   */
  allWrite: boolean;
  /** For members: the assigned companies they may change. */
  writeRealmIds: Set<string>;
}

export function isRealmAllowed(scope: AuthScope, realmId: string): boolean {
  return scope.allRealms || scope.realmIds.has(realmId);
}

/** Whether the scope may change data in this company (not just read it). */
export function canWriteRealm(scope: AuthScope, realmId: string): boolean {
  if (!isRealmAllowed(scope, realmId)) return false;
  return scope.allWrite || scope.writeRealmIds.has(realmId);
}

/** Build the scope for a signed-in user from their role and assignments. */
export function scopeForUser(user: User): AuthScope {
  const isAdmin = isAdminUser(user);
  const writeRealmIds = new Set(
    user.realmIds.filter((realmId) => effectiveAccessLevel(user, realmId) === 'read_write')
  );
  return {
    kind: 'user',
    userId: user.id,
    userName: user.name,
    role: isAdmin ? 'admin' : 'member',
    accountType: user.accountType,
    allRealms: isAdmin,
    realmIds: new Set(user.realmIds),
    canWrite: isAdmin || writeRealmIds.size > 0,
    allWrite: isAdmin,
    writeRealmIds,
  };
}

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * Extract the candidate API keys from an Authorization header and/or ?key=
 * query param (the query param exists because Claude.ai custom connectors
 * cannot send custom headers). Both are tried, query param first, so a
 * request carrying a stale query key alongside a valid header still works.
 * Fastify delivers duplicated params (?key=a&key=b) as arrays — only string
 * values are accepted, never arrays or other shapes.
 */
export function extractApiKeyCandidates(authHeader: unknown, queryKey?: unknown): string[] {
  const candidates: string[] = [];
  const query = Array.isArray(queryKey) ? queryKey[0] : queryKey;
  if (typeof query === 'string' && query) candidates.push(query);
  const header = Array.isArray(authHeader) ? authHeader[0] : authHeader;
  if (typeof header === 'string' && header) {
    candidates.push(header.startsWith('Bearer ') ? header.slice(7) : header);
  }
  return candidates;
}

/**
 * Resolve a presented API key to an AuthScope. Returns null when no
 * presented key matches the master key or an active user.
 */
export async function resolveAuth(
  qboManager: QBOManager,
  masterApiKey: string,
  authHeader: string | undefined,
  queryKey?: unknown
): Promise<AuthScope | null> {
  for (const presented of extractApiKeyCandidates(authHeader, queryKey)) {
    if (masterApiKey && safeEqual(presented, masterApiKey)) {
      return {
        kind: 'master',
        userId: null,
        userName: 'Master key',
        role: 'admin',
        accountType: 'master',
        allRealms: true,
        realmIds: new Set(),
        canWrite: true,
        allWrite: true,
        writeRealmIds: new Set(),
      };
    }

    // OAuth access token (per-user MCP connector sign-in) first — a shared
    // workspace connector authenticates each member individually this way.
    const oauthUserId = (await qboManager.oauth.verifyAccessToken(presented))?.userId;
    const oauthUser = oauthUserId != null ? await qboManager.users.get(oauthUserId) : null;
    if (oauthUser && oauthUser.status === 'active') {
      await qboManager.users.touchLastUsed(oauthUser);
      return scopeForUser(oauthUser);
    }

    // API key, then dashboard session token (issued by username/password
    // login) — both resolve to the same scope shape.
    const user = (await qboManager.users.findByApiKey(presented)) ?? (await qboManager.users.findBySessionToken(presented));
    if (user) {
      return scopeForUser(user);
    }
  }
  return null;
}

// ── Scoped manager facade ─────────────────────────────────────────────────────

/** The slice of QBOManager the MCP tools use, with scoping applied. */
export type ScopedQBOManager = Pick<
  QBOManager,
  | 'reports'
  | 'journalEntries'
  | 'transactions'
  | 'accounts'
  | 'company'
  | 'banking'
  | 'recurring'
  | 'cdc'
  | 'documents'
  | 'timeActivity'
  | 'lists'
  | 'attachments'
  | 'batch'
  | 'uploadTokens'
> & {
  listConnections(): Promise<Connection[]>;
  getConnection(realmId: string): Promise<Connection | null>;
};

class RealmAccessError extends Error {
  constructor() {
    super('Access denied: this company is not assigned to your API key. Use list_clients to see the companies you can access.');
    this.name = 'RealmAccessError';
  }
}

/**
 * Wrap an API namespace so every call verifies its realmId argument against
 * the scope before hitting QuickBooks. Every method on the API namespaces
 * takes realmId as its first parameter, which makes this a reliable
 * defense-in-depth check behind the name-resolution filtering.
 *
 * The call then runs inside an access context carrying whether the scope may
 * WRITE to that company, which QBOClient.request enforces on every request:
 * a read-only caller cannot get a mutating request out, whichever tool asked.
 * `writeOnly` is for namespaces whose every method grants write capability
 * without touching QuickBooks itself (upload tokens).
 */
function guardNamespace<T extends object>(namespace: T, scope: AuthScope, options: { writeOnly?: boolean } = {}): T {
  return new Proxy(namespace, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        const realmId = args[0];
        if (typeof realmId !== 'string' || !isRealmAllowed(scope, realmId)) {
          throw new RealmAccessError();
        }
        const canWrite = canWriteRealm(scope, realmId);
        if (options.writeOnly && !canWrite) {
          throw new ReadOnlyAccessError();
        }
        return runWithAccess({ realmId, canWrite, who: scope.userName }, () =>
          (value as (...a: unknown[]) => unknown).apply(target, args)
        );
      };
    },
  });
}

/**
 * A view of QBOManager restricted to the companies the scope allows.
 * Client-name resolution goes through listConnections(), so filtering it
 * makes unassigned companies invisible; the namespace guards additionally
 * reject any direct realmId access that slips past name resolution.
 */
export function createScopedManager(qboManager: QBOManager, scope: AuthScope): ScopedQBOManager {
  return {
    listConnections: async () =>
      (await qboManager.listConnections()).filter((c) => isRealmAllowed(scope, c.realmId)),
    getConnection: async (realmId: string) =>
      isRealmAllowed(scope, realmId) ? qboManager.getConnection(realmId) : null,
    reports: guardNamespace(qboManager.reports, scope),
    journalEntries: guardNamespace(qboManager.journalEntries, scope),
    transactions: guardNamespace(qboManager.transactions, scope),
    accounts: guardNamespace(qboManager.accounts, scope),
    company: guardNamespace(qboManager.company, scope),
    banking: guardNamespace(qboManager.banking, scope),
    recurring: guardNamespace(qboManager.recurring, scope),
    cdc: guardNamespace(qboManager.cdc, scope),
    documents: guardNamespace(qboManager.documents, scope),
    timeActivity: guardNamespace(qboManager.timeActivity, scope),
    lists: guardNamespace(qboManager.lists, scope),
    attachments: guardNamespace(qboManager.attachments, scope),
    batch: guardNamespace(qboManager.batch, scope),
    uploadTokens: guardNamespace(qboManager.uploadTokens, scope, { writeOnly: true }),
  };
}
