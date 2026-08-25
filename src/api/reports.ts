import { QBOClient } from './client.js';

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
 * QBO Reports API
 */
export class ReportsAPI {
  constructor(private client: QBOClient) {}

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
    return this.client.get(realmId, 'reports/ProfitAndLoss', query);
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
    return this.client.get(realmId, 'reports/BalanceSheet', query);
  }

  /**
   * Get Trial Balance report
   */
  async trialBalance(realmId: string, options: ReportOptions = {}): Promise<unknown> {
    const query = buildReportQuery(options, [
      'start_date',
      'end_date',
      'accounting_method',
    ]);
    return this.client.get(realmId, 'reports/TrialBalance', query);
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
    return this.client.get(realmId, 'reports/AgedReceivables', query);
  }

  /**
   * Get Accounts Payable Aging report (same aging_method requirement as
   * AgedReceivables — see arAging).
   */
  async apAging(realmId: string, options: ReportOptions = {}): Promise<unknown> {
    const query = buildReportQuery(options, ['report_date', 'accounting_method']);
    if (query.report_date) query.aging_method = 'Report_Date';
    return this.client.get(realmId, 'reports/AgedPayables', query);
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
    return this.client.get(realmId, 'reports/GeneralLedger', query);
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
    return this.client.get(realmId, 'reports/CashFlow', query);
  }

  /**
   * Get Budget vs Actuals report. `budgetId` selects which budget to compare
   * against (if omitted, QBO uses the company's default).
   */
  async budgetVsActuals(realmId: string, options: BudgetVsActualsOptions = {}): Promise<unknown> {
    const query = buildReportQuery(options, [
      'start_date',
      'end_date',
      'accounting_method',
      'summarize_column_by',
    ]);
    if (options.budgetId) query.budget_id = options.budgetId;
    return this.client.get(realmId, 'reports/BudgetVsActuals', query);
  }
}
