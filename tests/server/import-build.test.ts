import { describe, it, expect, beforeAll } from 'vitest';
import {
  buildTransaction, stampedNote, parseStamps, hasStamp, isValidDate, txnTypeForQbo, qboTxnAmount,
  type BuildOptions, type LinkResolver,
} from '../../src/server/import-build.js';
import { loadCompanyContext, type CompanyContext } from '../../src/server/import-context.js';
import { normalizedTransactionSchema } from '../../src/server/import-schema.js';
import { FakeQboLedger, seedImportCompany } from '../support/fake-qbo-ledger.js';

let ctx: CompanyContext;
const opts: BuildOptions = { closeDate: '2025-12-31', allowClosedPeriod: false, classTrackingOn: true, classPerTxn: false, truncateDocNumbers: false, itemNamePattern: 'History - {account_name}' };
const noLinks: LinkResolver = (sid) => ({ status: 'blocked', reason: `Linked transaction ${sid} is not imported yet.` });

beforeAll(async () => {
  const ledger = seedImportCompany(new FakeQboLedger('R'));
  ledger.seed('Item', [
    { Id: '600', Name: 'History - Consulting Income', Type: 'Service', IncomeAccountRef: { value: '9' } },
    { Id: '601', Name: 'Widget', Type: 'Service', IncomeAccountRef: { value: '10' } },
  ]);
  ledger.seed('Customer', [{ Id: '401', DisplayName: 'Old Client (deleted)', Active: false }]);
  ledger.seed('Account', [{ Id: '16', Name: 'Other Revenue', AcctNum: '4900', AccountType: 'Income', AccountSubType: 'OtherPrimaryIncome' }]);
  ctx = await loadCompanyContext(async (q) => ledger.query(q), async () => ({ Preferences: ledger.preferences() }), {
    accounts: true, names: true, classes: true, items: true, terms: true, prefs: true,
  });
});

const ok = (t: any, o: Partial<BuildOptions> = {}, links: LinkResolver = noLinks) => {
  const r = buildTransaction(normalizedTransactionSchema.parse(t), ctx, { ...opts, ...o }, links);
  if (r.kind !== 'ok') throw new Error(`expected ok, got ${r.kind}: ${JSON.stringify(r)}`);
  return r.built;
};
const fail = (t: any, o: Partial<BuildOptions> = {}, links: LinkResolver = noLinks) => {
  const r = buildTransaction(normalizedTransactionSchema.parse(t), ctx, { ...opts, ...o }, links);
  if (r.kind !== 'failed') throw new Error(`expected failed, got ${r.kind}: ${JSON.stringify(r)}`);
  return r.errors.join('\n');
};
const base = { source_id: 'ns:1', txn_date: '2026-07-01' };

