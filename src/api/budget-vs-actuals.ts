/**
 * Budget vs Actuals, computed from first principles:
 *   budget  = the QBO Budget entity (BudgetDetail lines), resolved by Id or name
 *   actuals = a ProfitAndLoss report for the same start..end and basis
 *
 * Why not Intuit's reports/BudgetVsActuals? Two live failures (Northway
 * Church, 2026-09-30, and Erick Erickson, LLC, 2026-09-05):
 *  - the budget is selected by a `budget` query param; this server sent
 *    `budget_id`, which QBO silently ignores, so every request came back for
 *    the company's default (newest) budget — FY27 no matter which was asked;
 *  - in Total mode the report ignored start_date/end_date and returned an
 *    Actual column that was ALL-TIME (no StartPeriod/EndPeriod in its Header),
 *    and Month/Quarter answer with a NullPointerException Fault.
 * ProfitAndLoss honours start/end/accounting_method/class reliably, and the
 * Budget entity is exactly what the user picked, so the comparison is built
 * here. Everything in this file is pure (no I/O) so it is unit-testable.
 */

export interface BudgetMeta {
  Id?: string;
  Name?: string;
  StartDate?: string;
  EndDate?: string;
  BudgetEntryType?: string;
  BudgetType?: string;
  Active?: boolean;
  BudgetDetail?: any[];
}

// ─── Budget resolution (by Id or name) ────────────────────────────────────────

export interface BudgetSelector {
  budgetId?: string;
  budgetName?: string;
}

function describeBudget(b: any): string {
  return `${b?.Id ?? '?'} "${b?.Name ?? ''}" (${b?.StartDate ?? '…'} → ${b?.EndDate ?? '…'})`;
}

