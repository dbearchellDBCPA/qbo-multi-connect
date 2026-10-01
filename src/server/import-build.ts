// ─── Validation + QBO payload building for import_transactions ───────────────
//
// Pure: given one normalized transaction, the live-company context and the
// link resolver, return either the exact QBO payload to write or every
// reason the row cannot be written (failed) / cannot be written yet
// (blocked). Nothing here calls QBO. Unit-tested in
// tests/server/import-build.test.ts.
//
// QBO rules enforced before QBO sees the row (sources: Intuit API reference
// for each entity; QuickBooks help "You cannot use more than one A/R or A/P
// account in the same transaction"; DocNumber max 21 per doc-number.ts):
//   - every amount > 0 with at most 2 decimals; journal entries balance to the cent
//   - dates are real YYYY-MM-DD dates; on/before the books closing date fails
//     unless allow_closed_period
//   - a line on an Accounts Receivable account needs a Customer name, on
//     Accounts Payable a Vendor name; one transaction may touch at most ONE
//     A/R or A/P account (two A/R, two A/P, or A/R + A/P are all rejected)
//   - each account slot only accepts the account types QBO accepts there
//   - DocNumber ≤ 21, line Description ≤ 4000, PrivateNote ≤ 4000 (memo is
//     shortened so the [src:…] stamp always survives)

import { displayName as accountDisplayName, type QboAccount } from './account-hierarchy.js';
import { buildDepositTxnLines, type DepositDirectLineInput } from './line-converters.js';
import { DOC_NUMBER_MAX_LENGTH } from './doc-number.js';
import {
  resolveAccount,
  resolveName,
  resolveNamed,
  resolveItemForAccount,
  type CompanyContext,
  type NameEntry,
} from './import-context.js';
import { QBO_ENTITY_FOR, type NormalizedLine, type NormalizedTransaction, type TxnType, type NameType } from './import-schema.js';

export const MAX_PRIVATE_NOTE = 4000;
export const MAX_LINE_DESCRIPTION = 4000;

export interface BuildOptions {
  closeDate: string | null;
  allowClosedPeriod: boolean;
  classTrackingOn: boolean;
  classPerTxn: boolean;
  truncateDocNumbers: boolean;
  itemNamePattern: string;
}

export type LinkLookup =
  | { status: 'ready'; qboId: string; qboType: string }
  | { status: 'pending'; qboType: string }
  | { status: 'blocked'; reason: string };

export type LinkResolver = (sourceId: string) => LinkLookup;

export interface BuiltTxn {
  qboType: string;
  payload: Record<string, any>;
  amount: number;
  docNumber?: string;
  warnings: string[];
}

export type BuildResult =
  | { kind: 'ok'; built: BuiltTxn }
  | { kind: 'failed'; errors: string[]; warnings: string[] }
  | { kind: 'blocked'; reason: string; warnings: string[] };

// ── Small helpers ────────────────────────────────────────────────────────────

export function cents(n: number): number {
  return Math.round(n * 100);
}

export function money(n: number): string {
  return (Math.round(n * 100) / 100).toFixed(2);
}

export function isValidDate(s: string | undefined): boolean {
  if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

export function stampFor(sourceId: string): string {
  return `[src:${sourceId}]`;
}

/** Every source_id stamped in a PrivateNote. */
export function parseStamps(note: unknown): string[] {
  if (typeof note !== 'string' || !note) return [];
  return [...note.matchAll(/\[src:([^\]\r\n]+)\]/g)].map((m) => m[1]);
}

export function hasStamp(note: unknown, sourceId: string): boolean {
  return parseStamps(note).includes(sourceId);
}

