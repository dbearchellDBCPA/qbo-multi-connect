import { QBOClient, QBOError } from './client.js';
import { escapeQboString } from '../server/entity-fields.js';
import {
  resolveBudget,
  computeBudgetVsActuals,
  type PartialPeriodMode,
} from './budget-vs-actuals.js';

export type SummarizeColumnBy =
  | 'Total'
  | 'Month'
  | 'Quarter'
  | 'Year'
  | 'Week'
  | 'Days'
  | 'Weeks'
  | 'Customers'
  | 'Vendors'
  | 'Classes'
  | 'Departments'
  | 'Employees'
  | 'ProductsAndServices';

export interface ReportOptions {
  startDate?: string; // YYYY-MM-DD
  endDate?: string; // YYYY-MM-DD
  asOfDate?: string; // YYYY-MM-DD
  /**
   * Intuit predefined period (e.g. "This Fiscal Year-to-date", "Last Month").
   * Alternative to start/end dates on reports that accept it.
   */
  dateMacro?: string;
  accountingMethod?: 'Accrual' | 'Cash';
  summarizeColumnBy?: SummarizeColumnBy;
  // Filter values are QBO entity IDs (or comma-separated lists) — names/numbers
  // are NOT accepted by the Reports API and will silently filter to nothing.
  classId?: string;
  departmentId?: string;
  customerId?: string;
  vendorId?: string;
  accountIds?: string; // single ID or comma-separated list of Account IDs
}

export interface BudgetVsActualsOptions extends ReportOptions {
  budgetId?: string;
}

export interface ComputedBudgetVsActualsOptions {
  clientName: string;
  budgetId?: string;
  budgetName?: string;
  startDate: string;
  endDate: string;
  accountingMethod?: 'Accrual' | 'Cash';
  /** Add a per-class breakdown under every account (P&L summarized by Classes). */
  splitByClass?: boolean;
  /** Limit both sides to one QBO Class Id. */
  classId?: string;
  partialPeriods?: PartialPeriodMode;
  includeZeroRows?: boolean;
}

/** A request that cannot run (bad/ambiguous budget, bad dates) — message is user-facing. */
export class BudgetRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BudgetRequestError';
  }
}

/** Metadata-only Budget query (no BudgetDetail — a few hundred bytes per budget). */
export const BUDGET_META_QUERY =
  'SELECT Id, Name, StartDate, EndDate, BudgetType, BudgetEntryType, Active FROM Budget MAXRESULTS 1000';

/**
 * Build the query-string param object for an Intuit Reports API call.
 * Only includes the params the caller passed AND that the named report supports.
 */
/**
 * These tools document "Defaults to Accrual", but leaving accounting_method
 * off makes QBO use the COMPANY's report-basis preference — on a cash-basis
 * company a Bill then posts on its BillPayment date (found 2026-09-27: UWGA
 * Bill 501 dated 7/20 showed on 7/24). Send Accrual explicitly.
 */
function withAccrualDefault<T extends ReportOptions>(options: T): T {
  return { ...options, accountingMethod: options.accountingMethod ?? 'Accrual' };
}

function buildReportQuery(
  options: ReportOptions,
  supports: ReadonlyArray<
    | 'start_date'
    | 'end_date'
    | 'report_date'
    | 'date_macro'
    | 'accounting_method'
    | 'summarize_column_by'
    | 'class'
    | 'department'
    | 'customer'
    | 'vendor'
    | 'account'
  >
): Record<string, string> {
  const q: Record<string, string> = {};
  const map: Record<string, string | undefined> = {
    start_date: options.startDate,
    end_date: options.endDate,
    report_date: options.asOfDate,
    date_macro: options.dateMacro,
    accounting_method: options.accountingMethod,
    summarize_column_by: options.summarizeColumnBy,
    class: options.classId,
    department: options.departmentId,
    customer: options.customerId,
    vendor: options.vendorId,
    account: options.accountIds,
  };
  for (const key of supports) {
    const value = map[key];
    if (value !== undefined && value !== '') q[key] = value;
  }
  return q;
}

/**
 * Intuit can return a report failure as an HTTP 200 whose body is a Fault
 * envelope (seen live 2026-09-05: BudgetVsActuals with summarize_column_by
 * answered `{"Fault":{"Error":[{"code":"10000","element":"SystemFailureError",
 * "Detail":"System Failure Error: java.lang.NullPointerException"}]}}` with a
 * 200 status). A caller that treats that body as a report renders nothing —
 * or, worse, renders the Fault as data. Surface it as an error instead.
 */
