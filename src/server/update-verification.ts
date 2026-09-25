/**
 * Post-write verification + rollback for line-replacing updates.
 *
 * Deposit line semantics (confirmed production 2026-09-25, HIL Deposit 48 /
 * HK Deposit 64): lines WITH an Id update in place; lines WITHOUT an Id are
 * ADDED; omitted lines are NOT removed unless the update is a full
 * (sparse:false) rewrite that posts the intended line set WITH Ids. The Aug
 * "strip Ids = replace" assumption is exactly wrong for Deposit — stripping
 * Ids on write (and again on rollback) caused 1 line → 2 → 3 → 7.
 *
 * Every line-replacing update handler runs its result through
 * verifyLinesAndMaybeRollback: if what QBO stored doesn't match what was
 * submitted, the ORIGINAL lines are re-posted WITH their Ids (and
 * sparse:false) so QBO updates those lines in place instead of appending.
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
 * Strip Id/LineNum from lines. Kept for callers/tests that need a clean
 * line shape, but MUST NOT be used on Deposit rollback — Deposit treats
 * no-Id lines as ADDS (see module docstring).
 */
export function stripLineIds(lines: any[] | undefined | null): any[] {
  return (lines ?? []).map((l: any) => {
    const { Id: _id, LineNum: _lineNum, ...rest } = l ?? {};
    return rest;
  });
}

/** True when actual looks like submitted lines were appended k times. */
export function looksLikeAppendedLines(submitted: LineStats, actual: LineStats): boolean {
  if (submitted.count <= 0 || submitted.total <= 0) return false;
  if (actual.count <= submitted.count) return false;
  const multiple = actual.total / submitted.total;
  const nearest = Math.round(multiple);
  if (nearest < 2) return false;
  // actual.total ≈ k * submitted.total (within 2%)
  return Math.abs(multiple - nearest) <= 0.02;
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
 * lines (WITH their Ids, sparse:false) and returns the full failure/rollback
 * report to surface to the caller. Never throws — a rollback failure is
 * reported, not raised.
 */
export async function verifyLinesAndMaybeRollback(opts: VerifyRollbackOptions): Promise<string | null> {
  const actual = postedLineStats(opts.updated?.Line);
  if (statsMatch(opts.submitted, actual)) return null;

  const lower = opts.entityLabel.toLowerCase();
  const appendHint = looksLikeAppendedLines(opts.submitted, actual)
    ? (
      ` This fingerprint looks like the submitted lines were APPENDED onto the existing set ` +
      `(actual.count ${actual.count} > submitted.count ${opts.submitted.count}, ` +
      `actual.total ≈ k × submitted.total). DO NOT RETRY — retrying appends again and inflates the ${lower} further.`
    )
    : '';
  const base =
    `VERIFICATION FAILED — the write went through but the ${lower} does not match what was submitted. ` +
    `Expected ${opts.submitted.count} line(s) totaling ${formatCurrency(opts.submitted.total)}; ` +
    `QBO now shows ${actual.count} line(s) totaling ${formatCurrency(actual.total)}.${appendHint}`;

  const originalStats = postedLineStats(opts.original?.Line);
  try {
    // Deposit: re-post original lines WITH their Ids so QBO updates in place.
    // stripLineIds here would APPEND another copy (the P0 rollback bug).
    const rollbackPayload = {
      ...opts.original,
      SyncToken: opts.updated?.SyncToken ?? opts.original?.SyncToken,
      Line: [...(opts.original?.Line ?? [])],
      sparse: false,
    };
    const rolled = await opts.rollback(rollbackPayload);
    const rolledStats = postedLineStats(rolled?.Line);
    if (rolled && statsMatch(originalStats, rolledStats)) {
      return (
        `${base}` + '\n' +
        `ROLLED BACK: restored the original ${originalStats.count} line(s) totaling ` +
        `${formatCurrency(originalStats.total)} (SyncToken now ${rolled.SyncToken}). ` +
        `The requested change was NOT applied — investigate before retrying. DO NOT RETRY until the append cause is fixed.`
      );
    }
    return (
      `${base}` + '\n' +
      `ROLLBACK ATTEMPTED but the ${lower} now shows ${rolledStats.count} line(s) totaling ` +
      `${formatCurrency(rolledStats.total)} instead of the original ${originalStats.count} totaling ` +
      `${formatCurrency(originalStats.total)} — fix manually in QBO. DO NOT RETRY.`
    );
  } catch (err: any) {
    return (
      `${base}` + '\n' +
      `ROLLBACK FAILED: ${err?.message ?? err} — the ${lower} is in the mismatched state above; fix manually in QBO. DO NOT RETRY.`
    );
  }
}
