/**
 * Post-write verification + rollback for line-replacing updates.
 *
 * QBO full-update semantics: the Line array posted becomes the entity's line
 * set (lines with an Id are updated in place, lines without an Id are added,
 * lines omitted are removed). A handler that accidentally carries the fetched
 * lines into the outgoing body therefore APPENDS instead of replacing — the
 * P0 update_deposit bug (8/11, re-confirmed in production 8/24: a 1-line
 * $2,752.54 deposit became 2 lines / $5,505.08).
 *
 * Every line-replacing update handler runs its result through
 * verifyLinesAndMaybeRollback: if what QBO stored doesn't match what was
 * submitted, the ORIGINAL lines are re-posted (rebuilt without Id/LineNum so
 * the array cleanly becomes the set again) and the outcome is reported
 * loudly either way.
 */

import { formatCurrency } from './report-shaping.js';

export interface LineStats {
  count: number;
  total: number;
}

/**
 * Count + sum the monetary lines of a QBO Line array. QBO-injected
 * SubTotal rows and non-monetary DescriptionOnly rows are excluded so the
 * stats compare like-for-like between what a caller submitted and what QBO
 * returned (sales forms come back with an extra SubTotalLineDetail row).
 */
export function postedLineStats(lines: any[] | undefined | null): LineStats {
  const monetary = (lines ?? []).filter(
    (l: any) => l?.DetailType !== 'SubTotalLineDetail' && l?.DetailType !== 'DescriptionOnly'
  );
  const total = monetary.reduce((sum: number, l: any) => sum + (parseFloat(l?.Amount ?? '0') || 0), 0);
  return { count: monetary.length, total: Math.round(total * 100) / 100 };
}

export function statsMatch(a: LineStats, b: LineStats): boolean {
  // Compare in integer cents — a raw float epsilon of 0.01 rejects exactly
  // one-cent differences (0.01 stored as 0.010000000000005…).
  const cents = (n: number) => Math.round(n * 100);
  return a.count === b.count && Math.abs(cents(a.total) - cents(b.total)) <= 1;
}

/**
 * Strip Id/LineNum from lines so a re-post cleanly REPLACES the stored line
 * set instead of updating-in-place/appending against whatever ids exist.
 */
export function stripLineIds(lines: any[] | undefined | null): any[] {
  return (lines ?? []).map((l: any) => {
    const { Id: _id, LineNum: _lineNum, ...rest } = l ?? {};
    return rest;
  });
}

export interface VerifyRollbackOptions {
  /** Human label, e.g. 'Deposit', 'Invoice' — used in the report text. */
  entityLabel: string;
  /** The entity as fetched BEFORE the update (rollback target). */
  original: any;
  /** Stats of the Line array that was actually sent in the update. */
  submitted: LineStats;
  /** The entity QBO returned from the update call. */
  updated: any;
  /**
   * Posts a rollback payload and returns the updated entity (or null).
   * Callers wrap their normal update API method.
   */
  rollback: (payload: any) => Promise<any | null>;
}

/**
 * Verify a line-replacing update against what was submitted. Returns null
 * when the write verified clean; otherwise attempts to restore the original
 * lines and returns the full failure/rollback report to surface to the
 * caller. Never throws — a rollback failure is reported, not raised.
 */
export async function verifyLinesAndMaybeRollback(opts: VerifyRollbackOptions): Promise<string | null> {
  const actual = postedLineStats(opts.updated?.Line);
  if (statsMatch(opts.submitted, actual)) return null;

  const lower = opts.entityLabel.toLowerCase();
  const base =
    `VERIFICATION FAILED — the write went through but the ${lower} does not match what was submitted. ` +
    `Expected ${opts.submitted.count} line(s) totaling ${formatCurrency(opts.submitted.total)}; ` +
    `QBO now shows ${actual.count} line(s) totaling ${formatCurrency(actual.total)}.`;

  const originalStats = postedLineStats(opts.original?.Line);
  try {
    const rollbackPayload = {
      ...opts.original,
      SyncToken: opts.updated?.SyncToken ?? opts.original?.SyncToken,
      Line: stripLineIds(opts.original?.Line),
    };
    const rolled = await opts.rollback(rollbackPayload);
    const rolledStats = postedLineStats(rolled?.Line);
    if (rolled && statsMatch(originalStats, rolledStats)) {
      return (
        `${base}\nROLLED BACK: restored the original ${originalStats.count} line(s) totaling ` +
        `${formatCurrency(originalStats.total)} (SyncToken now ${rolled.SyncToken}). ` +
        `The requested change was NOT applied — investigate before retrying.`
      );
    }
    return (
      `${base}\nROLLBACK ATTEMPTED but the ${lower} now shows ${rolledStats.count} line(s) totaling ` +
      `${formatCurrency(rolledStats.total)} instead of the original ${originalStats.count} totaling ` +
      `${formatCurrency(originalStats.total)} — fix manually in QBO.`
    );
  } catch (err: any) {
    return `${base}\nROLLBACK FAILED: ${err?.message ?? err} — the ${lower} is in the mismatched state above; fix manually in QBO.`;
  }
}
