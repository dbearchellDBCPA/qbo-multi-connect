// ─── MCP registration: Transfer read/update/delete + Expense/Deposit → Transfer ─
//
//   get_transfer               update-ready read of one Transfer
//   update_transfer            sparse header update, fresh SyncToken, verify + roll back
//   delete_transfer            QBO hard delete (echoes what was removed)
//   convert_to_transfer        replace an Expense and/or Deposit with a native Transfer
//
// QBO API reality (why convert_to_transfer is "create + delete", not a conversion):
// the Accounting API has no operation that changes a transaction's type. A
// Purchase (Expense/Check) or Deposit cannot be turned into a Transfer, and a
// Transfer cannot be created "from" an existing transaction. The only API path
// is: create a new Transfer, verify it, then hard-delete the originals. Bank-feed
// matches, attachments, reconciliation status, audit history and the original
// Ids belong to the deleted rows and are NOT carried over. Purchase and Deposit
// have no API void, so delete is the only removal path.

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ScopedQBOManager } from './auth.js';
import { formatCurrency } from './report-shaping.js';

type Text = { content: { type: 'text'; text: string }[] };
const text = (t: string): Text => ({ content: [{ type: 'text', text: t }] });
const notFound = (c: string) => text(`Client not found: "${c}". Use list_clients to see available companies.`);
const round2 = (n: number) => Math.round(n * 100) / 100;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export const CONVERT_TO_TRANSFER_MAX_ITEMS = 50;

export function transferToUpdateShape(t: any) {
  return {
    id: t.Id,
    sync_token: t.SyncToken,
    txn_date: t.TxnDate,
    amount: t.Amount,
    from_account_id: t.FromAccountRef?.value,
    from_account_name: t.FromAccountRef?.name,
    to_account_id: t.ToAccountRef?.value,
    to_account_name: t.ToAccountRef?.name,
    private_note: t.PrivateNote,
    department_id: t.DepartmentRef?.value,
  };
}

/** Fields we compare after a Transfer write. */
function transferMismatches(expected: any, actual: any): string[] {
  const out: string[] = [];
  if (expected.FromAccountRef && actual?.FromAccountRef?.value !== expected.FromAccountRef.value) out.push(`from account ${actual?.FromAccountRef?.value} ≠ ${expected.FromAccountRef.value}`);
  if (expected.ToAccountRef && actual?.ToAccountRef?.value !== expected.ToAccountRef.value) out.push(`to account ${actual?.ToAccountRef?.value} ≠ ${expected.ToAccountRef.value}`);
  if (expected.Amount !== undefined && round2(Number(actual?.Amount)) !== round2(Number(expected.Amount))) out.push(`amount ${actual?.Amount} ≠ ${expected.Amount}`);
  if (expected.TxnDate && actual?.TxnDate !== expected.TxnDate) out.push(`date ${actual?.TxnDate} ≠ ${expected.TxnDate}`);
  if (expected.PrivateNote !== undefined && (actual?.PrivateNote ?? '') !== expected.PrivateNote) out.push('private note differs');
  return out;
}

/** Does a TransactionList report contain a row whose txn id is `id`? */
function reportHasTxnId(report: any, id: string): boolean {
  const walk = (rows: any[] | undefined): boolean =>
    (rows ?? []).some((r) =>
      (r?.ColData ?? []).some((c: any) => c?.id === id) || walk(r?.Rows?.Row));
  return walk(report?.Rows?.Row);
}

function daysBetween(a: string, b: string): number {
  return Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000;
}

const LIMITATIONS = [
  'QBO cannot convert a transaction type in place: this tool CREATES a new Transfer and then HARD-DELETES the original Expense/Deposit (no API void exists for Purchase or Deposit).',
  'NOT preserved from the originals: bank-feed matches (the downloaded bank lines go back to "For Review" in QBO and must be re-matched to the new Transfer by a person in QBO — the API cannot match bank-feed lines), attachments, original transaction Ids, audit history, payee/vendor (Transfers have no payee), class/line detail (Transfers have no lines), and DocNumber/Ref no (Transfers have none).',
  'Preserved: amount, date (expense date when pairing, unless transfer_date is given), the bank account(s), and the original memo (appended to PrivateNote with a "[converted from …]" stamp).',
  'Originals that are reconciled are refused (deleting them would change a reconciled balance) unless allow_reconciled=true; if reconciliation status cannot be read the item is refused too.',
].join(' ');

