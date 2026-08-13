import { describe, it, expect } from 'vitest';
import {
  buildDepositTxnLines,
  buildDepositUpdatePayload,
  depositLineEntityError,
  qboDepositLinesToUpdateShape,
} from '../../src/server/line-converters.js';

// ─────────────────────────────────────────────────────────────────────────────
// update_deposit — Bug 4 (documented 2026-08-11, fixed 2026-08-13).
//
// QBO full updates replace the entire Line array with whatever is posted.
// The buggy behavior: the handler carried the fetched deposit's existing
// lines into the update payload alongside the caller's replacement lines,
// so every update APPENDED and inflated the deposit total (sandbox repro:
// a $150 two-line deposit updated with one $25 line became $175 / 3 lines).
// These tests pin the payload builder to true replace semantics.
// ─────────────────────────────────────────────────────────────────────────────

const existingDeposit = {
  Id: '511',
  SyncToken: '0',
  DepositToAccountRef: { value: '35', name: 'Checking' },
  TxnDate: '2026-08-13',
  PrivateNote: 'original memo',
  TotalAmt: 150,
  Line: [
    {
      Id: '1',
      LineNum: 1,
      Amount: 100,
      DetailType: 'DepositLineDetail',
      Description: 'repro line A',
      DepositLineDetail: { AccountRef: { value: '82', name: 'Design income' } },
    },
    {
      Id: '2',
      LineNum: 2,
      Amount: 50,
      DetailType: 'DepositLineDetail',
      Description: 'repro line B',
      DepositLineDetail: { AccountRef: { value: '1', name: 'Services' } },
    },
  ],
};

describe('update_deposit — lines REPLACE, never append', () => {
  it('replaces both existing lines with the single submitted line (the 2026-08-13 sandbox repro)', () => {
    const payload = buildDepositUpdatePayload(existingDeposit, {
      deposit_lines: [{ amount: 25, account_id: '83', description: 'replacement line C' }],
      linked_payment_ids: [],
    });
    expect(payload.Line).toHaveLength(1); // NOT 3
    expect(payload.Line[0].Amount).toBe(25);
    expect(payload.Line[0].DepositLineDetail.AccountRef.value).toBe('83');
    // No trace of the fetched lines may survive in the payload.
    const total = payload.Line.reduce((s: number, l: any) => s + l.Amount, 0);
    expect(total).toBe(25); // NOT 175
  });

  it('linked_payment_ids=[] alone still triggers the replace path (empty Line, loud QBO rejection beats silent append)', () => {
    const payload = buildDepositUpdatePayload(existingDeposit, { linked_payment_ids: [] });
    expect(payload.Line).toEqual([]);
  });

  it('replaces with the union of linked payments and direct lines, payments first', () => {
    const payload = buildDepositUpdatePayload(existingDeposit, {
      linked_payment_ids: [{ payment_id: 'pmt-9', amount: 400 }],
      deposit_lines: [{ amount: 25, account_id: '83' }],
    });
    expect(payload.Line).toHaveLength(2);
    expect(payload.Line[0].LinkedTxn).toEqual([{ TxnId: 'pmt-9', TxnType: 'Payment' }]);
    expect(payload.Line[1].DepositLineDetail.AccountRef.value).toBe('83');
  });

  it('preserves the existing Line array untouched when neither array is passed', () => {
    const payload = buildDepositUpdatePayload(existingDeposit, { private_note: 'metadata-only edit' });
    expect(payload.Line).toBe(existingDeposit.Line);
    expect(payload.PrivateNote).toBe('metadata-only edit');
  });
});