describe('buildTransaction — payload per txn_type', () => {
  it('JournalEntry: lines, posting types, entities and classes; balanced', () => {
    const b = ok({ ...base, txn_type: 'JournalEntry', doc_number: 'JE-1', memo: 'accrual', lines: [
      { account_number: '6000', amount: 100, posting_type: 'Debit', entity: { name: 'Acme Supplies', type: 'Vendor' }, class: 'East' },
      { account_number: '1200', amount: 100, posting_type: 'Credit', entity: { name: 'Globex Corp', type: 'Customer' } },
    ] });
    expect(b.qboType).toBe('JournalEntry');
    expect(b.payload.DocNumber).toBe('JE-1');
    expect(b.payload.PrivateNote).toBe('accrual [src:ns:1]');
    expect(b.payload.Line[0].JournalEntryLineDetail).toEqual({ PostingType: 'Debit', AccountRef: { value: '11' }, Entity: { Type: 'Vendor', EntityRef: { value: '300' } }, ClassRef: { value: '100' } });
    expect(b.payload.Line[1].JournalEntryLineDetail.Entity).toEqual({ Type: 'Customer', EntityRef: { value: '400' } });
    expect(b.amount).toBe(100);
  });

  it('Expense (Cash) / Check (check number → DocNumber) / card charge and credit', () => {
    const e = ok({ ...base, txn_type: 'Expense', payment_method: 'Cash', account_number: '1000', entity: { name: 'Acme Supplies', type: 'Vendor' }, lines: [{ account_name: 'Travel:Meals', amount: 12.5 }] });
    expect(e.payload).toMatchObject({ PaymentType: 'Cash', AccountRef: { value: '1' }, EntityRef: { value: '300', type: 'Vendor' } });
    expect(e.payload.Line[0].AccountBasedExpenseLineDetail.AccountRef).toEqual({ value: '14' });
    const c = ok({ ...base, txn_type: 'Check', check_number: '1234', account_number: '1000', lines: [{ account_number: '6100', amount: 300 }] });
    expect(c.payload).toMatchObject({ PaymentType: 'Check', DocNumber: '1234' });
    const cc = ok({ ...base, txn_type: 'CreditCardCharge', account_number: '2100', lines: [{ account_number: '6000', amount: 5 }] });
    expect(cc.payload.PaymentType).toBe('CreditCard');
    expect(cc.payload.Credit).toBeUndefined();
    const cr = ok({ ...base, txn_type: 'CreditCardCredit', account_number: '2100', lines: [{ account_number: '6000', amount: 5 }] });
    expect(cr.payload.Credit).toBe(true);
  });

  it('Deposit lines carry received-from names in the flat UPPERCASE shape', () => {
    const d = ok({ ...base, txn_type: 'Deposit', account_number: '1000', lines: [
      { account_number: '4000', amount: 100, entity: { name: 'Globex Corp', type: 'Customer' } },
      { account_number: '4100', amount: 50, entity: { name: 'Acme Supplies', type: 'Vendor' } },
    ] });
    expect(d.payload.DepositToAccountRef).toEqual({ value: '1' });
    expect(d.payload.Line.map((l: any) => l.DepositLineDetail.Entity)).toEqual([{ value: '400', type: 'CUSTOMER' }, { value: '300', type: 'VENDOR' }]);
    expect(d.amount).toBe(150);
  });

  it('Transfer drops class/name/doc number with warnings', () => {
    const t = ok({ ...base, txn_type: 'Transfer', account_number: '1000', transfer_to_account_number: '1010', amount: 250, class: 'East', doc_number: 'T1' });
    expect(t.payload).toMatchObject({ FromAccountRef: { value: '1' }, ToAccountRef: { value: '2' }, Amount: 250 });
    expect(t.payload.DocNumber).toBeUndefined();
    expect(t.warnings.join(' ')).toMatch(/no class/);
  });

  it('Bill with terms and due date; VendorCredit', () => {
    const b = ok({ ...base, txn_type: 'Bill', entity: { name: 'Acme Supplies', type: 'Vendor' }, terms: 'Net 30', due_date: '2026-07-31', lines: [{ account_number: '6000', amount: 10 }] });
    expect(b.payload).toMatchObject({ VendorRef: { value: '300' }, SalesTermRef: { value: '200' }, DueDate: '2026-07-31' });
    const vc = ok({ ...base, txn_type: 'VendorCredit', entity: { name: 'Acme Supplies', type: 'Vendor' }, lines: [{ account_number: '6000', amount: 10 }] });
    expect(vc.qboType).toBe('VendorCredit');
  });

  it('Invoice lines by item name or by income account (the ensure_items item)', () => {
    const i = ok({ ...base, txn_type: 'Invoice', entity: { name: 'Globex Corp', type: 'Customer' }, lines: [{ account_number: '4000', amount: 100 }, { item_name: 'Widget', amount: 30, quantity: 3 }] });
    expect(i.payload.Line[0].SalesItemLineDetail.ItemRef).toEqual({ value: '600' });
    expect(i.payload.Line[1].SalesItemLineDetail).toMatchObject({ ItemRef: { value: '601' }, Qty: 3, UnitPrice: 10 });
    // An account with no "History - …" item but exactly one item mapped to it uses that item.
    expect(ok({ ...base, txn_type: 'Invoice', entity: { name: 'Globex Corp', type: 'Customer' }, lines: [{ account_number: '4100', amount: 1 }] }).payload.Line[0].SalesItemLineDetail.ItemRef).toEqual({ value: '601' });
    const e = fail({ ...base, txn_type: 'Invoice', entity: { name: 'Globex Corp', type: 'Customer' }, lines: [{ account_number: '4900', amount: 1 }] });
    expect(e).toMatch(/ensure_items/);
  });

  it('SalesReceipt / RefundReceipt / CreditMemo', () => {
    expect(ok({ ...base, txn_type: 'SalesReceipt', account_number: '1000', lines: [{ item_name: 'Widget', amount: 5 }] }).payload.DepositToAccountRef).toEqual({ value: '1' });
    expect(fail({ ...base, txn_type: 'RefundReceipt', lines: [{ item_name: 'Widget', amount: 5 }] })).toMatch(/refund-from account/);
    expect(ok({ ...base, txn_type: 'CreditMemo', entity: { name: 'Globex Corp', type: 'Customer' }, lines: [{ item_name: 'Widget', amount: 5 }] }).qboType).toBe('CreditMemo');
  });

  it('Payment / BillPayment link by source_id; blocked when the target is not imported', () => {
    const ready: LinkResolver = (sid) => (sid === 'ns:inv' ? { status: 'ready', qboId: '77', qboType: 'Invoice' } : { status: 'ready', qboId: '88', qboType: 'Bill' });
    const p = ok({ ...base, txn_type: 'Payment', entity: { name: 'Globex Corp', type: 'Customer' }, check_number: '991', linked: [{ source_id: 'ns:inv', amount: 40 }], amount: 50 }, {}, ready);
    expect(p.payload).toMatchObject({ TotalAmt: 50, PaymentRefNum: '991', Line: [{ Amount: 40, LinkedTxn: [{ TxnId: '77', TxnType: 'Invoice' }] }] });
    const bp = ok({ ...base, txn_type: 'BillPayment', entity: { name: 'Acme Supplies', type: 'Vendor' }, account_number: '1000', linked: [{ source_id: 'ns:bill', amount: 10 }] }, {}, ready);
    expect(bp.payload).toMatchObject({ PayType: 'Check', CheckPayment: { BankAccountRef: { value: '1' } }, TotalAmt: 10 });
    const r = buildTransaction(normalizedTransactionSchema.parse({ ...base, txn_type: 'BillPayment', entity: { name: 'Acme Supplies', type: 'Vendor' }, account_number: '1000', linked: [{ source_id: 'ns:nope', amount: 10 }] }), ctx, opts, noLinks);
    expect(r.kind).toBe('blocked');
    const wrong = fail({ ...base, txn_type: 'Payment', entity: { name: 'Globex Corp', type: 'Customer' }, linked: [{ source_id: 'ns:bill', amount: 10 }] }, {}, ready);
    expect(wrong).toMatch(/imported as a Bill; a Payment can only be applied to Invoice/);
  });
});

