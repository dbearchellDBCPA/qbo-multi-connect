// ─── MCP registration: bulk Expense/Deposit create + reference lookup ───────
//
//   bulk_create_expenses           ≤200 Expenses (Purchase) per call, idempotent per row
//   bulk_create_deposits           ≤200 direct Deposits per call, idempotent per row
//   get_transactions_by_reference  find txns by DocNumber (server-side) and/or
//                                  PrivateNote text / idempotency key (client-side)
//
// Idempotency: each row's key is stamped into PrivateNote as "[ik:KEY]".
// QBO's query language cannot filter on PrivateNote (it is not a filterable
// property), so lookups query by TxnDate (filterable) and match the stamp in
// the results. DocNumber is left free for real check/ref numbers.

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ScopedQBOManager } from './auth.js';
import { buildExpenseLines } from './update-payloads.js';
import { buildDepositTxnLines } from './line-converters.js';
import { DOC_NUMBER_MAX_LENGTH } from './doc-number.js';

type Text = { content: { type: 'text'; text: string }[] };
const text = (t: string): Text => ({ content: [{ type: 'text', text: t }] });
const notFound = (c: string) => text(`Client not found: "${c}". Use list_clients to see available companies.`);
const round2 = (n: number) => Math.round(n * 100) / 100;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

export const BULK_CREATE_MAX_ROWS = 200;
export const REF_SEARCH_MAX_SCAN = 10_000;
const PAGE = 1000;

export const idempotencyStamp = (key: string) => `[ik:${key}]`;
const STAMP_RE = /\[ik:([A-Za-z0-9._:-]{1,40})\]/g;
export function stampsIn(note: unknown): string[] {
  return typeof note === 'string' ? [...note.matchAll(STAMP_RE)].map((m) => m[1]) : [];
}

const keySchema = z.string().regex(/^[A-Za-z0-9._:-]{1,40}$/)
  .describe('Unique idempotency key for this row (1-40 chars: letters, digits, . _ : -). Stamped into PrivateNote as "[ik:KEY]"; a rerun skips any row whose key already exists on a transaction of the same type and date.');

export type VendorResolver = (q: ScopedQBOManager, realmId: string, name: string) => Promise<{ id: string; name: string } | { error: string }>;

/** Page through `SELECT * FROM <entity> WHERE …`, stopping at maxScan rows. */
async function scan(q: ScopedQBOManager, realmId: string, entity: string, where: string, maxScan: number): Promise<{ rows: any[]; truncated: boolean }> {
  const rows: any[] = [];
  for (let start = 1; rows.length < maxScan; start += PAGE) {
    const sql = `SELECT * FROM ${entity}${where ? ` WHERE ${where}` : ''} ORDERBY TxnDate DESC STARTPOSITION ${start} MAXRESULTS ${PAGE}`;
    const page: any[] = ((await q.transactions.rawQuery(realmId, sql)) as any)?.QueryResponse?.[entity] ?? [];
    rows.push(...page);
    if (page.length < PAGE) return { rows, truncated: false };
  }
  return { rows: rows.slice(0, maxScan), truncated: true };
}

/** key → existing txn id, for one entity on one date (cached per call). */
function keyIndex(q: ScopedQBOManager, realmId: string, entity: 'Purchase' | 'Deposit') {
  const cache = new Map<string, Promise<Map<string, string>>>();
  return (date: string) => {
    if (!cache.has(date)) {
      cache.set(date, scan(q, realmId, entity, `TxnDate = '${date}'`, 50_000).then(({ rows }) => {
        const m = new Map<string, string>();
        for (const r of rows) for (const k of stampsIn(r.PrivateNote)) m.set(k, String(r.Id));
        return m;
      }));
    }
    return cache.get(date)!;
  };
}

const noteWithStamp = (note: string | undefined, key: string) => `${note ? `${note} ` : ''}${idempotencyStamp(key)}`;

const commonRow = {
  idempotency_key: keySchema,
  txn_date: z.string().regex(DATE_RE).describe('Transaction date YYYY-MM-DD'),
  vendor_id: z.string().optional().describe('Vendor ID (payee / received-from). Preferred over vendor_name.'),
  vendor_name: z.string().optional().describe('Vendor name, resolved by EXACT DisplayName; the row fails if there is no unique match.'),
  doc_number: z.string().max(DOC_NUMBER_MAX_LENGTH).optional().describe(`Ref no. / check number (QBO DocNumber, max ${DOC_NUMBER_MAX_LENGTH})`),
  private_note: z.string().max(3900).optional().describe('Memo (the idempotency stamp is appended)'),
  department_id: z.string().optional().describe('Header DepartmentRef (Location)'),
  amount: z.number().positive().optional().describe('Single-line shorthand: line amount (use with the category account) — or pass lines'),
  class_id: z.string().optional().describe('Single-line shorthand: ClassRef for the line (also the default for lines without class_id)'),
  description: z.string().optional().describe('Single-line shorthand: line description'),
};