export function registerTransferTools(
  server: McpServer,
  qboManager: ScopedQBOManager,
  findRealmId: (clientName: string) => Promise<string | null>,
): void {
  const tool = (server as any).tool.bind(server);

  // ── get_transfer ─────────────────────────────────────────────────────────
  tool(
    'get_transfer',
    'Fetch a Transfer in update-ready shape (id, sync_token, txn_date, amount, from/to account id+name, private_note, department_id).',
    {
      client_name: z.string().describe('The name of the client company'),
      transfer_id: z.string().describe('QBO Transfer ID'),
    },
    async ({ client_name, transfer_id }: any) => {
      const realmId = await findRealmId(client_name);
      if (!realmId) return notFound(client_name);
      try {
        const t = ((await qboManager.banking.getTransfer(realmId, transfer_id)) as any)?.Transfer;
        if (!t) return text(`Transfer ${transfer_id} not found.`);
        return text(JSON.stringify(transferToUpdateShape(t), null, 2));
      } catch (err: any) {
        return text(`Error fetching transfer: ${err?.message ?? err}`);
      }
    },
  );

  // ── update_transfer ──────────────────────────────────────────────────────
  tool(
    'update_transfer',
    'Update an existing Transfer in place. Auto-fetches the current Transfer + fresh SyncToken, sends a sparse update with only the fields you pass, then verifies the saved Transfer against what was sent; on any mismatch it re-posts the original values (rollback) and reports the failure. from_account_id and to_account_id must differ; amount must be > 0.',
    {
      client_name: z.string().describe('The name of the client company'),
      transfer_id: z.string().describe('QBO Transfer ID to update'),
      from_account_id: z.string().optional().describe('New source account ID (funds leave)'),
      to_account_id: z.string().optional().describe('New destination account ID (funds arrive)'),
      amount: z.number().positive().optional().describe('New amount (> 0)'),
      txn_date: z.string().regex(DATE_RE).optional().describe('New date YYYY-MM-DD'),
      private_note: z.string().max(4000).optional().describe('New memo (replaces the existing memo)'),
    },
    async ({ client_name, transfer_id, from_account_id, to_account_id, amount, txn_date, private_note }: any) => {
      const realmId = await findRealmId(client_name);
      if (!realmId) return notFound(client_name);
      if ([from_account_id, to_account_id, amount, txn_date, private_note].every((v) => v === undefined)) {
        return text('Nothing to update — pass at least one of from_account_id, to_account_id, amount, txn_date, private_note.');
      }
      try {
        const orig = ((await qboManager.banking.getTransfer(realmId, transfer_id)) as any)?.Transfer;
        if (!orig) return text(`Transfer ${transfer_id} not found.`);
        const fromId = from_account_id ?? orig.FromAccountRef?.value;
        const toId = to_account_id ?? orig.ToAccountRef?.value;
        if (fromId && fromId === toId) return text(`From and to account are both ${fromId} — nothing was posted.`);
        const changes: any = {};
        if (from_account_id) changes.FromAccountRef = { value: from_account_id };
        if (to_account_id) changes.ToAccountRef = { value: to_account_id };
        if (amount !== undefined) changes.Amount = round2(amount);
        if (txn_date) changes.TxnDate = txn_date;
        if (private_note !== undefined) changes.PrivateNote = private_note;
        const payload = { Id: orig.Id, SyncToken: orig.SyncToken, sparse: true, ...changes };
        const updated = ((await qboManager.banking.updateTransfer(realmId, payload)) as any)?.Transfer;
        const check = updated ?? (((await qboManager.banking.getTransfer(realmId, transfer_id)) as any)?.Transfer);
        const bad = transferMismatches(changes, check);
        if (bad.length) {
          let rb = 'rollback not attempted (no saved object returned)';
          if (check?.SyncToken) {
            try {
              const restore: any = {
                Id: orig.Id, SyncToken: check.SyncToken, sparse: true,
                FromAccountRef: orig.FromAccountRef && { value: orig.FromAccountRef.value },
                ToAccountRef: orig.ToAccountRef && { value: orig.ToAccountRef.value },
                Amount: orig.Amount, TxnDate: orig.TxnDate, PrivateNote: orig.PrivateNote ?? '',
              };
              await qboManager.banking.updateTransfer(realmId, restore);
              rb = 'original values restored';
            } catch (e: any) {
              rb = `ROLLBACK FAILED: ${e?.message ?? e} — check Transfer ${transfer_id} by hand`;
            }
          }
          return text(`Transfer ${transfer_id} update did not verify (${bad.join('; ')}); ${rb}.`);
        }
        return text(`Transfer ${check.Id} updated (verified).\nID: ${check.Id} | SyncToken: ${check.SyncToken} | Date: ${check.TxnDate} | Amount: ${formatCurrency(check.Amount)}\nFrom: ${check.FromAccountRef?.name ?? check.FromAccountRef?.value} → To: ${check.ToAccountRef?.name ?? check.ToAccountRef?.value}`);
      } catch (err: any) {
        return text(`Error updating transfer: ${err?.message ?? err}`);
      }
    },
  );

  // ── delete_transfer ──────────────────────────────────────────────────────
  tool(
    'delete_transfer',
    'Permanently delete a Transfer from QuickBooks Online. QBO HARD delete — recoverable only via the QBO Audit Log. Fetches a fresh SyncToken first and echoes what was deleted.',
    {
      client_name: z.string().describe('The name of the client company'),
      transfer_id: z.string().describe('QBO Transfer ID to delete'),
    },
    async ({ client_name, transfer_id }: any) => {
      const realmId = await findRealmId(client_name);
      if (!realmId) return notFound(client_name);
      try {
        const t = ((await qboManager.banking.getTransfer(realmId, transfer_id)) as any)?.Transfer;
        if (!t) return text(`Transfer ${transfer_id} not found.`);
        await qboManager.banking.deleteTransfer(realmId, transfer_id, t.SyncToken);
        return text(`Deleted transfer ${transfer_id}: ${t.TxnDate}, ${formatCurrency(t.Amount)} from ${t.FromAccountRef?.name ?? t.FromAccountRef?.value} to ${t.ToAccountRef?.name ?? t.ToAccountRef?.value}.\nQBO hard delete — recoverable only via the Audit Log.`);
      } catch (err: any) {
        return text(`Error deleting transfer: ${err?.message ?? err}`);
      }
    },
  );

  // ── convert_to_transfer ──────────────────────────────────────────────────
  tool(
    'convert_to_transfer',
    `Replace existing Expenses (Purchase) and/or Deposits with native Transfers, up to ${CONVERT_TO_TRANSFER_MAX_ITEMS} items per call. Each item is EITHER a pair (expense_id + deposit_id: the money left the expense's bank account and arrived in the deposit's bank account — amounts must match to the cent, dates within date_tolerance_days, accounts must differ) OR a single original plus counter_account_id (an expense becomes From=expense account → To=counter account; a deposit becomes From=counter account → To=deposit account). DRY RUN BY DEFAULT: with dry_run omitted/true nothing is written and you get the planned Transfer and every validation result per item. With dry_run=false, per item: re-fetch originals, validate, create the Transfer, read it back and verify from/to/amount/date, then hard-delete the original(s) with fresh SyncTokens. If verification fails the new Transfer is deleted and originals are left untouched; if deleting an original fails the new Transfer is deleted so nothing is double-counted (the item reports exactly what state it was left in). Refused: expenses that are credit-card credits, deposits with linked payments (Undeposited Funds) or zero/negative totals, originals with lines not coded to expected_line_account_id (when given), and reconciled originals (unless allow_reconciled). Items run sequentially and one failure never stops the others. LIMITATIONS: ${LIMITATIONS}`,
    {
      client_name: z.string().describe('The name of the client company'),
      items: z.array(z.object({
        expense_id: z.string().optional().describe('Existing Expense (Purchase) ID — the money-out side'),
        deposit_id: z.string().optional().describe('Existing Deposit ID — the money-in side'),
        counter_account_id: z.string().optional().describe('Required when only one of expense_id/deposit_id is given: the other bank/credit-card/equity account of the Transfer'),
        transfer_date: z.string().regex(DATE_RE).optional().describe('Override the Transfer date (default: the expense date, else the deposit date)'),
        private_note: z.string().max(3500).optional().describe('Memo for the Transfer (default: the original memo). A "[converted from …]" stamp is always appended.'),
      })).min(1).max(CONVERT_TO_TRANSFER_MAX_ITEMS),
      expected_line_account_id: z.string().optional().describe('Safety check: every line of each original must be coded to this account (e.g. the Owner\'s Pay & Personal Expenses account ID). Items that do not match are refused.'),
      date_tolerance_days: z.number().int().min(0).max(5).optional().describe('Pairs only: max days between expense and deposit dates. Default 0 (same day).'),
      allow_reconciled: z.boolean().optional().describe('Allow deleting originals that are reconciled (or whose reconcile status cannot be read). Default false.'),
      dry_run: z.boolean().optional().describe('Default TRUE — plan and validate only. Pass false to create Transfers and delete the originals.'),
    },
    async ({ client_name, items, expected_line_account_id, date_tolerance_days = 0, allow_reconciled = false, dry_run = true }: any) => {
      const realmId = await findRealmId(client_name);
      if (!realmId) return notFound(client_name);
      const results: any[] = [];
      for (const [i, item] of (items as any[]).entries()) {
        results.push(await convertOne(qboManager, realmId, i, item, { expected_line_account_id, date_tolerance_days, allow_reconciled, dry_run }));
      }
      const count = (s: string) => results.filter((r) => r.status === s).length;
      const header = `CONVERT TO TRANSFER — ${client_name}${dry_run ? ' (DRY RUN — nothing written; re-run with dry_run=false to apply)' : ''}\n` +
        `${dry_run ? `ready: ${count('ready')}` : `converted: ${count('converted')}`} | failed: ${count('failed')}${count('needs_attention') ? ` | NEEDS ATTENTION: ${count('needs_attention')}` : ''}\n` +
        (dry_run ? '' : 'Bank-feed matches on the deleted originals are gone: those bank lines return to For Review and must be matched to the new Transfers in QBO.\n');
      return text(header + JSON.stringify(results, null, 2));
    },
  );
}