describe('buildTransaction — the rules', () => {
  it('unbalanced JE names the difference', () => {
    expect(fail({ ...base, txn_type: 'JournalEntry', lines: [{ account_number: '6000', amount: 10, posting_type: 'Debit' }, { account_number: '1000', amount: 9.99, posting_type: 'Credit' }] })).toMatch(/difference 0\.01/);
  });
  it('A/R line needs a Customer, A/P line a Vendor', () => {
    expect(fail({ ...base, txn_type: 'JournalEntry', lines: [{ account_number: '1200', amount: 10, posting_type: 'Debit' }, { account_number: '4000', amount: 10, posting_type: 'Credit' }] })).toMatch(/requires a Customer/);
    expect(fail({ ...base, txn_type: 'JournalEntry', lines: [{ account_number: '6000', amount: 10, posting_type: 'Debit' }, { account_number: '2000', amount: 10, posting_type: 'Credit', entity: { name: 'Globex Corp', type: 'Customer' } }] })).toMatch(/requires a Vendor/);
  });
  it('at most one A/R or A/P account per transaction', () => {
    expect(fail({ ...base, txn_type: 'JournalEntry', lines: [
      { account_number: '1200', amount: 10, posting_type: 'Debit', entity: { name: 'Globex Corp', type: 'Customer' } },
      { account_number: '1250', amount: 10, posting_type: 'Credit', entity: { name: 'Globex Corp', type: 'Customer' } },
    ] })).toMatch(/only one Accounts Receivable or Accounts Payable/);
    expect(fail({ ...base, txn_type: 'JournalEntry', lines: [
      { account_number: '1200', amount: 10, posting_type: 'Debit', entity: { name: 'Globex Corp', type: 'Customer' } },
      { account_number: '2000', amount: 10, posting_type: 'Credit', entity: { name: 'Acme Supplies', type: 'Vendor' } },
    ] })).toMatch(/no A\/R together with A\/P/);
  });
  it('unknown account / name / class / wrong slot type', () => {
    expect(fail({ ...base, txn_type: 'Expense', account_number: '1000', lines: [{ account_number: '9999', amount: 1 }] })).toMatch(/9999/);
    expect(fail({ ...base, txn_type: 'Bill', entity: { name: 'Nobody Inc', type: 'Vendor' }, lines: [{ account_number: '6000', amount: 1 }] })).toMatch(/Nobody Inc/);
    expect(fail({ ...base, txn_type: 'Bill', entity: { name: 'Globex Corp', type: 'Vendor' }, lines: [{ account_number: '6000', amount: 1 }] })).toMatch(/is a Customer/);
    expect(fail({ ...base, txn_type: 'Expense', account_number: '1000', lines: [{ account_number: '6000', amount: 1, class: 'North' }] })).toMatch(/North/);
    expect(fail({ ...base, txn_type: 'Check', account_number: '6000', lines: [{ account_number: '6100', amount: 1 }] })).toMatch(/needs a Bank account/);
  });
  it('inactive names explain themselves', () => {
    expect(fail({ ...base, txn_type: 'Invoice', entity: { name: 'Old Client', type: 'Customer' }, lines: [{ item_name: 'Widget', amount: 1 }] })).toMatch(/inactive/i);
  });
  it('closing date, invalid dates, amounts', () => {
    expect(fail({ ...base, txn_date: '2025-12-31', txn_type: 'Expense', account_number: '1000', lines: [{ account_number: '6000', amount: 1 }] })).toMatch(/closing date/);
    ok({ ...base, txn_date: '2025-12-31', txn_type: 'Expense', account_number: '1000', lines: [{ account_number: '6000', amount: 1 }] }, { allowClosedPeriod: true });
    expect(fail({ ...base, txn_date: '2026-02-30', txn_type: 'Expense', account_number: '1000', lines: [{ account_number: '6000', amount: 1 }] })).toMatch(/date/);
    expect(fail({ ...base, txn_type: 'Expense', account_number: '1000', lines: [{ account_number: '6000', amount: -5 }] })).toMatch(/greater than 0/);
    expect(fail({ ...base, txn_type: 'Expense', account_number: '1000', lines: [{ account_number: '6000', amount: 1.234 }] })).toMatch(/2 decimal/);
  });
  it('DocNumber > 21 fails unless truncate_doc_numbers', () => {
    const t = { ...base, txn_type: 'Invoice', doc_number: 'D'.repeat(25), entity: { name: 'Globex Corp', type: 'Customer' }, lines: [{ item_name: 'Widget', amount: 1 }] };
    expect(fail(t)).toMatch(/25 characters; QBO allows at most 21/);
    const b = ok(t, { truncateDocNumbers: true });
    expect(b.payload.DocNumber).toHaveLength(21);
    expect(b.warnings.join(' ')).toMatch(/truncated|shortened|cut/i);
  });
  it('classes are dropped with a warning when class tracking is off', () => {
    const b = ok({ ...base, txn_type: 'Expense', account_number: '1000', lines: [{ account_number: '6000', amount: 1, class: 'East' }] }, { classTrackingOn: false });
    expect(b.payload.Line[0].AccountBasedExpenseLineDetail.ClassRef).toBeUndefined();
    expect(b.warnings.join(' ')).toMatch(/class/i);
  });
});

