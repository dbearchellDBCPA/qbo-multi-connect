import { describe, it, expect, beforeAll } from 'vitest';
import { buildTransaction, planBillPayment, shortSid, type BuildOptions, type LinkResolver } from '../../src/server/import-build.js';
import { normalizedAmount } from '../../src/server/import-engine.js';
import { loadCompanyContext, type CompanyContext } from '../../src/server/import-context.js';
import { normalizedTransactionSchema } from '../../src/server/import-schema.js';
import { FakeQboLedger, seedImportCompany } from '../support/fake-qbo-ledger.js';

let ctx: CompanyContext;
const opts: BuildOptions = { closeDate: '2025-12-31', allowClosedPeriod: false, classTrackingOn: true, classPerTxn: false, truncateDocNumbers: false, itemNamePattern: 'History - {account_name}' };
const types: Record<string, [string, string]> = {
  'netsuite:275459': ['Bill', '10303'], 'netsuite:274856': ['VendorCredit', '10448'],
  'ns:b2': ['Bill', '20'], 'ns:c2': ['VendorCredit', '30'], 'ns:c3': ['VendorCredit', '31'], 'ns:je': ['JournalEntry', '40'],
};
const links: LinkResolver = (sid) => {
  const d = /^qbo:(\w+):(\d+)$/.exec(sid);
  if (d) return { status: 'ready', qboType: d[1], qboId: d[2] };
  const t = types[sid];
  return t ? { status: 'ready', qboType: t[0], qboId: t[1] } : { status: 'blocked', reason: `not imported ${sid}` };
};
const row = (linked: any[], extra: any = {}) => normalizedTransactionSchema.parse({
  source_id: 'cleanup:x', txn_type: 'BillPayment', txn_date: '2026-10-07', entity: { name: 'Acme Supplies', type: 'Vendor' },
  account_number: '1000', payment_method: 'Check', linked, ...extra,
});
const build = (linked: any[], extra: any = {}) => buildTransaction(row(linked, extra), ctx, opts, links);

beforeAll(async () => {
  const ledger = seedImportCompany(new FakeQboLedger('R'));
  ctx = await loadCompanyContext(async (q) => ledger.query(q), async () => ({ Preferences: ledger.preferences() }), { accounts: true, names: true, classes: true, items: true, terms: true, prefs: true });
});

describe('planBillPayment — net-amount math', () => {
  it('bills minus credits; credits pair with the nearest preceding bill', () => {
    const p = planBillPayment([
      { sourceId: 'b1', kind: 'bill', cents: 59400 }, { sourceId: 'c1', kind: 'credit', cents: 59400 },
      { sourceId: 'b2', kind: 'bill', cents: 10000 }, { sourceId: 'c2', kind: 'credit', cents: 2500 }, { sourceId: 'c3', kind: 'credit', cents: 500 },
    ]);
    expect(p).toMatchObject({ billCents: 69400, creditCents: 62400, netCents: 7000, errors: [] });
    expect(p.groups.map((g) => [g.sourceId, g.credits.map((c) => c.sourceId)])).toEqual([['b1', ['c1']], ['b2', ['c2', 'c3']]]);
  });
  it('rejects credits over a bill, credits over the bills, and a credit before any bill', () => {
    expect(planBillPayment([{ sourceId: 'b', kind: 'bill', cents: 100 }, { sourceId: 'c', kind: 'credit', cents: 101 }]).errors.join(' ')).toMatch(/exceed/);
    expect(planBillPayment([{ sourceId: 'c', kind: 'credit', cents: 1 }, { sourceId: 'b', kind: 'bill', cents: 100 }]).errors.join(' ')).toMatch(/before any Bill/);
  });
  it('shortSid', () => {
    expect(shortSid('netsuite:275459')).toBe('275459');
    expect(shortSid('qbo:VendorCredit:10448')).toBe('10448');
  });
});

describe('BillPayment with vendor credits — payload', () => {
  it('fully covered bill → TotalAmt 0, bill line + credit line, summary', () => {
    const r = build([{ source_id: 'netsuite:275459', amount: 594 }, { source_id: 'netsuite:274856', amount: 594 }]);
    if (r.kind !== 'ok') throw new Error(JSON.stringify(r));
    expect(r.built.amount).toBe(0);
    expect(r.built.payload).toMatchObject({
      TotalAmt: 0, PayType: 'Check', CheckPayment: { BankAccountRef: { value: '1' } },
      Line: [
        { Amount: 594, LinkedTxn: [{ TxnId: '10303', TxnType: 'Bill' }] },
        { Amount: 594, LinkedTxn: [{ TxnId: '10448', TxnType: 'VendorCredit' }] },
      ],
    });
    expect(r.built.summary).toBe('applies 594.00 of credit 274856 to bill 275459');
    expect(r.built.credits).toEqual([{ creditSourceId: 'netsuite:274856', creditType: 'VendorCredit', creditQboId: '10448', billSourceId: 'netsuite:275459', amount: 594 }]);
  });
  it('explicit amount 0 is allowed; amount below the net is rejected', () => {
    expect(build([{ source_id: 'netsuite:275459', amount: 594 }, { source_id: 'netsuite:274856', amount: 594 }], { amount: 0 }).kind).toBe('ok');
    const r = build([{ source_id: 'ns:b2', amount: 100 }, { source_id: 'ns:c2', amount: 40 }], { amount: 50 });
    expect(r.kind).toBe('failed');
    if (r.kind === 'failed') expect(r.errors.join(' ')).toMatch(/less than the net 60\.00/);
  });
  it('partial credit, multiple bills, JournalEntry credit and qbo: refs', () => {
    const r = build([
      { source_id: 'qbo:Bill:10303', amount: 594 }, { source_id: 'qbo:VendorCredit:10448', amount: 94 },
      { source_id: 'ns:b2', amount: 100 }, { source_id: 'ns:je', amount: 100 },
    ]);
    if (r.kind !== 'ok') throw new Error(JSON.stringify(r));
    expect(r.built.payload.TotalAmt).toBe(500);
    expect(r.built.payload.Line.map((l: any) => [l.Amount, l.LinkedTxn[0].TxnType, l.LinkedTxn[0].TxnId])).toEqual([
      [594, 'Bill', '10303'], [94, 'VendorCredit', '10448'], [100, 'Bill', '20'], [100, 'JournalEntry', '40'],
    ]);
  });
  it('credits exceeding bills fail; a credit with no preceding bill fails', () => {
    expect(build([{ source_id: 'ns:b2', amount: 10 }, { source_id: 'ns:c2', amount: 20 }]).kind).toBe('failed');
    expect(build([{ source_id: 'ns:c2', amount: 10 }]).kind).toBe('failed');
  });
  it('normalizedAmount uses the net figure when link types are known', () => {
    const t = row([{ source_id: 'netsuite:275459', amount: 594 }, { source_id: 'netsuite:274856', amount: 594 }]);
    expect(normalizedAmount(t, (sid) => types[sid]?.[0])).toBe(0);
    expect(normalizedAmount(t)).toBe(1188);
  });
});
