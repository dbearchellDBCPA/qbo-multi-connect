// ─── MCP registration: bulk, idempotent transaction-history import tools ────
//
//   batch_create_names            vendors / customers / employees in bulk
//   ensure_items                  one Service item per income account
//   import_transactions           ≤500 normalized transactions per call
//   import_status                 query the mapping store (read-only)
//   rebuild_import_index          recover / verify the store from QBO stamps
//   delete_imported_transactions  roll back a run (or source_ids)
//
// Modelled on batch_create_accounts: same parameter names (client_name,
// dry_run, on_existing), status words, per-row tables and "nothing aborts
// the batch". Registered from registerMcpRoutes, so every deployment (the
// production and the sandbox server share this codebase) gets them; the
// company a call reaches is whatever client_name resolves to on that server.

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ScopedQBOManager } from './auth.js';
import { BatchRunner, type BatchRunnerOptions } from './qbo-batch.js';
import { describeQboFault } from './account-hierarchy.js';
import {
  batchCreateNames,
  ensureItems,
  importTransactions,
  rebuildImportIndex,
  deleteImportedTransactions,
  summarizeStatus,
  type EngineDeps,
  type ImportRowResult,
} from './import-engine.js';
import {
  normalizedTransactionSchema,
  nameRowSchema,
  itemRowSchema,
  TXN_TYPES,
  DEFAULT_ITEM_NAME_PATTERN,
  type TxnType,
} from './import-schema.js';
import { isValidDate, money } from './import-build.js';
import { table, firstLine, statusWord, writeRunLog } from './import-format.js';
import type { ImportStoreHandle } from '../db/import-store.js';

export interface ImportToolsConfig {
  /** Server data directory (dirname of QBO_DB_PATH): store + run logs live here. */
  dataDir: string;
  store: ImportStoreHandle;
  runner?: BatchRunnerOptions;
  /** Clock for run ids / log names (tests). */
  now?: () => Date;
}

type Text = { content: Array<{ type: 'text'; text: string }> };
const text = (t: string): Text => ({ content: [{ type: 'text', text: t }] });
const notFound = (client: string) => text(`Client not found: "${client}". Use list_clients to see available companies.`);

const ON_EXISTING_TXN =
  'What to do when a source_id is already imported and the row DIFFERS from what was imported (identical rows are always "unchanged"): "skip" (default) leaves QBO alone and reports the row skipped; "update" rewrites the QBO transaction in place (same Id, Line Ids carried so lines are replaced, not appended); "fail" reports it failed.';

