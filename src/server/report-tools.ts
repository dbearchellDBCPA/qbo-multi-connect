// ─── MCP registration: allowlisted Reports API (reports not already wrapped)
//
//   run_report    GET /v3/company/{realmId}/reports/{Name}
//
// Returns the current Reports API JSON (post 31 Aug 2026 cutover). Existing
// dedicated tools (get_profit_and_loss, get_balance_sheet, …) are unchanged.

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ScopedQBOManager } from './auth.js';
import {
  ALLOWED_RUN_REPORT_NAMES,
  ReportRequestError,
  type ReportOptions,
  type SummarizeColumnBy,
} from '../api/reports.js';

const REPORT_NAMES = ALLOWED_RUN_REPORT_NAMES as [string, ...string[]];

export function registerReportTools(
  server: McpServer,
  qboManager: ScopedQBOManager,
  findRealmId: (clientName: string) => Promise<string | null>,
): void {
  const tool = (server as any).tool.bind(server);

  tool(
    'run_report',
    `Run a QBO Reports API report that does not already have a dedicated tool, and return the current official JSON (the 31 Aug 2026 reports cutover has already happened; this tool does not reshape the body). Allowed reports: ${ALLOWED_RUN_REPORT_NAMES.join(', ')}. Only documented query params for that report are sent — QBO silently ignores unknown params. For ProfitAndLoss, BalanceSheet, TrialBalance, AgedReceivables, AgedPayables, CashFlow, GeneralLedger, or BudgetVsActuals, use the existing get_* tools. Defaults to Accrual on reports that accept accounting_method (except TransactionList*). AgedReceivableDetail / AgedPayableDetail send aging_method=Report_Date when as_of_date is set, same as get_ar_aging / get_ap_aging.`,
    {
      client_name: z.string().describe('The name of the client company'),
      report_name: z.enum(REPORT_NAMES).describe('Official Reports API name'),
      start_date: z.string().optional().describe('Start date (YYYY-MM-DD)'),
      end_date: z.string().optional().describe('End date (YYYY-MM-DD)'),
      as_of_date: z.string().optional().describe('As-of date (YYYY-MM-DD); sent as report_date'),
      date_macro: z.string().optional().describe('Intuit date macro, e.g. "This Fiscal Year-to-date"'),
      accounting_method: z.enum(['Cash', 'Accrual']).optional().describe('Cash or Accrual. Defaults to Accrual on reports that accept it (except TransactionList*).'),
      summarize_by: z.enum(['Total', 'Month', 'Week', 'Quarter', 'Year', 'Customers', 'Vendors', 'Classes', 'Departments', 'Employees', 'ProductsAndServices']).optional().describe('summarize_column_by, where the report supports it'),
      class_id: z.string().optional().describe('QBO Class ID or comma-separated IDs'),
      department_id: z.string().optional().describe('QBO Department ID or comma-separated IDs'),
      customer_id: z.string().optional().describe('QBO Customer ID or comma-separated IDs'),
      vendor_id: z.string().optional().describe('QBO Vendor ID or comma-separated IDs'),
      account_ids: z.string().optional().describe('QBO Account ID or comma-separated IDs (not names/numbers)'),
      columns: z.string().optional().describe('Optional column list (e.g. TransactionList, JournalReport)'),
      cleared: z.string().optional().describe('TransactionList cleared filter, if supported (e.g. Cleared, Uncleared, Reconciled)'),
      source_account_type: z.string().optional().describe('TransactionList source_account_type, if supported'),
      transaction_type: z.string().optional().describe('TransactionList transaction_type filter, if supported'),
      docnum: z.string().optional().describe('TransactionList docnum filter, if supported'),
      payment_method: z.string().optional().describe('TransactionList payment_method filter, if supported'),
    },
    async (args: Record<string, any>) => {
      const realmId = await findRealmId(args.client_name);
      if (!realmId) {
        return { content: [{ type: 'text', text: `Client not found: "${args.client_name}". Use list_clients to see available companies.` }] };
      }
      const options: ReportOptions = {
        startDate: args.start_date,
        endDate: args.end_date,
        asOfDate: args.as_of_date,
        dateMacro: args.date_macro,
        accountingMethod: args.accounting_method,
        summarizeColumnBy: args.summarize_by as SummarizeColumnBy | undefined,
        classId: args.class_id,
        departmentId: args.department_id,
        customerId: args.customer_id,
        vendorId: args.vendor_id,
        accountIds: args.account_ids,
        columns: args.columns,
        cleared: args.cleared,
        sourceAccountType: args.source_account_type,
        transactionType: args.transaction_type,
        docnum: args.docnum,
        paymentMethod: args.payment_method,
      };
      try {
        const report = await qboManager.reports.run(realmId, args.report_name, options);
        return { content: [{ type: 'text', text: JSON.stringify(report, null, 2) }] };
      } catch (err: any) {
        const prefix = err instanceof ReportRequestError ? '' : 'Error running report: ';
        return { content: [{ type: 'text', text: `${prefix}${err?.message ?? err}` }], isError: true };
      }
    },
  );
}
