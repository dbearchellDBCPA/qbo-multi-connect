import { describe, it, expect } from 'vitest';
import {
  buildBillPaymentCreatePayload, applyBillPaymentPayChanges,
  applyExpenseCreatePrintStatus, applyExpenseUpdatePrintStatus, PrintStatusError,
} from '../../src/server/print-status.js';

const base = { vendor_id: '427', total_amount: 100, bill_ids: [{ bill_id: '14601' }] };

// Shape of Northway BillPayment 14633 (read-only fetch 2026-10-16).
const existingBp = {
  Id: '14633', SyncToken: '0', PayType: 'Check', VendorRef: { value: '427' }, TotalAmt: 7481.5, DocNumber: 'ACH 261015',
  CheckPayment: { BankAccountRef: { value: '1150040003', name: 'Synovus Bank Checking' }, PrintStatus: 'NeedToPrint' },
  Line: [{ Amount: 7481.5, LinkedTxn: [{ TxnId: '14601', TxnType: 'Bill' }] }],
};
const upd = (bp: any, a: any) => { const p = { ...bp }; applyBillPaymentPayChanges(bp, p, a); return p; };

describe('create_bill_payment print_status', () => {
  it('sends explicit print_status inside CheckPayment with BankAccountRef', () => {
    const p = buildBillPaymentCreatePayload({ ...base, pay_type: 'Check', bank_account_id: '35', print_status: 'PrintComplete' });
    expect(p.CheckPayment).toEqual({ BankAccountRef: { value: '35' }, PrintStatus: 'PrintComplete' });
  });
  it('defaults to NotSet when doc_number is supplied', () => {
    const p = buildBillPaymentCreatePayload({ ...base, pay_type: 'Check', bank_account_id: '35', doc_number: '1001' });
    expect(p.CheckPayment.PrintStatus).toBe('NotSet');
    expect(p.DocNumber).toBe('1001');
  });
  it('explicit value wins over the doc_number default', () => {
    const p = buildBillPaymentCreatePayload({ ...base, pay_type: 'Check', bank_account_id: '35', doc_number: '1001', print_status: 'NeedToPrint' });
    expect(p.CheckPayment.PrintStatus).toBe('NeedToPrint');
  });
  it('sends no PrintStatus with no doc_number and no print_status', () => {
    const p = buildBillPaymentCreatePayload({ ...base, pay_type: 'Check', bank_account_id: '35' });
    expect(p.CheckPayment).toEqual({ BankAccountRef: { value: '35' } });
  });
  it('rejects print_status for CreditCard', () => {
    expect(() => buildBillPaymentCreatePayload({ ...base, pay_type: 'CreditCard', credit_card_account_id: '9', print_status: 'NotSet' })).toThrow(/only applies to Check/);
  });
  it('CreditCard with doc_number gets no PrintStatus', () => {
    const p = buildBillPaymentCreatePayload({ ...base, pay_type: 'CreditCard', credit_card_account_id: '9', doc_number: 'X' });
    expect(p.CheckPayment).toBeUndefined();
    expect(p.CreditCardPayment).toEqual({ CCAccountRef: { value: '9' } });
  });
  it('requires bank_account_id for Check (no BankAccountRef-less $0 payments)', () => {
    expect(() => buildBillPaymentCreatePayload({ ...base, total_amount: 0, pay_type: 'Check' })).toThrow(PrintStatusError);
  });
});

describe('update_bill_payment print_status', () => {
  it('merges print_status and keeps BankAccountRef', () => {
    const p = upd(existingBp, { print_status: 'NotSet' });
    expect(p.CheckPayment).toEqual({ BankAccountRef: { value: '1150040003', name: 'Synovus Bank Checking' }, PrintStatus: 'NotSet' });
    expect(p.Id).toBe('14633'); expect(p.SyncToken).toBe('0'); expect(p.Line).toEqual(existingBp.Line);
  });
  it('preserves existing PrintStatus when changing only the bank account', () => {
    const p = upd(existingBp, { pay_account_id: '40' });
    expect(p.CheckPayment).toEqual({ BankAccountRef: { value: '40' }, PrintStatus: 'NeedToPrint' });
  });
  it('preserves CheckPayment untouched when nothing relevant is passed', () => {
    const p = upd(existingBp, {});
    expect(p.CheckPayment).toBe(existingBp.CheckPayment);
  });
  it('defaults to NotSet when a doc_number is passed', () => {
    expect(upd(existingBp, { doc_number: '2002' }).CheckPayment.PrintStatus).toBe('NotSet');
  });
  it('refuses to write a CheckPayment without BankAccountRef', () => {
    const noBank = { ...existingBp, CheckPayment: { PrintStatus: 'NeedToPrint' } };
    expect(() => upd(noBank, { print_status: 'NotSet' })).toThrow(/BankAccountRef/);
    expect(upd(noBank, { print_status: 'NotSet', pay_account_id: '35' }).CheckPayment).toEqual({ PrintStatus: 'NotSet', BankAccountRef: { value: '35' } });
  });
  it('rejects print_status on a CreditCard bill payment; keeps card ref merge', () => {
    const cc = { Id: '1', PayType: 'CreditCard', CreditCardPayment: { CCAccountRef: { value: '9' } } };
    expect(() => upd(cc, { print_status: 'NotSet' })).toThrow(/only applies to Check/);
    expect(upd(cc, { pay_account_id: '10' }).CreditCardPayment).toEqual({ CCAccountRef: { value: '10' } });
  });
});

describe('expense (Purchase) print_status', () => {
  const create = (a: any) => { const p: any = {}; applyExpenseCreatePrintStatus(p, a); return p; };
  it('create: explicit, doc_number default, and omitted', () => {
    expect(create({ payment_type: 'Check', print_status: 'PrintComplete' }).PrintStatus).toBe('PrintComplete');
    expect(create({ payment_type: 'Check', doc_number: '5' }).PrintStatus).toBe('NotSet');
    expect(create({ payment_type: 'Check' })).toEqual({});
    expect(create({ payment_type: 'Cash', doc_number: '5' })).toEqual({});
  });
  it('create: rejects print_status for CreditCard/Cash', () => {
    expect(() => create({ payment_type: 'CreditCard', print_status: 'NotSet' })).toThrow(PrintStatusError);
    expect(() => create({ payment_type: 'Cash', print_status: 'NotSet' })).toThrow(PrintStatusError);
  });
  const exp = { Id: '7', PaymentType: 'Check', PrintStatus: 'NeedToPrint', AccountRef: { value: '35' } };
  const update = (e: any, a: any) => { const p = { ...e }; applyExpenseUpdatePrintStatus(e, p, a); return p; };
  it('update: preserves, sets, defaults', () => {
    expect(update(exp, {}).PrintStatus).toBe('NeedToPrint');
    expect(update(exp, { print_status: 'PrintComplete' }).PrintStatus).toBe('PrintComplete');
    expect(update(exp, { doc_number: '9' }).PrintStatus).toBe('NotSet');
    expect(update(exp, {}).AccountRef).toEqual({ value: '35' });
  });
  it('update: rejects on non-Check and drops PrintStatus when switching away from Check', () => {
    expect(() => update(exp, { payment_type: 'CreditCard', print_status: 'NotSet' })).toThrow(PrintStatusError);
    expect(update(exp, { payment_type: 'CreditCard' }).PrintStatus).toBeUndefined();
  });
});