export const IMPORT_TRANSACTIONS_DESCRIPTION = [
  'Load up to 500 normalized transactions (any source system — see docs/import-schema.md) into a QBO company as real QBO transactions: bank registers with payees, vendor/customer sub-ledgers, aging and classes. Validates every row against the LIVE company, writes in dependency order through the QBO batch endpoint (≤30 per request, throttled to 40 batch requests/min per company, automatic backoff + same-requestid retry on HTTP 429 / ThrottleExceeded), and returns one status row per transaction plus the path of a JSON and CSV log of the full result.',
  'IDEMPOTENT: each source_id is looked up in the server\'s import store (and in QBO by its PrivateNote stamp) before anything is created, so the same file can be re-run safely — already-imported rows come back "unchanged" (identical), "skipped"/"updated"/"failed" per on_existing (changed). A source_id is never written twice. Every written transaction\'s PrivateNote = your memo + " [src:<source_id>]".',
  'STATUS WORDS: created, updated, unchanged, skipped, blocked, failed; dry_run=true shows "would create"/"would update" and writes NOTHING to QBO or the store while still resolving and validating everything against the live company.',
  '"blocked" (not failed) = a Payment/BillPayment whose linked Invoice/Bill source_id is not imported yet (or failed in this call): load the target and re-run; the row then links. "failed" rows carry the reason (unknown account / name / class / item, wrong account type for the slot, unbalanced JE, A/R line without Customer, A/P line without Vendor, more than one A/R/A/P account, closed period, DocNumber > 21, or QBO\'s own fault text verbatim, e.g. 6140 duplicate document number).',
  'PER TYPE (every amount positive; lines[].account_number or account_name, "Parent:Child" allowed):',
  '• JournalEntry: lines with posting_type Debit|Credit, must balance; line entity {name,type} required on A/R (Customer) and A/P (Vendor) lines; at most one A/R or A/P account per entry.',
  '• Expense (Purchase, PaymentType from payment_method, default Cash) / Check (check_number → Ref no.) / CreditCardCharge / CreditCardCredit: account_number = the Bank (or Credit Card) account paid from; entity = payee (any type); lines = expense accounts (a line entity must be a Customer).',
  '• Deposit: account_number = deposit-to (Bank / Other Current Asset); lines = received-from accounts with optional entity per line (txn entity is the default).',
  '• Transfer: account_number = from, transfer_to_account_number = to, amount (no class/name in QBO).',
  '• Bill / VendorCredit: entity Vendor (required); optional account_number = A/P account; lines = expense accounts; Bill due_date, terms.',
  '• BillPayment: entity Vendor; account_number = paid-from Bank (payment_method Check/Cash) or Credit Card (CreditCard); linked [{source_id of Bill, amount}] required; check_number.',
  '• Invoice / CreditMemo: entity Customer (required); lines need item_name, or account_number of an income account that ensure_items made an item for; Invoice due_date, terms.',
  '• SalesReceipt / RefundReceipt: optional entity Customer; account_number = deposit-to / refund-from (required for RefundReceipt); lines as Invoice.',
  '• Payment: entity Customer; optional account_number = deposit-to (default Undeposited Funds); linked [{source_id of Invoice/CreditMemo, amount}]; amount = total if more than applied.',
  'Bills/Invoices load before the payments in the same call. On or before the books closing date fails unless allow_closed_period. Classes are dropped with a warning when class tracking is off.',
].join('\n');

// One writing import/delete/rebuild at a time per company, process-wide (each
// MCP request builds its own server, so this lives at module level). Two
// overlapping calls with the same file would otherwise both see a source_id
// as new before either recorded it.
const realmLocks = new Map<string, Promise<unknown>>();
async function withRealmLock<T>(realmId: string, fn: () => Promise<T>): Promise<T> {
  const prev = realmLocks.get(realmId) ?? Promise.resolve();
  const run = prev.catch(() => {}).then(fn);
  const tail = run.catch(() => {});
  realmLocks.set(realmId, tail);
  try {
    return await run;
  } finally {
    if (realmLocks.get(realmId) === tail) realmLocks.delete(realmId);
  }
}

function defaultRunId(now: Date): string {
  return `run-${now.toISOString().slice(0, 19).replace(/[:]/g, '-')}Z`;
}

function importTable(results: ImportRowResult[]): string[] {
  const rows = results.map((r) => [
    String(r.row),
    r.source_id,
    r.txn_type,
    r.txn_date,
    money(r.amount ?? 0),
    statusWord(r.status),
    r.qbo_id ? `${r.qbo_id}` : '',
    firstLine(r.message ?? (r.warnings.length ? `note: ${r.warnings.join('; ')}` : '')),
  ]);
  return table(['Row', 'Source Id', 'Type', 'Date', 'Amount', 'Status', 'QBO Id', 'Note'], rows);
}

