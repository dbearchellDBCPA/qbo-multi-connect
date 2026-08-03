import { describe, it, expect } from 'vitest';
import { qboExpenseLinesToUpdateShape } from '../../src/server/line-converters.js';

// ─────────────────────────────────────────────────────────────────────────────
// Unit tests for update_expense — in-place edit of a Purchase.
//
// These mirror the pattern in mcp-department.test.ts: a payload builder that
// reproduces the exact sparse-merge + replace-all-lines logic the MCP tool runs,
// exercised against in-memory fixtures (no live MCP server / QBO calls).
// ─────────────────────────────────────────────────────────────────────────────

// ── Expense line builder (mirrors create_expense / update_expense) ───────────

function buildExpenseLine(l: any): any {
  const line: any = { Amount: l.amount, DetailType: l.detail_type ?? 'AccountBasedExpenseLineDetail', Description: l.description };
  if (line.DetailType === 'AccountBasedExpenseLineDetail') {
    line.AccountBasedExpenseLineDetail = {};
    if (l.expense_account_id) line.AccountBasedExpenseLineDetail.AccountRef = { value: l.expense_account_id, name: l.expense_account_name };
    if (l.class_id) line.AccountBasedExpenseLineDetail.ClassRef = { value: l.class_id };
  } else {
    line.ItemBasedExpenseLineDetail = { Qty: l.quantity ?? 1, UnitPrice: l.unit_price ?? l.amount };
    if (l.item_id) line.ItemBasedExpenseLineDetail.ItemRef = { value: l.item_id };
    if (l.class_id) line.ItemBasedExpenseLineDetail.ClassRef = { value: l.class_id };
  }
  return line;
}

// ── Update payload builder (mirrors update_expense sparse merge) ─────────────

function buildExpenseUpdatePayload(existing: any, args: {
  payment_type?: string;
  account_id?: string;
  account_name?: string;
  txn_date?: string;
  vendor_id?: string;
  vendor_name?: string;
  private_note?: string;
  department_id?: string;
  lines?: any[];
}): any {
  const payload: any = { ...existing };
  if (args.payment_type) payload.PaymentType = args.payment_type;
  if (args.account_id) payload.AccountRef = { value: args.account_id, name: args.account_name };
  if (args.txn_date) payload.TxnDate = args.txn_date;
  if (args.vendor_id) payload.EntityRef = { value: args.vendor_id, name: args.vendor_name, type: 'Vendor' };
  if (args.department_id) payload.DepartmentRef = { value: args.department_id };
  if (args.private_note !== undefined) payload.PrivateNote = args.private_note;
  if (args.lines) payload.Line = args.lines.map(buildExpenseLine);
  return payload;
}

const existingExpense = {
  Id: '789',
  SyncToken: '2',
  PaymentType: 'Check',
  AccountRef: { value: '35', name: 'Checking' },
  EntityRef: { value: 'v-1', name: 'Acme', type: 'Vendor' },
  TxnDate: '2026-05-01',
  PrivateNote: 'Original memo',
  Line: [
    {
      Amount: 100,
      DetailType: 'AccountBasedExpenseLineDetail',
      Description: 'Office supplies',
      AccountBasedExpenseLineDetail: { AccountRef: { value: '62', name: 'Supplies' } },
    },
  ],
};

describe('update_expense — sparse header merge', () => {
  it('preserves Id and SyncToken from the fetched record (in-place edit)', () => {
    const payload = buildExpenseUpdatePayload(existingExpense, { private_note: 'new' });
    expect(payload.Id).toBe('789');
    expect(payload.SyncToken).toBe('2');
  });

  it('changes only the pay-from account when account_id is provided', () => {
    const payload = buildExpenseUpdatePayload(existingExpense, { account_id: '40', account_name: 'AmEx' });
    expect(payload.AccountRef).toEqual({ value: '40', name: 'AmEx' });
    expect(payload.PaymentType).toBe('Check'); // untouched
    expect(payload.TxnDate).toBe('2026-05-01'); // untouched
  });

  it('updates payment_type, vendor, date, and memo independently', () => {
    const payload = buildExpenseUpdatePayload(existingExpense, {
      payment_type: 'CreditCard',
      vendor_id: 'v-2',
      vendor_name: 'Globex',
      txn_date: '2026-06-01',
      private_note: 'Reclassified',
    });
    expect(payload.PaymentType).toBe('CreditCard');
    expect(payload.EntityRef).toEqual({ value: 'v-2', name: 'Globex', type: 'Vendor' });
    expect(payload.TxnDate).toBe('2026-06-01');
    expect(payload.PrivateNote).toBe('Reclassified');
  });

  it('leaves header fields untouched when nothing is passed', () => {
    const payload = buildExpenseUpdatePayload(existingExpense, {});
    expect(payload.PaymentType).toBe('Check');
    expect(payload.AccountRef).toEqual({ value: '35', name: 'Checking' });
    expect(payload.EntityRef).toEqual({ value: 'v-1', name: 'Acme', type: 'Vendor' });
    expect(payload.PrivateNote).toBe('Original memo');
    expect(payload.Line).toBe(existingExpense.Line); // lines untouched
  });

  it('allows clearing the memo with an empty string (!== undefined semantics)', () => {
    const payload = buildExpenseUpdatePayload(existingExpense, { private_note: '' });
    expect(payload.PrivateNote).toBe('');
  });
});

describe('update_expense — replace-all lines', () => {
  it('replaces ALL existing lines when lines is provided', () => {
    const payload = buildExpenseUpdatePayload(existingExpense, {
      lines: [
        { amount: 250, expense_account_id: '63', expense_account_name: 'Rent', class_id: '5', description: 'May rent' },
      ],
    });
    expect(payload.Line).toHaveLength(1);
    expect(payload.Line[0].Amount).toBe(250);
    expect(payload.Line[0].AccountBasedExpenseLineDetail.AccountRef).toEqual({ value: '63', name: 'Rent' });
    expect(payload.Line[0].AccountBasedExpenseLineDetail.ClassRef).toEqual({ value: '5' });
  });

  it('builds an item-based line with Qty/UnitPrice/Class', () => {
    const payload = buildExpenseUpdatePayload(existingExpense, {
      lines: [{ amount: 90, detail_type: 'ItemBasedExpenseLineDetail', item_id: 'it-1', quantity: 3, unit_price: 30, class_id: '5' }],
    });
    const detail = payload.Line[0].ItemBasedExpenseLineDetail;
    expect(detail.Qty).toBe(3);
    expect(detail.UnitPrice).toBe(30);
    expect(detail.ItemRef).toEqual({ value: 'it-1' });
    expect(detail.ClassRef).toEqual({ value: '5' });
  });

  it('round-trips get_expense → update_expense without reshaping', () => {
    // get_expense produces this shape; feeding lines straight back must rebuild
    // an equivalent account-based line.
    const updateShape = qboExpenseLinesToUpdateShape(existingExpense.Line);
    expect(updateShape[0].expense_account_id).toBe('62');
    const payload = buildExpenseUpdatePayload(existingExpense, { lines: updateShape });
    expect(payload.Line[0].AccountBasedExpenseLineDetail.AccountRef.value).toBe('62');
    expect(payload.Line[0].Amount).toBe(100);
  });
});
