// ─── Bulk-import acceptance scenario (spec "Testing", steps 1–8) ─────────────
//
// The same script runs against FakeQboLedger in vitest
// (tests/server/mcp-bulk-import.e2e.test.ts) and against a DEPLOYED sandbox
// server over MCP (scripts/sandbox-import.ts):
//   1. batch_create_names: new, existing, cross-type conflict; re-run
//   2. ensure_items for two income accounts; re-run
//   3. import_transactions dry run then live with every txn_type, plus the
//      BillPayment-before-its-Bill "blocked" case
//   4. re-run unchanged (no writes); on_existing="update" after a memo change
//   5. bad rows fail with clear messages while the rest loads
//   6. rebuild_import_index after the store is lost (or verify-only remotely)
//   7. delete_imported_transactions per run, import_status shows deleted
//   8. a 400-transaction batch (throttling / backoff, complete logs)
// Every name it creates carries the prefix; every source_id starts with it.

export type ToolCaller = (name: string, args: Record<string, unknown>) => Promise<string>;

export interface AccountRef { account_number?: string; account_name?: string }

export interface ImportScenarioAccounts {
  bank: AccountRef;
  savings: AccountRef;
  card: AccountRef;
  ar: AccountRef;
  undeposited: AccountRef;
  income1: AccountRef;
  income2: AccountRef;
  expense1: AccountRef;
  expense2: AccountRef;
  /** A sub-account given by "Parent:Child" name. */
  subExpense: AccountRef;
}

/** Accounts of the fake company (tests/support/fake-qbo-ledger.ts seedImportCompany). */
export const FAKE_COMPANY_ACCOUNTS: ImportScenarioAccounts = {
  bank: { account_number: '1000' },
  savings: { account_number: '1010' },
  card: { account_number: '2100' },
  ar: { account_number: '1200' },
  undeposited: { account_number: '1499' },
  income1: { account_number: '4000' },
  income2: { account_number: '4100' },
  expense1: { account_number: '6000' },
  expense2: { account_number: '6100' },
  subExpense: { account_name: 'Travel:Meals' },
};

export interface ImportScenarioOptions {
  client: string;
  prefix: string;
  accounts: ImportScenarioAccounts;
  /** Existing names in the company: one vendor and one customer (step 1 "existing"). */
  existingVendor: string;
  existingCustomer: string;
  /** Existing class name (JE lines). */
  className: string;
  /** Month the scenario dates its transactions in, YYYY-MM (must be after the closing date). */
  month: string;
  /** A date on or before the company's closing date (step 5); omit to skip that row. */
  closedDate?: string;
  bulkCount?: number;
  log: (line: string) => void;
  /** Delete the server's import store file (local runs only). Omitted → step 6 runs verify-only. */
  deleteStore?: () => void;
  /** Called before the 400-row load (tests inject throttling here). */
  beforeBulk?: () => void;
  /** Called after each tool call with its name, args and reply (tests collect extra assertions). */
  onCall?: (name: string, args: Record<string, unknown>, text: string) => void;
}

export interface ImportScenarioResult {
  passed: string[];
  failed: { step: string; detail: string }[];
  skipped: { step: string; reason: string }[];
  replies: Record<string, string>;
}

export function counts(text: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const m of text.matchAll(/\b(would create|would update|would delete|not found|created|updated|unchanged|skipped|blocked|failed|deleted|refused) (\d+)\b/g)) {
    const k = m[1].replace(' ', '_');
    if (out[k] === undefined) out[k] = Number(m[2]);
  }
  return out;
}

const STATUS_RE = /\b(would create|would update|would delete|not found|created|updated|unchanged|skipped|blocked|failed|deleted|refused)\b/;
export function statusOf(text: string, key: string): string | undefined {
  for (const line of text.split('\n')) {
    const at = line.indexOf(`  ${key}  `);
    if (at < 0) continue;
    const m = line.slice(at + key.length + 2).match(STATUS_RE);
    if (m) return m[1];
  }
  return undefined;
}