function summarize(title: string, dry: boolean, results: any[]) {
  const n = (s: string) => results.filter((r) => r.status === s).length;
  return `${title}${dry ? ' (DRY RUN — nothing written)' : ''}\n${dry ? `would_create: ${n('would_create')}` : `created: ${n('created')}`} | skipped: ${n('skipped')} | failed: ${n('failed')}\n${JSON.stringify(results, null, 2)}`;
}

export function registerBulkTxnTools(
  server: McpServer,
  qboManager: ScopedQBOManager,
  findRealmId: (clientName: string) => Promise<string | null>,
  resolveVendor: VendorResolver,
): void {
  const tool = (server as any).tool.bind(server);

  async function runBulk(kind: 'Expense' | 'Deposit', client_name: string, rows: any[], dry_run: boolean, build: (row: any, vendor: { id: string; name?: string } | null) => any) {
    const realmId = await findRealmId(client_name);
    if (!realmId) return notFound(client_name);
    const entity = kind === 'Expense' ? 'Purchase' : 'Deposit';
    const existing = keyIndex(qboManager, realmId, entity);
    const vendorCache = new Map<string, Promise<{ id: string; name: string } | { error: string }>>();
    const seen = new Set<string>();
    const results: any[] = [];
    for (const [index, row] of rows.entries()) {
      const base = { index, idempotency_key: row.idempotency_key };
      try {
        if (seen.has(row.idempotency_key)) { results.push({ ...base, status: 'skipped', reason: 'duplicate idempotency_key earlier in this batch' }); continue; }
        seen.add(row.idempotency_key);
        const hit = (await existing(row.txn_date)).get(row.idempotency_key);
        if (hit) { results.push({ ...base, status: 'skipped', id: hit, reason: `already posted (${kind} ${hit})` }); continue; }
        let vendor: { id: string; name?: string } | null = row.vendor_id ? { id: row.vendor_id, name: row.vendor_name } : null;
        if (!vendor && row.vendor_name) {
          if (!vendorCache.has(row.vendor_name)) vendorCache.set(row.vendor_name, resolveVendor(qboManager, realmId, row.vendor_name));
          const v = await vendorCache.get(row.vendor_name)!;
          if ('error' in v) { results.push({ ...base, status: 'failed', error: v.error }); continue; }
          vendor = v;
        }
        const built = build(row, vendor);
        if (typeof built === 'string') { results.push({ ...base, status: 'failed', error: built }); continue; }
        const total = round2(built.Line.reduce((s: number, l: any) => s + Number(l.Amount), 0));
        if (dry_run) { results.push({ ...base, status: 'would_create', txn_date: row.txn_date, total, payload: built }); continue; }
        const res: any = kind === 'Expense'
          ? await qboManager.transactions.createExpense(realmId, built)
          : await qboManager.banking.createDeposit(realmId, built);
        const saved = res?.[entity];
        if (!saved?.Id) { results.push({ ...base, status: 'failed', error: 'QBO returned no transaction' }); continue; }
        (await existing(row.txn_date)).set(row.idempotency_key, String(saved.Id));
        const r: any = { ...base, status: 'created', id: String(saved.Id), txn_date: saved.TxnDate, total: saved.TotalAmt };
        if (round2(Number(saved.TotalAmt)) !== total) r.warning = `QBO saved total ${saved.TotalAmt}, row lines sum to ${total} — check it`;
        results.push(r);
      } catch (err: any) {
        results.push({ ...base, status: 'failed', error: err?.message ?? String(err) });
      }
    }
    return text(summarize(`BULK CREATE ${kind.toUpperCase()}S — ${client_name}`, dry_run, results));
  }

  const lineCountError = (row: any, acctField: string) => {
    const short = row.amount !== undefined || row[acctField] !== undefined;
    if (row.lines?.length && short) return `Pass either lines or the single-line shorthand (amount + ${acctField}), not both.`;
    if (!row.lines?.length && (row.amount === undefined || !row[acctField])) return `Row needs lines, or amount + ${acctField}.`;
    return null;
  };

  tool(
    'bulk_create_expenses',
    `Create up to ${BULK_CREATE_MAX_ROWS} Expenses (QBO Purchase: Cash/Check/CreditCard) in one call — for posting large batches, not import_transactions. Every row carries an idempotency_key stamped into PrivateNote as "[ik:KEY]"; before posting, the tool looks for that key on existing Expenses of the same txn_date and SKIPS the row if found, so a rerun after a timeout or partial failure never double-posts. Rows run sequentially with continue-on-error: each row returns status created (with id) / skipped (with existing id) / failed (with QBO's error) / would_create (dry_run). Per row: bank/credit-card account, payee (vendor_id or exact vendor_name), class per line, department, doc_number. Single-line rows can use the shorthand amount + expense_account_id + class_id.`,
    {
      client_name: z.string().describe('The name of the client company'),
      rows: z.array(z.object({
        ...commonRow,
        account_id: z.string().describe('Bank or credit-card account the expense is paid from'),
        payment_type: z.enum(['Cash', 'Check', 'CreditCard']).optional().describe('Default Cash'),
        expense_account_id: z.string().optional().describe('Single-line shorthand: expense/category account ID'),
        lines: z.array(z.object({
          amount: z.number().positive(),
          expense_account_id: z.string().describe('Expense/category account ID'),
          class_id: z.string().optional(),
          description: z.string().optional(),
        })).max(50).optional().describe('Split lines (account-based)'),
      })).min(1).max(BULK_CREATE_MAX_ROWS),
      dry_run: z.boolean().optional().describe('Validate, resolve vendors and check keys, but write nothing. Default false.'),
    },
    async ({ client_name, rows, dry_run = false }: any) => runBulk('Expense', client_name, rows, dry_run, (row, vendor) => {
      const err = lineCountError(row, 'expense_account_id');
      if (err) return err;
      const lines = row.lines?.length ? row.lines : [{ amount: row.amount, expense_account_id: row.expense_account_id, description: row.description }];
      const p: any = {
        PaymentType: row.payment_type ?? 'Cash',
        AccountRef: { value: row.account_id },
        TxnDate: row.txn_date,
        Line: buildExpenseLines(lines.map((l: any) => ({ ...l, class_id: l.class_id ?? row.class_id, detail_type: 'AccountBasedExpenseLineDetail' }))),
        PrivateNote: noteWithStamp(row.private_note, row.idempotency_key),
      };
      if (vendor) p.EntityRef = { value: vendor.id, name: vendor.name, type: 'Vendor' };
      if (row.doc_number) p.DocNumber = row.doc_number;
      if (row.department_id) p.DepartmentRef = { value: row.department_id };
      return p;
    }),
  );

  tool(
    'bulk_create_deposits',
    `Create up to ${BULK_CREATE_MAX_ROWS} direct bank Deposits in one call (no Undeposited Funds linking). Same idempotency and per-row semantics as bulk_create_expenses: idempotency_key stamped into PrivateNote as "[ik:KEY]", existing keys on Deposits of the same txn_date are skipped, continue-on-error, statuses created / skipped / failed / would_create. The row's vendor (vendor_id or exact vendor_name) or customer_id becomes the "Received From" entity on every line; class_id and payment_method_id per line. Single-line rows can use the shorthand amount + account_id + class_id.`,
    {
      client_name: z.string().describe('The name of the client company'),
      rows: z.array(z.object({
        ...commonRow,
        deposit_account_id: z.string().describe('Bank account the deposit goes into'),
        customer_id: z.string().optional().describe('Received-from customer (instead of a vendor)'),
        account_id: z.string().optional().describe('Single-line shorthand: income/offset account ID'),
        payment_method_id: z.string().optional().describe('PaymentMethodRef for every line'),
        lines: z.array(z.object({
          amount: z.number().positive(),
          account_id: z.string().describe('Income/offset account ID'),
          class_id: z.string().optional(),
          description: z.string().optional(),
          payment_method_id: z.string().optional(),
        })).max(50).optional().describe('Split lines'),
      })).min(1).max(BULK_CREATE_MAX_ROWS),
      dry_run: z.boolean().optional().describe('Validate, resolve vendors and check keys, but write nothing. Default false.'),
    },
    async ({ client_name, rows, dry_run = false }: any) => runBulk('Deposit', client_name, rows, dry_run, (row, vendor) => {
      const err = lineCountError(row, 'account_id');
      if (err) return err;
      if (vendor && row.customer_id) return 'Pass a vendor or customer_id as received-from, not both.';
      const lines = row.lines?.length ? row.lines : [{ amount: row.amount, account_id: row.account_id, description: row.description }];
      const entity = vendor ? { entity_id: vendor.id, entity_type: 'Vendor' as const } : row.customer_id ? { entity_id: row.customer_id, entity_type: 'Customer' as const } : {};
      const p: any = {
        DepositToAccountRef: { value: row.deposit_account_id },
        TxnDate: row.txn_date,
        Line: buildDepositTxnLines([], lines.map((l: any) => ({
          ...l, ...entity, class_id: l.class_id ?? row.class_id, payment_method_id: l.payment_method_id ?? row.payment_method_id,
        }))),
        PrivateNote: noteWithStamp(row.private_note, row.idempotency_key),
      };
      if (row.doc_number) p.DocNumber = row.doc_number;
      if (row.department_id) p.DepartmentRef = { value: row.department_id };
      return p;
    }),
  );

  const ENTITIES = ['Purchase', 'Deposit', 'Transfer', 'Bill', 'Invoice', 'JournalEntry', 'SalesReceipt', 'Payment', 'BillPayment', 'CreditMemo', 'VendorCredit', 'RefundReceipt'] as const;
  tool(
    'get_transactions_by_reference',
    `Find transactions by Ref no. (DocNumber) and/or memo (PrivateNote) — e.g. to check which bulk rows already posted. doc_number is an exact, server-side QBO filter (not available on Transfer, which has no DocNumber). private_note_contains (case-insensitive substring) and idempotency_key (matches the "[ik:KEY]" stamp written by bulk_create_*) are applied after fetching, because QBO cannot filter on PrivateNote — so narrow with start_date/end_date; at most ${REF_SEARCH_MAX_SCAN} rows are scanned and the result says if the scan was truncated. Purchase = Expense/Check/CC charge. Returns compact rows (id, type, date, doc_number, amount, account, payee, private_note). For anything else use query_transactions.`,
    {
      client_name: z.string().describe('The name of the client company'),
      entity: z.enum(ENTITIES).describe('QBO entity to search'),
      doc_number: z.string().max(DOC_NUMBER_MAX_LENGTH).optional().describe('Exact DocNumber / Ref no.'),
      private_note_contains: z.string().min(1).optional().describe('Case-insensitive substring of PrivateNote (memo)'),
      idempotency_key: z.string().regex(/^[A-Za-z0-9._:-]{1,40}$/).optional().describe('Key stamped by bulk_create_* ("[ik:KEY]")'),
      start_date: z.string().regex(DATE_RE).optional().describe('TxnDate >= (YYYY-MM-DD)'),
      end_date: z.string().regex(DATE_RE).optional().describe('TxnDate <= (YYYY-MM-DD)'),
      max_results: z.number().int().min(1).max(1000).optional().describe('Max matches returned. Default 200.'),
    },
    async ({ client_name, entity, doc_number, private_note_contains, idempotency_key, start_date, end_date, max_results = 200 }: any) => {
      if (!doc_number && !private_note_contains && !idempotency_key) return text('Pass at least one of doc_number, private_note_contains, idempotency_key.');
      if (doc_number && entity === 'Transfer') return text('Transfer has no DocNumber in QBO; search Transfers by private_note_contains instead.');
      const realmId = await findRealmId(client_name);
      if (!realmId) return notFound(client_name);
      try {
        const where: string[] = [];
        if (doc_number) where.push(`DocNumber = '${esc(doc_number)}'`);
        if (start_date) where.push(`TxnDate >= '${start_date}'`);
        if (end_date) where.push(`TxnDate <= '${end_date}'`);
        const { rows, truncated } = await scan(qboManager, realmId, entity, where.join(' AND '), REF_SEARCH_MAX_SCAN);
        const needle = private_note_contains?.toLowerCase();
        const matches = rows.filter((r) =>
          (!needle || String(r.PrivateNote ?? '').toLowerCase().includes(needle)) &&
          (!idempotency_key || stampsIn(r.PrivateNote).includes(idempotency_key)));
        const out = matches.slice(0, max_results).map((r) => ({
          id: String(r.Id), type: entity === 'Purchase' ? `Expense (${r.PaymentType})` : entity, txn_date: r.TxnDate, doc_number: r.DocNumber,
          amount: r.TotalAmt ?? r.Amount,
          account: (r.AccountRef ?? r.DepositToAccountRef ?? r.FromAccountRef)?.name ?? (r.AccountRef ?? r.DepositToAccountRef ?? r.FromAccountRef)?.value,
          to_account: r.ToAccountRef?.name ?? r.ToAccountRef?.value,
          payee: (r.EntityRef ?? r.VendorRef ?? r.CustomerRef)?.name,
          private_note: r.PrivateNote,
        }));
        return text(JSON.stringify({ scanned: rows.length, scan_truncated: truncated, matched: matches.length, returned: out.length, results: out }, null, 2));
      } catch (err: any) {
        return text(`Error searching ${entity}: ${err?.message ?? err}`);
      }
    },
  );
}