export function qboFaultMessage(body: unknown): string | null {
  const fault = (body as any)?.Fault;
  if (!fault || typeof fault !== 'object') return null;
  const errors: any[] = Array.isArray(fault.Error) ? fault.Error : [];
  const parts = errors.map((e) => {
    const bits = [e?.Message, e?.Detail].filter((x) => typeof x === 'string' && x.trim());
    const tag = [e?.element, e?.code ? `code ${e.code}` : ''].filter(Boolean).join(', ');
    return `${bits.join(' — ') || 'Unknown error'}${tag ? ` (${tag})` : ''}`;
  });
  return `QBO ${fault.type ?? 'Fault'}: ${parts.join('; ') || 'no error detail returned'}`;
}

/**
 * QBO Reports API
 */
export class ReportsAPI {
  constructor(private client: QBOClient) {}

  /** GET a report and throw on a Fault body (see qboFaultMessage). */
  private async fetchReport(realmId: string, path: string, query: Record<string, string>): Promise<unknown> {
    const body = await this.client.get(realmId, path, query);
    const fault = qboFaultMessage(body);
    if (fault) throw new QBOError(fault, 200, body);
    return body;
  }

  /**
   * Get Profit & Loss report
   */
  async profitAndLoss(realmId: string, options: ReportOptions = {}): Promise<unknown> {
    const query = buildReportQuery(withAccrualDefault(options), [
      'start_date',
      'end_date',
      'accounting_method',
      'summarize_column_by',
      'class',
      'department',
      'customer',
      'vendor',
    ]);
    return this.fetchReport(realmId, 'reports/ProfitAndLoss', query);
  }

  /**
   * Get Balance Sheet report.
   * The as-of date maps to Intuit's `end_date` param — BalanceSheet has NO
   * `date` param, and QBO silently ignores unknown query params, so sending
   * `date` returns TODAY'S balance sheet regardless of the requested date.
   * `start_date` only matters for multi-column summarize_column_by series
   * (QBO defaults it to the fiscal-year start containing end_date).
   */
  async balanceSheet(realmId: string, options: ReportOptions = {}): Promise<unknown> {
    const query = buildReportQuery(
      withAccrualDefault({ ...options, endDate: options.endDate ?? options.asOfDate }),
      [
        'start_date',
        'end_date',
        'accounting_method',
        'summarize_column_by',
        'class',
        'department',
      ]
    );
    return this.fetchReport(realmId, 'reports/BalanceSheet', query);
  }

  /**
   * Get Trial Balance report. Like BalanceSheet, the "as of" date is Intuit's
   * `end_date` — there is no as-of param, and an unknown param is silently
   * ignored (the report then comes back for QBO's default period).
   */
  async trialBalance(realmId: string, options: ReportOptions = {}): Promise<unknown> {
    const query = buildReportQuery(
      withAccrualDefault({ ...options, endDate: options.endDate ?? options.asOfDate }),
      ['start_date', 'end_date', 'accounting_method']
    );
    return this.fetchReport(realmId, 'reports/TrialBalance', query);
  }

  /**
   * Get Accounts Receivable Aging report.
   * `report_date` alone is NOT honored by QBO (verified live 2026-08-15:
   * two different as-of dates returned identical aging) — the report ages
   * as of "today" unless aging_method=Report_Date accompanies it.
   */
  async arAging(realmId: string, options: ReportOptions = {}): Promise<unknown> {
    const query = buildReportQuery(options, ['report_date', 'accounting_method']);
    if (query.report_date) query.aging_method = 'Report_Date';
    return this.fetchReport(realmId, 'reports/AgedReceivables', query);
  }

  /**
   * Get Accounts Payable Aging report (same aging_method requirement as
   * AgedReceivables — see arAging).
   */
  async apAging(realmId: string, options: ReportOptions = {}): Promise<unknown> {
    const query = buildReportQuery(options, ['report_date', 'accounting_method']);
    if (query.report_date) query.aging_method = 'Report_Date';
    return this.fetchReport(realmId, 'reports/AgedPayables', query);
  }

  /**
   * Get General Ledger report.
   * NOTE: `accountIds` must be QBO Account IDs (comma-separated). Names/numbers
   * are not accepted by Intuit and will silently return an empty report.
   * `columns` optionally requests an explicit column set (e.g. debt_amt /
   * credit_amt for true Debit/Credit columns instead of the signed net amount).
   */
  async generalLedger(
    realmId: string,
    options: ReportOptions & { columns?: string } = {}
  ): Promise<unknown> {
    const query = buildReportQuery(withAccrualDefault(options), [
      'start_date',
      'end_date',
      'accounting_method',
      'class',
      'department',
      'customer',
      'vendor',
      'account',
    ]);
    if (options.columns) query.columns = options.columns;
    return this.fetchReport(realmId, 'reports/GeneralLedger', query);
  }

