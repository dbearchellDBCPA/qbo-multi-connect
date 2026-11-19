import type { ConnectionDatabase } from './db/index.js';
import type { ActivityEntry, NewActivityEntry, UserAccountType } from './db/models.js';

/** How long activity is kept. Long enough to answer "who touched this last quarter?". */
export const ACTIVITY_RETENTION_DAYS = 180;

/** Old entries are swept at most this often — recording must stay cheap. */
const PURGE_INTERVAL_MS = 60 * 60 * 1000;

export const MAX_ACTIVITY_PAGE = 200;

/**
 * Hard ceiling on rows, whatever their age, so nothing that writes to the log
 * can fill the disk the connections database also lives on. Far above what
 * 180 days of normal use produces.
 */
export const MAX_ACTIVITY_ROWS = 250_000;

/** Free text that reaches the log (names, tool names) is cut to this length. */
const MAX_LOGGED_TEXT = 80;

function clip(value: string | null | undefined): string | null {
  if (value == null) return null;
  return value.length > MAX_LOGGED_TEXT ? `${value.slice(0, MAX_LOGGED_TEXT)}…` : value;
}

/**
 * The record of who did what through this server: every MCP tool call and
 * every sign-in, with the company it concerned and how it ended.
 *
 * It answers the questions an admin has once people outside the firm hold
 * logins — is this client actually using their access, what did they look
 * at, did anyone try something they aren't allowed to — without storing any
 * of the financial data the calls carried.
 */
export class ActivityLog {
  private lastPurge = 0;

  constructor(private db: ConnectionDatabase) {}

  /**
   * Record one event. Never throws: a logging problem must not fail the tool
   * call or sign-in being logged.
   */
  async record(entry: NewActivityEntry): Promise<void> {
    try {
      await this.db.insertActivity({
        ...entry,
        userName: clip(entry.userName) ?? '',
        tool: clip(entry.tool),
        clientName: clip(entry.clientName),
      });
      if (Date.now() - this.lastPurge > PURGE_INTERVAL_MS) {
        this.lastPurge = Date.now();
        await this.db.purgeActivityOlderThan(ACTIVITY_RETENTION_DAYS);
        await this.db.trimActivityTo(MAX_ACTIVITY_ROWS);
      }
    } catch (error) {
      console.error('[activity] failed to record event:', error instanceof Error ? error.message : error);
    }
  }

  /**
   * Record a refused password sign-in. Only attempts against a real login are
   * written — a made-up username is nobody's activity, and logging whatever
   * strangers type would let them fill the log — and a lockout is written
   * once per lock, not once per refused attempt.
   */
  async recordSignInFailure(
    result:
      | { status: 'invalid'; account: { id: number; name: string; accountType: UserAccountType } | null }
      | { status: 'locked'; account: { id: number; name: string; accountType: UserAccountType } | null; firstNotice: boolean },
    where: 'connector' | 'dashboard'
  ): Promise<void> {
    if (!result.account) return;
    if (result.status === 'locked' && !result.firstNotice) return;
    await this.record({
      userId: result.account.id,
      userName: result.account.name,
      accountType: result.account.accountType,
      event: result.status === 'locked' ? 'locked_out' : 'sign_in_failed',
      tool: where,
      outcome: 'denied',
    });
  }

  /** Newest first. */
  async list(
    filter: {
      userId?: number;
      realmId?: string;
      accountType?: 'master' | UserAccountType;
      beforeId?: number;
      limit?: number;
    } = {}
  ): Promise<ActivityEntry[]> {
    const limit = Math.min(Math.max(Math.floor(filter.limit ?? 50), 1), MAX_ACTIVITY_PAGE);
    return this.db.listActivity({ ...filter, limit });
  }
}