/** Caller's memo, then the stamp; the memo is shortened (never the stamp) to fit 4000. */
export function stampedNote(memo: string | undefined, sourceId: string): { note: string; warning?: string } {
  const stamp = stampFor(sourceId);
  const m = (memo ?? '').trim();
  if (!m) return { note: stamp };
  const room = MAX_PRIVATE_NOTE - stamp.length - 1;
  if (m.length <= room) return { note: `${m} ${stamp}` };
  return { note: `${m.slice(0, room - 1)}… ${stamp}`, warning: `memo shortened to fit QBO's ${MAX_PRIVATE_NOTE}-character PrivateNote with the source stamp` };
}

function amountProblem(value: number | undefined, label: string): string | null {
  if (value === undefined || value === null || !Number.isFinite(value)) return `${label}: amount is missing or not a number.`;
  if (value <= 0) return `${label}: amount must be greater than 0 (got ${value}); express the side with posting_type or the transaction type, not a sign.`;
  if (Math.abs(cents(value) / 100 - value) > 1e-9) return `${label}: amount ${value} has more than 2 decimal places.`;
  return null;
}

const BANK = ['Bank'];
const CARD = ['Credit Card'];
const DEPOSIT_TO = ['Bank', 'Other Current Asset'];
const TRANSFER_TYPES = ['Bank', 'Credit Card', 'Other Current Asset', 'Other Asset', 'Fixed Asset', 'Other Current Liability', 'Long Term Liability', 'Equity'];
const AR = 'Accounts Receivable';
const AP = 'Accounts Payable';

function checkSlotType(account: QboAccount, allowed: string[], slot: string): string | null {
  if (allowed.includes(String(account.AccountType))) return null;
  return `${slot}: account "${accountDisplayName(account)}"${account.AcctNum ? ` (${account.AcctNum})` : ''} is ${account.AccountType ?? 'of unknown type'}, but this slot needs ${allowed.length === 1 ? `a ${allowed[0]} account` : `one of: ${allowed.join(', ')}`}.`;
}

/** Normalized txn_type for a QBO entity read back from QBO (rebuild_import_index). */
export function txnTypeForQbo(entityName: string, entity: any): TxnType | null {
  switch (entityName) {
    case 'Purchase': {
      if (entity?.PaymentType === 'CreditCard') return entity?.Credit === true ? 'CreditCardCredit' : 'CreditCardCharge';
      if (entity?.PaymentType === 'Check') return 'Check';
      return 'Expense';
    }
    case 'JournalEntry': case 'Deposit': case 'Transfer': case 'Bill': case 'BillPayment': case 'VendorCredit':
    case 'Invoice': case 'Payment': case 'CreditMemo': case 'SalesReceipt': case 'RefundReceipt':
      return entityName as TxnType;
    default:
      return null;
  }
}

/** The amount a QBO transaction reports (TotalAmt, Transfer Amount, or JE debits). */
export function qboTxnAmount(entityName: string, e: any): number | null {
  if (entityName === 'Transfer') return e?.Amount != null ? Number(e.Amount) : null;
  if (e?.TotalAmt != null) return Number(e.TotalAmt);
  if (entityName === 'JournalEntry') {
    const debits = (e?.Line ?? []).filter((l: any) => l?.JournalEntryLineDetail?.PostingType === 'Debit');
    return debits.reduce((s: number, l: any) => s + Number(l.Amount ?? 0), 0);
  }
  return null;
}

/** The document number stored for a QBO transaction (DocNumber, or Payment's PaymentRefNum). */
export function qboDocNumber(entityName: string, e: any): string | null {
  if (entityName === 'Payment') return e?.PaymentRefNum ?? null;
  return e?.DocNumber ?? null;
}

// ── Builder ──────────────────────────────────────────────────────────────────

interface LineCtx {
  errors: string[];
  warnings: string[];
  ctx: CompanyContext;
  opts: BuildOptions;
  txn: NormalizedTransaction;
}

function lineLabel(i: number): string {
  return `line ${i + 1}`;
}

function resolveClassRef(lc: LineCtx, className: string | undefined, slot: string): { value: string } | undefined {
  if (!className) return undefined;
  if (!lc.opts.classTrackingOn) return undefined;
  const r = resolveNamed(lc.ctx.classes, className, 'class', slot, 'Create it with create_class (classes are loaded with the chart).');
  if (!r.ok) {
    lc.errors.push(r.error);
    return undefined;
  }
  return { value: String(r.value.Id) };
}