describe('stamps and helpers', () => {
  it('memo + stamp, memo shortened (never the stamp) to fit 4000', () => {
    expect(stampedNote(undefined, 'a:1').note).toBe('[src:a:1]');
    const long = stampedNote('m'.repeat(5000), 'a:1');
    expect(long.note).toHaveLength(4000);
    expect(long.note.endsWith(' [src:a:1]')).toBe(true);
    expect(long.warning).toBeTruthy();
    expect(parseStamps('x [src:a:1] y [src:b:2]')).toEqual(['a:1', 'b:2']);
    expect(hasStamp('edited note', 'a:1')).toBe(false);
  });
  it('dates, QBO type mapping and amounts read back from QBO', () => {
    expect(isValidDate('2024-02-29')).toBe(true);
    expect(isValidDate('2023-02-29')).toBe(false);
    expect(txnTypeForQbo('Purchase', { PaymentType: 'CreditCard', Credit: true })).toBe('CreditCardCredit');
    expect(txnTypeForQbo('Purchase', { PaymentType: 'Check' })).toBe('Check');
    expect(txnTypeForQbo('Purchase', { PaymentType: 'Cash' })).toBe('Expense');
    expect(qboTxnAmount('Transfer', { Amount: 12 })).toBe(12);
    expect(qboTxnAmount('JournalEntry', { Line: [{ Amount: 5, JournalEntryLineDetail: { PostingType: 'Debit' } }, { Amount: 5, JournalEntryLineDetail: { PostingType: 'Credit' } }] })).toBe(5);
  });
  it('the schema rejects source_ids that would break the stamp, and unknown keys', () => {
    expect(() => normalizedTransactionSchema.parse({ ...base, source_id: 'a]b', txn_type: 'Expense' })).toThrow(/source_id/);
    expect(() => normalizedTransactionSchema.parse({ ...base, txn_type: 'Expense', amout: 1 })).toThrow(/amout/);
  });
});
