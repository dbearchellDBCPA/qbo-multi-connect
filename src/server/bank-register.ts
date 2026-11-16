/**
 * Bank-register helpers for get_bank_register / get_uncleared_transactions.
 *
 * The TransactionList report is the wrong source for a per-account register:
 * Intuit's TransactionList query params have `cleared` and `source_account_type`
 * but NO `account` filter (Account.Id). QBO silently ignores unknown report
 * params, so `account=<id>` was dropped and every account returned the same
 * mixed company-wide list. Default TransactionList columns also omit
 * `is_cleared` and the running-balance column (`rbal_nat_amount`).
 *
 * GeneralLedger is the documented report that accepts `account` as Account.Id
 * and can request `is_cleared` + `rbal_nat_amount`.
 */
import { formatCurrency, headerPeriod, periodMismatchNote } from './report-shaping.js';

/** Columns that make a GL pull look like a bank register (Clr + running balance). */
export const BANK_REGISTER_COLUMNS =
  'tx_date,txn_type,doc_num,name,memo,split_acc,is_cleared,subt_nat_amount,rbal_nat_amount';

export interface ResolvedRegisterAccount {
  id: string;
  name: string;
  acctNum: string | null;
  accountType: string | null;
  label: string;
}

export type RegisterAccountResult =
  | { ok: true; account: ResolvedRegisterAccount }
  | { ok: false; error: string };

function displayName(a: any): string {
  return String(a?.FullyQualifiedName || a?.Name || '').trim();
}

function accountLabel(a: any): string {
  const num = String(a?.AcctNum ?? '').trim();
  const name = displayName(a) || `Account ${a?.Id}`;
  return num ? `${num} ${name}` : name;
}

function describeAccount(a: any): string {
  const num = a?.AcctNum ? ` [${a.AcctNum}]` : '';
  return `Id ${a?.Id}${num}  ${displayName(a) || '(unnamed)'}  (${a?.AccountType ?? '?'})`;
}

/**
 * Resolve a single bank/CC account from a caller term (QBO Account Id,
 * AcctNum, or exact name / fully-qualified name). Never falls back to "all
 * accounts" — unmatched or ambiguous terms are an error.
 */
export function resolveRegisterAccount(accountList: any[], term: string): RegisterAccountResult {
  const raw = String(term ?? '').trim();
  if (!raw) {
    return { ok: false, error: 'No account given. Pass account_id as a QBO Account ID, account number, or exact account name.' };
  }
  const lower = raw.toLowerCase();
  const list = accountList ?? [];

  const byId = list.filter((a) => a?.Id != null && String(a.Id) === raw);
  const byNum = list.filter((a) => String(a?.AcctNum ?? '').toLowerCase() === lower);
  const byName = list.filter((a) => {
    const name = String(a?.Name ?? '').toLowerCase();
    const fq = String(a?.FullyQualifiedName ?? '').toLowerCase();
    return name === lower || fq === lower;
  });

  const exact = new Map<string, any>();
  for (const a of [...byId, ...byNum, ...byName]) {
    if (a?.Id != null) exact.set(String(a.Id), a);
  }

  if (exact.size === 1) {
    return { ok: true, account: toResolved(exact.values().next().value) };
  }
  if (exact.size > 1) {
    // Id 104 vs AcctNum 104 is a real collision. These tools are bank/CC
    // registers, so prefer the unique Bank / Credit Card match when there is
    // one — otherwise ask the caller to pass the QBO Account ID.
    const bankish = [...exact.values()].filter((a) => /^(Bank|Credit Card)$/i.test(String(a?.AccountType ?? '')));
    if (bankish.length === 1) return { ok: true, account: toResolved(bankish[0]) };
    const lines = [...exact.values()].map((a) => `  ${describeAccount(a)}`).join('\n');
    return {
      ok: false,
      error: `Account "${raw}" matched more than one account (e.g. an Account ID and a different account's number). Nothing was returned — pass the QBO Account ID.\n${lines}`,
    };
  }

  // Last resort: unique case-insensitive name substring, only for reasonably
  // specific terms (avoid "Bank" matching every bank account).
  if (raw.length >= 4) {
    const loose = list.filter((a) => {
      const name = String(a?.Name ?? '').toLowerCase();
      const fq = String(a?.FullyQualifiedName ?? '').toLowerCase();
      return name.includes(lower) || fq.includes(lower);
    });
    if (loose.length === 1) return { ok: true, account: toResolved(loose[0]) };
    if (loose.length > 1) {
      const lines = loose.map((a) => `  ${describeAccount(a)}`).join('\n');
      return {
        ok: false,
        error: `Account "${raw}" is ambiguous — ${loose.length} accounts matched. Pass the QBO Account ID or the exact account number.\n${lines}`,
      };
    }
  }

  return {
    ok: false,
    error: `No account matched "${raw}". Use get_accounts to see IDs, numbers, and names. Nothing was returned (the register is not unfiltered).`,
  };
}