function resolveLineAccount(lc: LineCtx, line: NormalizedLine, i: number): QboAccount | null {
  const r = resolveAccount(lc.ctx, { number: line.account_number, name: line.account_name }, lineLabel(i));
  if (!r.ok) {
    lc.errors.push(r.error);
    return null;
  }
  return r.value;
}

function resolveEntity(lc: LineCtx, ref: { name: string; type?: NameType } | undefined, slot: string, required?: NameType): NameEntry | null {
  if (!ref) return null;
  const r = resolveName(lc.ctx, ref, slot, required);
  if (!r.ok) {
    lc.errors.push(r.error);
    return null;
  }
  return r.value;
}

/** A/R lines need a Customer, A/P lines a Vendor; at most one A/R-or-A/P account per transaction. */
function checkArAp(lc: LineCtx, touched: Array<{ account: QboAccount; entity: NameEntry | null; label: string }>): void {
  const controlAccounts = new Map<string, QboAccount>();
  for (const t of touched) {
    const type = String(t.account.AccountType);
    if (type !== AR && type !== AP) continue;
    controlAccounts.set(String(t.account.Id), t.account);
    const need: NameType = type === AR ? 'Customer' : 'Vendor';
    if (!t.entity) lc.errors.push(`${t.label}: posts to ${type} "${accountDisplayName(t.account)}" — QBO requires a ${need} name on that line (entity: {name, type: "${need}"}).`);
    else if (t.entity.type !== need) lc.errors.push(`${t.label}: posts to ${type} "${accountDisplayName(t.account)}" with ${t.entity.type} "${t.entity.displayName}" — QBO requires a ${need} there.`);
  }
  if (controlAccounts.size > 1) {
    lc.errors.push(
      `QBO allows only one Accounts Receivable or Accounts Payable account per transaction (no two A/R, no two A/P, no A/R together with A/P); this one touches ${[...controlAccounts.values()].map((a) => `"${accountDisplayName(a)}" (${a.AccountType})`).join(' and ')}. Split it into two entries through a clearing account.`
    );
  }
}

function linesOrError(lc: LineCtx): NormalizedLine[] {
  const lines = lc.txn.lines ?? [];
  if (lines.length === 0) lc.errors.push(`${lc.txn.txn_type} needs at least one line.`);
  return lines;
}

function checkLineBasics(lc: LineCtx, lines: NormalizedLine[]): void {
  lines.forEach((l, i) => {
    const p = amountProblem(l.amount, lineLabel(i));
    if (p) lc.errors.push(p);
    if (l.description && l.description.length > MAX_LINE_DESCRIPTION) {
      lc.errors.push(`${lineLabel(i)}: description is ${l.description.length} characters; QBO allows at most ${MAX_LINE_DESCRIPTION}.`);
    }
  });
}

function sumLines(lines: NormalizedLine[]): number {
  return lines.reduce((s, l) => s + cents(l.amount ?? 0), 0) / 100;
}

function headerAccount(lc: LineCtx, allowed: string[], slot: string, required: boolean): QboAccount | null {
  const { account_number, account_name } = lc.txn;
  if (!account_number && !account_name) {
    if (required) lc.errors.push(`${slot}: required for ${lc.txn.txn_type} — pass account_number (or account_name).`);
    return null;
  }
  const r = resolveAccount(lc.ctx, { number: account_number, name: account_name }, slot);
  if (!r.ok) {
    lc.errors.push(r.error);
    return null;
  }
  const bad = checkSlotType(r.value, allowed, slot);
  if (bad) {
    lc.errors.push(bad);
    return null;
  }
  return r.value;
}

