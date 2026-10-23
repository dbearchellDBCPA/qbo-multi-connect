import { describe, it, expect } from 'vitest';
import { buildPaymentCreatePayload, PaymentArgsError } from '../../src/server/payment-payload.js';
import { normalizedAmount } from '../../src/server/import-engine.js';

const base = { customer_id: '58', customer_name: 'Globex' };

describe('create_payment payload — JournalEntry / CreditMemo credits', () => {
  it('$0 payment applies JE A/R credit to open invoices', () => {
    const p = buildPaymentCreatePayload({
      ...base, total_amount: 0,
      invoice_ids: [{ invoice_id: '1001', amount: 400 }, { invoice_id: '1002', amount: 100 }],
      credits: [{ txn_type: 'JournalEntry', txn_id: '3136', amount: 500 }],
    });
    expect(p.TotalAmt).toBe(0);
    expect(p.Line).toEqual([
      { Amount: 400, LinkedTxn: [{ TxnId: '1001', TxnType: 'Invoice' }] },
      { Amount: 100, LinkedTxn: [{ TxnId: '1002', TxnType: 'Invoice' }] },
      { Amount: 500, LinkedTxn: [{ TxnId: '3136', TxnType: 'JournalEntry' }] },
    ]);
  });

  it('mixed invoice + credit memo + JE with cash remainder', () => {
    const p = buildPaymentCreatePayload({
      ...base, total_amount: 250.5, deposit_to_account_id: '35',
      invoice_ids: [{ invoice_id: '1', amount: 500.5 }],
      credits: [{ txn_type: 'CreditMemo', txn_id: '9', amount: 50 }, { txn_type: 'JournalEntry', txn_id: '3136', amount: 200 }],
    });
    expect(p.TotalAmt).toBe(250.5);
    expect(p.Line.map((l: any) => l.LinkedTxn[0].TxnType)).toEqual(['Invoice', 'CreditMemo', 'JournalEntry']);
    expect(p.DepositToAccountRef).toEqual({ value: '35' });
  });

  it('existing callers unchanged (no credits, default amount)', () => {
    const p = buildPaymentCreatePayload({ ...base, total_amount: 75, invoice_ids: [{ invoice_id: '1' }] });
    expect(p).toEqual({ CustomerRef: { value: '58', name: 'Globex' }, TotalAmt: 75, Line: [{ Amount: 75, LinkedTxn: [{ TxnId: '1', TxnType: 'Invoice' }] }] });
    expect(buildPaymentCreatePayload({ ...base, total_amount: 20 }).Line).toBeUndefined();
  });

  const bad = (a: any) => { try { buildPaymentCreatePayload({ ...base, ...a }); } catch (e) { expect(e).toBeInstanceOf(PaymentArgsError); return (e as Error).message; } throw new Error('expected error'); };

  it('validation errors', () => {
    const inv = [{ invoice_id: '1', amount: 100 }];
    expect(bad({ total_amount: 0, invoice_ids: inv, credits: [{ txn_type: 'JournalEntry', txn_id: '3136', amount: 0 }] })).toMatch(/greater than 0/);
    expect(bad({ total_amount: 0, invoice_ids: inv, credits: [{ txn_type: 'JournalEntry', txn_id: '3136', amount: -5 }] })).toMatch(/greater than 0/);
    expect(bad({ total_amount: 0, invoice_ids: inv, credits: [{ txn_type: 'JournalEntry', txn_id: '3136', amount: 1.234 }] })).toMatch(/2 decimal/);
    expect(bad({ total_amount: 0, invoice_ids: inv, credits: [{ txn_type: 'JournalEntry', txn_id: '3136' }] })).toMatch(/amount is required/);
    expect(bad({ total_amount: 0, invoice_ids: inv, credits: [{ txn_type: 'JournalEntry', txn_id: ' ', amount: 100 }] })).toMatch(/txn_id/);
    expect(bad({ total_amount: 0, invoice_ids: [{ invoice_id: '', amount: 100 }], credits: [{ txn_type: 'JournalEntry', txn_id: '3136', amount: 100 }] })).toMatch(/invoice_id is required/);
    expect(bad({ total_amount: 0, credits: [{ txn_type: 'JournalEntry', txn_id: '3136', amount: 100 }] })).toMatch(/at least one invoice/);
    expect(bad({ total_amount: 0, invoice_ids: [{ invoice_id: '1' }], credits: [{ txn_type: 'JournalEntry', txn_id: '3136', amount: 100 }] })).toMatch(/amount is required when credits/);
    expect(bad({ total_amount: 0, invoice_ids: inv, credits: [{ txn_type: 'JournalEntry', txn_id: '3136', amount: 150 }] })).toMatch(/exceed/);
    expect(bad({ total_amount: 10, invoice_ids: inv, credits: [{ txn_type: 'JournalEntry', txn_id: '3136', amount: 100 }] })).toMatch(/must equal/);
    expect(bad({ total_amount: -1 })).toMatch(/0 or more/);
  });
});

describe('import_transactions Payment — credits net against invoices', async () => {
  const { buildTransaction } = await import('../../src/server/import-build.js');
  it('normalizedAmount nets CreditMemo/JE credits', () => {
    const t: any = { source_id: 'p', txn_type: 'Payment', txn_date: '2026-07-01', linked: [{ source_id: 'qbo:Invoice:1', amount: 300 }, { source_id: 'qbo:JournalEntry:3136', amount: 300 }] };
    const typeOf = (s: string) => /^qbo:(\w+):/.exec(s)?.[1];
    expect(normalizedAmount(t, typeOf)).toBe(0);
    expect(typeof buildTransaction).toBe('function');
  });
});
