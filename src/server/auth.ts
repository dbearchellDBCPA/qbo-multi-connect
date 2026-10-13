import { timingSafeEqual } from 'node:crypto';
import type { QBOManager } from '../index.js';
import type { Connection } from '../db/models.js';
import { DEFAULT_FIRM_ID } from '../firms.js';

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
   * The firm this request acts within: the user's firm, or for the master
   * key the default firm unless an X-QBO-Firm header names another.
   */
  firmId: number;
  /**
   * True only for the master key with no firm selected: the platform
   * operator sees every firm's companies and users.
   */
  allFirms: boolean;
  /** Admins reach every company of their firm; members only their assignments. */
  allRealms: boolean;
  /** The firm's connected realms — the outer boundary — or null when unrestricted (operator). */
  firmRealmIds: Set<string> | null;
  realmIds: Set<string>;
  /**
   * Whether the key may reach QuickBooks write tools. Read-only members get
   * false; the master key and admin-role users are always true (an admin
   * could grant themselves write access anyway, so restricting them would
   * only be decorative).
   */
  canWrite: boolean;
}

export function isRealmAllowed(scope: AuthScope, realmId: string): boolean {
  if (scope.allRealms) return scope.firmRealmIds ? scope.firmRealmIds.has(realmId) : true;
  return scope.realmIds.has(realmId);
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
  queryKey?: unknown,
  options: {
    /** Master key only: act within this firm (X-QBO-Firm). Omit to see every firm. */
    masterFirmId?: number | null;
  } = {}
): Promise<AuthScope | null> {
  const userScope = async (user: {
    id: number;
    name: string;
    role: 'admin' | 'member';
    accessLevel: 'read' | 'read_write';
    firmId: number;
    realmIds: string[];
  }): Promise<AuthScope> => {
    const firmRealmIds = new Set(await qboManager.listConnections(user.firmId).then((cs) => cs.map((c) => c.realmId)));
    return {
      kind: 'user',
      userId: user.id,
      userName: user.name,
      role: user.role,
      firmId: user.firmId,
      allFirms: false,
      allRealms: user.role === 'admin',
      firmRealmIds,
      // Assignments are made within the firm; the intersection guards a stale row.
      realmIds: new Set(user.realmIds.filter((r) => firmRealmIds.has(r))),
      canWrite: user.role === 'admin' || user.accessLevel !== 'read',
    };
  };

  for (const presented of extractApiKeyCandidates(authHeader, queryKey)) {
    if (masterApiKey && safeEqual(presented, masterApiKey)) {
      const selected = options.masterFirmId ?? null;
      const firmRealmIds =
        selected == null
          ? null
          : new Set((await qboManager.listConnections(selected)).map((c) => c.realmId));
      return {
        kind: 'master',
        userId: null,
        userName: 'Master key',
        role: 'admin',
        firmId: selected ?? DEFAULT_FIRM_ID,
        allFirms: selected == null,
        allRealms: true,
        firmRealmIds,
        realmIds: new Set(),
        canWrite: true,
      };
    }

    // OAuth access token (per-user MCP connector sign-in) first — a shared
    // workspace connector authenticates each member individually this way.
    const oauthUserId = (await qboManager.oauth.verifyAccessToken(presented))?.userId;
    const oauthUser = oauthUserId != null ? await qboManager.users.get(oauthUserId) : null;
    if (oauthUser && oauthUser.status === 'active') return userScope(oauthUser);

    // API key, then dashboard session token (issued by username/password
    // login) — both resolve to the same scope shape.
    const user = (await qboManager.users.findByApiKey(presented)) ?? (await qboManager.users.findBySessionToken(presented));
    if (user) return userScope(user);
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
 */
function guardNamespace<T extends object>(namespace: T, scope: AuthScope): T {
  return new Proxy(namespace, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        const realmId = args[0];
        if (typeof realmId !== 'string' || !isRealmAllowed(scope, realmId)) {
          throw new RealmAccessError();
        }
        return (value as (...a: unknown[]) => unknown).apply(target, args);
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
    lists: guardNamespace(qboManager.lists, scope),
    attachments: guardNamespace(qboManager.attachments, scope),
    batch: guardNamespace(qboManager.batch, scope),
    uploadTokens: guardNamespace(qboManager.uploadTokens, scope),
  };
}