function applyDocNumber(lc: LineCtx, value: string | undefined, field = 'DocNumber'): string | undefined {
  if (value === undefined || value === '') return undefined;
  if (value.length <= DOC_NUMBER_MAX_LENGTH) return value;
  if (lc.opts.truncateDocNumbers) {
    const cut = value.slice(0, DOC_NUMBER_MAX_LENGTH);
    lc.warnings.push(`${field} "${value}" truncated to "${cut}" (QBO max ${DOC_NUMBER_MAX_LENGTH})`);
    return cut;
  }
  lc.errors.push(`${field} "${value}" is ${value.length} characters; QBO allows at most ${DOC_NUMBER_MAX_LENGTH}. Shorten it, or pass truncate_doc_numbers=true to cut it to ${DOC_NUMBER_MAX_LENGTH} with a warning.`);
  return undefined;
}

function expenseLines(lc: LineCtx, lines: NormalizedLine[], forbidAP: boolean): any[] {
  const touched: Array<{ account: QboAccount; entity: NameEntry | null; label: string }> = [];
  const built = lines.map((l, i) => {
    const account = resolveLineAccount(lc, l, i);
    const entity = resolveEntity(lc, l.entity, lineLabel(i));
    if (account && String(account.AccountType) === AP && forbidAP) {
      lc.errors.push(`${lineLabel(i)}: account "${accountDisplayName(account)}" is Accounts Payable — a ${lc.txn.txn_type} already posts to A/P; QBO does not allow a second A/P line. Use the expense/asset account the bill is for.`);
    } else if (account && String(account.AccountType) === AP) {
      lc.errors.push(`${lineLabel(i)}: account "${accountDisplayName(account)}" is Accounts Payable — QBO cannot post a ${lc.txn.txn_type} line to A/P (it has no vendor-per-line). Use a BillPayment, or a JournalEntry with the vendor on the A/P line.`);
    }
    if (account && String(account.AccountType) === AR) touched.push({ account, entity, label: lineLabel(i) });
    if (entity && entity.type !== 'Customer') {
      lc.errors.push(`${lineLabel(i)}: ${lc.txn.txn_type} lines can only carry a Customer (the "Customer" column); "${entity.displayName}" is a ${entity.type}. Put the payee on the transaction-level entity instead.`);
    }
    const detail: any = {};
    if (account) detail.AccountRef = { value: String(account.Id) };
    const cls = resolveClassRef(lc, l.class ?? lc.txn.class, lineLabel(i));
    if (cls) detail.ClassRef = cls;
    if (entity && entity.type === 'Customer') detail.CustomerRef = { value: entity.id };
    const line: any = { Amount: l.amount, DetailType: 'AccountBasedExpenseLineDetail', AccountBasedExpenseLineDetail: detail };
    if (l.description) line.Description = l.description;
    return line;
  });
  checkArAp(lc, touched);
  return built;
}

function salesLines(lc: LineCtx, lines: NormalizedLine[]): any[] {
  return lines.map((l, i) => {
    let itemId: string | null = null;
    if (l.item_name) {
      const r = resolveNamed(lc.ctx.items, l.item_name, 'item', lineLabel(i), 'Create it with ensure_items, or give account_number and let the tool find the item ensure_items made for that account.');
      if (r.ok) itemId = String(r.value.Id);
      else lc.errors.push(r.error);
    } else if (l.account_number || l.account_name) {
      const acct = resolveLineAccount(lc, l, i);
      if (acct) {
        const r = resolveItemForAccount(lc.ctx, acct, lc.opts.itemNamePattern, lineLabel(i));
        if (r.ok) itemId = String(r.value.Id);
        else lc.errors.push(r.error);
      }
    } else {
      lc.errors.push(`${lineLabel(i)}: ${lc.txn.txn_type} lines need item_name, or account_number/account_name of an income account that ensure_items has an item for.`);
    }
    if (l.entity) lc.warnings.push(`${lineLabel(i)}: line-level entity ignored on ${lc.txn.txn_type} (the customer is the transaction-level entity)`);
    const qty = l.quantity ?? 1;
    if (!(qty > 0)) lc.errors.push(`${lineLabel(i)}: quantity must be greater than 0.`);
    const detail: any = { Qty: qty, UnitPrice: qty > 0 ? l.amount / qty : l.amount };
    if (itemId) detail.ItemRef = { value: itemId };
    const cls = resolveClassRef(lc, l.class ?? lc.txn.class, lineLabel(i));
    if (cls) detail.ClassRef = cls;
    const line: any = { Amount: l.amount, DetailType: 'SalesItemLineDetail', SalesItemLineDetail: detail };
    if (l.description) line.Description = l.description;
    return line;
  });
}

