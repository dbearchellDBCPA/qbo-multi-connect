import { describe, it, expect } from 'vitest';
import {
  buildDepositQboLines,
  buildDepositUpdatePayload,
  verifyDepositWrite,
  formatDepositVerificationFailure,
} from '../../src/server/deposit-update.js';
import { qboDepositLinesToUpdateShape } from '../../src/server/line-converters.js';

// ─────────────────────────────────────────────────────────────────────────────
// Regression tests for update_deposit's REPLACE-ALL contract.
//
// Background: the deployed handler APPENDED submitted deposit_lines to the
// fetched Line array instead of replacing it, silently inflating posted
// deposits ($6,000 → $24,000 over three calls) with no API path to remove
// the extra lines afterwards. These tests import the exact functions the MCP
// tool runs — not mirrored copies — so the replace semantics, the post-write
// verification, and the failure messaging cannot drift from what ships.
// ─────────────────────────────────────────────────────────────────────────────

// The reproduction case: H2 Company Deposit 68 — one direct line of $6,000.
const DEPOSIT_ONE_LINE = {
  Id: '68',
  SyncToken: '3',
  TxnDate: '2026-07-15',
  DepositToAccountRef: { value: '21', name: 'Checking' },
  PrivateNote: 'Original memo',
  TotalAmt: 6000,
  Line: [
    {
      Id: '1',
      Amount: 6000,
      DetailType: 'DepositLineDetail',
      DepositLineDetail: { AccountRef: { value: '62', name: 'Misc Income' } },
    },
  ],
};

const DEPOSIT_THREE_LINES = {
  Id: '90',
  SyncToken: '0',
  TxnDate: '2026-07-20',
  DepositToAccountRef: { value: '21' },
  TotalAmt: 600,
  Line: [
    { Id: '1', Amount: 100, DetailType: 'DepositLineDetail', DepositLineDetail: { AccountRef: { value: '61' } } },
    { Id: '2', Amount: 200, DetailType: 'DepositLineDetail', DepositLineDetail: { AccountRef: { value: '62' } } },
    { Id: '3', Amount: 300, DetailType: 'DepositLineDetail', DepositLineDetail: { AccountRef: { value: '63' } } },
  ],
};

const DEPOSIT_MIXED = {
  Id: '77',
  SyncToken: '1',
  TxnDate: '2026-07-01',
  DepositToAccountRef: { value: '21' },
  TotalAmt: 950,
  Line: [
    { Id: '1', Amount: 400, LinkedTxn: [{ TxnId: 'pmt-1', TxnType: 'Payment' }] },
    { Id: '2', Amount: 400, LinkedTxn: [{ TxnId: 'pmt-2', TxnType: 'Payment' }] },
    {
      Id: '3',
      Amount: 150,
      Description: 'Direct income',
      DetailType: 'DepositLineDetail',
      DepositLineDetail: { AccountRef: { value: '62' }, Entity: { type: 'Customer', EntityRef: { value: 'cust-1' } } },
    },
  ],
};

function lineSum(payload: any): number {
  return payload.Line.reduce((s: number, l: any) => s + l.Amount, 0);
}

// ── Test 1 (bug report): 1 line → 1 different line ───────────────────────────

