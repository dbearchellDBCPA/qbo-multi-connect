import { QBOClient, QBOError } from './client.js';

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

/**
 * Build the query-string param object for an Intuit Reports API call.
 * Only includes the params the caller passed AND that the named report supports.
 */
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
    const query = buildReportQuery(options, [
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
      { ...options, endDate: options.endDate ?? options.asOfDate },
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
      { ...options, endDate: options.endDate ?? options.asOfDate },
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
    const query = buildReportQuery(options, [
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
   * Get Budget vs Actuals report. `budgetId` selects which budget to compare
   * against (if omitted, QBO uses the company's default). The period is
   * either `dateMacro` (Intuit's predefined ranges, e.g. "This Fiscal
   * Year-to-date") or start/end dates that fall inside the budget's own
   * StartDate..EndDate.
   */
  async budgetVsActuals(realmId: string, options: BudgetVsActualsOptions = {}): Promise<unknown> {
    const query = buildReportQuery(options, [
      'start_date',
      'end_date',
      'date_macro',
      'accounting_method',
      'summarize_column_by',
    ]);
    if (options.budgetId) query.budget_id = options.budgetId;
    return this.fetchReport(realmId, 'reports/BudgetVsActuals', query);
  }
}