  /**
   * Get Cash Flow report
   */
  async cashFlow(realmId: string, options: ReportOptions = {}): Promise<unknown> {
    const query = buildReportQuery(options, [
      'start_date',
      'end_date',
      'accounting_method',
      'class',
      'department',
    ]);
    return this.fetchReport(realmId, 'reports/CashFlow', query);
  }

  /**
   * Intuit's Budget vs Actuals report. The budget is selected with the
   * `budget` query param — NOT `budget_id`. QBO silently ignores unknown
   * params, so sending `budget_id` (as this method did until 2026-09-30)
   * always produced the company's default budget (Northway: FY27 whatever
   * was asked). Even with the right param, Total mode has been seen to
   * ignore start/end and return all-time actuals, so the MCP tool defaults
   * to computedBudgetVsActuals() and this is the opt-in raw view.
   */
  async budgetVsActuals(realmId: string, options: BudgetVsActualsOptions = {}): Promise<unknown> {
    const query = buildReportQuery(options, [
      'start_date',
      'end_date',
      'date_macro',
      'accounting_method',
      'summarize_column_by',
    ]);
    if (options.budgetId) query.budget = options.budgetId;
    return this.fetchReport(realmId, 'reports/BudgetVsActuals', query);
  }

  /** Budget metadata for every budget in the company (no detail lines). */
  async listBudgets(realmId: string): Promise<any[]> {
    const res: any = await this.client.query(realmId, BUDGET_META_QUERY);
    return res?.QueryResponse?.Budget ?? [];
  }

  /** One full Budget entity (with BudgetDetail), or null. */
  async getBudget(realmId: string, budgetId: string): Promise<any | null> {
    const res: any = await this.client.query(realmId, `SELECT * FROM Budget WHERE Id = '${escapeQboString(String(budgetId))}'`);
    return res?.QueryResponse?.Budget?.[0] ?? null;
  }

  /**
   * Budget vs Actuals built from the Budget entity (resolved by Id or name)
   * plus a ProfitAndLoss for exactly startDate..endDate on the requested
   * basis — both of which QBO scopes reliably. See budget-vs-actuals.ts.
   */
  async computedBudgetVsActuals(realmId: string, options: ComputedBudgetVsActualsOptions): Promise<any> {
    const iso = /^\d{4}-\d{2}-\d{2}$/;
    if (!options.startDate || !options.endDate) {
      throw new BudgetRequestError('start_date and end_date are both required (YYYY-MM-DD).');
    }
    for (const [label, v] of [['start_date', options.startDate], ['end_date', options.endDate]] as const) {
      if (!iso.test(v)) throw new BudgetRequestError(`${label} must be YYYY-MM-DD (got "${v}").`);
    }
    if (options.startDate > options.endDate) {
      throw new BudgetRequestError(`start_date ${options.startDate} is after end_date ${options.endDate}.`);
    }

    const budgets = await this.listBudgets(realmId);
    const picked = resolveBudget(budgets, { budgetId: options.budgetId, budgetName: options.budgetName });
    if (picked.error || !picked.budget) throw new BudgetRequestError(picked.error ?? 'Budget not found.');
    const budget = await this.getBudget(realmId, String(picked.budget.Id));
    if (!budget) throw new BudgetRequestError(`Budget ${picked.budget.Id} could not be loaded.`);

    const accountingMethod = options.accountingMethod ?? 'Accrual';
    const wantClasses = Boolean(options.splitByClass || options.classId);
    const [pnl, accountsRes, classesRes] = await Promise.all([
      this.profitAndLoss(realmId, {
        startDate: options.startDate,
        endDate: options.endDate,
        accountingMethod,
        summarizeColumnBy: options.splitByClass ? 'Classes' : undefined,
        classId: options.classId,
      }),
      this.client.query<any>(realmId, 'SELECT * FROM Account WHERE Active IN (true, false) MAXRESULTS 1000'),
      wantClasses
        ? this.client.query<any>(realmId, 'SELECT * FROM Class MAXRESULTS 1000')
        : Promise.resolve(null),
    ]);

    return computeBudgetVsActuals({
      clientName: options.clientName,
      budget,
      startDate: options.startDate,
      endDate: options.endDate,
      accountingMethod,
      pnl,
      accounts: accountsRes?.QueryResponse?.Account ?? [],
      classes: classesRes?.QueryResponse?.Class ?? [],
      splitByClass: options.splitByClass,
      classId: options.classId,
      partialPeriods: options.partialPeriods,
      includeZeroRows: options.includeZeroRows,
    });
  }
}