export function scenarioTransactions(o: Pick<ImportScenarioOptions, 'prefix' | 'accounts' | 'className' | 'month' | 'existingVendor' | 'existingCustomer'>) {
  const P = o.prefix;
  const A = o.accounts;
  const d = (day: number) => `${o.month}-${String(day).padStart(2, '0')}`;
  const V = { name: `${P} Vendor A`, type: 'Vendor' };
  const V2 = { name: o.existingVendor, type: 'Vendor' };
  const C = { name: `${P} Customer A`, type: 'Customer' };
  const E = { name: `${P} Employee A`, type: 'Employee' };
  const sid = (s: string) => `${P}:${s}`;
  const txns: any[] = [
    {
      source_id: sid('je1'), txn_type: 'JournalEntry', txn_date: d(1), doc_number: `${P}-JE1`, memo: 'Accrual with names and class',
      lines: [
        { ...A.expense1, amount: 100, posting_type: 'Debit', entity: V, class: o.className, description: 'vendor line' },
        { ...A.expense2, amount: 50, posting_type: 'Debit', entity: E, class: o.className, description: 'employee line' },
        { ...A.income1, amount: 75, posting_type: 'Credit', entity: C, class: o.className, description: 'customer line' },
        { ...A.bank, amount: 75, posting_type: 'Credit' },
      ],
    },
    { source_id: sid('exp1'), txn_type: 'Expense', txn_date: d(2), payment_method: 'Cash', ...A.bank, entity: V, memo: 'Cash expense', lines: [{ ...A.expense1, amount: 25.1, description: 'pens' }] },
    { source_id: sid('chk1'), txn_type: 'Check', txn_date: d(3), check_number: '5001', ...A.bank, entity: V2, memo: 'Rent check', lines: [{ ...A.expense2, amount: 300 }] },
    { source_id: sid('cc1'), txn_type: 'CreditCardCharge', txn_date: d(4), ...A.card, entity: V, memo: 'Team lunch', lines: [{ ...A.subExpense, amount: 42 }] },
    { source_id: sid('ccc1'), txn_type: 'CreditCardCredit', txn_date: d(5), ...A.card, entity: V, memo: 'Returned supplies', lines: [{ ...A.expense1, amount: 10 }] },
    {
      source_id: sid('dep1'), txn_type: 'Deposit', txn_date: d(6), ...A.bank, memo: 'Two received-from lines',
      lines: [{ ...A.income1, amount: 400, entity: C }, { ...A.income2, amount: 100, entity: { name: o.existingCustomer, type: 'Customer' } }],
    },
    { source_id: sid('xfer1'), txn_type: 'Transfer', txn_date: d(7), ...A.bank, transfer_to_account_number: A.savings.account_number, transfer_to_account_name: A.savings.account_name, amount: 1000, memo: 'To savings' },
    { source_id: sid('bill1'), txn_type: 'Bill', txn_date: d(8), doc_number: `${P}-B100`, entity: V, due_date: d(28), memo: 'Supplies bill', lines: [{ ...A.expense1, amount: 200 }, { ...A.expense2, amount: 300 }] },
    { source_id: sid('vc1'), txn_type: 'VendorCredit', txn_date: d(9), entity: V, memo: 'Credit for damaged goods', lines: [{ ...A.expense1, amount: 20 }] },
    { source_id: sid('inv1'), txn_type: 'Invoice', txn_date: d(10), doc_number: `${P}-INV1`, entity: C, due_date: d(30), memo: 'Consulting', lines: [{ ...A.income1, amount: 750, description: 'Hours' }, { ...A.income2, amount: 250, quantity: 5 }] },
    { source_id: sid('cm1'), txn_type: 'CreditMemo', txn_date: d(11), doc_number: `${P}-CM1`, entity: C, memo: 'Goodwill credit', lines: [{ ...A.income1, amount: 40 }] },
    { source_id: sid('sr1'), txn_type: 'SalesReceipt', txn_date: d(12), doc_number: `${P}-SR1`, entity: C, ...A.bank, memo: 'Counter sale', lines: [{ ...A.income2, amount: 120 }] },
    { source_id: sid('rr1'), txn_type: 'RefundReceipt', txn_date: d(13), doc_number: `${P}-RR1`, entity: C, ...A.bank, memo: 'Refund', lines: [{ ...A.income2, amount: 30 }] },
    // Payments last in the file, but they would load after their targets in any order.
    { source_id: sid('bp1'), txn_type: 'BillPayment', txn_date: d(14), entity: V, ...A.bank, payment_method: 'Check', check_number: '5002', memo: 'Pay bill 100', linked: [{ source_id: sid('bill1'), amount: 500 }] },
    { source_id: sid('pmt1'), txn_type: 'Payment', txn_date: d(15), entity: C, ...A.undeposited, check_number: '881', memo: 'Partial payment', linked: [{ source_id: sid('inv1'), amount: 600 }] },
  ];
  const later = {
    bill2: { source_id: sid('bill2'), txn_type: 'Bill', txn_date: d(16), doc_number: `${P}-B200`, entity: V, memo: 'Second bill', lines: [{ ...A.expense1, amount: 80 }] },
    bp2: { source_id: sid('bp2'), txn_type: 'BillPayment', txn_date: d(17), entity: V, ...A.bank, check_number: '5003', memo: 'Pays bill 200', linked: [{ source_id: sid('bill2'), amount: 80 }] },
  };
  return { txns, later, sid };
}

