import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { startImportHarness, IMPORT_CLIENT, rowStatus, runLog, type ImportHarness } from '../support/import-harness.js';
import { IMPORT_STORE_FILENAME } from '../../src/db/import-store.js';

// Edge cases of the import tools over MCP against FakeQboLedger, each test
// with its own source_id namespace on one shared company.

const V = { name: 'Acme Supplies', type: 'Vendor' };
const C = { name: 'Globex Corp', type: 'Customer' };

describe('bulk import — edge cases over MCP', () => {
  let h: ImportHarness;
  const call = (name: string, args: Record<string, unknown>) => h.call(name, { client_name: IMPORT_CLIENT, ...args });
  const expense = (sid: string, amount = 10, extra: any = {}) => ({ source_id: sid, txn_type: 'Expense', txn_date: '2026-08-03', account_number: '1000', entity: V, memo: 'edge', lines: [{ account_number: '6000', amount }], ...extra });
  const invoice = (sid: string, extra: any = {}) => ({ source_id: sid, txn_type: 'Invoice', txn_date: '2026-08-04', entity: C, lines: [{ item_name: 'Widget', amount: 100 }, { item_name: 'Widget', amount: 50 }], ...extra });

  beforeAll(async () => {
    h = await startImportHarness({ closeDate: '2025-12-31' });
    h.ledger.seed('Item', [{ Id: '700', Name: 'Widget', Type: 'Service', IncomeAccountRef: { value: '10' } }]);
    h.ledger.seed('Invoice', [{ Id: '710', DocNumber: 'INV-9', TxnDate: '2026-01-05', CustomerRef: { value: '400' }, TotalAmt: 5, Balance: 5, Line: [] }]);
  }, 60_000);
  afterAll(async () => { await h?.close(); });

  it('on_existing="fail" fails a changed row; identical rows stay unchanged', async () => {
    await call('import_transactions', { transactions: [expense('e1:a'), expense('e1:b')], run_id: 'e1' });
    const t = await call('import_transactions', { transactions: [expense('e1:a', 11), expense('e1:b')], run_id: 'e1', on_existing: 'fail' });
    expect(rowStatus(t, 'e1:a')).toBe('failed');
    expect(rowStatus(t, 'e1:b')).toBe('unchanged');
  });

  it('a source_id twice in one call: the second copy fails, the first loads', async () => {
    const t = await call('import_transactions', { transactions: [expense('e2:a'), expense('e2:a', 20)], run_id: 'e2' });
    const log = runLog(t);
    expect(log.results.map((r: any) => r.status)).toEqual(['created', 'failed']);
    expect(log.results[1].message).toMatch(/more than once|duplicate|appears/i);
    expect(h.ledger.stamped('e2:a')).toHaveLength(1);
  });

  it('6140 duplicate document number: explained, and allow_doc_number_suffix retries with -2', async () => {
    let t = await call('import_transactions', { transactions: [invoice('e3:inv', { doc_number: 'INV-9' })], run_id: 'e3' });
    expect(rowStatus(t, 'e3:inv')).toBe('failed');
    expect(t).toMatch(/6140/);
    expect(t).toMatch(/allow_doc_number_suffix/);
    t = await call('import_transactions', { transactions: [invoice('e3:inv', { doc_number: 'INV-9' })], run_id: 'e3', allow_doc_number_suffix: true });
    expect(rowStatus(t, 'e3:inv')).toBe('created');
    expect(h.ledger.stamped('e3:inv')[0].rec.DocNumber).toBe('INV-9-2');
  });

  it('stop_on_first_failure: a validation failure means nothing is written', async () => {
    const before = h.ledger.writes;
    const t = await call('import_transactions', { transactions: [expense('e4:ok'), expense('e4:bad', 5, { lines: [{ account_number: 'nope', amount: 5 }] })], run_id: 'e4', stop_on_first_failure: true });
    expect(rowStatus(t, 'e4:bad')).toBe('failed');
    expect(rowStatus(t, 'e4:ok')).not.toBe('created');
    expect(h.ledger.writes).toBe(before);
  });

  it('a Payment listed before its Invoice in the same call still links (payments load second)', async () => {
    const t = await call('import_transactions', {
      transactions: [
        { source_id: 'e5:pmt', txn_type: 'Payment', txn_date: '2026-08-06', entity: C, linked: [{ source_id: 'e5:inv', amount: 150 }] },
        invoice('e5:inv'),
      ],
      run_id: 'e5',
    });
    expect(rowStatus(t, 'e5:inv')).toBe('created');
    expect(rowStatus(t, 'e5:pmt')).toBe('created');
    expect(h.ledger.stamped('e5:inv')[0].rec.Balance).toBe(0);
  });

  it('a Payment whose Invoice fails in the same call is blocked, not failed', async () => {
    const t = await call('import_transactions', {
      transactions: [invoice('e6:inv', { entity: { name: 'Nobody', type: 'Customer' } }), { source_id: 'e6:pmt', txn_type: 'Payment', txn_date: '2026-08-06', entity: C, linked: [{ source_id: 'e6:inv', amount: 150 }] }],
      run_id: 'e6',
    });
    expect(rowStatus(t, 'e6:inv')).toBe('failed');
    expect(rowStatus(t, 'e6:pmt')).toBe('blocked');
  });

  it('on_existing="update" keeps the QBO Id and Line Ids (lines replaced, not appended)', async () => {
    await call('import_transactions', { transactions: [invoice('e7:inv')], run_id: 'e7' });
    const before = structuredClone(h.ledger.stamped('e7:inv')[0].rec);
    const t = await call('import_transactions', { transactions: [invoice('e7:inv', { memo: 'changed', lines: [{ item_name: 'Widget', amount: 100 }, { item_name: 'Widget', amount: 60 }] })], run_id: 'e7', on_existing: 'update' });
    expect(rowStatus(t, 'e7:inv')).toBe('updated');
    const after = h.ledger.stamped('e7:inv');
    expect(after).toHaveLength(1);
    expect(after[0].rec.Id).toBe(before.Id);
    expect(after[0].rec.SyncToken).toBe('1');
    expect(after[0].rec.Line.map((l: any) => l.Id)).toEqual(before.Line.map((l: any) => l.Id));
    expect(after[0].rec.TotalAmt).toBe(160);
    expect(after[0].rec.PrivateNote).toBe('changed [src:e7:inv]');
  });

  it('store lost and NOT rebuilt: a re-run still finds the stamped rows in QBO and writes nothing', async () => {
    await call('import_transactions', { transactions: [expense('e8:a', 33), expense('e8:b', 44)], run_id: 'e8' });
    rmSync(join(h.dataDir, IMPORT_STORE_FILENAME), { force: true });
    const before = h.ledger.writes;
    const t = await call('import_transactions', { transactions: [expense('e8:a', 33), expense('e8:b', 44)], run_id: 'e8' });
    expect(rowStatus(t, 'e8:a')).toBe('unchanged');
    expect(rowStatus(t, 'e8:b')).toBe('unchanged');
    expect(h.ledger.writes).toBe(before);
    expect(h.ledger.stamped('e8:a')).toHaveLength(1);
    const s = await call('import_status', { source_ids: ['e8:a', 'e8:b'] });
    expect(s).toMatch(/indexed/);
  });

  it('rebuild_import_index reports a source_id stamped on two QBO transactions', async () => {
    h.ledger.seed('Purchase', [
      { Id: '9001', TxnDate: '2026-08-20', PaymentType: 'Cash', AccountRef: { value: '1' }, TotalAmt: 1, PrivateNote: 'copy one [src:e9:dup]', Line: [] },
      { Id: '9002', TxnDate: '2026-08-21', PaymentType: 'Cash', AccountRef: { value: '1' }, TotalAmt: 1, PrivateNote: 'copy two [src:e9:dup]', Line: [] },
    ]);
    const t = await call('rebuild_import_index', { start_date: '2026-08-20', end_date: '2026-08-21', run_id: 'e9', dry_run: true });
    expect(t).toMatch(/duplicates 1/);
    expect(t).toMatch(/e9:dup: Purchase 9001.*Purchase 9002/);
  });

  it('delete refuses a transaction whose stamp was edited away unless force=true; already-gone rows are "not found"', async () => {
    await call('import_transactions', { transactions: [expense('e10:a'), expense('e10:b'), expense('e10:c')], run_id: 'e10' });
    h.ledger.stamped('e10:a')[0].rec.PrivateNote = 'someone edited this in QBO';
    const c = h.ledger.stamped('e10:c')[0];
    h.ledger.store.Purchase.delete(c.rec.Id);
    let t = await call('delete_imported_transactions', { run_id: 'e10' });
    expect(rowStatus(t, 'e10:a')).toBe('refused');
    expect(rowStatus(t, 'e10:b')).toBe('deleted');
    expect(rowStatus(t, 'e10:c')).toBe('not found');
    expect(t).toMatch(/force/);
    t = await call('delete_imported_transactions', { run_id: 'e10', force: true });
    expect(rowStatus(t, 'e10:a')).toBe('deleted');
    const s = await call('import_status', { run_id: 'e10', status: 'live' });
    expect(s).toMatch(/Matched: 0/);
  });

  it('delete by source_ids, and refuses to run with neither run_id nor source_ids', async () => {
    await call('import_transactions', { transactions: [expense('e11:a'), expense('e11:b')], run_id: 'e11' });
    const t = await call('delete_imported_transactions', { source_ids: ['e11:b'] });
    expect(rowStatus(t, 'e11:b')).toBe('deleted');
    expect(h.ledger.stamped('e11:a')).toHaveLength(1);
    expect(await call('delete_imported_transactions', {})).toMatch(/refusing to guess/);
  });

  it('import_status summarizes counts and sums by type and lists missing source_ids', async () => {
    await call('import_transactions', { transactions: [invoice('e12:inv'), { source_id: 'e12:pmt', txn_type: 'Payment', txn_date: '2026-08-07', entity: C, linked: [{ source_id: 'e12:inv', amount: 150 }] }, expense('e12:x', 7.5)], run_id: 'e12' });
    const t = await call('import_status', { run_id: 'e12', source_ids: ['e12:inv', 'e12:pmt', 'e12:missing'] });
    expect(t).toMatch(/Invoice\s+created\s+1\s+150\.00/);
    expect(t).toMatch(/Payment\s+created\s+1\s+150\.00/);
    expect(t).toMatch(/Not in the store \(1\): e12:missing/);
    const all = await call('import_status', { run_id: 'e12' });
    expect(all).toMatch(/Matched: 3/);
    expect(all).toMatch(/Expense\s+created\s+1\s+7\.50/);
  });

  it('two overlapping calls with the same rows still create each source_id once', async () => {
    const rows = [expense('e13:a', 1), expense('e13:b', 2), expense('e13:c', 3)];
    const [a, b] = await Promise.all([
      call('import_transactions', { transactions: rows, run_id: 'e13' }),
      call('import_transactions', { transactions: rows, run_id: 'e13' }),
    ]);
    for (const sid of ['e13:a', 'e13:b', 'e13:c']) {
      expect(h.ledger.stamped(sid)).toHaveLength(1);
      expect([rowStatus(a, sid), rowStatus(b, sid)].sort()).toEqual(['created', 'unchanged']);
    }
  });

  it('unknown client and schema errors come back as messages', async () => {
    expect(await h.call('import_status', { client_name: 'No Such Co' })).toMatch(/Client not found/);
    const res: any = await h.mcp.callTool({ name: 'import_transactions', arguments: { client_name: IMPORT_CLIENT, transactions: [{ source_id: 'x', txn_type: 'Nope', txn_date: '2026-01-01' }] } });
    expect(res.isError).toBe(true);
  });

  it('cross-type names in import rows, and a names re-run with on_existing="update"', async () => {
    let t = await call('batch_create_names', { names: [{ display_name: 'Edge Vendor', name_type: 'Vendor', email: 'a@example.com' }] });
    expect(rowStatus(t, 'Edge Vendor')).toBe('created');
    t = await call('batch_create_names', { names: [{ display_name: 'Edge Vendor', name_type: 'Vendor', email: 'b@example.com' }] });
    expect(rowStatus(t, 'Edge Vendor')).toBe('unchanged');
    expect(t).toMatch(/email/i);
    t = await call('batch_create_names', { names: [{ display_name: 'Edge Vendor', name_type: 'Vendor', email: 'b@example.com' }], on_existing: 'update' });
    expect(rowStatus(t, 'Edge Vendor')).toBe('updated');
    expect(h.ledger.all('Vendor').find((v) => v.DisplayName === 'Edge Vendor').PrimaryEmailAddr.Address).toBe('b@example.com');
    t = await call('batch_create_names', { names: [{ display_name: 'Edge Vendor', name_type: 'Employee', given_name: 'E' }], dry_run: true });
    expect(rowStatus(t, 'Edge Vendor')).toBe('failed');
  });

  it('ensure_items refuses an A/R account and names a custom pattern', async () => {
    const t = await call('ensure_items', { items: [{ account_number: '1200' }, { account_number: '4000' }], name_pattern: 'Hist {account_number}' });
    expect(t).toMatch(/failed 1\b/);
    expect(t).toMatch(/Row 1 .*FAILED: .*A\/R or A\/P \(QBO code 6430\)/);
    expect(rowStatus(t, 'Hist 4000')).toBe('created');
  });
});
