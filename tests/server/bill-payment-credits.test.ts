import { describe, it, expect } from 'vitest';
import { buildBillPaymentWithCreditsPayload, BillPaymentCreditsError } from '../../src/server/bill-payment-credits.js';

const base = { vendor_id: '3', pay_type: 'Check' as const, bank_account_id: '35', txn_date: '2026-10-07' };

describe('buildBillPaymentWithCreditsPayload', () => {
  it('builds a $0 payment: bill line then credit line', () => {
    const p = buildBillPaymentWithCreditsPayload({ ...base, total_amount: 0, bill_ids: [{ bill_id: '11768', amount: 4512 }], credits: [{ txn_type: 'VendorCredit', txn_id: '11353', amount: 4512 }] });
    expect(p.TotalAmt).toBe(0);
    expect(p.Line).toEqual([
      { Amount: 4512, LinkedTxn: [{ TxnId: '11768', TxnType: 'Bill' }] },
      { Amount: 4512, LinkedTxn: [{ TxnId: '11353', TxnType: 'VendorCredit' }] },
    ]);
    expect(p.CheckPayment.BankAccountRef.value).toBe('35');
  });
  it('groups credits under their bill_id and nets the total', () => {
    const p = buildBillPaymentWithCreditsPayload({ ...base, total_amount: 150, bill_ids: [{ bill_id: 'A', amount: 100 }, { bill_id: 'B', amount: 100 }], credits: [{ txn_type: 'VendorCredit', txn_id: 'C2', amount: 30, bill_id: 'B' }, { txn_type: 'VendorCredit', txn_id: 'C1', amount: 20, bill_id: 'A' }] });
    expect(p.Line.map((l: any) => l.LinkedTxn[0].TxnId)).toEqual(['A', 'C1', 'B', 'C2']);
  });
  const bad = (a: any, re: RegExp) => { expect(() => buildBillPaymentWithCreditsPayload({ ...base, ...a })).toThrow(BillPaymentCreditsError); expect(() => buildBillPaymentWithCreditsPayload({ ...base, ...a })).toThrow(re); };
  it('rejects wrong total', () => bad({ total_amount: 10, bill_ids: [{ bill_id: 'A', amount: 100 }], credits: [{ txn_type: 'VendorCredit', txn_id: 'C', amount: 100 }] }, /must equal bills 100.00 − credits 100.00 = 0.00/));
  it('requires bill amounts', () => bad({ total_amount: 0, bill_ids: [{ bill_id: 'A' }], credits: [{ txn_type: 'VendorCredit', txn_id: 'C', amount: 100 }] }, /amount is required when credits/));
  it('credit over bill', () => bad({ total_amount: 0, bill_ids: [{ bill_id: 'A', amount: 50 }], credits: [{ txn_type: 'VendorCredit', txn_id: 'C', amount: 60 }] }, /exceed/));
  it('needs bill_id with multiple bills', () => bad({ total_amount: 0, bill_ids: [{ bill_id: 'A', amount: 50 }, { bill_id: 'B', amount: 50 }], credits: [{ txn_type: 'VendorCredit', txn_id: 'C', amount: 100 }] }, /bill_id is required/));
  it('rejects JournalEntry credits and zero amounts', () => {
    bad({ total_amount: 0, bill_ids: [{ bill_id: 'A', amount: 50 }], credits: [{ txn_type: 'JournalEntry', txn_id: 'J', amount: 50 }] }, /must be 'VendorCredit'/);
    bad({ total_amount: 50, bill_ids: [{ bill_id: 'A', amount: 50 }], credits: [{ txn_type: 'VendorCredit', txn_id: 'C', amount: 0 }] }, /greater than 0/);
  });
  it('no credits = legacy payload', () => {
    const p = buildBillPaymentWithCreditsPayload({ ...base, total_amount: 5, bill_ids: [{ bill_id: 'A' }] });
    expect(p.Line).toEqual([{ Amount: 5, LinkedTxn: [{ TxnId: 'A', TxnType: 'Bill' }] }]);
  });
});