describe('update_deposit — replace-all lines', () => {
  it('replaces a single line with a different line — never appends', () => {
    // The exact production repro payload: account 21, $6,000, Vendor entity 1.
    const { payload, linesReplaced } = buildDepositUpdatePayload(DEPOSIT_ONE_LINE, {
      deposit_lines: [{ account_id: '21', amount: 6000, entity_id: '1', entity_type: 'Vendor' }],
    });

    expect(linesReplaced).toBe(true);
    // Exactly 1 line — not 2 ($12,000), which is what the append bug produced.
    expect(payload.Line).toHaveLength(1);
    expect(payload.Line[0].DepositLineDetail.AccountRef.value).toBe('21');
    expect(payload.Line[0].Amount).toBe(6000);
    expect(payload.Line[0].DepositLineDetail.Entity).toEqual({ type: 'Vendor', EntityRef: { value: '1' } });
    expect(lineSum(payload)).toBe(6000);
    // The fetched line (account 62) must be gone entirely.
    expect(payload.Line.some((l: any) => l.DepositLineDetail?.AccountRef?.value === '62')).toBe(false);
    // Header/read-modify-write fields ride along untouched.
    expect(payload.Id).toBe('68');
    expect(payload.SyncToken).toBe('3');
    expect(payload.PrivateNote).toBe('Original memo');
  });

  // ── Test 2 (bug report): 3 lines → 1 line — append-only can never shrink ──
  it('shrinks a 3-line deposit to 1 line', () => {
    const { payload } = buildDepositUpdatePayload(DEPOSIT_THREE_LINES, {
      deposit_lines: [{ account_id: '65', amount: 50 }],
    });
    expect(payload.Line).toHaveLength(1);
    expect(payload.Line[0].DepositLineDetail.AccountRef.value).toBe('65');
    expect(lineSum(payload)).toBe(50);
  });

  // ── Test 3 (bug report): both arrays together replace everything ──────────
  it('replaces linked payments and direct lines together with no duplicates', () => {
    const { payload } = buildDepositUpdatePayload(DEPOSIT_MIXED, {
      linked_payment_ids: [
        { payment_id: 'pmt-1', amount: 400 },
        { payment_id: 'pmt-2', amount: 400 },
      ],
      deposit_lines: [{ account_id: '64', amount: 175, description: 'Corrected income line' }],
    });

    expect(payload.Line).toHaveLength(3);
    // Both payments still linked — they are NOT returned to Undeposited Funds.
    const linkedIds = payload.Line.filter((l: any) => l.LinkedTxn).map((l: any) => l.LinkedTxn[0].TxnId);
    expect(linkedIds).toEqual(['pmt-1', 'pmt-2']);
    // The direct line is the new one, and nothing from the old set survived.
    const direct = payload.Line.filter((l: any) => l.DetailType === 'DepositLineDetail');
    expect(direct).toHaveLength(1);
    expect(direct[0].DepositLineDetail.AccountRef.value).toBe('64');
    expect(lineSum(payload)).toBe(975);
  });

  it('passing only deposit_lines drops existing linked payments (documented contract)', () => {
    const { payload } = buildDepositUpdatePayload(DEPOSIT_MIXED, {
      deposit_lines: [{ account_id: '64', amount: 175 }],
    });
    expect(payload.Line).toHaveLength(1);
    expect(payload.Line.some((l: any) => l.LinkedTxn)).toBe(false);
  });

  // ── Test 4 (bug report): metadata-only update preserves lines ─────────────
  it('preserves lines untouched when neither line array is provided', () => {
    const { payload, linesReplaced } = buildDepositUpdatePayload(DEPOSIT_ONE_LINE, {
      private_note: 'Reclassified per client email',
      txn_date: '2026-07-16',
    });
    expect(linesReplaced).toBe(false);
    expect(payload.Line).toBe(DEPOSIT_ONE_LINE.Line); // same array, byte-for-byte
    expect(payload.PrivateNote).toBe('Reclassified per client email');
    expect(payload.TxnDate).toBe('2026-07-16');
    expect(payload.DepositToAccountRef).toEqual({ value: '21', name: 'Checking' });
  });

  // ── Test 5 (bug report): same-deposit idempotency ─────────────────────────
  it('applying the identical update twice is a no-op, not a doubling', () => {
    const args = { deposit_lines: [{ account_id: '21', amount: 6000, entity_id: '1', entity_type: 'Vendor' as const }] };

    const first = buildDepositUpdatePayload(DEPOSIT_ONE_LINE, args);
    // Simulate QBO's post-write state: the payload as written, fresh SyncToken.
    const afterFirstWrite = { ...first.payload, SyncToken: '4', TotalAmt: 6000 };

    const second = buildDepositUpdatePayload(afterFirstWrite, args);
    expect(second.payload.Line).toHaveLength(1);
    expect(lineSum(second.payload)).toBe(6000);
    expect(second.payload.Line).toEqual(first.payload.Line);
  });

  it('flags an explicit empty replacement so the handler can refuse it', () => {
    const { payload, linesReplaced } = buildDepositUpdatePayload(DEPOSIT_ONE_LINE, {
      linked_payment_ids: [],
      deposit_lines: [],
    });
    expect(linesReplaced).toBe(true);
    expect(payload.Line).toHaveLength(0); // handler refuses to write zero lines
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Post-write verification — the safety net that caught the production bug.
// ─────────────────────────────────────────────────────────────────────────────

describe('update_deposit — post-write verification', () => {
  const submitted = buildDepositUpdatePayload(DEPOSIT_ONE_LINE, {
    deposit_lines: [{ account_id: '21', amount: 6000, entity_id: '1', entity_type: 'Vendor' }],
  }).payload;

  it('passes when QBO wrote exactly what was submitted', () => {
    const written = { ...submitted, SyncToken: '4', TotalAmt: 6000 };
    const v = verifyDepositWrite(submitted, DEPOSIT_ONE_LINE, written);
    expect(v.ok).toBe(true);
    expect(v.looks_appended).toBe(false);
    expect(v.expected_line_count).toBe(1);
    expect(v.actual_line_count).toBe(1);
  });

  it('fails and fingerprints the append signature when lines were appended', () => {
    // Simulate the production bug: submitted line stacked on top of the old one.
    const written = {
      ...submitted,
      SyncToken: '4',
      TotalAmt: 12000,
      Line: [...DEPOSIT_ONE_LINE.Line, ...submitted.Line],
    };
    const v = verifyDepositWrite(submitted, DEPOSIT_ONE_LINE, written);
    expect(v.ok).toBe(false);
    expect(v.looks_appended).toBe(true);
    expect(v.expected_line_count).toBe(1);
    expect(v.actual_line_count).toBe(2);
    expect(v.expected_total).toBe(6000);
    expect(v.actual_total).toBe(12000);
  });

  it('fails without the append fingerprint on an unrelated mismatch', () => {
    const written = {
      ...submitted,
      Line: [{ ...submitted.Line[0], Amount: 5999 }], // right count, wrong amount
    };
    const v = verifyDepositWrite(submitted, DEPOSIT_ONE_LINE, written);
    expect(v.ok).toBe(false);
    expect(v.looks_appended).toBe(false);
  });

  it('verifies a metadata-only update left the lines unchanged', () => {
    const { payload } = buildDepositUpdatePayload(DEPOSIT_ONE_LINE, { private_note: 'memo' });
    const written = { ...payload, SyncToken: '4' };
    expect(verifyDepositWrite(payload, DEPOSIT_ONE_LINE, written).ok).toBe(true);
  });

  it('tolerates sub-cent floating point noise', () => {
    const written = { ...submitted, Line: [{ ...submitted.Line[0], Amount: 6000.004 }] };
    expect(verifyDepositWrite(submitted, DEPOSIT_ONE_LINE, written).ok).toBe(true);
  });
});

describe('update_deposit — verification failure message', () => {
  const appendVerification = {
    ok: false,
    expected_line_count: 1,
    actual_line_count: 2,
    expected_total: 6000,
    actual_total: 12000,
    looks_appended: true,
  };

  it('states expected vs actual, calls out the append, and forbids retrying', () => {
    const msg = formatDepositVerificationFailure(appendVerification, { status: 'restored' });
    expect(msg).toContain('VERIFICATION FAILED');
    expect(msg).toContain('Expected 1 line(s) totaling $6,000.00');
    expect(msg).toContain('QBO now shows 2 line(s) totaling $12,000.00');
    expect(msg).toContain('APPENDED to the existing lines, not replaced');
    expect(msg).toContain('DO NOT RETRY');
    expect(msg).toContain('Automatic rollback succeeded');
  });

  it('omits the append call-out for non-append mismatches but still forbids retrying', () => {
    const msg = formatDepositVerificationFailure(
      { ...appendVerification, looks_appended: false, actual_line_count: 1, actual_total: 5999 },
      { status: 'failed', error: 'stale SyncToken' }
    );
    expect(msg).not.toContain('APPENDED');
    expect(msg).toContain('DO NOT RETRY');
    expect(msg).toContain('Automatic rollback FAILED (stale SyncToken)');
  });

  it('reports a rollback that wrote but did not restore the original state', () => {
    const msg = formatDepositVerificationFailure(appendVerification, { status: 'mismatched' });
    expect(msg).toContain('still does not match its pre-update state');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Round-trip: get_deposit → update_deposit with no reshaping.
// ─────────────────────────────────────────────────────────────────────────────

describe('update_deposit — round-trip from get_deposit', () => {
  it('rebuilds an equivalent Line array from the get_deposit shape', () => {
    const shape = qboDepositLinesToUpdateShape(DEPOSIT_MIXED.Line);
    expect(shape.linked_payment_ids).toHaveLength(2);
    expect(shape.deposit_lines).toHaveLength(1);

    const { payload } = buildDepositUpdatePayload(DEPOSIT_MIXED, {
      linked_payment_ids: shape.linked_payment_ids,
      deposit_lines: shape.deposit_lines,
    });

    expect(payload.Line).toHaveLength(DEPOSIT_MIXED.Line.length);
    expect(lineSum(payload)).toBe(950);
    expect(payload.Line[0].LinkedTxn[0]).toEqual({ TxnId: 'pmt-1', TxnType: 'Payment' });
    expect(payload.Line[2].DepositLineDetail.AccountRef.value).toBe('62');
    expect(payload.Line[2].DepositLineDetail.Entity).toEqual({ type: 'Customer', EntityRef: { value: 'cust-1' } });
    // Identical update → verification would pass against a faithful write.
    const written = { ...payload, SyncToken: '2' };
    expect(verifyDepositWrite(payload, DEPOSIT_MIXED, written).ok).toBe(true);
  });

  it('preserves a Vendor line entity as Vendor across the round-trip', () => {
    const nativeVendorLine = {
      Amount: 6000,
      DetailType: 'DepositLineDetail',
      // Flat entity shape as QBO returns it.
      DepositLineDetail: { AccountRef: { value: '21' }, Entity: { value: '1', name: 'Robbo', type: 'VENDOR' } },
    };
    const shape = qboDepositLinesToUpdateShape([nativeVendorLine]);
    expect(shape.deposit_lines[0]).toEqual({ amount: 6000, account_id: '21', entity_id: '1', entity_type: 'Vendor' });

    const rebuilt = buildDepositQboLines([], shape.deposit_lines);
    expect(rebuilt[0].DepositLineDetail.Entity).toEqual({ type: 'Vendor', EntityRef: { value: '1' } });
  });
});