export async function runBulkImportScenario(call: ToolCaller, o: ImportScenarioOptions): Promise<ImportScenarioResult> {
  const { client, prefix: P, log } = o;
  const result: ImportScenarioResult = { passed: [], failed: [], skipped: [], replies: {} };
  const check = (step: string, ok: boolean, detail: string) => {
    if (ok) result.passed.push(step);
    else result.failed.push({ step, detail });
    log(`${ok ? 'PASS' : 'FAIL'}  ${step}${ok ? '' : `\n      ${detail.split('\n').join('\n      ')}`}`);
  };
  const tool = async (name: string, args: Record<string, unknown>, label?: string) => {
    const full = { client_name: client, ...args };
    const text = await call(name, full);
    const shown = { ...args } as any;
    if (Array.isArray(shown.transactions)) shown.transactions = `[${shown.transactions.length} rows]`;
    if (Array.isArray(shown.names)) shown.names = `[${shown.names.length} rows]`;
    log(`\n▶ ${name} ${JSON.stringify(shown)}\n${text.split('\n').map((l) => `  ${l}`).join('\n')}\n`);
    if (label) result.replies[label] = text;
    o.onCall?.(name, full, text);
    return text;
  };
  const { txns, later, sid } = scenarioTransactions(o);
  const runMain = `${P}-main`;
  const A = o.accounts;

  // ── 1. names ──────────────────────────────────────────────────────────────
  const names = [
    { display_name: `${P} Vendor A`, name_type: 'Vendor', company_name: `${P} Vendor A LLC`, email: 'ap@example.com', vendor_1099: true, source_id: `${P}:vendor-a` },
    { display_name: `${P} Customer A`, name_type: 'Customer', email: 'ar@example.com', billing_address: { street: '1 Main St', city: 'Albany', state: 'NY', postal_code: '12207' }, source_id: `${P}:cust-a` },
    { display_name: `${P} Employee A`, name_type: 'Employee', given_name: 'Emma', family_name: 'Ployee' },
    { display_name: o.existingVendor, name_type: 'Vendor' },
    { display_name: o.existingCustomer, name_type: 'Vendor' }, // cross-type conflict
  ];
  let t = await tool('batch_create_names', { names }, 'names1');
  check('1a names: three new names created', statusOf(t, `${P} Vendor A`) === 'created' && statusOf(t, `${P} Customer A`) === 'created' && statusOf(t, `${P} Employee A`) === 'created', t);
  check('1b names: existing vendor reported unchanged', statusOf(t, o.existingVendor) === 'unchanged', t);
  check('1c names: customer name sent as a vendor fails and names the type holding it', statusOf(t, o.existingCustomer) === 'failed' && /customer/i.test(t.split('\n').filter((l) => l.includes(o.existingCustomer)).join(' ')), t);
  t = await tool('batch_create_names', { names: names.slice(0, 4) }, 'names2');
  check('1d names: re-run is all unchanged', counts(t).unchanged === 4 && (counts(t).created ?? 0) === 0, t);

  // ── 2. items ──────────────────────────────────────────────────────────────
  const items = [{ ...A.income1 }, { ...A.income2 }];
  t = await tool('ensure_items', { items }, 'items1');
  check('2a ensure_items: two items created', counts(t).created === 2, t);
  t = await tool('ensure_items', { items }, 'items2');
  check('2b ensure_items: re-run unchanged', counts(t).unchanged === 2 && (counts(t).created ?? 0) === 0, t);

  // ── 3. every txn_type, dry then live; blocked BillPayment ────────────────
  t = await tool('import_transactions', { transactions: [later.bp2], run_id: `${P}-blocked` }, 'blocked');
  check('3a BillPayment sent before its Bill is blocked (not failed)', statusOf(t, later.bp2.source_id) === 'blocked' && /not (been )?imported|not imported yet|load the/i.test(t), t);

  t = await tool('import_transactions', { transactions: txns, run_id: runMain, dry_run: true }, 'dry');
  check('3b dry run: every row "would create", nothing failed', counts(t).would_create === txns.length && (counts(t).failed ?? 0) === 0 && (counts(t).blocked ?? 0) === 0, t);
  t = await tool('import_status', { run_id: runMain }, 'status-after-dry');
  check('3c dry run wrote nothing to the store', /Matched: 0/.test(t), t);

  t = await tool('import_transactions', { transactions: txns, run_id: runMain }, 'live');
  check('3d live: every row created', counts(t).created === txns.length && (counts(t).failed ?? 0) === 0, t);
  const types = new Set(txns.map((x) => x.txn_type));
  check('3e live: one of every txn_type (15)', types.size === 15, [...types].join(', '));

  t = await tool('import_transactions', { transactions: [later.bill2], run_id: `${P}-blocked` }, 'bill2');
  check('3f the missing Bill loads', statusOf(t, later.bill2.source_id) === 'created', t);
  t = await tool('import_transactions', { transactions: [later.bp2], run_id: `${P}-blocked` }, 'bp2');
  check('3g re-sent BillPayment now links and is created', statusOf(t, later.bp2.source_id) === 'created', t);

  // ── 4. idempotency + update ───────────────────────────────────────────────
  t = await tool('import_transactions', { transactions: txns, run_id: runMain }, 'rerun');
  check('4a re-run: all unchanged', counts(t).unchanged === txns.length && (counts(t).created ?? 0) === 0, t);
  check('4b re-run: no batch requests sent', /QBO batch requests: 0\b/.test(t), t);
  const edited = txns.map((x) => (x.source_id === sid('exp1') || x.source_id === sid('inv1') ? { ...x, memo: `${x.memo} (corrected)` } : x));
  t = await tool('import_transactions', { transactions: edited, run_id: runMain }, 'changed-skip');
  check('4c changed memo with default on_existing=skip is reported skipped', statusOf(t, sid('exp1')) === 'skipped' && counts(t).skipped === 2, t);
  t = await tool('import_transactions', { transactions: edited, run_id: runMain, on_existing: 'update' }, 'update');
  check('4d on_existing=update: the two changed rows are updated, the rest unchanged', statusOf(t, sid('exp1')) === 'updated' && statusOf(t, sid('inv1')) === 'updated' && counts(t).unchanged === txns.length - 2, t);
  t = await tool('import_transactions', { transactions: edited, run_id: runMain }, 'after-update');
  check('4e after the update the edited batch is unchanged', counts(t).unchanged === txns.length, t);

  // ── 5. bad rows ───────────────────────────────────────────────────────────
  const d = (day: number) => `${o.month}-${String(day).padStart(2, '0')}`;
  const bad: any[] = [
    { source_id: sid('bad-unbalanced'), txn_type: 'JournalEntry', txn_date: d(20), lines: [{ ...A.expense1, amount: 100, posting_type: 'Debit' }, { ...A.bank, amount: 90, posting_type: 'Credit' }] },
    { source_id: sid('bad-account'), txn_type: 'Expense', txn_date: d(20), ...A.bank, entity: { name: `${P} Vendor A`, type: 'Vendor' }, lines: [{ account_number: '99999-NOPE', amount: 10 }] },
    { source_id: sid('bad-nametype'), txn_type: 'Bill', txn_date: d(20), entity: { name: `${P} Customer A`, type: 'Vendor' }, lines: [{ ...A.expense1, amount: 10 }] },
    { source_id: sid('bad-docnum'), txn_type: 'Invoice', txn_date: d(20), doc_number: 'X'.repeat(25), entity: { name: `${P} Customer A`, type: 'Customer' }, lines: [{ ...A.income1, amount: 10 }] },
    { source_id: sid('good-among-bad'), txn_type: 'Expense', txn_date: d(21), ...A.bank, entity: { name: `${P} Vendor A`, type: 'Vendor' }, memo: 'loads despite neighbours', lines: [{ ...A.expense1, amount: 12.34 }] },
  ];
  if (o.closedDate) bad.push({ source_id: sid('bad-closed'), txn_type: 'Expense', txn_date: o.closedDate, ...A.bank, lines: [{ ...A.expense1, amount: 5 }] });
  t = await tool('import_transactions', { transactions: bad, run_id: `${P}-bad` }, 'bad');
  const lineOf = (s: string) => t.split('\n').filter((l) => l.includes(s) && /FAILED/.test(l)).join(' ');
  check('5a unbalanced JE fails with the difference', /does not balance/i.test(lineOf(sid('bad-unbalanced'))), t);
  check('5b unknown account fails naming it', /99999-NOPE/.test(lineOf(sid('bad-account'))), t);
  check('5c customer used as a vendor fails naming the type it is', /customer/i.test(lineOf(sid('bad-nametype'))), t);
  check('5d 25-character DocNumber fails (21 max)', /21/.test(lineOf(sid('bad-docnum'))), t);
  if (o.closedDate) check('5e date on/before the closing date fails', /clos/i.test(lineOf(sid('bad-closed'))), t);
  else result.skipped.push({ step: '5e closed period', reason: 'company has no closing date configured' });
  check('5f the good row in the same batch is created', statusOf(t, sid('good-among-bad')) === 'created', t);

  // ── 6. rebuild ────────────────────────────────────────────────────────────
  // The main run is dated days 1–15; the blocked/bad runs days 16–21. A
  // rebuild gives every recovered row one run_id, so recover them separately.
  const range = { start_date: d(1), end_date: d(15) };
  let cleanupRuns = [`${P}-blocked`, `${P}-bad`];
  if (o.deleteStore) {
    o.deleteStore();
    t = await tool('import_status', { run_id: runMain }, 'status-after-loss');
    check('6a store file gone: import_status finds nothing', /Matched: 0/.test(t), t);
    t = await tool('rebuild_import_index', { ...range, run_id: runMain }, 'rebuild');
    check(`6b rebuild restores all ${txns.length} stamped transactions of the main run`, new RegExp(`new to store ${txns.length}\\b`).test(t) && /duplicates 0/.test(t), t);
    t = await tool('rebuild_import_index', { start_date: d(16), end_date: d(28), run_id: `${P}-rest` }, 'rebuild-rest');
    check('6c rebuild of the rest restores bill2, bp2 and the good row', /new to store 3\b/.test(t), t);
    cleanupRuns = [`${P}-rest`];
    t = await tool('import_transactions', { transactions: edited, run_id: runMain }, 'after-rebuild');
    check('6d after the rebuild the batch is unchanged again (no duplicates)', counts(t).unchanged === txns.length && (counts(t).created ?? 0) === 0, t);
  } else {
    t = await tool('rebuild_import_index', { ...range, run_id: runMain, dry_run: true }, 'rebuild');
    check('6 rebuild (verify only on a remote server): no duplicates, nothing missing', /duplicates 0/.test(t) && /in store but not in QBO 0/.test(t), t);
    result.skipped.push({ step: '6 delete store file', reason: 'remote server: the store file cannot be deleted from here; ran verify-only' });
  }

  // ── 7. delete by run ──────────────────────────────────────────────────────
  t = await tool('delete_imported_transactions', { run_id: runMain, dry_run: true }, 'delete-dry');
  check('7a delete dry run lists every row as would delete', counts(t).would_delete === txns.length, t);
  const order = t.split('\n').filter((l) => /would delete/.test(l) && l.includes(`${P}:`)).map((l) => (l.match(new RegExp(`${P}:(\\w+)`)) ?? [])[1]);
  const firstNonPayment = order.findIndex((s) => s !== 'bp1' && s !== 'pmt1');
  check('7b payments are deleted before the bills/invoices they pay', order.indexOf('bp1') < firstNonPayment && order.indexOf('pmt1') < firstNonPayment, order.join(', '));
  t = await tool('delete_imported_transactions', { run_id: runMain }, 'delete');
  check('7c delete run: every row deleted', counts(t).deleted === txns.length && (counts(t).failed ?? 0) === 0, t);
  for (const run of cleanupRuns) {
    t = await tool('delete_imported_transactions', { run_id: run });
    check(`7c' cleanup run ${run}: nothing failed or refused`, (counts(t).failed ?? 0) === 0 && (counts(t).refused ?? 0) === 0 && (counts(t).deleted ?? 0) > 0, t);
  }
  t = await tool('import_status', { run_id: runMain, status: 'deleted' }, 'status-deleted');
  check('7d import_status shows every row of the run as deleted', new RegExp(`Matched: ${txns.length}\\b`).test(t) && txns.every((x) => t.includes(x.source_id)), t);
  t = await tool('import_status', { run_id: runMain, status: 'live' }, 'status-live');
  check('7e nothing from the run is live any more', /Matched: 0/.test(t), t);

  // ── 8. bulk ───────────────────────────────────────────────────────────────
  const n = o.bulkCount ?? 400;
  const bulk = Array.from({ length: n }, (_, i) => ({
    source_id: sid(`bulk-${i + 1}`),
    txn_type: i % 2 === 0 ? 'Expense' : 'Deposit',
    txn_date: d(1 + (i % 27)),
    ...A.bank,
    ...(i % 2 === 0 ? { entity: { name: `${P} Vendor A`, type: 'Vendor' } } : {}),
    memo: `bulk row ${i + 1}`,
    lines: [{ ...(i % 2 === 0 ? A.expense1 : A.income1), amount: Math.round((10 + i * 1.37) * 100) / 100 }],
  }));
  o.beforeBulk?.();
  t = await tool('import_transactions', { transactions: bulk, run_id: `${P}-bulk` }, 'bulk');
  check(`8a ${n}-row batch: every row created`, counts(t).created === n && (counts(t).failed ?? 0) === 0, t.split('\n').slice(0, 12).join('\n'));
  check('8b table has one line per row and log paths', bulk.every((b) => statusOf(t, b.source_id) === 'created') && /Full result: \S+\.json/.test(t) && /CSV: \S+\.csv/.test(t), t.slice(0, 2000));
  t = await tool('import_transactions', { transactions: bulk, run_id: `${P}-bulk` }, 'bulk-rerun');
  check(`8c ${n}-row re-run: all unchanged`, counts(t).unchanged === n, t.split('\n').slice(0, 8).join('\n'));
  t = await tool('delete_imported_transactions', { run_id: `${P}-bulk` }, 'bulk-delete');
  check(`8d ${n}-row cleanup: all deleted`, counts(t).deleted === n, t.split('\n').slice(0, 8).join('\n'));
  return result;
}