interface ConvertOpts { expected_line_account_id?: string; date_tolerance_days: number; allow_reconciled: boolean; dry_run: boolean }

async function convertOne(q: ScopedQBOManager, realmId: string, index: number, item: any, o: ConvertOpts): Promise<any> {
  const base: any = { index, expense_id: item.expense_id, deposit_id: item.deposit_id };
  const fail = (error: string, extra: any = {}) => ({ ...base, status: 'failed', error, ...extra });
  try {
    if (!item.expense_id && !item.deposit_id) return fail('Pass expense_id and/or deposit_id.');
    const pair = Boolean(item.expense_id && item.deposit_id);
    if (pair && item.counter_account_id) return fail('counter_account_id is only for single-original items; a pair already defines both accounts.');
    if (!pair && !item.counter_account_id) return fail('counter_account_id is required when only one original is given.');

    const exp = item.expense_id ? ((await q.transactions.getExpense(realmId, item.expense_id)) as any)?.Purchase : null;
    if (item.expense_id && !exp) return fail(`Expense ${item.expense_id} not found.`);
    const dep = item.deposit_id ? ((await q.banking.getDeposit(realmId, item.deposit_id)) as any)?.Deposit : null;
    if (item.deposit_id && !dep) return fail(`Deposit ${item.deposit_id} not found.`);

    const problems: string[] = [];
    if (exp) {
      if (exp.Credit === true) problems.push(`Expense ${exp.Id} is a credit-card credit (money in), not an expense.`);
      if (!(Number(exp.TotalAmt) > 0)) problems.push(`Expense ${exp.Id} total ${exp.TotalAmt} is not positive.`);
      if (!exp.AccountRef?.value) problems.push(`Expense ${exp.Id} has no pay-from account.`);
      if (expected_line_ok(exp.Line, o.expected_line_account_id, 'AccountBasedExpenseLineDetail') === false) problems.push(`Expense ${exp.Id} has lines not coded to account ${o.expected_line_account_id}.`);
    }
    if (dep) {
      if ((dep.Line ?? []).some((l: any) => (l.LinkedTxn ?? []).length)) problems.push(`Deposit ${dep.Id} includes linked payments from Undeposited Funds; deleting it would return them to Undeposited Funds.`);
      if (!(Number(dep.TotalAmt) > 0)) problems.push(`Deposit ${dep.Id} total ${dep.TotalAmt} is not positive.`);
      if (dep.CashBack) problems.push(`Deposit ${dep.Id} has cash back.`);
      if (expected_line_ok(dep.Line, o.expected_line_account_id, 'DepositLineDetail') === false) problems.push(`Deposit ${dep.Id} has lines not coded to account ${o.expected_line_account_id}.`);
    }
    let from: string; let to: string; let amount: number; let date: string;
    if (pair) {
      from = exp.AccountRef?.value; to = dep.DepositToAccountRef?.value;
      if (round2(Number(exp.TotalAmt)) !== round2(Number(dep.TotalAmt))) problems.push(`Amounts differ: expense ${exp.TotalAmt} vs deposit ${dep.TotalAmt}.`);
      if (daysBetween(exp.TxnDate, dep.TxnDate) > o.date_tolerance_days) problems.push(`Dates differ: expense ${exp.TxnDate} vs deposit ${dep.TxnDate} (tolerance ${o.date_tolerance_days} day(s)).`);
      amount = round2(Number(exp.TotalAmt)); date = item.transfer_date ?? exp.TxnDate;
    } else if (exp) {
      from = exp.AccountRef?.value; to = item.counter_account_id;
      amount = round2(Number(exp.TotalAmt)); date = item.transfer_date ?? exp.TxnDate;
    } else {
      from = item.counter_account_id; to = dep.DepositToAccountRef?.value;
      amount = round2(Number(dep.TotalAmt)); date = item.transfer_date ?? dep.TxnDate;
    }
    if (!to) problems.push('Deposit has no deposit-to account.');
    if (from && from === to) problems.push(`From and to account are both ${from}.`);

    // Reconciled originals: deleting changes a reconciled balance.
    const recon: Record<string, string> = {};
    for (const [label, txn, acct] of [['expense', exp, exp?.AccountRef?.value], ['deposit', dep, dep?.DepositToAccountRef?.value]] as const) {
      if (!txn) continue;
      try {
        const rep = await q.banking.transactionList(realmId, { accountId: acct, startDate: txn.TxnDate, endDate: txn.TxnDate, cleared: 'Reconciled' });
        recon[label] = reportHasTxnId(rep, txn.Id) ? 'reconciled' : 'not_reconciled';
      } catch {
        recon[label] = 'unknown';
      }
      if (recon[label] !== 'not_reconciled' && !o.allow_reconciled) problems.push(`${label} ${txn.Id} reconcile status is ${recon[label]} — refused (pass allow_reconciled=true to override).`);
    }

    const sources = [exp && `Expense ${exp.Id}`, dep && `Deposit ${dep.Id}`].filter(Boolean).join(' + ');
    const baseNote = item.private_note ?? [exp?.PrivateNote, dep?.PrivateNote].filter(Boolean).join(' | ');
    const stamp = `[converted from ${sources}]`;
    const transfer: any = {
      FromAccountRef: { value: from! }, ToAccountRef: { value: to! }, Amount: amount!, TxnDate: date!,
      PrivateNote: `${baseNote ? `${baseNote} ` : ''}${stamp}`.slice(0, 4000),
    };
    const plan = {
      from_account: { id: from!, name: exp && from === exp.AccountRef?.value ? exp.AccountRef?.name : undefined },
      to_account: { id: to!, name: dep && to === dep.DepositToAccountRef?.value ? dep.DepositToAccountRef?.name : undefined },
      amount: amount!, txn_date: date!, private_note: transfer.PrivateNote,
      originals_to_delete: [exp && { type: 'Expense', id: exp.Id, date: exp.TxnDate, amount: exp.TotalAmt, payee: exp.EntityRef?.name, reconcile_status: recon.expense },
        dep && { type: 'Deposit', id: dep.Id, date: dep.TxnDate, amount: dep.TotalAmt, reconcile_status: recon.deposit }].filter(Boolean),
    };
    if (problems.length) return fail(problems.join(' '), { plan });
    if (o.dry_run) return { ...base, status: 'ready', plan };

    // ── live: create → verify → delete originals ──
    const created = ((await q.banking.createTransfer(realmId, transfer)) as any)?.Transfer;
    if (!created?.Id) return fail('QBO did not return the created Transfer; originals untouched.', { plan });
    const readBack = ((await q.banking.getTransfer(realmId, created.Id)) as any)?.Transfer;
    const bad = transferMismatches(transfer, readBack);
    if (bad.length) {
      const undo = await safeDeleteTransfer(q, realmId, readBack ?? created);
      return fail(`New Transfer ${created.Id} did not verify (${bad.join('; ')}); ${undo}. Originals untouched.`, { plan });
    }
    const deleted: string[] = [];
    for (const [type, txn] of [['Expense', exp], ['Deposit', dep]] as const) {
      if (!txn) continue;
      try {
        if (type === 'Expense') {
          const fresh = ((await q.transactions.getExpense(realmId, txn.Id)) as any)?.Purchase;
          await q.transactions.deleteExpense(realmId, txn.Id, fresh?.SyncToken ?? txn.SyncToken);
        } else {
          const fresh = ((await q.banking.getDeposit(realmId, txn.Id)) as any)?.Deposit;
          await q.banking.deleteDeposit(realmId, txn.Id, fresh?.SyncToken ?? txn.SyncToken);
        }
        deleted.push(`${type} ${txn.Id}`);
      } catch (e: any) {
        const msg = `Deleting ${type} ${txn.Id} failed: ${e?.message ?? e}.`;
        if (deleted.length === 0) {
          const undo = await safeDeleteTransfer(q, realmId, readBack);
          return fail(`${msg} New Transfer ${created.Id}: ${undo}. Originals untouched.`, { plan });
        }
        return { ...base, status: 'needs_attention', transfer_id: created.Id, deleted, error: `${msg} ${deleted.join(', ')} was already deleted and Transfer ${created.Id} exists, so ${type} ${txn.Id} now double-counts — delete it once the cause is fixed.`, plan };
      }
    }
    return { ...base, status: 'converted', transfer_id: created.Id, transfer_sync_token: readBack.SyncToken, deleted, plan,
      warning: 'Bank-feed matches, attachments and Ids of the deleted originals were not carried over; re-match the bank lines to this Transfer in QBO.' };
  } catch (err: any) {
    return fail(err?.message ?? String(err));
  }
}

function expected_line_ok(lines: any[] | undefined, accountId: string | undefined, detail: string): boolean | null {
  if (!accountId) return null;
  const ls = (lines ?? []).filter((l: any) => l?.DetailType !== 'SubTotalLineDetail');
  if (!ls.length) return false;
  return ls.every((l: any) => l?.DetailType === detail && l?.[detail]?.AccountRef?.value === accountId);
}

async function safeDeleteTransfer(q: ScopedQBOManager, realmId: string, t: any): Promise<string> {
  try {
    await q.banking.deleteTransfer(realmId, t.Id, t.SyncToken);
    return 'it was deleted again';
  } catch (e: any) {
    return `COULD NOT delete it (${e?.message ?? e}) — delete Transfer ${t.Id} by hand`;
  }
}