export function registerImportTools(
  server: McpServer,
  qboManager: ScopedQBOManager,
  findRealmId: (clientName: string) => Promise<string | null>,
  config: ImportToolsConfig
): void {
  const now = config.now ?? (() => new Date());
  const deps = (realmId: string, clientName: string): EngineDeps => ({
    realmId,
    clientName,
    query: (q: string) => qboManager.transactions.rawQuery(realmId, q) as Promise<any>,
    getPrefs: () => qboManager.company.getPreferences(realmId),
    runner: new BatchRunner((realm, items, requestId) => qboManager.batch.execute(realm, items, requestId) as Promise<any>, config.runner),
    store: config.store.get(),
  });
  const clientLabel = async (realmId: string, fallback: string) => {
    const c = await qboManager.getConnection(realmId);
    return c?.clientName ?? fallback;
  };

  // ── batch_create_names ───────────────────────────────────────────────────
  server.tool(
    'batch_create_names',
    'Create vendors, customers and employees in bulk (up to 500 rows) before importing transactions. Resolves every display_name against ALL THREE lists first, because QBO requires DisplayName to be unique across vendors, customers and employees combined: a row whose name already exists as a different type FAILS with a message naming the type that holds it (never a silent near-duplicate). Idempotent by display_name + name_type: an existing name of the same type is "unchanged" (differences listed) or "updated" with on_existing="update" (sparse update of the fields given). source_id is stored in Vendor AcctNum (unless account_number is given) or appended to Customer Notes as [src:<id>], and always echoed back. Employees without given/family name get them from the display name. dry_run=true resolves and plans only. Writes go through the QBO batch endpoint (30 per request, throttled, retried on 429). Statuses: created / updated / unchanged / failed (would create / would update in a dry run).',
    {
      client_name: z.string().describe('The name of the client company'),
      names: z.array(nameRowSchema).min(1).max(500).describe('Rows: display_name + name_type (Vendor | Customer | Employee) required; company_name, given_name, family_name, email, phone, billing_address {street, city, state, postal_code, country}, terms (by name), vendor_1099, account_number, notes, active (default true), source_id optional'),
      on_existing: z.enum(['skip', 'update']).optional().describe('Existing name of the same type that differs: "skip" (default) reports it unchanged with the differences; "update" applies the given fields'),
      dry_run: z.boolean().optional().describe('Plan and validate only — nothing is written. Default false.'),
    },
    async ({ client_name, names, on_existing = 'skip', dry_run = false }: any) => {
      const realmId = await findRealmId(client_name);
      if (!realmId) return notFound(client_name);
      try {
        const d = deps(realmId, client_name);
        const outcome = await withRealmLock(realmId, () => batchCreateNames(d, names, { dryRun: dry_run, onExisting: on_existing }));
        const c = outcome.counts;
        const summary = dry_run
          ? `would create ${c.would_create} | would update ${c.would_update} | unchanged ${c.unchanged} | failed ${c.failed}`
          : `created ${c.created} | updated ${c.updated} | unchanged ${c.unchanged} | failed ${c.failed}`;
        const rows = outcome.results.map((r) => [String(r.row), r.display_name, r.name_type, statusWord(r.status), r.id ?? '', r.source_id ?? '', firstLine(r.message ?? '')]);
        const lines = [
          `BATCH CREATE NAMES — ${client_name}${dry_run ? ' (DRY RUN — nothing written)' : ''}`,
          '─'.repeat(60),
          `Rows: ${outcome.results.length} | ${summary}`,
          '',
          ...table(['Row', 'Display name', 'Type', 'Status', 'QBO Id', 'Source Id', 'Note'], rows),
        ];
        const problems = outcome.results.filter((r) => r.status === 'failed');
        if (problems.length) {
          lines.push('', 'Rows needing attention:');
          for (const r of problems) lines.push(`  Row ${r.row} ${r.name_type} "${r.display_name}" — FAILED: ${r.message ?? ''}`);
        }
        return text(lines.join('\n'));
      } catch (err: any) {
        return text(`Error creating names: ${describeQboFault(err)}`);
      }
    }
  );

  // ── ensure_items ─────────────────────────────────────────────────────────
  server.tool(
    'ensure_items',
    `Guarantee a non-taxable Service item exists for each income account named, so Invoice / SalesReceipt / CreditMemo / RefundReceipt lines (which QBO requires to carry an item) can be imported by account: import_transactions resolves a sales line's account_number to the item mapped to that account. Default item name "${DEFAULT_ITEM_NAME_PATTERN}" (name_pattern placeholders: {account_name}, {account_number}, {account_fqn}). Idempotent by item name: an existing item mapped to the same account is "unchanged"; mapped elsewhere is "skipped" (or re-mapped with on_existing="update"). Rejects A/R and A/P accounts (QBO 6430). Reports the item Id per row. dry_run supported. Writes through the batch endpoint.`,
    {
      client_name: z.string().describe('The name of the client company'),
      items: z.array(itemRowSchema).min(1).max(500).describe('Rows: account_number or account_name (income account) required; optional item_name, expense_account_number/expense_account_name, description'),
      name_pattern: z.string().optional().describe(`Item name pattern when item_name is omitted. Default "${DEFAULT_ITEM_NAME_PATTERN}"`),
      on_existing: z.enum(['skip', 'update']).optional().describe('An item with that name exists but maps to another account: "skip" (default) or "update" (re-map it)'),
      dry_run: z.boolean().optional().describe('Plan and validate only. Default false.'),
    },
    async ({ client_name, items, name_pattern, on_existing = 'skip', dry_run = false }: any) => {
      const realmId = await findRealmId(client_name);
      if (!realmId) return notFound(client_name);
      try {
        const outcome = await withRealmLock(realmId, () => ensureItems(deps(realmId, client_name), items, { dryRun: dry_run, onExisting: on_existing, namePattern: name_pattern ?? DEFAULT_ITEM_NAME_PATTERN }));
        const c = outcome.counts;
        const summary = dry_run
          ? `would create ${c.would_create} | would update ${c.would_update} | unchanged ${c.unchanged} | skipped ${c.skipped} | failed ${c.failed}`
          : `created ${c.created} | updated ${c.updated} | unchanged ${c.unchanged} | skipped ${c.skipped} | failed ${c.failed}`;
        const rows = outcome.results.map((r) => [String(r.row), r.item_name, statusWord(r.status), r.id ?? '', r.account, firstLine(r.message ?? '')]);
        const lines = [
          `ENSURE ITEMS — ${client_name}${dry_run ? ' (DRY RUN — nothing written)' : ''}`,
          '─'.repeat(60),
          `Rows: ${outcome.results.length} | ${summary}`,
          '',
          ...table(['Row', 'Item name', 'Status', 'Item Id', 'Income account', 'Note'], rows),
        ];
        const problems = outcome.results.filter((r) => r.status === 'failed' || r.status === 'skipped');
        if (problems.length) {
          lines.push('', 'Rows needing attention:');
          for (const r of problems) lines.push(`  Row ${r.row} "${r.item_name}" — ${r.status.toUpperCase()}: ${r.message ?? ''}`);
        }
        return text(lines.join('\n'));
      } catch (err: any) {
        return text(`Error ensuring items: ${describeQboFault(err)}`);
      }
    }
  );

  // ── import_transactions ──────────────────────────────────────────────────
  server.tool(
    'import_transactions',
    IMPORT_TRANSACTIONS_DESCRIPTION,
    {
      client_name: z.string().describe('The name of the client company'),
      transactions: z.array(normalizedTransactionSchema).min(1).max(500).describe('Normalized transactions (docs/import-schema.md), any order'),
      dry_run: z.boolean().optional().describe('Resolve + validate against the live company, write nothing (QBO or store). Default false.'),
      on_existing: z.enum(['skip', 'update', 'fail']).optional().describe(ON_EXISTING_TXN),
      run_id: z.string().max(100).optional().describe('Your label for this load (e.g. "netsuite-2024-07"); default a timestamp. Used by import_status and delete_imported_transactions; a transaction keeps the run_id of the call that created it.'),
      stop_on_first_failure: z.boolean().optional().describe('Stop at the first failed row: if validation fails nothing is written; if QBO rejects a row, later batch requests are not sent (rows already in the same 30-row request may have landed). Default false — every row gets its own status.'),
      allow_closed_period: z.boolean().optional().describe('Allow dates on or before the books closing date (QBO\'s own closing-password rule is surfaced if it rejects). Default false.'),
      allow_doc_number_suffix: z.boolean().optional().describe('On a duplicate document number (QBO 6140) retry with "-2", "-3", "-4" appended (fits 21 chars). Default false: the row fails with the fix.'),
      truncate_doc_numbers: z.boolean().optional().describe('Cut DocNumbers longer than 21 characters with a warning instead of failing the row. Default false.'),
      item_name_pattern: z.string().optional().describe(`Pattern ensure_items used, to pick the item for a sales line given by account. Default "${DEFAULT_ITEM_NAME_PATTERN}"`),
    },
    async (args: any) => {
      const { client_name, transactions } = args;
      const realmId = await findRealmId(client_name);
      if (!realmId) return notFound(client_name);
      const started = now();
      const runId: string = args.run_id?.trim() || defaultRunId(started);
      const dryRun = args.dry_run === true;
      try {
        const d = deps(realmId, client_name);
        const outcome = await withRealmLock(realmId, () => importTransactions(d, transactions, {
          dryRun,
          onExisting: args.on_existing ?? 'skip',
          runId,
          stopOnFirstFailure: args.stop_on_first_failure === true,
          allowClosedPeriod: args.allow_closed_period === true,
          allowDocNumberSuffix: args.allow_doc_number_suffix === true,
          truncateDocNumbers: args.truncate_doc_numbers === true,
          itemNamePattern: args.item_name_pattern ?? DEFAULT_ITEM_NAME_PATTERN,
        }));
        const c = outcome.counts;
        const summary = dryRun
          ? `would create ${c.would_create} | would update ${c.would_update} | unchanged ${c.unchanged} | skipped ${c.skipped} | blocked ${c.blocked} | failed ${c.failed}`
          : `created ${c.created} | updated ${c.updated} | unchanged ${c.unchanged} | skipped ${c.skipped} | blocked ${c.blocked} | failed ${c.failed}`;
        const label = await clientLabel(realmId, client_name);
        const doc = {
          tool: 'import_transactions', client: label, realm_id: realmId, run_id: runId, dry_run: dryRun,
          started_at: started.toISOString(), finished_at: now().toISOString(),
          options: { on_existing: args.on_existing ?? 'skip', stop_on_first_failure: !!args.stop_on_first_failure, allow_closed_period: !!args.allow_closed_period, allow_doc_number_suffix: !!args.allow_doc_number_suffix, truncate_doc_numbers: !!args.truncate_doc_numbers },
          counts: outcome.counts, notices: outcome.notices, stats: outcome.stats,
          results: outcome.results,
        };
        const csvRows = outcome.results.map((r) => ({ ...r, warnings: r.warnings.join('; '), fault_code: r.fault?.code, fault_message: r.fault ? [r.fault.message, r.fault.detail].filter(Boolean).join(' — ') : undefined }));
        const log = writeRunLog(config.dataDir, 'import_transactions', label, runId, doc,
          ['row', 'source_id', 'txn_type', 'txn_date', 'amount', 'status', 'qbo_type', 'qbo_id', 'doc_number', 'message', 'warnings', 'fault_code', 'fault_message'], csvRows, started);
        const lines = [
          `IMPORT TRANSACTIONS — ${client_name}${dryRun ? ' (DRY RUN — nothing written to QBO or the import store)' : ''}`,
          `run_id: ${runId} | rows: ${outcome.results.length}`,
          summary,
          ...outcome.notices.map((n) => `note: ${n}`),
          '─'.repeat(60),
          ...importTable(outcome.results),
        ];
        const problems = outcome.results.filter((r) => ['failed', 'blocked', 'skipped'].includes(r.status));
        if (problems.length) {
          lines.push('', 'Rows needing attention:');
          for (const r of problems) lines.push(`  Row ${r.row} ${r.source_id} (${r.txn_type} ${r.txn_date} ${money(r.amount ?? 0)}) — ${r.status.toUpperCase()}: ${r.message ?? ''}`);
        }
        const warned = outcome.results.filter((r) => r.warnings.length > 0);
        if (warned.length) {
          lines.push('', 'Warnings:');
          for (const r of warned) lines.push(`  Row ${r.row} ${r.source_id}: ${r.warnings.join('; ')}`);
        }
        const s = outcome.stats;
        if (!dryRun) lines.push('', `QBO batch requests: ${s.batchRequests} | throttle/transient retries: ${s.retries} | waited ${(s.waitedMs / 1000).toFixed(1)}s`);
        lines.push('', 'json' in log ? `Full result: ${log.json}\nCSV: ${log.csv}` : `Run log: ${log.error}`);
        if (!dryRun && (c.failed > 0 || c.blocked > 0)) lines.push('', 'Fix the failed rows and re-run the same batch: rows that already landed report "unchanged"; blocked rows load once their linked transactions are in.');
        return text(lines.join('\n'));
      } catch (err: any) {
        return text(`Error importing transactions (nothing further was attempted): ${describeQboFault(err)}`);
      }
    }
  );

  // ── import_status ────────────────────────────────────────────────────────
  server.tool(
    'import_status',
    'Read-only: query the import store (source_id → QBO transaction) for a company by any of run_id, source_id, source_ids[], txn_type, date range and status (created | updated | indexed | deleted; indexed = recovered by rebuild_import_index). Returns a summary (count and sum of amounts by type and status) and the matching rows. Use it to reconcile a month: everything you sent should be present (created/updated/indexed) and the sums by type should equal the source totals. Deleted rows stay as history.',
    {
      client_name: z.string().describe('The name of the client company'),
      run_id: z.string().optional(),
      source_id: z.string().optional(),
      source_ids: z.array(z.string()).max(5000).optional(),
      txn_type: z.enum(TXN_TYPES).optional(),
      start_date: z.string().optional().describe('txn_date from, YYYY-MM-DD'),
      end_date: z.string().optional().describe('txn_date to, YYYY-MM-DD'),
      status: z.enum(['created', 'updated', 'indexed', 'deleted', 'live']).optional().describe('"live" = everything not deleted. Default: all, including deleted history'),
      limit: z.number().int().min(0).max(5000).optional().describe('Max rows listed (default 200; the summary always covers everything matched)'),
    },
    async (args: any) => {
      const realmId = await findRealmId(args.client_name);
      if (!realmId) return notFound(args.client_name);
      try {
        const ids = [...(args.source_ids ?? []), ...(args.source_id ? [args.source_id] : [])];
        const rows = config.store.get().query({
          realm_id: realmId, run_id: args.run_id, source_ids: ids.length ? ids : undefined, txn_type: args.txn_type,
          start_date: args.start_date, end_date: args.end_date,
          status: args.status && args.status !== 'live' ? args.status : undefined,
          include_deleted: args.status === 'live' ? false : true,
        });
        const summary = summarizeStatus(rows);
        const limit = args.limit ?? 200;
        const lines = [
          `IMPORT STATUS — ${args.client_name}`,
          `Filters: ${[args.run_id && `run_id=${args.run_id}`, ids.length && `source_ids=${ids.length}`, args.txn_type && `txn_type=${args.txn_type}`, args.start_date && `from ${args.start_date}`, args.end_date && `to ${args.end_date}`, args.status && `status=${args.status}`].filter(Boolean).join(', ') || '(none)'}`,
          `Matched: ${rows.length}`,
          '',
          ...table(['Type', 'Status', 'Count', 'Amount'], summary.map((s) => [s.txn_type, s.status, String(s.count), money(s.amount)])),
        ];
        if (ids.length) {
          const have = new Set(rows.map((r) => r.source_id));
          const missing = ids.filter((i) => !have.has(i));
          lines.push('', missing.length ? `Not in the store (${missing.length}): ${missing.slice(0, 50).join(', ')}${missing.length > 50 ? ', …' : ''}` : 'Every requested source_id is in the store.');
        }
        if (limit > 0 && rows.length) {
          lines.push('', ...table(
            ['Source Id', 'Type', 'Date', 'Amount', 'Status', 'QBO', 'Doc no.', 'run_id', 'Updated'],
            rows.slice(0, limit).map((r) => [r.source_id, r.txn_type, r.txn_date ?? '', money(r.amount ?? 0), r.status, `${r.qbo_type} ${r.qbo_id}`, r.doc_number ?? '', r.run_id, String(r.updated_at ?? '')])
          ));
          if (rows.length > limit) lines.push(`… ${rows.length - limit} more (raise limit or narrow the filters)`);
        }
        return text(lines.join('\n'));
      } catch (err: any) {
        return text(`Error reading the import store: ${err?.message ?? err}`);
      }
    }
  );

  // ── rebuild_import_index ─────────────────────────────────────────────────
  server.tool(
    'rebuild_import_index',
    'Scan the company\'s transactions of every importable type (or txn_types) dated start_date..end_date (QBO query, paged), read each PrivateNote for the [src:<source_id>] stamp, and upsert the import store. Reports how many were scanned/stamped, how many were new to the store, store rows QBO no longer shows (deleted, or stamp edited), and any source_id stamped on MORE THAN ONE QBO transaction (duplicates to investigate — not added). Recovered rows get status "indexed" and the run_id you pass, so delete_imported_transactions(run_id) keeps working after a recovery. Use it to recover a lost store or (dry_run=true) to verify it.',
    {
      client_name: z.string().describe('The name of the client company'),
      start_date: z.string().describe('YYYY-MM-DD'),
      end_date: z.string().describe('YYYY-MM-DD'),
      txn_types: z.array(z.enum(TXN_TYPES)).optional().describe('Limit the scan (Expense/Check/CreditCardCharge/CreditCardCredit all scan Purchase)'),
      run_id: z.string().max(100).optional().describe('run_id to give recovered rows (default "rebuilt-<date>")'),
      dry_run: z.boolean().optional().describe('Verify only: report, do not write the store'),
    },
    async (args: any) => {
      const realmId = await findRealmId(args.client_name);
      if (!realmId) return notFound(args.client_name);
      if (!isValidDate(args.start_date) || !isValidDate(args.end_date) || args.start_date > args.end_date) {
        return text('start_date and end_date must be valid YYYY-MM-DD dates with start_date <= end_date.');
      }
      try {
        const runId = args.run_id?.trim() || `rebuilt-${now().toISOString().slice(0, 10)}`;
        const label = await clientLabel(realmId, args.client_name);
        const out = await withRealmLock(realmId, () => rebuildImportIndex(deps(realmId, label), { startDate: args.start_date, endDate: args.end_date, txnTypes: args.txn_types as TxnType[] | undefined, runId, dryRun: args.dry_run === true }));
        const lines = [
          `REBUILD IMPORT INDEX — ${args.client_name} ${args.start_date}..${args.end_date}${args.dry_run ? ' (DRY RUN — store not written)' : ''}`,
          `Scanned ${out.scanned} transactions | stamped ${out.stamped} | new to store ${out.newToStore.length}${args.dry_run ? ' (would add)' : ''} | already in store ${out.alreadyInStore} | conflicts ${out.conflicts.length} | duplicates ${out.duplicates.length} | in store but not in QBO ${out.missingFromQbo.length}`,
          `Per entity: ${Object.entries(out.perEntity).map(([k, v]) => `${k} ${v.stamped}/${v.scanned}`).join(', ')}`,
          `Recovered rows get run_id "${runId}".`,
        ];
        if (out.newToStore.length) lines.push('', ...table(['Source Id', 'QBO', 'Date', 'Amount'], out.newToStore.slice(0, 500).map((n) => [n.source_id, `${n.qbo_type} ${n.qbo_id}`, n.txn_date ?? '', money(n.amount ?? 0)])));
        if (out.duplicates.length) {
          lines.push('', 'DUPLICATES — one source_id stamped on several QBO transactions (not added; investigate, then delete the extras):');
          for (const d of out.duplicates) lines.push(`  ${d.source_id}: ${d.transactions.join(', ')}`);
        }
        if (out.conflicts.length) {
          lines.push('', 'CONFLICTS — the store maps these source_ids to a different QBO transaction than the one stamped (store left unchanged):');
          for (const c of out.conflicts) lines.push(`  ${c.source_id}: store ${c.store_qbo} vs stamped ${c.qbo}`);
        }
        if (out.missingFromQbo.length) {
          lines.push('', 'IN STORE BUT NOT FOUND STAMPED IN QBO:');
          for (const m of out.missingFromQbo) lines.push(`  ${m.source_id}: ${m.qbo_type} ${m.qbo_id} — ${m.status}`);
        }
        return text(lines.join('\n'));
      } catch (err: any) {
        return text(`Error rebuilding the import index: ${describeQboFault(err)}`);
      }
    }
  );

  // ── delete_imported_transactions ─────────────────────────────────────────
  server.tool(
    'delete_imported_transactions',
    'Roll back imported transactions by run_id or source_ids[] (dry_run=true lists what would go). Deletes in reverse dependency order — Payments and BillPayments first, then Invoices, Bills and everything else — through the QBO batch endpoint, and marks the store rows "deleted" (history is kept; nothing is dropped). REFUSES, per row, any transaction whose PrivateNote no longer carries [src:<source_id>] (someone edited it in QBO) unless force=true. Transactions already gone from QBO are reported "not found" and marked deleted. Statuses: deleted / would delete / refused / not found / failed.',
    {
      client_name: z.string().describe('The name of the client company'),
      run_id: z.string().optional().describe('Delete every live import of this run'),
      source_ids: z.array(z.string()).max(5000).optional().describe('Delete these source_ids (combined with run_id: only those in that run)'),
      dry_run: z.boolean().optional().describe('List only. Default false.'),
      force: z.boolean().optional().describe('Delete even when the [src:] stamp was edited away. Default false.'),
    },
    async (args: any) => {
      const realmId = await findRealmId(args.client_name);
      if (!realmId) return notFound(args.client_name);
      if (!args.run_id && !(args.source_ids?.length)) return text('Pass run_id or source_ids — refusing to guess what to delete.');
      try {
        const started = now();
        const label = await clientLabel(realmId, args.client_name);
        const out = await withRealmLock(realmId, () => deleteImportedTransactions(deps(realmId, label), { runId: args.run_id, sourceIds: args.source_ids, dryRun: args.dry_run === true, force: args.force === true }));
        const c = out.counts;
        const log = writeRunLog(config.dataDir, 'delete_imported_transactions', label, args.run_id ?? 'source-ids', { tool: 'delete_imported_transactions', client: label, realm_id: realmId, run_id: args.run_id ?? null, source_ids: args.source_ids ?? null, dry_run: !!args.dry_run, force: !!args.force, started_at: started.toISOString(), finished_at: now().toISOString(), counts: c, results: out.results },
          ['order', 'source_id', 'txn_type', 'qbo_type', 'qbo_id', 'txn_date', 'amount', 'status', 'message'], out.results as any, started);
        const lines = [
          `DELETE IMPORTED TRANSACTIONS — ${args.client_name}${args.dry_run ? ' (DRY RUN — nothing deleted)' : ''}${args.force ? ' (force)' : ''}`,
          `${args.run_id ? `run_id: ${args.run_id} | ` : ''}rows: ${out.results.length}`,
          args.dry_run
            ? `would delete ${c.would_delete} | refused ${c.refused} | not found ${c.not_found} | failed ${c.failed}`
            : `deleted ${c.deleted} | refused ${c.refused} | not found ${c.not_found} | failed ${c.failed}`,
          '─'.repeat(60),
          ...table(['Order', 'Source Id', 'Type', 'QBO', 'Date', 'Amount', 'Status', 'Note'], out.results.map((r) => [String(r.order || ''), r.source_id, r.txn_type, r.qbo_type ? `${r.qbo_type} ${r.qbo_id}` : '', r.txn_date ?? '', money(r.amount ?? 0), statusWord(r.status), firstLine(r.message ?? '')])),
        ];
        const problems = out.results.filter((r) => r.status === 'refused' || r.status === 'failed');
        if (problems.length) {
          lines.push('', 'Rows needing attention:');
          for (const r of problems) lines.push(`  ${r.source_id} — ${r.status.toUpperCase()}: ${r.message ?? ''}`);
        }
        lines.push('', 'json' in log ? `Full result: ${log.json}\nCSV: ${log.csv}` : `Run log: ${log.error}`);
        return text(lines.join('\n'));
      } catch (err: any) {
        return text(`Error deleting imported transactions: ${describeQboFault(err)}`);
      }
    }
  );
}
