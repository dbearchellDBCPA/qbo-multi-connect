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

// ─────────────────────────────────────────────────────────────────────────────
// Per-kind semantics (2026-08-24): each array independently — provided
// replaces that kind, OMITTED preserves that kind (rebuilt without Ids),
// linked_payment_ids: [] explicitly returns payments to Undeposited Funds.
// ─────────────────────────────────────────────────────────────────────────────

const mixedDeposit = {
  Id: '60',
  SyncToken: '1',
  DepositToAccountRef: { value: '35' },
  TxnDate: '2026-07-07',
  TotalAmt: 480.08,
  Line: [
    { Id: '1', LineNum: 1, Amount: 400, LinkedTxn: [{ TxnId: 'pmt-1', TxnType: 'Payment' }] },
    {
      Id: '2',
      LineNum: 2,
      Amount: 80.08,
      DetailType: 'DepositLineDetail',
      Description: 'vendor refund',
      DepositLineDetail: { AccountRef: { value: '182' }, Entity: { value: '6', type: 'VENDOR' } },
    },
  ],
};

describe('update_deposit — per-kind preserve/replace semantics', () => {
  it('deposit_lines passed + linked_payment_ids OMITTED preserves the linked payment (never silently unlinks it)', () => {
    const payload = buildDepositUpdatePayload(mixedDeposit, {
      deposit_lines: [{ amount: 80.08, account_id: '73', entity_id: '6', entity_type: 'Vendor' }],
    });
    expect(payload.Line).toHaveLength(2);
    expect(payload.Line[0].LinkedTxn).toEqual([{ TxnId: 'pmt-1', TxnType: 'Payment' }]);
    expect(payload.Line[0].Amount).toBe(400);
    expect(payload.Line[1].DepositLineDetail.AccountRef.value).toBe('73'); // re-coded
    expect(payload.Line[1].DepositLineDetail.Entity).toEqual({ value: '6', type: 'VENDOR' });
  });

  it('linked_payment_ids passed + deposit_lines OMITTED preserves the direct line', () => {
    const payload = buildDepositUpdatePayload(mixedDeposit, {
      linked_payment_ids: [{ payment_id: 'pmt-1', amount: 400 }],
    });
    expect(payload.Line).toHaveLength(2);
    expect(payload.Line[1].DepositLineDetail.AccountRef.value).toBe('182'); // preserved as-is
    expect(payload.Line[1].Description).toBe('vendor refund');
  });

  it('linked_payment_ids: [] explicitly removes the linked payment (returns it to Undeposited Funds)', () => {
    const payload = buildDepositUpdatePayload(mixedDeposit, { linked_payment_ids: [] });
    expect(payload.Line).toHaveLength(1); // only the preserved direct line
    expect(payload.Line[0].DepositLineDetail.AccountRef.value).toBe('182');
    expect(payload.Line[0].LinkedTxn).toBeUndefined();
  });

  it('never carries fetched Id/LineNum into the outgoing Line array (preserved lines are rebuilt clean)', () => {
    const payload = buildDepositUpdatePayload(mixedDeposit, {
      deposit_lines: [{ amount: 80.08, account_id: '73' }],
    });
    for (const line of payload.Line) {
      expect(line.Id).toBeUndefined();
      expect(line.LineNum).toBeUndefined();
    }
  });

  it('entity-only change: same account, new Received-From entity', () => {
    const payload = buildDepositUpdatePayload(mixedDeposit, {
      linked_payment_ids: [],
      deposit_lines: [{ amount: 80.08, account_id: '182', entity_id: '9', entity_type: 'Vendor' }],
    });
    expect(payload.Line).toHaveLength(1);
    expect(payload.Line[0].DepositLineDetail.Entity).toEqual({ value: '9', type: 'VENDOR' });
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

// ─────────────────────────────────────────────────────────────────────────────
// Per-line Class + Payment Method (Northway Church and other class-tracked
// companies): every DepositLineDetail carries ClassRef and PaymentMethodRef.
// Fixtures mirror Northway deposit 14048 (2026-08-30 Checks, realm
// 9130353483179106) and its Cash twin 14047.
// ─────────────────────────────────────────────────────────────────────────────

const CLASS_UNRESTRICTED = '1900000000000747661';
const CLASS_DESIGNATED = '1900000000000747660';
const PM_CASH = '1';
const PM_CHECK = '2';

const northwayDeposit = {
  Id: '14048',
  SyncToken: '0',
  DepositToAccountRef: { value: '1150040003', name: 'Synovus Bank Checking' },
  TxnDate: '2026-08-30',
  TotalAmt: 15245,
  Line: [
    {
      Id: '1',
      LineNum: 1,
      Amount: 15245,
      DetailType: 'DepositLineDetail',
      DepositLineDetail: {
        AccountRef: { value: '150', name: '4100 Contributions' },
        ClassRef: { value: CLASS_UNRESTRICTED, name: 'Unrestricted' },
        PaymentMethodRef: { value: PM_CHECK, name: 'Check' },
      },
    },
    {
      Id: '2',
      LineNum: 2,
      Amount: 300,
      DetailType: 'DepositLineDetail',
      Description: 'Tax Refund',
      DepositLineDetail: {
        AccountRef: { value: '151', name: '4410 Misc' },
        ClassRef: { value: CLASS_DESIGNATED, name: 'Designated' },
        PaymentMethodRef: { value: PM_CHECK, name: 'Check' },
      },
    },
    {
      Id: '3',
      LineNum: 3,
      Amount: 125,
      DetailType: 'DepositLineDetail',
      DepositLineDetail: {
        AccountRef: { value: '136', name: '2540 FFF' },
        ClassRef: { value: CLASS_DESIGNATED, name: 'Designated' },
        PaymentMethodRef: { value: PM_CHECK, name: 'Check' },
      },
    },
  ],
};

describe('deposit lines — Class and Payment Method', () => {
  it('writes ClassRef and PaymentMethodRef in the QBO wire shape', () => {
    const [line] = buildDepositTxnLines([], [
      { amount: 15245, account_id: '150', class_id: CLASS_UNRESTRICTED, payment_method_id: PM_CHECK },
    ]);
    expect(line).toEqual({
      Amount: 15245,
      Description: undefined,
      DetailType: 'DepositLineDetail',
      DepositLineDetail: {
        AccountRef: { value: '150' },
        ClassRef: { value: CLASS_UNRESTRICTED },
        PaymentMethodRef: { value: PM_CHECK },
      },
    });
  });

  it('carries Class/PM alongside a Received From entity and description', () => {
    const [line] = buildDepositTxnLines([], [
      {
        amount: 300,
        account_id: '151',
        description: 'Tax Refund',
        class_id: CLASS_DESIGNATED,
        payment_method_id: PM_CHECK,
        entity_id: '6',
        entity_type: 'Vendor',
      },
    ]);
    expect(line.Description).toBe('Tax Refund');
    expect(line.DepositLineDetail.ClassRef).toEqual({ value: CLASS_DESIGNATED });
    expect(line.DepositLineDetail.PaymentMethodRef).toEqual({ value: PM_CHECK });
    expect(line.DepositLineDetail.Entity).toEqual({ value: '6', type: 'VENDOR' });
  });

  it('omits both refs entirely when not supplied (backward compatible)', () => {
    const [line] = buildDepositTxnLines([], [{ amount: 100, account_id: '82' }]);
    expect(line.DepositLineDetail).toEqual({ AccountRef: { value: '82' } });
    expect(line.DepositLineDetail).not.toHaveProperty('ClassRef');
    expect(line.DepositLineDetail).not.toHaveProperty('PaymentMethodRef');
  });

  it('reads Class/PM back out of QBO in the update-ready shape (get_deposit)', () => {
    const { deposit_lines } = qboDepositLinesToUpdateShape(northwayDeposit.Line);
    expect(deposit_lines).toHaveLength(3);
    expect(deposit_lines[0]).toEqual({
      amount: 15245,
      account_id: '150',
      class_id: CLASS_UNRESTRICTED,
      payment_method_id: PM_CHECK,
    });
    expect(deposit_lines[1]).toMatchObject({
      account_id: '151',
      description: 'Tax Refund',
      class_id: CLASS_DESIGNATED,
      payment_method_id: PM_CHECK,
    });
    expect(deposit_lines[2].class_id).toBe(CLASS_DESIGNATED);
  });

  it('round-trips a class-tracked deposit unchanged (read → build)', () => {
    const shape = qboDepositLinesToUpdateShape(northwayDeposit.Line);
    const rebuilt = buildDepositTxnLines(shape.linked_payment_ids, shape.deposit_lines);
    expect(rebuilt).toHaveLength(3);
    rebuilt.forEach((line: any, i: number) => {
      const orig: any = northwayDeposit.Line[i].DepositLineDetail;
      expect(line.DepositLineDetail.AccountRef.value).toBe(orig.AccountRef.value);
      expect(line.DepositLineDetail.ClassRef.value).toBe(orig.ClassRef.value);
      expect(line.DepositLineDetail.PaymentMethodRef.value).toBe(orig.PaymentMethodRef.value);
    });
  });

  it('PRESERVES Class/PM on lines the caller did not touch (the strip hazard)', () => {
    // Replacing only the linked payments must not silently drop the Class and
    // Payment Method off the preserved direct lines — buildDepositUpdatePayload
    // rebuilds them through the read converter.
    const payload = buildDepositUpdatePayload(northwayDeposit, { linked_payment_ids: [] });
    expect(payload.Line).toHaveLength(3);
    for (const line of payload.Line) {
      expect(line.DepositLineDetail.ClassRef?.value).toBeTruthy();
      expect(line.DepositLineDetail.PaymentMethodRef?.value).toBe(PM_CHECK);
    }
  });

  it('re-codes one line to a new class while keeping the others intact', () => {
    const shape = qboDepositLinesToUpdateShape(northwayDeposit.Line);
    const lines = shape.deposit_lines.map((l, i) =>
      i === 1 ? { ...l, class_id: CLASS_UNRESTRICTED } : l
    );
    const payload = buildDepositUpdatePayload(northwayDeposit, { deposit_lines: lines });
    expect(payload.Line[1].DepositLineDetail.ClassRef).toEqual({ value: CLASS_UNRESTRICTED });
    expect(payload.Line[0].DepositLineDetail.ClassRef).toEqual({ value: CLASS_UNRESTRICTED });
    expect(payload.Line[2].DepositLineDetail.ClassRef).toEqual({ value: CLASS_DESIGNATED });
    expect(payload.Line).toHaveLength(3);
  });

  it('supports the Cash twin (payment method 1) on every line', () => {
    const lines = buildDepositTxnLines([], [
      { amount: 500, account_id: '150', class_id: CLASS_UNRESTRICTED, payment_method_id: PM_CASH },
      { amount: 25, account_id: '136', class_id: CLASS_DESIGNATED, payment_method_id: PM_CASH },
    ]);
    expect(lines.map((l: any) => l.DepositLineDetail.PaymentMethodRef.value)).toEqual([PM_CASH, PM_CASH]);
  });

  it('keeps linked Undeposited Funds payment lines untouched by Class/PM', () => {
    const lines = buildDepositTxnLines(
      [{ payment_id: 'pmt-1', amount: 400 }],
      [{ amount: 100, account_id: '150', class_id: CLASS_UNRESTRICTED, payment_method_id: PM_CHECK }]
    );
    expect(lines[0]).toEqual({ Amount: 400, LinkedTxn: [{ TxnId: 'pmt-1', TxnType: 'Payment' }] });
    expect(lines[0]).not.toHaveProperty('DepositLineDetail');
  });
});