describe('update_deposit — header merge (read-modify-write)', () => {
  it('preserves Id and SyncToken from the fetched record', () => {
    const payload = buildDepositUpdatePayload(existingDeposit, { txn_date: '2026-08-01' });
    expect(payload.Id).toBe('511');
    expect(payload.SyncToken).toBe('0');
    expect(payload.TxnDate).toBe('2026-08-01');
    expect(payload.DepositToAccountRef).toEqual({ value: '35', name: 'Checking' });
  });

  it('moves the deposit to a new bank account when deposit_account_id is passed', () => {
    const payload = buildDepositUpdatePayload(existingDeposit, { deposit_account_id: '36' });
    expect(payload.DepositToAccountRef).toEqual({ value: '36' });
  });

  it('allows clearing the memo with an empty string', () => {
    const payload = buildDepositUpdatePayload(existingDeposit, { private_note: '' });
    expect(payload.PrivateNote).toBe('');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Deposit line building — QBO stores DepositLineDetail.Entity as a FLAT ref
// {value, type} with UPPERCASE type. The old nested {type, EntityRef} shape
// was silently dropped by QBO (customer attribution lost on write AND read).
// ─────────────────────────────────────────────────────────────────────────────

describe('buildDepositTxnLines — entity shapes', () => {
  it('writes the flat uppercase Entity shape for customer_id (back-compat alias)', () => {
    const [line] = buildDepositTxnLines([], [{ amount: 55.55, account_id: '82', customer_id: '1' }]);
    expect(line.DepositLineDetail.Entity).toEqual({ value: '1', type: 'CUSTOMER' });
    expect(line.DepositLineDetail.Entity).not.toHaveProperty('EntityRef');
  });

  it('writes a VENDOR entity for vendor-refund deposits', () => {
    const [line] = buildDepositTxnLines([], [
      { amount: 80.08, account_id: '20', entity_id: '41', entity_type: 'Vendor' },
    ]);
    expect(line.DepositLineDetail.Entity).toEqual({ value: '41', type: 'VENDOR' });
  });

  it('omits Entity entirely when no entity is given', () => {
    const [line] = buildDepositTxnLines([], [{ amount: 10, account_id: '82' }]);
    expect(line.DepositLineDetail).not.toHaveProperty('Entity');
  });

  it('flags entity_id without entity_type instead of guessing', () => {
    expect(depositLineEntityError([{ amount: 1, account_id: '82', entity_id: '41' }])).toMatch(/entity_type/);
    expect(depositLineEntityError([{ amount: 1, account_id: '82', entity_id: '41', entity_type: 'Vendor' }])).toBeNull();
    expect(depositLineEntityError([{ amount: 1, account_id: '82', customer_id: '1' }])).toBeNull();
  });
});

describe('get_deposit → update_deposit round-trip', () => {
  it('reads the flat Entity shape (as stored by QBO) including vendors', () => {
    const { linked_payment_ids, deposit_lines } = qboDepositLinesToUpdateShape([
      { Amount: 400, LinkedTxn: [{ TxnId: 'pmt-1', TxnType: 'Payment' }] },
      {
        Amount: 80.08,
        DetailType: 'DepositLineDetail',
        Description: 'vendor refund attribution',
        DepositLineDetail: {
          AccountRef: { value: '20', name: 'Supplies' },
          Entity: { value: '41', name: 'Hicks Hardware', type: 'VENDOR' },
        },
      },
    ]);
    expect(linked_payment_ids).toEqual([{ payment_id: 'pmt-1', amount: 400 }]);
    expect(deposit_lines[0]).toEqual({
      amount: 80.08,
      account_id: '20',
      description: 'vendor refund attribution',
      entity_id: '41',
      entity_type: 'Vendor',
    });
  });

  it('keeps customer_id as an alias when the entity is a customer', () => {
    const { deposit_lines } = qboDepositLinesToUpdateShape([
      {
        Amount: 55.55,
        DetailType: 'DepositLineDetail',
        DepositLineDetail: {
          AccountRef: { value: '82' },
          Entity: { value: '1', name: "Amy's Bird Sanctuary", type: 'CUSTOMER' },
        },
      },
    ]);
    expect(deposit_lines[0].customer_id).toBe('1');
    expect(deposit_lines[0].entity_id).toBe('1');
    expect(deposit_lines[0].entity_type).toBe('Customer');
  });

  it('round-trips fetched lines through the payload builder unchanged in count and amounts', () => {
    const shape = qboDepositLinesToUpdateShape(existingDeposit.Line);
    const payload = buildDepositUpdatePayload(existingDeposit, {
      linked_payment_ids: shape.linked_payment_ids,
      deposit_lines: shape.deposit_lines,
    });
    expect(payload.Line).toHaveLength(existingDeposit.Line.length);
    const total = payload.Line.reduce((s: number, l: any) => s + l.Amount, 0);
    expect(total).toBe(150);
  });
});