function normName(s: unknown): string {
  return String(s ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * Pick exactly one budget by Id or name. Name matching: exact
 * (case/whitespace-insensitive) first, then a UNIQUE substring match. An
 * ambiguous or unknown selector is an error that lists the candidates — a
 * silent "closest" pick is how the wrong budget got reported before.
 */
export function resolveBudget(
  budgets: any[],
  sel: BudgetSelector
): { budget: any | null; error: string | null } {
  const all = budgets ?? [];
  const list = all.length
    ? `Budgets in this company:\n  ${all.map(describeBudget).join('\n  ')}`
    : 'This company has no budgets (create one in the QBO web UI first).';
  const id = sel.budgetId?.trim();
  const name = sel.budgetName?.trim();
  if (!id && !name) {
    return { budget: null, error: `Pass budget_id or budget_name (find them with get_budget). ${list}` };
  }
  let byId: any | null = null;
  if (id) {
    byId = all.find((b) => String(b?.Id ?? '') === id) ?? null;
    if (!byId) return { budget: null, error: `Budget ${id} not found. ${list}` };
    if (!name) return { budget: byId, error: null };
  }
  const needle = normName(name);
  let matches = all.filter((b) => normName(b?.Name) === needle);
  if (matches.length === 0) matches = all.filter((b) => normName(b?.Name).includes(needle));
  if (byId) {
    if (!matches.some((b) => String(b.Id) === String(byId.Id))) {
      return { budget: null, error: `budget_id ${id} is ${describeBudget(byId)}, which does not match budget_name "${name}". Pass one of them, or make them agree.` };
    }
    return { budget: byId, error: null };
  }
  if (matches.length === 1) return { budget: matches[0], error: null };
  if (matches.length === 0) return { budget: null, error: `No budget named "${name}". ${list}` };
  return {
    budget: null,
    error: `budget_name "${name}" matches ${matches.length} budgets — pass budget_id (or the exact name):\n  ${matches.map(describeBudget).join('\n  ')}`,
  };
}

// ─── Dates ────────────────────────────────────────────────────────────────────

const DAY_MS = 24 * 60 * 60 * 1000;

function toUtc(iso: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) throw new Error(`Invalid date: ${iso}`);
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

function fromUtc(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Inclusive day count between two ISO dates. */
function daysInclusive(start: string, end: string): number {
  return Math.round((toUtc(end) - toUtc(start)) / DAY_MS) + 1;
}

/** Last day of the period that starts on `start` and spans `months` months. */
function periodEnd(start: string, months: number): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(start)!;
  // Day 0 of (month + months) is the last day of the period's final month.
  return fromUtc(Date.UTC(Number(m[1]), Number(m[2]) - 1 + months, 0));
}

function monthsPerEntry(entryType: string | undefined): number {
  const t = String(entryType ?? '').toLowerCase();
  if (t.startsWith('quarter')) return 3;
  if (t.startsWith('annual') || t.startsWith('year')) return 12;
  return 1; // Monthly (QBO's default and by far the common case)
}

export type PartialPeriodMode = 'prorate' | 'full';

export interface BudgetPeriodSlice {
  period_start: string;
  period_end: string;
  /** Share of this budget period's amount counted in the requested range (0..1). */
  factor: number;
}

export interface BudgetLine {
  account_id: string;
  account_name?: string;
  class_id: string | null;
  class_name?: string | null;
  amount: number;
}

/**
 * Budget amounts falling inside start..end, keyed by account + class.
 * A budget period that is only partly inside the range is pro-rated by days
 * (mode 'prorate', the default) or counted in full (mode 'full').
 */
export function budgetAmountsForRange(
  budget: BudgetMeta,
  start: string,
  end: string,
  mode: PartialPeriodMode = 'prorate'
): { lines: BudgetLine[]; periods: BudgetPeriodSlice[] } {
  const months = monthsPerEntry(budget.BudgetEntryType);
  const budgetEnd = budget.EndDate ? String(budget.EndDate).slice(0, 10) : undefined;
  const byKey = new Map<string, BudgetLine>();
  const periods = new Map<string, BudgetPeriodSlice>();

  for (const d of budget.BudgetDetail ?? []) {
    const pStart = String(d?.BudgetDate ?? '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(pStart)) continue;
    let pEnd = periodEnd(pStart, months);
    if (budgetEnd && pEnd > budgetEnd) pEnd = budgetEnd;
    const oStart = pStart > start ? pStart : start;
    const oEnd = pEnd < end ? pEnd : end;
    if (oStart > oEnd) continue; // no overlap with the requested range
    const factor = mode === 'full' ? 1 : daysInclusive(oStart, oEnd) / daysInclusive(pStart, pEnd);
    if (!periods.has(pStart)) periods.set(pStart, { period_start: pStart, period_end: pEnd, factor: Math.round(factor * 10000) / 10000 });

    const amount = (parseFloat(String(d?.Amount ?? '0')) || 0) * factor;
    const accountId = String(d?.AccountRef?.value ?? '');
    if (!accountId) continue;
    const classId = d?.ClassRef?.value != null && d.ClassRef.value !== '' ? String(d.ClassRef.value) : null;
    const key = `${accountId}|${classId ?? ''}`;
    const line = byKey.get(key) ?? {
      account_id: accountId,
      account_name: d?.AccountRef?.name,
      class_id: classId,
      class_name: d?.ClassRef?.name ?? null,
      amount: 0,
    };
    line.amount += amount;
    byKey.set(key, line);
  }
  return {
    lines: Array.from(byKey.values()),
    periods: Array.from(periods.values()).sort((a, b) => a.period_start.localeCompare(b.period_start)),
  };
}

/** How much of start..end the budget's own StartDate..EndDate covers. */
export function budgetCoverage(budget: BudgetMeta, start: string, end: string): 'full' | 'partial' | 'none' {
  const bs = budget.StartDate ? String(budget.StartDate).slice(0, 10) : undefined;
  const be = budget.EndDate ? String(budget.EndDate).slice(0, 10) : undefined;
  if ((bs && bs > end) || (be && be < start)) return 'none';
  if ((bs && bs > start) || (be && be < end)) return 'partial';
  return 'full';
}

// ─── P&L actuals extraction ───────────────────────────────────────────────────

export interface PnlColumn {
  index: number;
  title: string;
  /** QBO Class Id for a class column; null for "Not Specified"; undefined for the Total column. */
  class_id?: string | null;
  is_total: boolean;
}

export interface PnlActualRow {
  account_id: string | null;
  account_name: string;
  /** P&L section group: Income | COGS | Expenses | OtherIncome | OtherExpenses (as QBO labels it). */
  section: string | null;
  total: number;
  /** class_id ('' = Not Specified) → amount; only for a Classes-summarized report. */
  by_class: Map<string, number>;
}

function money(v: any): number {
  return parseFloat(String(v ?? '').replace(/,/g, '')) || 0;
}

/**
 * Map a ProfitAndLoss report's columns. For summarize_column_by=Classes the
 * class columns are matched to QBO Class Ids via the column's ColKey
 * metadata when it is a known class Id, else by title against the class
 * list (Name or FullyQualifiedName). The last Money column is the Total.
 */
export function mapPnlColumns(report: any, classes: any[] = []): PnlColumn[] {
  const cols: any[] = report?.Columns?.Column ?? [];
  const classIds = new Set(classes.map((c) => String(c?.Id ?? '')));
  const byTitle = new Map<string, string>();
  for (const c of classes) {
    if (c?.Name) byTitle.set(normName(c.Name), String(c.Id));
    if (c?.FullyQualifiedName) byTitle.set(normName(c.FullyQualifiedName), String(c.Id));
  }
  let lastMoney = -1;
  cols.forEach((c, i) => {
    if (i > 0 && String(c?.ColType ?? 'Money') !== 'Account') lastMoney = i;
  });
  const out: PnlColumn[] = [];
  cols.forEach((c, i) => {
    if (i === 0) return; // account label column
    const title = String(c?.ColTitle ?? '');
    const isTotal = i === lastMoney;
    if (isTotal) {
      out.push({ index: i, title, is_total: true });
      return;
    }
    const meta: any[] = Array.isArray(c?.MetaData) ? c.MetaData : [];
    const colKey = meta.find((m) => m?.Name === 'ColKey')?.Value;
    let classId: string | null | undefined;
    if (colKey != null && classIds.has(String(colKey))) classId = String(colKey);
    else if (byTitle.has(normName(title))) classId = byTitle.get(normName(title))!;
    else if (/^(not specified|unclassified|no class|)$/i.test(title.trim())) classId = null;
    else classId = undefined;
    out.push({ index: i, title, class_id: classId, is_total: false });
  });
  return out;
}

export interface PnlActuals {
  rows: PnlActualRow[];
  columns: PnlColumn[];
  /** QBO's own Net Income from the report (Total column), when present. */
  net_income: number | null;
  /** Class column titles that could not be matched to a QBO Class. */
  unmatched_class_columns: string[];
}

/**
 * Leaf account amounts from a ProfitAndLoss report. Data rows (bare ColData
 * — QBO's row `type` is optional) carry the account; section Summary rows
 * are totals and are skipped, except the NetIncome summary which is kept for
 * reconciliation. A parent account's own postings appear as a data row
 * inside its section, so no amount is ever counted twice.
 */
export function extractPnlActuals(report: any, classes: any[] = []): PnlActuals {
  const columns = mapPnlColumns(report, classes);
  const totalCol = columns.find((c) => c.is_total);
  const classCols = columns.filter((c) => !c.is_total);
  const rows: PnlActualRow[] = [];
  let netIncome: number | null = null;

  const walk = (rowSet: any, section: string | null): void => {
    for (const row of rowSet?.Row ?? []) {
      const group = row?.group ? String(row.group) : null;
      const isSection = Boolean(row?.Rows || row?.Header || row?.Summary);
      if (isSection) {
        const sec = section ?? group;
        if (row.Rows) walk(row.Rows, sec);
        if (group === 'NetIncome' && row.Summary?.ColData && totalCol) {
          netIncome = money(row.Summary.ColData[totalCol.index]?.value);
        }
        continue;
      }
      const cd: any[] = row?.ColData ?? [];
      if (!cd.length) continue;
      const label = String(cd[0]?.value ?? '');
      if (group === 'NetIncome' && totalCol) {
        netIncome = money(cd[totalCol.index]?.value);
        continue;
      }
      if (!label) continue;
      const byClass = new Map<string, number>();
      for (const c of classCols) {
        const key = c.class_id === undefined ? `title:${c.title}` : (c.class_id ?? '');
        byClass.set(key, (byClass.get(key) ?? 0) + money(cd[c.index]?.value));
      }
      rows.push({
        account_id: cd[0]?.id != null ? String(cd[0].id) : null,
        account_name: label,
        section,
        total: totalCol ? money(cd[totalCol.index]?.value) : 0,
        by_class: byClass,
      });
    }
  };
  walk(report?.Rows, null);
  return {
    rows,
    columns,
    net_income: netIncome,
    unmatched_class_columns: classCols.filter((c) => c.class_id === undefined).map((c) => c.title),
  };
}

// ─── Assembly ─────────────────────────────────────────────────────────────────

const SECTION_ORDER = ['Income', 'Cost of Goods Sold', 'Expenses', 'Other Income', 'Other Expenses'] as const;
type Section = (typeof SECTION_ORDER)[number] | 'Other';

/** Section from the P&L group label, else from the account's AccountType / Classification. */
function sectionFor(pnlGroup: string | null, account: any | undefined): Section {
  const g = String(pnlGroup ?? '').toLowerCase();
  if (g === 'income') return 'Income';
  if (g === 'cogs') return 'Cost of Goods Sold';
  if (g === 'expenses') return 'Expenses';
  if (g === 'otherincome') return 'Other Income';
  if (g === 'otherexpenses') return 'Other Expenses';
  const t = String(account?.AccountType ?? '').toLowerCase();
  if (t === 'income') return 'Income';
  if (t === 'cost of goods sold') return 'Cost of Goods Sold';
  if (t === 'expense') return 'Expenses';
  if (t === 'other income') return 'Other Income';
  if (t === 'other expense') return 'Other Expenses';
  const cls = String(account?.Classification ?? '').toLowerCase();
  if (cls === 'revenue') return 'Income';
  if (cls === 'expense') return 'Expenses';
  return 'Other';
}

/** +1 when the section adds to net income, -1 when it subtracts. */
function netSign(section: Section): number {
  return section === 'Income' || section === 'Other Income' ? 1 : section === 'Other' ? 0 : -1;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

function variance(actual: number, budget: number) {
  return {
    actual: round2(actual),
    budget: round2(budget),
    over_budget: round2(actual - budget),
    pct_of_budget: budget !== 0 ? Math.round((actual / budget) * 10000) / 100 : null,
  };
}

export interface ComputeBvaInput {
  clientName: string;
  budget: BudgetMeta;
  startDate: string;
  endDate: string;
  accountingMethod: 'Cash' | 'Accrual';
  pnl: any;
  accounts?: any[];
  classes?: any[];
  splitByClass?: boolean;
  classId?: string;
  partialPeriods?: PartialPeriodMode;
  includeZeroRows?: boolean;
}

/**
 * Join budget lines and P&L actuals per account (and per class when split),
 * with section subtotals, net income, and reconciliation warnings.
 */
export function computeBudgetVsActuals(input: ComputeBvaInput): any {
  const {
    budget, startDate, endDate, accountingMethod, pnl,
    accounts = [], classes = [], splitByClass = false, classId,
    partialPeriods = 'prorate', includeZeroRows = false,
  } = input;
  const warnings: string[] = [];

  const accountById = new Map<string, any>();
  for (const a of accounts) if (a?.Id != null) accountById.set(String(a.Id), a);
  const classNameById = new Map<string, string>();
  for (const c of classes) if (c?.Id != null) classNameById.set(String(c.Id), String(c.FullyQualifiedName ?? c.Name ?? ''));

  // Budget side
  const coverage = budgetCoverage(budget, startDate, endDate);
  if (coverage === 'none') {
    warnings.push(`Budget ${describeBudget(budget)} does not cover any of ${startDate}..${endDate}, so every budget amount is 0. Pick the budget for that fiscal year (get_budget lists them).`);
  } else if (coverage === 'partial') {
    warnings.push(`Budget ${describeBudget(budget)} covers only part of ${startDate}..${endDate}; days outside the budget have no budget amounts.`);
  }
  const { lines: allBudgetLines, periods } = budgetAmountsForRange(budget, startDate, endDate, partialPeriods);
  const budgetLines = classId ? allBudgetLines.filter((l) => l.class_id === classId) : allBudgetLines;
  for (const l of allBudgetLines) {
    // Inactive classes are not in the Class list; the budget's ClassRef name still is.
    if (l.class_id && l.class_name && !classNameById.has(l.class_id)) classNameById.set(l.class_id, l.class_name);
  }
  const prorated = periods.filter((p) => p.factor > 0 && p.factor < 1);
  if (prorated.length) {
    warnings.push(`Partial budget period(s) pro-rated by days: ${prorated.map((p) => `${p.period_start}..${p.period_end} × ${p.factor}`).join(', ')}. Pass partial_periods="full" to count them in full.`);
  }
  if (splitByClass && budgetLines.length > 0 && budgetLines.every((l) => l.class_id === null)) {
    warnings.push('This budget has no class breakdown (no ClassRef on its lines), so all of its amounts sit under "Not Specified".');
  }

  // Actuals side
  const reqPeriod = { start: startDate, end: endDate };
  const h = pnl?.Header ?? {};
  if (!h.StartPeriod && !h.EndPeriod) {
    warnings.push(`The ProfitAndLoss report did not echo StartPeriod/EndPeriod, so QBO did not confirm actuals are limited to ${startDate}..${endDate}.`);
  } else if ((h.StartPeriod && h.StartPeriod !== reqPeriod.start) || (h.EndPeriod && h.EndPeriod !== reqPeriod.end)) {
    warnings.push(`QBO applied ${h.StartPeriod ?? '…'}..${h.EndPeriod ?? '…'} to the actuals (requested ${startDate}..${endDate}).`);
  }
  if (h.ReportBasis && String(h.ReportBasis).toLowerCase() !== accountingMethod.toLowerCase()) {
    warnings.push(`QBO reported the actuals on ${h.ReportBasis} basis (requested ${accountingMethod}).`);
  }
  const actuals = extractPnlActuals(pnl, classes);
  if (actuals.unmatched_class_columns.length) {
    warnings.push(`P&L class column(s) not matched to a QBO Class: ${actuals.unmatched_class_columns.join(', ')} — shown by title.`);
  }

  // Join
  type Acc = { key: string; account_id: string | null; account_name: string; pnlSection: string | null; actual: number; budget: number; byClass: Map<string, { actual: number; budget: number; title?: string }> };
  const rows = new Map<string, Acc>();
  const keyFor = (id: string | null, name: string) => (id ? `id:${id}` : `name:${name.toLowerCase()}`);
  for (const r of actuals.rows) {
    const key = keyFor(r.account_id, r.account_name);
    const acc = rows.get(key) ?? { key, account_id: r.account_id, account_name: r.account_name, pnlSection: r.section, actual: 0, budget: 0, byClass: new Map() };
    acc.actual += r.total;
    for (const [ck, amt] of r.by_class) {
      const slot = acc.byClass.get(ck) ?? { actual: 0, budget: 0, title: ck.startsWith('title:') ? ck.slice(6) : undefined };
      slot.actual += amt;
      acc.byClass.set(ck, slot);
    }
    rows.set(key, acc);
  }
  for (const l of budgetLines) {
    const key = keyFor(l.account_id, l.account_name ?? '');
    const a = accountById.get(l.account_id);
    const acc = rows.get(key) ?? {
      key, account_id: l.account_id,
      account_name: String(a?.FullyQualifiedName ?? a?.Name ?? l.account_name ?? `Account ${l.account_id}`),
      pnlSection: null, actual: 0, budget: 0, byClass: new Map(),
    };
    acc.budget += l.amount;
    const ck = l.class_id ?? '';
    const slot = acc.byClass.get(ck) ?? { actual: 0, budget: 0 };
    slot.budget += l.amount;
    acc.byClass.set(ck, slot);
    rows.set(key, acc);
  }

  const sections = new Map<Section, { actual: number; budget: number; accounts: any[] }>();
  for (const acc of rows.values()) {
    if (!includeZeroRows && round2(acc.actual) === 0 && round2(acc.budget) === 0) continue;
    const a = acc.account_id ? accountById.get(acc.account_id) : undefined;
    const section = sectionFor(acc.pnlSection, a);
    const out: any = {
      account_id: acc.account_id,
      account_number: a?.AcctNum ?? null,
      account_name: acc.account_name,
      ...variance(acc.actual, acc.budget),
    };
    if (splitByClass) {
      out.by_class = Array.from(acc.byClass.entries())
        .filter(([, v]) => includeZeroRows || round2(v.actual) !== 0 || round2(v.budget) !== 0)
        .map(([ck, v]) => ({
          class_id: ck === '' || ck.startsWith('title:') ? null : ck,
          class_name: ck === '' ? 'Not Specified' : ck.startsWith('title:') ? v.title : classNameById.get(ck) ?? `Class ${ck}`,
          ...variance(v.actual, v.budget),
        }))
        .sort((x, y) => String(x.class_name).localeCompare(String(y.class_name)));
    }
    const s = sections.get(section) ?? { actual: 0, budget: 0, accounts: [] };
    s.actual += acc.actual;
    s.budget += acc.budget;
    s.accounts.push(out);
    sections.set(section, s);
  }

  let netActual = 0;
  let netBudget = 0;
  const sectionOut: any[] = [];
  for (const name of [...SECTION_ORDER, 'Other' as const]) {
    const s = sections.get(name);
    if (!s) continue;
    netActual += netSign(name) * s.actual;
    netBudget += netSign(name) * s.budget;
    s.accounts.sort((x, y) => String(x.account_number ?? '').localeCompare(String(y.account_number ?? '')) || String(x.account_name).localeCompare(String(y.account_name)));
    sectionOut.push({ section: name, ...variance(s.actual, s.budget), accounts: s.accounts });
  }
  if (sections.has('Other')) {
    warnings.push('Some budget accounts are not P&L accounts (section "Other") and are excluded from net income.');
  }
  if (actuals.net_income !== null && Math.abs(round2(netActual) - actuals.net_income) > 0.01) {
    warnings.push(`Reconciliation: net income from the account rows (${round2(netActual)}) differs from QBO's P&L Net Income (${actuals.net_income}). Do not rely on this rendering without checking get_profit_and_loss.`);
  }

  return {
    client: input.clientName,
    report: 'Budget vs Actuals',
    source: 'computed: QBO Budget entity + ProfitAndLoss report',
    budget: {
      budget_id: String(budget.Id ?? ''),
      name: budget.Name ?? '',
      budget_entry_type: budget.BudgetEntryType ?? '',
      start_date: budget.StartDate ?? null,
      end_date: budget.EndDate ?? null,
      coverage_of_period: coverage,
      periods_included: periods,
    },
    period: { start: startDate, end: endDate },
    actuals_period_applied_by_qbo: { start: h.StartPeriod ?? null, end: h.EndPeriod ?? null },
    accounting_method: accountingMethod,
    class_filter: classId ? { class_id: classId, class_name: classNameById.get(classId) ?? null } : null,
    split_by_class: splitByClass,
    partial_periods: partialPeriods,
    columns: { actual: 'P&L actual for the period', budget: 'budget for the period', over_budget: 'actual − budget', pct_of_budget: 'actual ÷ budget × 100 (null when budget is 0)' },
    sections: sectionOut,
    net_income: { ...variance(netActual, netBudget), qbo_pnl_net_income: actuals.net_income },
    warnings,
  };
}