function toResolved(a: any): ResolvedRegisterAccount {
  return {
    id: String(a.Id),
    name: displayName(a) || String(a.Id),
    acctNum: a?.AcctNum != null && String(a.AcctNum).trim() !== '' ? String(a.AcctNum) : null,
    accountType: a?.AccountType != null ? String(a.AccountType) : null,
    label: accountLabel(a),
  };
}

function colKey(col: any): string {
  const meta = Array.isArray(col?.MetaData) ? col.MetaData : [];
  const found = meta.find((m: any) => String(m?.Name ?? '') === 'ColKey');
  return String(found?.Value ?? '').toLowerCase();
}

function colTitle(col: any): string {
  return String(col?.ColTitle ?? '').toLowerCase();
}

/** Find a report column by ColKey first, then by ColTitle. */
export function findRegisterColumn(cols: any[], keys: string[], titles: string[]): number {
  const keySet = keys.map((k) => k.toLowerCase());
  const titleSet = titles.map((t) => t.toLowerCase());
  const byKey = cols.findIndex((c) => keySet.includes(colKey(c)));
  if (byKey >= 0) return byKey;
  return cols.findIndex((c) => {
    const title = colTitle(c);
    return titleSet.some((t) => title === t || (t.length > 3 && title.includes(t)));
  });
}

export interface RegisterColumnIndex {
  date: number;
  type: number;
  num: number;
  name: number;
  memo: number;
  clr: number;
  amt: number;
  bal: number;
}

export function indexRegisterColumns(report: any): RegisterColumnIndex {
  const cols: any[] = report?.Columns?.Column ?? [];
  return {
    date: findRegisterColumn(cols, ['tx_date'], ['date']),
    type: findRegisterColumn(cols, ['txn_type'], ['transaction type', 'type']),
    num: findRegisterColumn(cols, ['doc_num'], ['no.', 'no', 'num']),
    name: findRegisterColumn(cols, ['name', 'cust_name', 'vend_name'], ['name']),
    memo: findRegisterColumn(cols, ['memo'], ['memo', 'memo/description', 'description']),
    clr: findRegisterColumn(cols, ['is_cleared'], ['clr', 'cleared', 'reconcile status']),
    amt: findRegisterColumn(cols, ['subt_nat_amount', 'nat_amount'], ['amount']),
    bal: findRegisterColumn(cols, ['rbal_nat_amount'], ['balance']),
  };
}

/**
 * True when the Clr cell is outstanding (not cleared, reconciled, or deposited).
 * QBO typically prints blank, "C", or "R" in this column.
 */
export function isUnclearedClr(value: unknown): boolean {
  const v = String(value ?? '').trim().toLowerCase();
  if (!v) return true;
  if (v === 'uncleared' || v === 'no' || v === 'false' || v === 'n' || v === 'outstanding') return true;
  return false;
}

function isLeafDataRow(row: any): boolean {
  if (!row || row.Rows) return false;
  if (!Array.isArray(row.ColData)) return false;
  if (row.type === 'Section') return false;
  if (row.group === 'GrandTotal' || row.type === 'Section') return false;
  return true;
}

export function collectRegisterRows(report: any): any[] {
  const rows: any[] = [];
  function walk(rowSet: any): void {
    if (!rowSet?.Row) return;
    const list = Array.isArray(rowSet.Row) ? rowSet.Row : [rowSet.Row];
    for (const row of list) {
      if (row?.Rows) walk(row.Rows);
      else if (isLeafDataRow(row)) rows.push(row);
    }
  }
  walk(report?.Rows);
  return rows;
}

