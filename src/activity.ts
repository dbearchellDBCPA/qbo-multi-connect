import type { ConnectionDatabase } from './db/index.js';
import type { ActivityEntry, NewActivityEntry, UserAccountType } from './db/models.js';

/** How long activity is kept. Long enough to answer "who touched this last quarter?". */
export const ACTIVITY_RETENTION_DAYS = 180;

/** Old entries are swept at most this often — recording must stay cheap. */
const PURGE_INTERVAL_MS = 60 * 60 * 1000;

export const MAX_ACTIVITY_PAGE = 200;

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
      await this.db.insertActivity(entry);
      if (Date.now() - this.lastPurge > PURGE_INTERVAL_MS) {
        this.lastPurge = Date.now();
        await this.db.purgeActivityOlderThan(ACTIVITY_RETENTION_DAYS);
      }
    } catch (error) {
      console.error('[activity] failed to record event:', error instanceof Error ? error.message : error);
    }
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