export function buildTransaction(txn: NormalizedTransaction, ctx: CompanyContext, opts: BuildOptions, links: LinkResolver): BuildResult {
  const lc: LineCtx = { errors: [], warnings: [], ctx, opts, txn };
  const type = txn.txn_type;
  const qboType = QBO_ENTITY_FOR[type];

  // Dates and closed period.
  if (!isValidDate(txn.txn_date)) {
    lc.errors.push(`txn_date "${txn.txn_date}" is not a valid YYYY-MM-DD date.`);
  } else if (opts.closeDate && txn.txn_date <= opts.closeDate) {
    if (!opts.allowClosedPeriod) {
      lc.errors.push(`txn_date ${txn.txn_date} is on or before the company's books closing date ${opts.closeDate}. Pass allow_closed_period=true to post into the closed period (QBO may still require the closing-date password and will say so).`);
    } else {
      lc.warnings.push(`posting into the closed period (closing date ${opts.closeDate})`);
    }
  }
  if (txn.due_date !== undefined && !isValidDate(txn.due_date)) lc.errors.push(`due_date "${txn.due_date}" is not a valid YYYY-MM-DD date.`);

  // Class preference.
  const anyClass = Boolean(txn.class) || (txn.lines ?? []).some((l) => l.class);
  if (anyClass && !opts.classTrackingOn) lc.warnings.push('class tracking is off in this company — classes dropped (turn on Settings → Advanced → Categories → Track classes to keep them)');

  const note = stampedNote(txn.memo, txn.source_id);
  if (note.warning) lc.warnings.push(note.warning);

  const payload: Record<string, any> = { TxnDate: txn.txn_date, PrivateNote: note.note };
  let amount = 0;
  let docNumber: string | undefined;

  const headerEntity = (required: NameType | null, mustExist: boolean): NameEntry | null => {
    if (!txn.entity) {
      if (mustExist) lc.errors.push(`entity: ${type} requires a ${required} (entity: {name, type: "${required}"}).`);
      return null;
    }
    return resolveEntity(lc, txn.entity, 'entity', required ?? undefined);
  };

  switch (type) {
    case 'JournalEntry': {
      if (txn.entity) lc.warnings.push('transaction-level entity applied to lines without their own entity');
      const lines = linesOrError(lc);
      checkLineBasics(lc, lines);
      let debits = 0;
      let credits = 0;
      const touched: Array<{ account: QboAccount; entity: NameEntry | null; label: string }> = [];
      payload.Line = lines.map((l, i) => {
        if (!l.posting_type) lc.errors.push(`${lineLabel(i)}: posting_type ("Debit" or "Credit") is required on journal entry lines.`);
        if (l.posting_type === 'Debit') debits += cents(l.amount ?? 0);
        if (l.posting_type === 'Credit') credits += cents(l.amount ?? 0);
        const account = resolveLineAccount(lc, l, i);
        const entity = resolveEntity(lc, l.entity ?? txn.entity, lineLabel(i));
        if (account) touched.push({ account, entity, label: lineLabel(i) });
        const detail: any = { PostingType: l.posting_type };
        if (account) detail.AccountRef = { value: String(account.Id) };
        if (entity) detail.Entity = { Type: entity.type, EntityRef: { value: entity.id } };
        const cls = resolveClassRef(lc, l.class ?? txn.class, lineLabel(i));
        if (cls) detail.ClassRef = cls;
        const line: any = { Amount: l.amount, DetailType: 'JournalEntryLineDetail', JournalEntryLineDetail: detail };
        if (l.description) line.Description = l.description;
        return line;
      });
      checkArAp(lc, touched);
      if (lines.length > 0 && debits !== credits) {
        lc.errors.push(`journal entry does not balance: debits ${money(debits / 100)}, credits ${money(credits / 100)} (difference ${money(Math.abs(debits - credits) / 100)}).`);
      }
      amount = debits / 100;
      docNumber = applyDocNumber(lc, txn.doc_number);
      break;
    }

    case 'Expense': case 'Check': case 'CreditCardCharge': case 'CreditCardCredit': {
      const paymentType = type === 'Check' ? 'Check' : type === 'Expense' ? (txn.payment_method ?? 'Cash') : 'CreditCard';
      if (type !== 'Expense' && txn.payment_method && txn.payment_method !== paymentType) {
        lc.warnings.push(`payment_method ${txn.payment_method} ignored — ${type} is always PaymentType ${paymentType}`);
      }
      const acct = headerAccount(lc, paymentType === 'CreditCard' ? CARD : BANK, paymentType === 'CreditCard' ? 'credit card account' : 'bank account', true);
      payload.PaymentType = paymentType;
      if (acct) payload.AccountRef = { value: String(acct.Id) };
      if (type === 'CreditCardCredit') payload.Credit = true;
      const ent = headerEntity(null, false);
      if (ent) payload.EntityRef = { value: ent.id, type: ent.type };
      const lines = linesOrError(lc);
      checkLineBasics(lc, lines);
      payload.Line = expenseLines(lc, lines, false);
      amount = sumLines(lines);
      if (paymentType === 'Check') {
        payload.PrintStatus = 'NotSet';
        docNumber = applyDocNumber(lc, txn.check_number ?? txn.doc_number, txn.check_number ? 'check_number' : 'DocNumber');
      } else {
        docNumber = applyDocNumber(lc, txn.doc_number);
        if (txn.check_number) lc.warnings.push('check_number ignored (not a check payment)');
      }
      break;
    }

    case 'Deposit': {
      const acct = headerAccount(lc, DEPOSIT_TO, 'deposit-to account', true);
      if (acct) payload.DepositToAccountRef = { value: String(acct.Id) };
      const lines = linesOrError(lc);
      checkLineBasics(lc, lines);
      const touched: Array<{ account: QboAccount; entity: NameEntry | null; label: string }> = [];
      const direct: DepositDirectLineInput[] = lines.map((l, i) => {
        const account = resolveLineAccount(lc, l, i);
        const entity = resolveEntity(lc, l.entity ?? txn.entity, lineLabel(i));
        if (account) touched.push({ account, entity, label: lineLabel(i) });
        const cls = resolveClassRef(lc, l.class ?? txn.class, lineLabel(i));
        const d: DepositDirectLineInput = { account_id: account ? String(account.Id) : '', amount: l.amount } as DepositDirectLineInput;
        if (l.description) d.description = l.description;
        if (cls) d.class_id = cls.value;
        if (entity) {
          d.entity_id = entity.id;
          d.entity_type = entity.type;
        }
        return d;
      });
      checkArAp(lc, touched);
      payload.Line = buildDepositTxnLines([], direct);
      amount = sumLines(lines);
      docNumber = applyDocNumber(lc, txn.doc_number);
      break;
    }

    case 'Transfer': {
      const from = headerAccount(lc, TRANSFER_TYPES, 'transfer-from account', true);
      let to: QboAccount | null = null;
      if (!txn.transfer_to_account_number && !txn.transfer_to_account_name) {
        lc.errors.push('transfer_to_account_number: required for Transfer.');
      } else {
        const r = resolveAccount(ctx, { number: txn.transfer_to_account_number, name: txn.transfer_to_account_name }, 'transfer-to account');
        if (!r.ok) lc.errors.push(r.error);
        else {
          const bad = checkSlotType(r.value, TRANSFER_TYPES, 'transfer-to account');
          if (bad) lc.errors.push(bad);
          else to = r.value;
        }
      }
      if (from && to && String(from.Id) === String(to.Id)) lc.errors.push('Transfer from and to the same account.');
      const lines = txn.lines ?? [];
      const amt = txn.amount ?? (lines.length === 1 ? lines[0].amount : undefined);
      if (txn.amount === undefined && lines.length > 1) lc.errors.push('Transfer takes one amount: pass amount (or a single line).');
      const p = amountProblem(amt, 'amount');
      if (p) lc.errors.push(p);
      if (from) payload.FromAccountRef = { value: String(from.Id) };
      if (to) payload.ToAccountRef = { value: String(to.Id) };
      payload.Amount = amt;
      amount = amt ?? 0;
      if (txn.class || lines.some((l) => l.class)) lc.warnings.push('Transfer has no class in QBO — class dropped');
      if (txn.entity) lc.warnings.push('Transfer has no name in QBO — entity dropped');
      if (txn.doc_number) lc.warnings.push('Transfer has no DocNumber in QBO — doc_number kept only in the import store');
      docNumber = undefined;
      break;
    }

    case 'Bill': case 'VendorCredit': {
      const vendor = headerEntity('Vendor', true);
      if (vendor) payload.VendorRef = { value: vendor.id };
      const ap = headerAccount(lc, [AP], 'A/P account', false);
      if (ap) payload.APAccountRef = { value: String(ap.Id) };
      const lines = linesOrError(lc);
      checkLineBasics(lc, lines);
      payload.Line = expenseLines(lc, lines, true);
      amount = sumLines(lines);
      docNumber = applyDocNumber(lc, txn.doc_number);
      if (type === 'Bill') {
        if (txn.due_date) payload.DueDate = txn.due_date;
        if (txn.terms) {
          const t = resolveNamed(ctx.terms, txn.terms, 'term', 'terms', 'Check the name with query_transactions "SELECT * FROM Term".');
          if (t.ok) payload.SalesTermRef = { value: String(t.value.Id) };
          else lc.errors.push(t.error);
        }
      }
      break;
    }

    case 'Invoice': case 'CreditMemo': case 'SalesReceipt': case 'RefundReceipt': {
      const needsCustomer = type === 'Invoice' || type === 'CreditMemo';
      const customer = headerEntity('Customer', needsCustomer);
      if (customer) payload.CustomerRef = { value: customer.id };
      if (type === 'SalesReceipt' || type === 'RefundReceipt') {
        const acct = headerAccount(lc, DEPOSIT_TO, type === 'RefundReceipt' ? 'refund-from account' : 'deposit-to account', type === 'RefundReceipt');
        if (acct) payload.DepositToAccountRef = { value: String(acct.Id) };
      } else {
        const ar = headerAccount(lc, [AR], 'A/R account', false);
        if (ar) payload.ARAccountRef = { value: String(ar.Id) };
      }
      const lines = linesOrError(lc);
      checkLineBasics(lc, lines);
      payload.Line = salesLines(lc, lines);
      if (opts.classTrackingOn && opts.classPerTxn && txn.class) {
        const cls = resolveClassRef(lc, txn.class, 'class');
        if (cls) payload.ClassRef = cls;
      }
      amount = sumLines(lines);
      docNumber = applyDocNumber(lc, txn.doc_number);
      if (type === 'Invoice') {
        if (txn.due_date) payload.DueDate = txn.due_date;
        if (txn.terms) {
          const t = resolveNamed(ctx.terms, txn.terms, 'term', 'terms', 'Check the name with query_transactions "SELECT * FROM Term".');
          if (t.ok) payload.SalesTermRef = { value: String(t.value.Id) };
          else lc.errors.push(t.error);
        }
      }
      break;
    }

    case 'Payment': case 'BillPayment': {
      const isBill = type === 'BillPayment';
      const party = headerEntity(isBill ? 'Vendor' : 'Customer', true);
      if (party) payload[isBill ? 'VendorRef' : 'CustomerRef'] = { value: party.id };
      const linked = txn.linked ?? [];
      if (isBill && linked.length === 0) lc.errors.push('BillPayment needs linked: [{source_id of the Bill, amount}].');
      if ((txn.lines ?? []).length > 0) lc.warnings.push(`${type} lines ignored — the applied amounts come from linked[]`);
      const allowedTargets = isBill ? ['Bill', 'VendorCredit', 'JournalEntry'] : ['Invoice', 'CreditMemo', 'JournalEntry'];
      const blockers: string[] = [];
      const qboLines: any[] = [];
      let appliedCents = 0;
      linked.forEach((lk, i) => {
        const p = amountProblem(lk.amount, `linked ${i + 1}`);
        if (p) lc.errors.push(p);
        appliedCents += cents(lk.amount ?? 0);
        const r = links(lk.source_id);
        if (r.status === 'blocked') {
          blockers.push(r.reason);
          return;
        }
        if (!allowedTargets.includes(r.qboType)) {
          lc.errors.push(`linked ${i + 1}: source_id ${lk.source_id} was imported as a ${r.qboType}; a ${type} can only be applied to ${allowedTargets.join(' / ')}.`);
          return;
        }
        qboLines.push({ Amount: lk.amount, LinkedTxn: [{ TxnId: r.status === 'ready' ? r.qboId : `pending:${lk.source_id}`, TxnType: r.qboType }] });
      });
      const total = txn.amount ?? appliedCents / 100;
      const tp = amountProblem(total, 'amount');
      if (tp) lc.errors.push(tp);
      if (txn.amount !== undefined && cents(txn.amount) < appliedCents) {
        lc.errors.push(`amount ${money(txn.amount)} is less than the ${money(appliedCents / 100)} applied through linked[].`);
      }
      payload.TotalAmt = total;
      payload.Line = qboLines;
      amount = total;
      if (isBill) {
        const method = txn.payment_method === 'CreditCard' ? 'CreditCard' : 'Check';
        if (txn.payment_method === 'Cash') lc.warnings.push('BillPayment payment_method Cash recorded as PayType Check (QBO bill payments are Check or CreditCard)');
        const acct = headerAccount(lc, method === 'CreditCard' ? CARD : BANK, method === 'CreditCard' ? 'paid-from credit card account' : 'paid-from bank account', true);
        payload.PayType = method;
        if (method === 'Check') {
          payload.CheckPayment = { PrintStatus: 'NotSet', ...(acct ? { BankAccountRef: { value: String(acct.Id) } } : {}) };
        } else {
          payload.CreditCardPayment = acct ? { CCAccountRef: { value: String(acct.Id) } } : {};
        }
        docNumber = applyDocNumber(lc, txn.check_number ?? txn.doc_number, txn.check_number ? 'check_number' : 'DocNumber');
      } else {
        const acct = headerAccount(lc, DEPOSIT_TO, 'deposit-to account', false);
        if (acct) payload.DepositToAccountRef = { value: String(acct.Id) };
        docNumber = applyDocNumber(lc, txn.check_number ?? txn.doc_number, 'PaymentRefNum');
      }
      if (lc.errors.length === 0 && blockers.length > 0) {
        return { kind: 'blocked', reason: blockers.join(' '), warnings: lc.warnings };
      }
      break;
    }
  }

  if (docNumber !== undefined) {
    if (type === 'Payment') payload.PaymentRefNum = docNumber;
    else payload.DocNumber = docNumber;
  }

  if (lc.errors.length > 0) return { kind: 'failed', errors: lc.errors, warnings: lc.warnings };
  return { kind: 'ok', built: { qboType, payload, amount, docNumber, warnings: lc.warnings } };
}