/** Drop reconciled/cleared rows. Beginning-balance rows (no txn type, often no Clr) are kept only if uncleared. */
export function filterToUncleared(report: any): any {
  const idx = indexRegisterColumns(report);
  const keep = (row: any): boolean => {
    const cd = row.ColData ?? [];
    const type = idx.type >= 0 ? String(cd[idx.type]?.value ?? '') : '';
    if (/^beginning balance$/i.test(type.trim())) return false;
    const clr = idx.clr >= 0 ? cd[idx.clr]?.value : '';
    return isUnclearedClr(clr);
  };

  function filterRowSet(rowSet: any): any {
    if (!rowSet?.Row) return rowSet;
    const list = Array.isArray(rowSet.Row) ? rowSet.Row : [rowSet.Row];
    const next: any[] = [];
    for (const row of list) {
      if (row?.Rows) {
        const nested = filterRowSet(row.Rows);
        const nestedList = nested?.Row ? (Array.isArray(nested.Row) ? nested.Row : [nested.Row]) : [];
        if (nestedList.length > 0) next.push({ ...row, Rows: nested });
      } else if (isLeafDataRow(row) && keep(row)) {
        next.push(row);
      }
    }
    return { ...rowSet, Row: next };
  }

  return { ...report, Rows: filterRowSet(report?.Rows ?? { Row: [] }) };
}

export function formatBankRegister(
  report: any,
  clientName: string,
  accountLabel: string | undefined,
  title = 'BANK REGISTER',
  requested?: { start?: string; end?: string },
): string {
  const idx = indexRegisterColumns(report);
  const rows = collectRegisterRows(report);
  const period = headerPeriod(report);
  const periodLine = period.start || period.end
    ? `Period: ${period.start ?? '…'} to ${period.end ?? '…'}`
    : undefined;
  const mismatch = requested ? periodMismatchNote(requested, period) : null;

  const lines: string[] = [
    `${title} — ${clientName}`,
    accountLabel ? `Account: ${accountLabel}` : '',
    periodLine,
    `Transactions: ${rows.length}`,
    '─'.repeat(110),
    `${'Date'.padEnd(12)} ${'Type'.padEnd(20)} ${'No.'.padEnd(8)} ${'Name'.padEnd(25)} ${'Memo'.padEnd(25)} ${'Clr'.padEnd(4)} ${'Amount'.padStart(12)} ${'Balance'.padStart(12)}`,
    '─'.repeat(110),
  ].filter((line): line is string => Boolean(line));

  const v = (cd: any[], i: number) => (i >= 0 ? cd[i]?.value ?? '' : '');

  for (const row of rows) {
    const cd = row.ColData ?? [];
    const date = String(v(cd, idx.date)).padEnd(12);
    const type = String(v(cd, idx.type)).substring(0, 19).padEnd(20);
    const num = String(v(cd, idx.num)).substring(0, 7).padEnd(8);
    const name = String(v(cd, idx.name)).substring(0, 24).padEnd(25);
    const memo = String(v(cd, idx.memo)).substring(0, 24).padEnd(25);
    const clr = String(v(cd, idx.clr)).substring(0, 3).padEnd(4);
    const amt = (idx.amt >= 0 ? formatCurrency(v(cd, idx.amt)) : '').padStart(12);
    const bal = (idx.bal >= 0 ? formatCurrency(v(cd, idx.bal)) : '').padStart(12);
    lines.push(`${date} ${type} ${num} ${name} ${memo} ${clr} ${amt} ${bal}`);
  }

  if (mismatch) {
    lines.push('', mismatch);
  }
  if (idx.clr < 0 || idx.bal < 0) {
    const missing = [idx.clr < 0 ? 'Clr (is_cleared)' : null, idx.bal < 0 ? 'Balance (rbal_nat_amount)' : null].filter(Boolean);
    lines.push('', `⚠ QBO did not return ${missing.join(' or ')} for this pull — those columns are blank.`);
  }

  return lines.join('\n');
}

/** Default window for uncleared pulls when the caller omits dates (QBO would otherwise default to this month-to-date and hide older outstanding items). */
export function defaultUnclearedRange(now = new Date()): { start: string; end: string } {
  const iso = (d: Date) => {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  };
  const start = new Date(now.getFullYear() - 10, now.getMonth(), now.getDate());
  return { start: iso(start), end: iso(now) };
}
