import { describe, it, expect, vi } from 'vitest';
import {
  postedLineStats,
  statsMatch,
  stripLineIds,
  verifyLinesAndMaybeRollback,
} from '../../src/server/update-verification.js';

describe('postedLineStats', () => {
  it('counts and sums monetary lines', () => {
    expect(postedLineStats([
      { Amount: 100, DetailType: 'DepositLineDetail' },
      { Amount: 50.5, DetailType: 'DepositLineDetail' },
    ])).toEqual({ count: 2, total: 150.5 });
  });

  it('excludes QBO-injected SubTotal rows and non-monetary DescriptionOnly rows', () => {
    expect(postedLineStats([
      { Amount: 100, DetailType: 'SalesItemLineDetail' },
      { Amount: 100, DetailType: 'SubTotalLineDetail' },
      { DetailType: 'DescriptionOnly', Description: 'note' },
    ])).toEqual({ count: 1, total: 100 });
  });

  it('handles empty/missing arrays', () => {
    expect(postedLineStats(undefined)).toEqual({ count: 0, total: 0 });
    expect(postedLineStats([])).toEqual({ count: 0, total: 0 });
  });
});

describe('statsMatch', () => {
  it('tolerates sub-cent drift only', () => {
    expect(statsMatch({ count: 2, total: 100 }, { count: 2, total: 100.01 })).toBe(true);
    expect(statsMatch({ count: 2, total: 100 }, { count: 2, total: 100.02 })).toBe(false);
    expect(statsMatch({ count: 2, total: 100 }, { count: 3, total: 100 })).toBe(false);
  });
});

describe('stripLineIds', () => {
  it('removes Id and LineNum but keeps everything else', () => {
    const stripped = stripLineIds([
      { Id: '1', LineNum: 1, Amount: 100, DetailType: 'DepositLineDetail', DepositLineDetail: { AccountRef: { value: '182' } } },
    ]);
    expect(stripped[0]).toEqual({ Amount: 100, DetailType: 'DepositLineDetail', DepositLineDetail: { AccountRef: { value: '182' } } });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The P0 production incident (2026-08-24, Hatcher Investments deposit 50):
// submitted 1 line / $2,752.54, QBO stored 2 lines / $5,505.08. The handler
// must detect the drift and restore the original single line.
// ─────────────────────────────────────────────────────────────────────────────

const originalDeposit = {
  Id: '50',
  SyncToken: '2',
  DepositToAccountRef: { value: '18', name: 'Truist x2631' },
  TxnDate: '2026-07-07',
  Line: [
    {
      Id: '1',
      LineNum: 1,
      Amount: 2752.54,
      DetailType: 'DepositLineDetail',
      DepositLineDetail: { AccountRef: { value: '182', name: '1700-01 Eastside Fund III' }, Entity: { value: '6', type: 'VENDOR' } },
    },
  ],
};

const appendedResult = {
  Id: '50',
  SyncToken: '3',
  TotalAmt: 5505.08,
  Line: [
    { Id: '2', Amount: 2752.54, DetailType: 'DepositLineDetail', DepositLineDetail: { AccountRef: { value: '73' } } },
    { Id: '1', Amount: 2752.54, DetailType: 'DepositLineDetail', DepositLineDetail: { AccountRef: { value: '182' } } },
  ],
};

describe('verifyLinesAndMaybeRollback', () => {
  it('returns null when the stored lines match what was submitted', async () => {
    const rollback = vi.fn();
    const failure = await verifyLinesAndMaybeRollback({
      entityLabel: 'Deposit',
      original: originalDeposit,
      submitted: { count: 1, total: 2752.54 },
      updated: { Id: '50', SyncToken: '3', Line: [{ Amount: 2752.54, DetailType: 'DepositLineDetail' }] },
      rollback,
    });
    expect(failure).toBeNull();
    expect(rollback).not.toHaveBeenCalled();
  });

  it('detects the append, rolls back to the original lines, and says the change was NOT applied', async () => {
    const rollback = vi.fn().mockResolvedValue({
      Id: '50',
      SyncToken: '4',
      Line: [{ Amount: 2752.54, DetailType: 'DepositLineDetail', DepositLineDetail: { AccountRef: { value: '182' } } }],
    });
    const failure = await verifyLinesAndMaybeRollback({
      entityLabel: 'Deposit',
      original: originalDeposit,
      submitted: { count: 1, total: 2752.54 },
      updated: appendedResult,
      rollback,
    });
    expect(failure).toContain('VERIFICATION FAILED');
    expect(failure).toContain('2 line(s) totaling $5,505.08');
    expect(failure).toContain('ROLLED BACK');
    expect(failure).toContain('NOT applied');

    // The rollback payload must be the original deposit with the FAILED
    // update's SyncToken and lines stripped of Id/LineNum (clean replace).
    const payload = rollback.mock.calls[0][0];
    expect(payload.Id).toBe('50');
    expect(payload.SyncToken).toBe('3');
    expect(payload.Line).toHaveLength(1);
    expect(payload.Line[0].Id).toBeUndefined();
    expect(payload.Line[0].LineNum).toBeUndefined();
    expect(payload.Line[0].DepositLineDetail.AccountRef.value).toBe('182');
  });

  it('reports a rollback that did not restore the original state', async () => {
    const rollback = vi.fn().mockResolvedValue(appendedResult); // still wrong
    const failure = await verifyLinesAndMaybeRollback({
      entityLabel: 'Deposit',
      original: originalDeposit,
      submitted: { count: 1, total: 2752.54 },
      updated: appendedResult,
      rollback,
    });
    expect(failure).toContain('ROLLBACK ATTEMPTED');
    expect(failure).toContain('fix manually');
  });

  it('reports a rollback that threw, without raising', async () => {
    const rollback = vi.fn().mockRejectedValue(new Error('stale SyncToken'));
    const failure = await verifyLinesAndMaybeRollback({
      entityLabel: 'Invoice',
      original: originalDeposit,
      submitted: { count: 1, total: 2752.54 },
      updated: appendedResult,
      rollback,
    });
    expect(failure).toContain('ROLLBACK FAILED: stale SyncToken');
    expect(failure).toContain('fix manually');
  });
});
