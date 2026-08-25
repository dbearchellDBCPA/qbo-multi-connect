import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { QBOManager } from '../index.js';
import { resolveAuth, createScopedManager, type AuthScope, type ScopedQBOManager } from './auth.js';
import { publicBaseUrl, resolvePublicUrl } from './public-url.js';
import {
  qboSalesLinesToUpdateShape,
  qboBillLinesToUpdateShape,
  qboJournalLinesToUpdateShape,
  qboExpenseLinesToUpdateShape,
  qboPoLinesToUpdateShape,
  qboDepositLinesToUpdateShape,
  buildDepositTxnLines,
  buildDepositUpdatePayload,
  depositLineEntityError,
  swapItemInLines,
  swapAccountInLines,
} from './line-converters.js';
import {
  resolveAccountFilterTerms,
  expandToDescendants,
  parseGeneralLedger,
  summarizeGeneralLedger,
  stripQboNoise,
  filterBudgets,
  budgetToSummary,
  formatCurrency,
  headerPeriod,
  periodMismatchNote,
  formatTrialBalance,
  formatAgingReport,
} from './report-shaping.js';
import {
  postedLineStats,
  verifyLinesAndMaybeRollback,
} from './update-verification.js';
import {
  addressInput,
  contactInputShape,
  toQboAddress,
  applyContactFields,
  buildCustomerUpdatePayload,
  buildVendorUpdatePayload,
  escapeQboString,
  EMAIL_PARAM_DESCRIPTION,
  DOC_NUMBER_DESCRIPTION,
} from './entity-fields.js';
import { readFile, readdir, stat } from 'node:fs/promises';
import { basename } from 'node:path';
import {
  contentTypeForFile,
  supportedExtensions,
  resolveAttachmentPath,
  assertSafeUrl,
  MAX_ATTACHMENT_BYTES,
  MAX_FILES_PER_UPLOAD,
  type AttachmentUploadItem,
} from '../api/attachments.js';

// ─── Report Formatters ────────────────────────────────────────────────────────
// formatCurrency, formatTrialBalance, and formatAgingReport live in
// report-shaping.ts (pure + unit-tested); the formatters here are the
// Section-typed reports whose structure extractRows already handles.

function padLine(label: string, value: string, width = 60): string {
  const dots = Math.max(2, width - label.length - value.length);
  return `  ${label}${' '.repeat(dots)}${value}`;
}

/**
 * Recursively extract rows from QBO report Rows structure.
 * Returns array of { label, amount, isTotal, indent }
 */
function extractRows(rows: any, indent = 0): Array<{ label: string; amount: string; isTotal: boolean; indent: number }> {
  if (!rows?.Row) return [];
  const result: Array<{ label: string; amount: string; isTotal: boolean; indent: number }> = [];

  for (const row of rows.Row) {
    if (row.type === 'Section') {
      // Section header
      if (row.Header?.ColData) {
        const label = row.Header.ColData[0]?.value ?? '';
        if (label) result.push({ label, amount: '', isTotal: false, indent });
      }
      // Recurse into nested rows
      result.push(...extractRows(row.Rows, indent + 1));
      // Section summary
      if (row.Summary?.ColData) {
        const label = row.Summary.ColData[0]?.value ?? '';
        const amount = row.Summary.ColData[1]?.value ?? '';
        if (label) result.push({ label, amount, isTotal: true, indent });
      }
    } else if (row.type === 'Data') {
      const label = row.ColData?.[0]?.value ?? '';
      const amount = row.ColData?.[1]?.value ?? '';
      if (label) result.push({ label, amount, isTotal: false, indent });
    }
  }
  return result;
}

function formatPnL(reportData: any, clientName: string, startDate: string, endDate: string): string {
  const rows = extractRows(reportData?.Rows);
  // Echo the period QBO actually applied (response Header), not the request.
  const actual = headerPeriod(reportData);
  const lines: string[] = [
    `PROFIT & LOSS — ${clientName}`,
    `Period: ${actual.start ?? startDate} to ${actual.end ?? endDate}`,
  ];
  const mismatch = periodMismatchNote({ start: startDate, end: endDate }, actual);
  if (mismatch) lines.push(mismatch);
  lines.push('─'.repeat(60));

  for (const row of rows) {
    const indent = '  '.repeat(row.indent);
    if (!row.amount) {
      lines.push(`\n${indent}${row.label.toUpperCase()}`);
    } else if (row.isTotal) {
      lines.push(padLine(`${indent}${row.label}`, formatCurrency(row.amount)));
    } else {
      lines.push(padLine(`${indent}${row.label}`, formatCurrency(row.amount)));
    }
  }

  return lines.join('\n');
}

function formatBalanceSheet(reportData: any, clientName: string, asOfDate: string): string {
  const rows = extractRows(reportData?.Rows);
  // Echo the as-of date QBO actually applied (Header.EndPeriod) — rendering
  // the requested date over different-period data is what made the 2026-08
  // as_of_date bugs silent.
  const actual = headerPeriod(reportData);
  const lines: string[] = [
    `BALANCE SHEET — ${clientName}`,
    `As of: ${actual.end ?? asOfDate}`,
  ];
  const mismatch = periodMismatchNote({ end: asOfDate }, actual);
  if (mismatch) lines.push(mismatch);
  lines.push('─'.repeat(60));

  for (const row of rows) {
    const indent = '  '.repeat(row.indent);
    if (!row.amount) {
      lines.push(`\n${indent}${row.label.toUpperCase()}`);
    } else {
      lines.push(padLine(`${indent}${row.label}`, formatCurrency(row.amount)));
    }
  }

  return lines.join('\n');
}

// parseGeneralLedger lives in report-shaping.ts (pure + unit-tested).

function formatCashFlow(reportData: any, clientName: string, startDate: string, endDate: string): string {
  const rows = extractRows(reportData?.Rows);
  const actual = headerPeriod(reportData);
  const lines: string[] = [
    `STATEMENT OF CASH FLOWS — ${clientName}`,
    `Period: ${actual.start ?? startDate} to ${actual.end ?? endDate}`,
  ];
  const mismatch = periodMismatchNote({ start: startDate, end: endDate }, actual);
  if (mismatch) lines.push(mismatch);
  lines.push('─'.repeat(60));

  for (const row of rows) {
    const indent = '  '.repeat(row.indent);
    if (!row.amount) {
      lines.push(`\n${indent}${row.label.toUpperCase()}`);
    } else if (row.isTotal) {
      lines.push(padLine(`${indent}${row.label}`, formatCurrency(row.amount)));
      lines.push('─'.repeat(60));
    } else {
      lines.push(padLine(`${indent}${row.label}`, formatCurrency(row.amount)));
    }
  }

  return lines.join('\n');
}

// ─── TransactionList / Bank Register Formatter ───────────────────────────────

function formatTransactionList(report: any, clientName: string, accountName?: string, title = 'BANK REGISTER'): string {
  const cols: any[] = report?.Columns?.Column ?? [];
  const colTitles = cols.map((c: any) => (c.ColTitle ?? '').toLowerCase());

  const idxDate = colTitles.findIndex((t: string) => t === 'date');
  const idxType = colTitles.findIndex((t: string) => t.includes('transaction type') || t === 'type');
  const idxNum  = colTitles.findIndex((t: string) => t === 'no.' || t === 'no' || t === 'num');
  const idxName = colTitles.findIndex((t: string) => t === 'name');
  const idxMemo = colTitles.findIndex((t: string) => t.includes('memo') || t.includes('description'));
  const idxAmt  = colTitles.findIndex((t: string) => t === 'amount');
  const idxBal  = colTitles.findIndex((t: string) => t === 'balance');
  const idxClr  = colTitles.findIndex((t: string) => t === 'clr' || t === 'cleared' || t === 'reconcile status');

  const rows: any[] = [];
  function collectRows(rowSet: any): void {
    if (!rowSet?.Row) return;
    for (const row of rowSet.Row) {
      if (row.type === 'Data') rows.push(row);
      else if (row.Rows) collectRows(row.Rows);
    }
  }
  collectRows(report?.Rows);

  const lines: string[] = [
    `${title} — ${clientName}`,
    accountName ? `Account: ${accountName}` : '',
    `Transactions: ${rows.length}`,
    '─'.repeat(110),
    `${'Date'.padEnd(12)} ${'Type'.padEnd(20)} ${'No.'.padEnd(8)} ${'Name'.padEnd(25)} ${'Memo'.padEnd(25)} ${'Clr'.padEnd(4)} ${'Amount'.padStart(12)} ${'Balance'.padStart(12)}`,
    '─'.repeat(110),
  ].filter(Boolean);

  for (const row of rows) {
    const cd = row.ColData ?? [];
    const v = (i: number) => (i >= 0 ? cd[i]?.value ?? '' : '');
    const date  = v(idxDate).padEnd(12);
    const type  = v(idxType).substring(0, 19).padEnd(20);
    const num   = v(idxNum).substring(0, 7).padEnd(8);
    const name  = v(idxName).substring(0, 24).padEnd(25);
    const memo  = v(idxMemo).substring(0, 24).padEnd(25);
    const clr   = v(idxClr).substring(0, 3).padEnd(4);
    const amt   = formatCurrency(v(idxAmt)).padStart(12);
    const bal   = idxBal >= 0 ? formatCurrency(v(idxBal)).padStart(12) : ''.padStart(12);
    lines.push(`${date} ${type} ${num} ${name} ${memo} ${clr} ${amt} ${bal}`);
  }

  return lines.join('\n');
}

// ─── Client Lookup Helper ─────────────────────────────────────────────────────

async function findRealmId(qboManager: ScopedQBOManager, clientName: string): Promise<string | null> {
  const connections = await qboManager.listConnections();
  const normalized = clientName.toLowerCase().trim();
  const match = connections.find(
    (c) =>
      c.clientName.toLowerCase().trim() === normalized ||
      c.clientName.toLowerCase().trim().includes(normalized) ||
      normalized.includes(c.clientName.toLowerCase().trim())
  );
  return match?.realmId ?? null;
}

// ─── Vendor name resolution ───────────────────────────────────────────────────
// Callers sometimes pass vendor_name without vendor_id. Silently posting a
// payee-less transaction is dangerous (a bulk job can post hundreds of
// unattributed expenses and look like it worked), so the name is resolved to
// a vendor by exact DisplayName match — and the call FAILS loudly when no
// (or more than one) vendor matches, before anything is posted.
async function resolveVendorByName(
  qboManager: ScopedQBOManager,
  realmId: string,
  vendorName: string
): Promise<{ id: string; name: string } | { error: string }> {
  const result: any = await qboManager.transactions.rawQuery(
    realmId,
    `SELECT * FROM Vendor WHERE DisplayName = '${escapeQboString(vendorName)}'`
  );
  const vendors: any[] = result?.QueryResponse?.Vendor ?? [];
  if (vendors.length === 1) return { id: String(vendors[0].Id), name: vendors[0].DisplayName };
  if (vendors.length === 0) {
    return {
      error: `No vendor found with exact name "${vendorName}". Nothing was posted. Pass vendor_id, or use get_vendors to look up the vendor (create_vendor if it doesn't exist yet).`,
    };
  }
  return { error: `Multiple vendors matched "${vendorName}". Nothing was posted. Pass vendor_id to disambiguate.` };
}

// ─── Tool safety annotations ──────────────────────────────────────────────────
// MCP clients (e.g. the Claude.ai connector) use these hints to decide whether a
// tool call can run automatically or must first prompt the user for approval.
// Without them, every tool is treated as "unknown safety", so the client may
// raise an approval prompt for ANY tool — and an unanswered/timed-out prompt
// surfaces to the user as "No approval received". Marking reads as read-only lets
// the client auto-run them and makes the approval behaviour deterministic instead
// of intermittent. NOTE: annotations are advisory hints; a cautious client may
// still prompt for writes, so write tools should additionally be allow-listed in
// the connector's settings ("Always allow") for unattended/batch use.

// Explicit list of tools that permanently remove data.
const DESTRUCTIVE_TOOLS = new Set<string>([
  'delete_journal_entry',
  'delete_invoice',
  'delete_bill',
  'delete_customer',
  'delete_vendor',
  'delete_account',
  'delete_attachment',
  'delete_deposit',
  'delete_expense',
  'delete_bill_payment',
]);

// Read-only tools never mutate QBO state. All get_*/list_* tools plus the query tool.
function isReadOnlyTool(name: string): boolean {
  return name.startsWith('get_') || name.startsWith('list_') || name === 'query_transactions';
}

function annotationsForTool(name: string): ToolAnnotations {
  if (isReadOnlyTool(name)) {
    return { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
  }
  if (DESTRUCTIVE_TOOLS.has(name)) {
    return { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };
  }
  // create/update/apply/convert/close/match/swap/bulk → writes, but non-destructive
  return { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
}

// ─── MCP Server Setup ─────────────────────────────────────────────────────────

export async function registerMcpRoutes(
  fastify: FastifyInstance,
  qboRoot: QBOManager,
  masterApiKey: string,
  attachmentsDir?: string
): Promise<void> {
  // Each request builds a server scoped to the caller's API key. The tools
  // below close over `qboManager`, which is the scoped view — member keys
  // only ever see and reach their assigned companies.
  function createMcpServer(scope: AuthScope, baseUrl: string | null = null): McpServer {
    const qboManager = createScopedManager(qboRoot, scope);
    const server = new McpServer({
      name: 'qbo-multi-connect',
      version: '1.0.0',
    });

    // Inject safety annotations into every tool registration without touching
    // the ~79 individual call sites. The existing calls use the 4-arg form
    // tool(name, description, schema, cb); we splice the annotations object in
    // just before the callback to upgrade them to the 5-arg overload
    // tool(name, description, schema, annotations, cb).
    const registerToolRaw = server.tool.bind(server);
    (server as any).tool = (name: string, ...rest: any[]) => {
      // Read-only keys never see write tools at all — skipping registration
      // beats erroring at call time, since the model can't attempt what was
      // never listed. Reads are get_*/list_*/query_transactions; everything
      // else (create/update/delete/apply/convert/close/match/swap/bulk) writes.
      if (!scope.canWrite && !isReadOnlyTool(name)) return undefined;
      if (rest.length > 0 && typeof rest[rest.length - 1] === 'function') {
        const cb = rest[rest.length - 1];
        const head = rest.slice(0, -1); // [description?, schema?]
        return (registerToolRaw as any)(name, ...head, annotationsForTool(name), cb);
      }
      return (registerToolRaw as any)(name, ...rest);
    };

    // ── list_clients ──────────────────────────────────────────────────────────
    server.tool('list_clients', 'List all connected QuickBooks Online companies', {}, async () => {
      const connections = await qboManager.listConnections();
      const list = connections
        .filter((c) => c.status === 'active')
        .map((c) => `• ${c.clientName} (realmId: ${c.realmId})`)
        .join('\n');

      return {
        content: [
          {
            type: 'text',
            text: `Connected QBO Companies (${connections.filter((c) => c.status === 'active').length}):\n\n${list || 'No active connections found.'}`,
          },
        ],
      };
    });

    // ── get_company_info ──────────────────────────────────────────────────────
    server.tool(
      'get_company_info',
      'Get company information for a QBO client',
      { client_name: z.string().describe('The name of the client company') },
      async ({ client_name }) => {
        const realmId = await findRealmId(qboManager, client_name);
        if (!realmId) {
          return { content: [{ type: 'text', text: `Client not found: "${client_name}". Use list_clients to see available companies.` }] };
        }
        try {
          const info = await qboManager.company.getInfo(realmId);
          const ci = (info as any)?.CompanyInfo ?? info;
          const lines = [
            `COMPANY INFO — ${client_name}`,
            '─'.repeat(40),
            `Name: ${ci?.CompanyName ?? 'N/A'}`,
            `Legal Name: ${ci?.LegalName ?? 'N/A'}`,
            `Email: ${ci?.Email?.Address ?? 'N/A'}`,
            `Phone: ${ci?.PrimaryPhone?.FreeFormNumber ?? 'N/A'}`,
            `Address: ${[ci?.CompanyAddr?.Line1, ci?.CompanyAddr?.City, ci?.CompanyAddr?.CountrySubDivisionCode, ci?.CompanyAddr?.PostalCode].filter(Boolean).join(', ')}`,
            `Industry: ${ci?.IndustryType ?? 'N/A'}`,
            `Fiscal Year Start: ${ci?.FiscalYearStartMonth ?? 'N/A'}`,
            `Country: ${ci?.Country ?? 'N/A'}`,
          ];
          return { content: [{ type: 'text', text: lines.join('\n') }] };
        } catch (err: any) {
          return { content: [{ type: 'text', text: `Error fetching company info: ${err?.message ?? err}` }] };
        }
      }
    );

    // ── get_profit_and_loss ───────────────────────────────────────────────────
    server.tool(
      'get_profit_and_loss',
      'Get Profit & Loss report for a QBO client. Optionally filter by class/department for segment reporting, or summarize columns by Month/Quarter/Year/Class/etc. Defaults to Accrual basis. SIZE: summarize_by other than Total returns raw QBO JSON — a Month series over a full year can run ~400k characters; prefer Quarter or a shorter period when monthly column detail is not needed.',
      {
        client_name: z.string().describe('The name of the client company'),
        start_date: z.string().describe('Start date in YYYY-MM-DD format'),
        end_date: z.string().describe('End date in YYYY-MM-DD format'),
        summarize_by: z.enum(['Total', 'Month', 'Week', 'Quarter', 'Year', 'Customers', 'Vendors', 'Classes', 'Departments', 'Employees']).optional().describe('Optional: how to summarize columns. Use Classes or Departments for segment breakdown, Month/Quarter for time series.'),
        accounting_method: z.enum(['Cash', 'Accrual']).optional().describe('Cash or Accrual basis. Defaults to Accrual (QBO server default).'),
        class_id: z.string().optional().describe('Optional: QBO Class ID (or comma-separated IDs) to filter by class.'),
        department_id: z.string().optional().describe('Optional: QBO Department/Location ID (or comma-separated IDs) to filter by department.'),
      },
      async ({ client_name, start_date, end_date, summarize_by, accounting_method, class_id, department_id }) => {
        const realmId = await findRealmId(qboManager, client_name);
        if (!realmId) {
          return { content: [{ type: 'text', text: `Client not found: "${client_name}". Use list_clients to see available companies.` }] };
        }
        try {
          const report = await qboManager.reports.profitAndLoss(realmId, {
            startDate: start_date,
            endDate: end_date,
            summarizeColumnBy: summarize_by,
            accountingMethod: accounting_method,
            classId: class_id,
            departmentId: department_id,
          });
          if (summarize_by && summarize_by !== 'Total') {
            // Return raw JSON for multi-column reports so Claude can analyze the structure
            return { content: [{ type: 'text', text: JSON.stringify(report, null, 2) }] };
          }
          const formatted = formatPnL(report, client_name, start_date, end_date);
          return { content: [{ type: 'text', text: formatted }] };
        } catch (err: any) {
          return { content: [{ type: 'text', text: `Error fetching P&L: ${err?.message ?? err}` }] };
        }
      }
    );

    // ── get_balance_sheet ─────────────────────────────────────────────────────
    server.tool(
      'get_balance_sheet',
      'Get Balance Sheet report for a QBO client as of as_of_date (sent to Intuit as the report end_date). Defaults to Accrual basis. When summarize_by is set (any value, including Total) the raw QBO report JSON is returned instead of formatted text — a Month series over a year can run ~100-400k characters, so prefer Quarter/Year when column detail is not needed.',
      {
        client_name: z.string().describe('The name of the client company'),
        as_of_date: z.string().describe('As-of date in YYYY-MM-DD format'),
        accounting_method: z.enum(['Cash', 'Accrual']).optional().describe('Cash or Accrual basis. Defaults to Accrual.'),
        summarize_by: z.enum(['Total', 'Month', 'Quarter', 'Year', 'Classes', 'Departments']).optional().describe('Optional: how to summarize columns. Returns raw JSON when set.'),
        start_date: z.string().optional().describe('Optional: series start (YYYY-MM-DD) for multi-column summarize_by reports. Defaults to QBO\'s fiscal-year start containing as_of_date.'),
        class_id: z.string().optional().describe('Optional: QBO Class ID (or comma-separated IDs) to filter by class.'),
        department_id: z.string().optional().describe('Optional: QBO Department/Location ID (or comma-separated IDs).'),
      },
      async ({ client_name, as_of_date, accounting_method, summarize_by, start_date, class_id, department_id }) => {
        const realmId = await findRealmId(qboManager, client_name);
        if (!realmId) {
          return { content: [{ type: 'text', text: `Client not found: "${client_name}". Use list_clients to see available companies.` }] };
        }
        try {
          const report = await qboManager.reports.balanceSheet(realmId, {
            asOfDate: as_of_date,
            startDate: start_date,
            accountingMethod: accounting_method,
            summarizeColumnBy: summarize_by,
            classId: class_id,
            departmentId: department_id,
          });
          if (summarize_by) {
            // Description promises raw JSON whenever summarize_by is set —
            // including Total, so callers can see the Header QBO actually applied.
            return { content: [{ type: 'text', text: JSON.stringify(report, null, 2) }] };
          }
          const formatted = formatBalanceSheet(report, client_name, as_of_date);
          return { content: [{ type: 'text', text: formatted }] };
        } catch (err: any) {
          return { content: [{ type: 'text', text: `Error fetching Balance Sheet: ${err?.message ?? err}` }] };
        }
      }
    );

    // ── get_trial_balance ─────────────────────────────────────────────────────
    server.tool(
      'get_trial_balance',
      'Get Trial Balance report for a QBO client with proper Debit/Credit column parsing. Defaults to Accrual basis.',
      {
        client_name: z.string().describe('The name of the client company'),
        start_date: z.string().optional().describe('Start date in YYYY-MM-DD format (optional)'),
        end_date: z.string().optional().describe('End date in YYYY-MM-DD format (optional)'),
        accounting_method: z.enum(['Cash', 'Accrual']).optional().describe('Cash or Accrual basis. Defaults to Accrual.'),
      },
      async ({ client_name, start_date, end_date, accounting_method }) => {
        const realmId = await findRealmId(qboManager, client_name);
        if (!realmId) {
          return { content: [{ type: 'text', text: `Client not found: "${client_name}". Use list_clients to see available companies.` }] };
        }
        try {
          const report = await qboManager.reports.trialBalance(realmId, {
            startDate: start_date,
            endDate: end_date,
            accountingMethod: accounting_method,
          });
          const formatted = formatTrialBalance(report, client_name, start_date, end_date);
          return { content: [{ type: 'text', text: formatted }] };
        } catch (err: any) {
          return { content: [{ type: 'text', text: `Error fetching Trial Balance: ${err?.message ?? err}` }] };
        }
      }
    );

    // ── get_ar_aging ──────────────────────────────────────────────────────────
    server.tool(
      'get_ar_aging',
      'Get Accounts Receivable Aging report for a QBO client with proper bucket columns (Current, 1-30, 31-60, 61-90, 90+, Total)',
      {
        client_name: z.string().describe('The name of the client company'),
        as_of_date: z.string().optional().describe('As-of date in YYYY-MM-DD format (optional, defaults to today)'),
      },
      async ({ client_name, as_of_date }) => {
        const realmId = await findRealmId(qboManager, client_name);
        if (!realmId) {
          return { content: [{ type: 'text', text: `Client not found: "${client_name}". Use list_clients to see available companies.` }] };
        }
        try {
          const options: any = {};
          if (as_of_date) options.asOfDate = as_of_date;
          const report = await qboManager.reports.arAging(realmId, options);
          const formatted = formatAgingReport(report, client_name, 'AR', as_of_date);
          return { content: [{ type: 'text', text: formatted }] };
        } catch (err: any) {
          return { content: [{ type: 'text', text: `Error fetching AR Aging: ${err?.message ?? err}` }] };
        }
      }
    );

    // ── get_ap_aging ──────────────────────────────────────────────────────────
    server.tool(
      'get_ap_aging',
      'Get Accounts Payable Aging report for a QBO client with proper bucket columns (Current, 1-30, 31-60, 61-90, 90+, Total)',
      {
        client_name: z.string().describe('The name of the client company'),
        as_of_date: z.string().optional().describe('As-of date in YYYY-MM-DD format (optional, defaults to today)'),
      },
      async ({ client_name, as_of_date }) => {
        const realmId = await findRealmId(qboManager, client_name);
        if (!realmId) {
          return { content: [{ type: 'text', text: `Client not found: "${client_name}". Use list_clients to see available companies.` }] };
        }
        try {
          const options: any = {};
          if (as_of_date) options.asOfDate = as_of_date;
          const report = await qboManager.reports.apAging(realmId, options);
          const formatted = formatAgingReport(report, client_name, 'AP', as_of_date);
          return { content: [{ type: 'text', text: formatted }] };
        } catch (err: any) {
          return { content: [{ type: 'text', text: `Error fetching AP Aging: ${err?.message ?? err}` }] };
        }
      }
    );

    // ── get_cash_flow ─────────────────────────────────────────────────────────
    server.tool(
      'get_cash_flow',
      'Get Statement of Cash Flows for a QBO client (Operating, Investing, Financing sections). Defaults to Accrual basis.',
      {
        client_name: z.string().describe('The name of the client company'),
        start_date: z.string().describe('Start date in YYYY-MM-DD format'),
        end_date: z.string().describe('End date in YYYY-MM-DD format'),
        accounting_method: z.enum(['Cash', 'Accrual']).optional().describe('Cash or Accrual basis. Defaults to Accrual.'),
        class_id: z.string().optional().describe('Optional: QBO Class ID to filter by class.'),
        department_id: z.string().optional().describe('Optional: QBO Department/Location ID to filter by department.'),
      },
      async ({ client_name, start_date, end_date, accounting_method, class_id, department_id }) => {
        const realmId = await findRealmId(qboManager, client_name);
        if (!realmId) {
          return { content: [{ type: 'text', text: `Client not found: "${client_name}". Use list_clients to see available companies.` }] };
        }
        try {
          const report = await qboManager.reports.cashFlow(realmId, {
            startDate: start_date,
            endDate: end_date,
            accountingMethod: accounting_method,
            classId: class_id,
            departmentId: department_id,
          });
          const formatted = formatCashFlow(report, client_name, start_date, end_date);
          return { content: [{ type: 'text', text: formatted }] };
        } catch (err: any) {
          return { content: [{ type: 'text', text: `Error fetching Cash Flow: ${err?.message ?? err}` }] };
        }
      }
    );

    // Shared one-line QBO address formatter for detail views
    function formatAddressLine(addr: any): string {
      if (!addr) return '—';
      const parts = [addr.Line1, addr.Line2, addr.Line3, addr.Line4, addr.Line5, addr.City, addr.CountrySubDivisionCode, addr.PostalCode, addr.Country].filter(Boolean);
      return parts.length ? parts.join(', ') : '—';
    }

    // ── get_customers ────────────────────────────────────────────────────────
    server.tool(
      'get_customers',
      'Get list of customers for a QBO client. detail:"summary" (default) is a compact table; detail:"full" returns untruncated name, company, contact, email, phones, delivery method, and billing/shipping addresses — use it to audit contact data.',
      {
        client_name: z.string().describe('The name of the client company'),
        active_only: z.boolean().optional().describe('If true, only return active customers (default: true)'),
        detail: z.enum(['summary', 'full']).optional().describe('summary = compact table (default); full = complete untruncated contact records including addresses'),
      },
      async ({ client_name, active_only = true, detail = 'summary' }) => {
        const realmId = await findRealmId(qboManager, client_name);
        if (!realmId) {
          return { content: [{ type: 'text', text: `Client not found: "${client_name}". Use list_clients to see available companies.` }] };
        }
        try {
          const activeClause = active_only ? " WHERE Active = true" : "";
          const result = await qboManager.transactions.rawQuery(realmId, `SELECT * FROM Customer${activeClause} MAXRESULTS 1000`);
          const customers: any[] = (result as any)?.QueryResponse?.Customer ?? [];
          if (customers.length === 0) {
            return { content: [{ type: 'text', text: `No customers found for ${client_name}.` }] };
          }

          if (detail === 'full') {
            const blocks = customers.map((c) => {
              const person = [c.Title, c.GivenName, c.MiddleName, c.FamilyName, c.Suffix].filter(Boolean).join(' ');
              const lines = [
                `#${c.Id} ${c.DisplayName ?? c.FullyQualifiedName ?? ''} — ${c.Active ? 'Active' : 'Inactive'} | Balance: ${formatCurrency(c.Balance ?? 0)}`,
              ];
              if (c.CompanyName) lines.push(`  Company: ${c.CompanyName}`);
              if (person) lines.push(`  Contact: ${person}`);
              const comm: string[] = [];
              if (c.PrimaryEmailAddr?.Address) comm.push(`Email: ${c.PrimaryEmailAddr.Address}`);
              if (c.PrimaryPhone?.FreeFormNumber) comm.push(`Phone: ${c.PrimaryPhone.FreeFormNumber}`);
              if (c.Mobile?.FreeFormNumber) comm.push(`Mobile: ${c.Mobile.FreeFormNumber}`);
              if (c.Fax?.FreeFormNumber) comm.push(`Fax: ${c.Fax.FreeFormNumber}`);
              if (c.WebAddr?.URI) comm.push(`Web: ${c.WebAddr.URI}`);
              if (comm.length) lines.push(`  ${comm.join(' | ')}`);
              lines.push(`  Bill addr: ${formatAddressLine(c.BillAddr)}`);
              if (c.ShipAddr) lines.push(`  Ship addr: ${formatAddressLine(c.ShipAddr)}`);
              const meta: string[] = [];
              meta.push(`Delivery: ${c.PreferredDeliveryMethod ?? 'None'}`);
              if (c.Taxable !== undefined) meta.push(`Taxable: ${c.Taxable ? 'Yes' : 'No'}`);
              if (c.SalesTermRef?.value) meta.push(`Terms: ${c.SalesTermRef.name ?? c.SalesTermRef.value}`);
              if (c.ResaleNum) meta.push(`Resale #: ${c.ResaleNum}`);
              lines.push(`  ${meta.join(' | ')}`);
              if (c.Notes) lines.push(`  Notes: ${c.Notes}`);
              return lines.join('\n');
            });
            return { content: [{ type: 'text', text: `CUSTOMERS (full) — ${client_name}\nTotal: ${customers.length}${active_only ? ' (active only)' : ''}\n${'─'.repeat(80)}\n${blocks.join('\n\n')}` }] };
          }

          const lines = [
            `CUSTOMERS — ${client_name}`,
            `Total: ${customers.length}${active_only ? ' (active only)' : ''} — use detail:"full" for untruncated contact data incl. addresses`,
            '─'.repeat(80),
            `${'ID'.padEnd(12)} ${'Name'.padEnd(30)} ${'Email'.padEnd(25)} ${'Balance'.padStart(12)} ${'Status'.padEnd(8)}`,
            '─'.repeat(80),
          ];
          for (const c of customers) {
            const id = (c.Id ?? '').padEnd(12);
            const name = (c.DisplayName ?? c.FullyQualifiedName ?? '').substring(0, 29).padEnd(30);
            const email = (c.PrimaryEmailAddr?.Address ?? '').substring(0, 24).padEnd(25);
            const balance = formatCurrency(c.Balance ?? 0).padStart(12);
            const status = c.Active ? 'Active' : 'Inactive';
            lines.push(`${id} ${name} ${email} ${balance} ${status}`);
          }
          return { content: [{ type: 'text', text: lines.join('\n') }] };
        } catch (err: any) {
          return { content: [{ type: 'text', text: `Error fetching customers: ${err?.message ?? err}` }] };
        }
      }
    );

    // ── get_vendors ──────────────────────────────────────────────────────────
    server.tool(
      'get_vendors',
      'Get list of vendors for a QBO client. detail:"summary" (default) is a compact table; detail:"full" returns untruncated name, company, contact, email, phones, 1099 status, and billing address — use it to audit contact data.',
      {
        client_name: z.string().describe('The name of the client company'),
        active_only: z.boolean().optional().describe('If true, only return active vendors (default: true)'),
        detail: z.enum(['summary', 'full']).optional().describe('summary = compact table (default); full = complete untruncated contact records including addresses'),
      },
      async ({ client_name, active_only = true, detail = 'summary' }) => {
        const realmId = await findRealmId(qboManager, client_name);
        if (!realmId) {
          return { content: [{ type: 'text', text: `Client not found: "${client_name}". Use list_clients to see available companies.` }] };
        }
        try {
          const activeClause = active_only ? " WHERE Active = true" : "";
          const result = await qboManager.transactions.rawQuery(realmId, `SELECT * FROM Vendor${activeClause} MAXRESULTS 1000`);
          const vendors: any[] = (result as any)?.QueryResponse?.Vendor ?? [];
          if (vendors.length === 0) {
            return { content: [{ type: 'text', text: `No vendors found for ${client_name}.` }] };
          }

          if (detail === 'full') {
            const blocks = vendors.map((v) => {
              const person = [v.Title, v.GivenName, v.MiddleName, v.FamilyName, v.Suffix].filter(Boolean).join(' ');
              const lines = [
                `#${v.Id} ${v.DisplayName ?? v.PrintOnCheckName ?? ''} — ${v.Active ? 'Active' : 'Inactive'} | Balance: ${formatCurrency(v.CurrentBalance ?? 0)}`,
              ];
              if (v.CompanyName) lines.push(`  Company: ${v.CompanyName}`);
              if (person) lines.push(`  Contact: ${person}`);
              const comm: string[] = [];
              if (v.PrimaryEmailAddr?.Address) comm.push(`Email: ${v.PrimaryEmailAddr.Address}`);
              if (v.PrimaryPhone?.FreeFormNumber) comm.push(`Phone: ${v.PrimaryPhone.FreeFormNumber}`);
              if (v.Mobile?.FreeFormNumber) comm.push(`Mobile: ${v.Mobile.FreeFormNumber}`);
              if (v.Fax?.FreeFormNumber) comm.push(`Fax: ${v.Fax.FreeFormNumber}`);
              if (v.WebAddr?.URI) comm.push(`Web: ${v.WebAddr.URI}`);
              if (comm.length) lines.push(`  ${comm.join(' | ')}`);
              lines.push(`  Bill addr: ${formatAddressLine(v.BillAddr)}`);
              const meta: string[] = [];
              meta.push(`1099: ${v.Vendor1099 ? 'Yes' : 'No'}`);
              if (v.TaxIdentifier) meta.push(`Tax ID: ${v.TaxIdentifier}`);
              if (v.AcctNum) meta.push(`Acct #: ${v.AcctNum}`);
              if (v.TermRef?.value) meta.push(`Terms: ${v.TermRef.name ?? v.TermRef.value}`);
              if (v.BillRate !== undefined) meta.push(`Bill rate: ${v.BillRate}`);
              lines.push(`  ${meta.join(' | ')}`);
              return lines.join('\n');
            });
            return { content: [{ type: 'text', text: `VENDORS (full) — ${client_name}\nTotal: ${vendors.length}${active_only ? ' (active only)' : ''}\n${'─'.repeat(80)}\n${blocks.join('\n\n')}` }] };
          }

          const lines = [
            `VENDORS — ${client_name}`,
            `Total: ${vendors.length}${active_only ? ' (active only)' : ''} — use detail:"full" for untruncated contact data incl. addresses`,
            '─'.repeat(80),
            `${'ID'.padEnd(12)} ${'Name'.padEnd(30)} ${'Email'.padEnd(25)} ${'Balance'.padStart(12)} ${'Status'.padEnd(8)}`,
            '─'.repeat(80),
          ];
          for (const v of vendors) {
            const id = (v.Id ?? '').padEnd(12);
            const name = (v.DisplayName ?? v.PrintOnCheckName ?? '').substring(0, 29).padEnd(30);
            const email = (v.PrimaryEmailAddr?.Address ?? '').substring(0, 24).padEnd(25);
            const balance = formatCurrency(v.CurrentBalance ?? 0).padStart(12);
            const status = v.Active ? 'Active' : 'Inactive';
            lines.push(`${id} ${name} ${email} ${balance} ${status}`);
          }
          return { content: [{ type: 'text', text: lines.join('\n') }] };
        } catch (err: any) {
          return { content: [{ type: 'text', text: `Error fetching vendors: ${err?.message ?? err}` }] };
        }
      }
    );

    // ── get_invoices ─────────────────────────────────────────────────────────
    server.tool(
      'get_invoices',
      'Get invoices for a QBO client with id, date, due date, customer, amount, balance, and status',
      {
        client_name: z.string().describe('The name of the client company'),
        start_date: z.string().optional().describe('Start date filter in YYYY-MM-DD format'),
        end_date: z.string().optional().describe('End date filter in YYYY-MM-DD format'),
        status: z.enum(['open', 'paid', 'all']).optional().describe('Filter by status: open (Balance > 0), paid (Balance = 0), or all. Default: all'),
      },
      async ({ client_name, start_date, end_date, status = 'all' }) => {
        const realmId = await findRealmId(qboManager, client_name);
        if (!realmId) {
          return { content: [{ type: 'text', text: `Client not found: "${client_name}". Use list_clients to see available companies.` }] };
        }
        try {
          const conditions: string[] = [];
          if (start_date) conditions.push(`TxnDate >= '${start_date}'`);
          if (end_date) conditions.push(`TxnDate <= '${end_date}'`);
          const whereClause = conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : '';
          const result = await qboManager.transactions.rawQuery(realmId, `SELECT * FROM Invoice${whereClause} ORDERBY TxnDate DESC MAXRESULTS 1000`);
          let invoices: any[] = (result as any)?.QueryResponse?.Invoice ?? [];
          // Filter by status
          if (status === 'open') invoices = invoices.filter((inv: any) => parseFloat(inv.Balance ?? '0') > 0);
          else if (status === 'paid') invoices = invoices.filter((inv: any) => parseFloat(inv.Balance ?? '0') === 0);
          if (invoices.length === 0) {
            return { content: [{ type: 'text', text: `No invoices found for ${client_name} with the given filters.` }] };
          }
          const lines = [
            `INVOICES — ${client_name}`,
            `Total: ${invoices.length} | Filter: ${status}${start_date ? ` | From: ${start_date}` : ''}${end_date ? ` | To: ${end_date}` : ''}`,
            '─'.repeat(100),
            `${'ID'.padEnd(10)} ${'Date'.padEnd(12)} ${'Due Date'.padEnd(12)} ${'Customer'.padEnd(28)} ${'Amount'.padStart(12)} ${'Balance'.padStart(12)} ${'Status'.padEnd(8)}`,
            '─'.repeat(100),
          ];
          for (const inv of invoices) {
            const id = (inv.Id ?? '').padEnd(10);
            const date = (inv.TxnDate ?? '').padEnd(12);
            const dueDate = (inv.DueDate ?? '').padEnd(12);
            const customer = (inv.CustomerRef?.name ?? '').substring(0, 27).padEnd(28);
            const amount = formatCurrency(inv.TotalAmt ?? 0).padStart(12);
            const balance = formatCurrency(inv.Balance ?? 0).padStart(12);
            const invStatus = parseFloat(inv.Balance ?? '0') === 0 ? 'Paid' : 'Open';
            lines.push(`${id} ${date} ${dueDate} ${customer} ${amount} ${balance} ${invStatus}`);
          }
          const totalAmount = invoices.reduce((s: number, i: any) => s + parseFloat(i.TotalAmt ?? '0'), 0);
          const totalBalance = invoices.reduce((s: number, i: any) => s + parseFloat(i.Balance ?? '0'), 0);
          lines.push('─'.repeat(100));
          lines.push(`${'TOTAL'.padEnd(10)} ${''.padEnd(12)} ${''.padEnd(12)} ${''.padEnd(28)} ${formatCurrency(totalAmount).padStart(12)} ${formatCurrency(totalBalance).padStart(12)}`);
          return { content: [{ type: 'text', text: lines.join('\n') }] };
        } catch (err: any) {
          return { content: [{ type: 'text', text: `Error fetching invoices: ${err?.message ?? err}` }] };
        }
      }
    );

    // ── get_bills ────────────────────────────────────────────────────────────
    server.tool(
      'get_bills',
      'Get bills (accounts payable) for a QBO client with id, date, due date, vendor, amount, balance, and status',
      {
        client_name: z.string().describe('The name of the client company'),
        start_date: z.string().optional().describe('Start date filter in YYYY-MM-DD format'),
        end_date: z.string().optional().describe('End date filter in YYYY-MM-DD format'),
        status: z.enum(['open', 'paid', 'all']).optional().describe('Filter by status: open (Balance > 0), paid (Balance = 0), or all. Default: all'),
      },
      async ({ client_name, start_date, end_date, status = 'all' }) => {
        const realmId = await findRealmId(qboManager, client_name);
        if (!realmId) {
          return { content: [{ type: 'text', text: `Client not found: "${client_name}". Use list_clients to see available companies.` }] };
        }
        try {
          const conditions: string[] = [];
          if (start_date) conditions.push(`TxnDate >= '${start_date}'`);
          if (end_date) conditions.push(`TxnDate <= '${end_date}'`);
          const whereClause = conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : '';
          const result = await qboManager.transactions.rawQuery(realmId, `SELECT * FROM Bill${whereClause} ORDERBY TxnDate DESC MAXRESULTS 1000`);
          let bills: any[] = (result as any)?.QueryResponse?.Bill ?? [];
          // Filter by status
          if (status === 'open') bills = bills.filter((b: any) => parseFloat(b.Balance ?? '0') > 0);
          else if (status === 'paid') bills = bills.filter((b: any) => parseFloat(b.Balance ?? '0') === 0);
          if (bills.length === 0) {
            return { content: [{ type: 'text', text: `No bills found for ${client_name} with the given filters.` }] };
          }
          const lines = [
            `BILLS — ${client_name}`,
            `Total: ${bills.length} | Filter: ${status}${start_date ? ` | From: ${start_date}` : ''}${end_date ? ` | To: ${end_date}` : ''}`,
            '─'.repeat(100),
            `${'ID'.padEnd(10)} ${'Date'.padEnd(12)} ${'Due Date'.padEnd(12)} ${'Vendor'.padEnd(28)} ${'Amount'.padStart(12)} ${'Balance'.padStart(12)} ${'Status'.padEnd(8)}`,
            '─'.repeat(100),
          ];
          for (const bill of bills) {
            const id = (bill.Id ?? '').padEnd(10);
            const date = (bill.TxnDate ?? '').padEnd(12);
            const dueDate = (bill.DueDate ?? '').padEnd(12);
            const vendor = (bill.VendorRef?.name ?? '').substring(0, 27).padEnd(28);
            const amount = formatCurrency(bill.TotalAmt ?? 0).padStart(12);
            const balance = formatCurrency(bill.Balance ?? 0).padStart(12);
            const billStatus = parseFloat(bill.Balance ?? '0') === 0 ? 'Paid' : 'Open';
            lines.push(`${id} ${date} ${dueDate} ${vendor} ${amount} ${balance} ${billStatus}`);
          }
          const totalAmount = bills.reduce((s: number, b: any) => s + parseFloat(b.TotalAmt ?? '0'), 0);
          const totalBalance = bills.reduce((s: number, b: any) => s + parseFloat(b.Balance ?? '0'), 0);
          lines.push('─'.repeat(100));
          lines.push(`${'TOTAL'.padEnd(10)} ${''.padEnd(12)} ${''.padEnd(12)} ${''.padEnd(28)} ${formatCurrency(totalAmount).padStart(12)} ${formatCurrency(totalBalance).padStart(12)}`);
          return { content: [{ type: 'text', text: lines.join('\n') }] };
        } catch (err: any) {
          return { content: [{ type: 'text', text: `Error fetching bills: ${err?.message ?? err}` }] };
        }
      }
    );

    // ── get_accounts ──────────────────────────────────────────────────────────
    server.tool(
      'get_accounts',
      'Get Chart of Accounts for a QBO client',
      { client_name: z.string().describe('The name of the client company') },
      async ({ client_name }) => {
        const realmId = await findRealmId(qboManager, client_name);
        if (!realmId) {
          return { content: [{ type: 'text', text: `Client not found: "${client_name}". Use list_clients to see available companies.` }] };
        }
        try {
          const accounts = await qboManager.accounts.getAll(realmId);
          const list = ((accounts as any)?.QueryResponse?.Account ?? accounts ?? []) as any[];
          const lines = [
            `CHART OF ACCOUNTS — ${client_name}`,
            '─'.repeat(60),
            ...list.map((a: any) => `  ${a.AcctNum ? `[${a.AcctNum}] ` : ''}${a.Name ?? 'Unknown'} — ${a.AccountType ?? ''} (${a.Classification ?? ''})`),
          ];
          return { content: [{ type: 'text', text: lines.join('\n') }] };
        } catch (err: any) {
          return { content: [{ type: 'text', text: `Error fetching accounts: ${err?.message ?? err}` }] };
        }
      }
    );

    // ── get_general_ledger ───────────────────────────────────────────────────
    server.tool(
      'get_general_ledger',
      'Get General Ledger report for a QBO client. Returns structured transaction-level detail by account, with true per-transaction `debit` and `credit` fields (from the report\'s explicit Debit/Credit columns when QBO provides them, else derived from the signed amount and each account\'s normal balance — the signed `amount` is positive in the account\'s normal-balance direction, NOT always positive-means-debit). The account filter (`accounts` array, or `account_filter` as a comma-separated string) accepts QBO Account IDs, account numbers ("5012"), names ("Wages Pastoral"), or "number name" strings. Number terms match by prefix at a sub-account boundary — "4404" catches 4404, 4404-1 and 4404.2, but not 44040 — and matched parents expand to all their sub-accounts unless include_sub_accounts=false. Everything resolves to Account IDs server-side and rides Intuit\'s native account filter, so filtered pulls stay small and fast; terms that match nothing are listed in `warnings` (and unresolved_account_filters), never silently dropped. SIZE: an unfiltered full-year GL can exceed 1.5M characters — filter to specific accounts and/or set summary_only=true unless you truly need everything. Defaults to Accrual basis.',
      {
        client_name: z.string().describe('The name of the client company'),
        start_date: z.string().describe('Start date in YYYY-MM-DD format'),
        end_date: z.string().describe('End date in YYYY-MM-DD format'),
        accounts: z.array(z.string()).optional().describe('Optional: filter to specific accounts. Accepts QBO Account IDs, account numbers (e.g. "5012" — prefix-matches sub-accounts like 5012-1), names (e.g. "Wages Pastoral"), or "number name" strings. Resolved to IDs server-side before calling Intuit.'),
        account_filter: z.string().optional().describe('Optional: the same account filter as `accounts`, as a single string — one account or a comma-separated list (e.g. "4404" or "1200,4404"). Merged with `accounts` when both are provided.'),
        include_sub_accounts: z.boolean().optional().describe('When an account filter matches a parent account, also include all of its sub-accounts (default: true). Set false to report on exactly the matched accounts.'),
        summary_only: z.boolean().optional().describe('If true, omit transaction rows and return one row per account (number, name, classification, transaction_count, total_debits, total_credits, ending_balance). Use for size control on wide pulls.'),
        accounting_method: z.enum(['Cash', 'Accrual']).optional().describe('Cash or Accrual basis. Defaults to Accrual.'),
        class_id: z.string().optional().describe('Optional: QBO Class ID (or comma-separated IDs) to filter by class.'),
        department_id: z.string().optional().describe('Optional: QBO Department/Location ID (or comma-separated IDs).'),
      },
      async ({ client_name, start_date, end_date, accounts, account_filter, include_sub_accounts, summary_only, accounting_method, class_id, department_id }) => {
        const realmId = await findRealmId(qboManager, client_name);
        if (!realmId) {
          return { content: [{ type: 'text', text: `Client not found: "${client_name}". Use list_clients to see available companies.` }] };
        }
        try {
          // The chart of accounts backs three things here: filter-term
          // resolution, parent → sub-account expansion, and the account
          // classification that makes debit/credit attribution correct.
          const accountsResp: any = await qboManager.accounts.getAll(realmId);
          const accountList: any[] = accountsResp?.QueryResponse?.Account ?? [];
          const warnings: string[] = [];

          // Merge both filter spellings into one term list. Intuit's GL
          // `account` param only accepts IDs — names/numbers sent raw would
          // silently return an empty report, so resolve them here first.
          const filterTerms = [
            ...(accounts ?? []),
            ...(account_filter ? account_filter.split(',') : []),
          ].map((t) => t.trim()).filter(Boolean);

          let resolvedAccountIds: string | undefined;
          let unresolved: string[] = [];
          if (filterTerms.length > 0) {
            const resolution = resolveAccountFilterTerms(accountList, filterTerms);
            unresolved = resolution.unresolved;
            if (resolution.ids.length === 0) {
              return { content: [{ type: 'text', text: `No accounts matched the provided filter(s): ${filterTerms.join(', ')}. Use get_accounts to see available account IDs / names / numbers.` }] };
            }
            const ids = include_sub_accounts === false
              ? resolution.ids
              : expandToDescendants(accountList, resolution.ids);
            resolvedAccountIds = ids.join(',');
            for (const term of unresolved) {
              warnings.push(`Account filter term "${term}" did not match any account — it was NOT applied. Use get_accounts to see available IDs / numbers / names.`);
            }
          }

          const glOptions = {
            startDate: start_date,
            endDate: end_date,
            accountingMethod: accounting_method,
            classId: class_id,
            departmentId: department_id,
            accountIds: resolvedAccountIds,
          };

          // Prefer explicit Debit/Credit columns from Intuit. If the
          // columns-qualified request fails or comes back without them,
          // fall back to the default report and classification-based
          // attribution — never let the whole GL call die on a columns quirk.
          const GL_EXPLICIT_COLUMNS = 'tx_date,txn_type,doc_num,name,memo,split_acc,debt_amt,credit_amt,subt_nat_amount,rbal_nat_amount';
          const hasCol = (r: any, title: string): boolean =>
            ((r?.Columns?.Column ?? []) as any[]).some((c: any) => (c.ColTitle ?? '').toLowerCase() === title);
          let report: any = null;
          try {
            report = await qboManager.reports.generalLedger(realmId, { ...glOptions, columns: GL_EXPLICIT_COLUMNS });
            if (!hasCol(report, 'debit') || !hasCol(report, 'credit') || !hasCol(report, 'date')) report = null;
          } catch {
            report = null;
          }
          if (!report) {
            report = await qboManager.reports.generalLedger(realmId, glOptions);
            warnings.push('Explicit Debit/Credit columns were unavailable from QBO for this pull — debit/credit are derived from the signed amount and each account\'s normal balance (classification).');
          }

          let parsed = parseGeneralLedger(report, client_name, start_date, end_date, accountList);
          if (summary_only) {
            parsed = summarizeGeneralLedger(parsed);
          }
          if (unresolved.length > 0) {
            (parsed as any).unresolved_account_filters = unresolved;
          }
          if (warnings.length > 0) {
            (parsed as any).warnings = warnings;
          }
          return { content: [{ type: 'text', text: JSON.stringify(parsed, null, 2) }] };
        } catch (err: any) {
          return { content: [{ type: 'text', text: `Error fetching General Ledger: ${err?.message ?? err}` }] };
        }
      }
    );

    // ── query_transactions ────────────────────────────────────────────────────
    server.tool(
      'query_transactions',
      'Execute a raw QBO SQL query for a client. Queryable entities include Invoice, Bill, Payment, BillPayment, Purchase, SalesReceipt, CreditMemo, RefundReceipt, JournalEntry, Deposit, Estimate, PurchaseOrder, Transfer, Customer, Vendor, Employee, Account, Class, Department, Item, Budget, CompanyInfo, Preferences, TaxCode, TaxRate, PaymentMethod, Term, Attachable. Column projection (SELECT Id, DisplayName FROM …) is supported for scalar fields; QBO itself may reject complex-typed fields (e.g. BillAddr) in a projection list — use SELECT *, or get_customers/get_vendors with detail:"full", when you need addresses. Some fields are not queryable at all (e.g. TotalAmt on Deposit; TotalAmt does not exist on JournalEntry; Line-level fields) — QBO\'s validation error is surfaced verbatim. Results are cleaned of QBO wire noise (PurchaseEx-style JAXB blobs, empty CustomExtensions, domain, sparse) by default — MetaData create/update times are kept; pass raw=true for the untouched response.',
      {
        client_name: z.string().describe('The name of the client company'),
        query: z.string().describe('QBO SQL query, e.g. "SELECT * FROM Invoice WHERE TxnDate > \'2026-01-01\'" or "SELECT * FROM Budget"'),
        raw: z.boolean().optional().describe('If true, return QBO\'s response untouched (including PurchaseEx blobs, CustomExtensions, domain, sparse). Default false.'),
      },
      async ({ client_name, query, raw }) => {
        const realmId = await findRealmId(qboManager, client_name);
        if (!realmId) {
          return { content: [{ type: 'text', text: `Client not found: "${client_name}". Use list_clients to see available companies.` }] };
        }
        try {
          const result = await qboManager.transactions.rawQuery(realmId, query);
          const output = raw ? result : stripQboNoise(result);
          return { content: [{ type: 'text', text: JSON.stringify(output, null, 2) }] };
        } catch (err: any) {
          return { content: [{ type: 'text', text: `Error executing query: ${err?.message ?? err}` }] };
        }
      }
    );

    // ── get_budget ────────────────────────────────────────────────────────────
    server.tool(
      'get_budget',
      'Get budget(s) for a QBO client. DEFAULT (no budget_id): returns a SUMMARY list — one row per budget with budget_id, name, budget_type (ProfitAndLoss or BalanceSheet), budget_entry_type (Yearly | Quarterly | Monthly), start/end dates, active, and entry_count — so the right budget can be found without pulling everything. Pass budget_id for full (account × period) entries of one budget, or summary_only=false to force full entries for every matched budget. SIZE: a full-detail all-budgets pull can exceed 3M characters for companies with many budgets — stay in summary mode until you know which budget you need. Narrow with name_contains and/or active_on.',
      {
        client_name: z.string().describe('The name of the client company'),
        budget_id: z.string().optional().describe('Optional: a specific Budget ID. When provided, full entries are returned by default.'),
        active_only: z.boolean().optional().describe('If true, only return active budgets (default: true).'),
        name_contains: z.string().optional().describe('Optional: case-insensitive substring filter on the budget name (e.g. "FY26").'),
        active_on: z.string().optional().describe('Optional: a date (YYYY-MM-DD) — only return budgets whose start/end range covers it.'),
        summary_only: z.boolean().optional().describe('Metadata only, no entries. Defaults to true when budget_id is omitted, false when it is provided; pass explicitly to override either default.'),
      },
      async ({ client_name, budget_id, active_only = true, name_contains, active_on, summary_only }) => {
        const realmId = await findRealmId(qboManager, client_name);
        if (!realmId) {
          return { content: [{ type: 'text', text: `Client not found: "${client_name}". Use list_clients to see available companies.` }] };
        }
        try {
          const conditions: string[] = [];
          if (budget_id) conditions.push(`Id = '${budget_id}'`);
          if (active_only) conditions.push(`Active = true`);
          const where = conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '';
          const result: any = await qboManager.transactions.rawQuery(realmId, `SELECT * FROM Budget${where} MAXRESULTS 1000`);
          const allBudgets: any[] = result?.QueryResponse?.Budget ?? [];
          const budgets = filterBudgets(allBudgets, { nameContains: name_contains, activeOn: active_on });

          if (budgets.length === 0) {
            const filterNote = [
              budget_id ? `id ${budget_id}` : '',
              name_contains ? `name containing "${name_contains}"` : '',
              active_on ? `active on ${active_on}` : '',
            ].filter(Boolean).join(', ');
            return { content: [{ type: 'text', text: `No budgets found for ${client_name}${filterNote ? ` matching: ${filterNote}` : ''}${allBudgets.length > 0 ? ` (${allBudgets.length} budget(s) exist — loosen the filters or call without them for the summary list)` : ''}. Note: budgets are read-only via the QBO API — they must be created in the QBO web UI.` }] };
          }

          // Summary metadata unless full detail was requested — a lone
          // get_budget(client_name) call must never dump every entry again.
          const wantSummary = summary_only ?? !budget_id;
          if (wantSummary) {
            const output = budgets.map(budgetToSummary);
            return { content: [{ type: 'text', text: JSON.stringify({ client: client_name, total_budgets: output.length, detail_level: 'summary', hint: 'Pass budget_id (or summary_only=false) for full account × period entries.', budgets: output }, null, 2) }] };
          }

          // Resolve account IDs → names from the chart of accounts
          const accountsResp: any = await qboManager.accounts.getAll(realmId);
          const accountList: any[] = accountsResp?.QueryResponse?.Account ?? [];
          const accountNameById = new Map<string, string>();
          for (const a of accountList) {
            if (a.Id) accountNameById.set(String(a.Id), a.Name ?? a.FullyQualifiedName ?? '');
          }

          const output = budgets.map((b: any) => {
            const entries: any[] = [];
            for (const detail of (b.BudgetDetail ?? [])) {
              const accountId = String(detail.AccountRef?.value ?? '');
              const accountName = accountNameById.get(accountId) ?? detail.AccountRef?.name ?? '';
              entries.push({
                account_id: accountId,
                account_name: accountName,
                period: {
                  start: detail.BudgetDate ?? null,
                  end: detail.EndDate ?? null,
                },
                amount: parseFloat(detail.Amount ?? '0') || 0,
              });
            }
            return {
              ...budgetToSummary(b),
              entries,
            };
          });

          return { content: [{ type: 'text', text: JSON.stringify({ client: client_name, total_budgets: output.length, detail_level: 'full', budgets: output }, null, 2) }] };
        } catch (err: any) {
          return { content: [{ type: 'text', text: `Error fetching budget: ${err?.message ?? err}` }] };
        }
      }
    );

    // ── get_budget_vs_actuals ─────────────────────────────────────────────────
    server.tool(
      'get_budget_vs_actuals',
      'Get the Budget vs Actuals report for a QBO client. Returns variance between budgeted and actual amounts per account. Defaults to Accrual basis.',
      {
        client_name: z.string().describe('The name of the client company'),
        start_date: z.string().describe('Start date in YYYY-MM-DD format'),
        end_date: z.string().describe('End date in YYYY-MM-DD format'),
        budget_id: z.string().optional().describe('Optional: a specific Budget ID. If omitted, QBO uses the company default.'),
        summarize_by: z.enum(['Total', 'Month', 'Quarter', 'Year']).optional().describe('Optional: how to summarize columns.'),
        accounting_method: z.enum(['Cash', 'Accrual']).optional().describe('Cash or Accrual basis. Defaults to Accrual.'),
      },
      async ({ client_name, start_date, end_date, budget_id, summarize_by, accounting_method }) => {
        const realmId = await findRealmId(qboManager, client_name);
        if (!realmId) {
          return { content: [{ type: 'text', text: `Client not found: "${client_name}". Use list_clients to see available companies.` }] };
        }
        try {
          const report = await qboManager.reports.budgetVsActuals(realmId, {
            startDate: start_date,
            endDate: end_date,
            budgetId: budget_id,
            summarizeColumnBy: summarize_by,
            accountingMethod: accounting_method,
          });
          return { content: [{ type: 'text', text: JSON.stringify(report, null, 2) }] };
        } catch (err: any) {
          return { content: [{ type: 'text', text: `Error fetching Budget vs Actuals: ${err?.message ?? err}` }] };
        }
      }
    );

    // ═══════════════════════════════════════════════════════════════════════════
    // WRITE / EDIT TOOLS
    // ═══════════════════════════════════════════════════════════════════════════

    // ── create_journal_entry ─────────────────────────────────────────────────
    server.tool(
      'create_journal_entry',
      'Create a journal entry in QuickBooks Online. Each line must have a PostingType (Debit or Credit) and an AccountRef. Debits and credits must balance. Supports class, department, and (where applicable) sales terms at the appropriate QBO level (header or line). NOTE: DepartmentRef is set per-line on JournalEntry, not on the header.',
      {
        client_name: z.string().describe('The name of the client company'),
        txn_date: z.string().optional().describe('Transaction date in YYYY-MM-DD format. Defaults to today.'),
        private_note: z.string().optional().describe('Private memo/note for the journal entry'),
        lines: z.array(z.object({
          posting_type: z.enum(['Debit', 'Credit']).describe('Debit or Credit'),
          account_id: z.string().describe('QBO Account ID (use get_accounts to find IDs)'),
          account_name: z.string().optional().describe('Account name (optional, for readability)'),
          amount: z.number().describe('Line amount (positive number)'),
          description: z.string().optional().describe('Line description/memo'),
          entity_type: z.enum(['Customer', 'Vendor', 'Employee']).optional().describe('Entity type if assigning to a name'),
          entity_id: z.string().optional().describe('Entity ID (customer/vendor/employee ID)'),
          entity_name: z.string().optional().describe('Entity name (optional, for readability)'),
          class_id: z.string().optional().describe('Class ID for class tracking'),
          class_name: z.string().optional().describe('Class name (optional, for readability)'),
          department_id: z.string().optional().describe('Line-level DepartmentRef.value (JournalEntry uses department per-line, not header)'),
        })).describe('Array of journal entry lines. Debits must equal credits.'),
      },
      async ({ client_name, txn_date, private_note, lines }) => {
        const realmId = await findRealmId(qboManager, client_name);
        if (!realmId) {
          return { content: [{ type: 'text', text: `Client not found: "${client_name}". Use list_clients to see available companies.` }] };
        }

        // Validate debits = credits
        const totalDebits = lines.filter(l => l.posting_type === 'Debit').reduce((sum, l) => sum + l.amount, 0);
        const totalCredits = lines.filter(l => l.posting_type === 'Credit').reduce((sum, l) => sum + l.amount, 0);
        if (Math.abs(totalDebits - totalCredits) > 0.01) {
          return { content: [{ type: 'text', text: `Debits (${totalDebits.toFixed(2)}) must equal Credits (${totalCredits.toFixed(2)}). Difference: ${Math.abs(totalDebits - totalCredits).toFixed(2)}` }] };
        }

        try {
          const jeLines = lines.map(l => {
            const line: any = {
              Amount: l.amount,
              DetailType: 'JournalEntryLineDetail',
              Description: l.description,
              JournalEntryLineDetail: {
                PostingType: l.posting_type,
                AccountRef: { value: l.account_id, name: l.account_name },
              },
            };
            if (l.entity_type && l.entity_id) {
              line.JournalEntryLineDetail.Entity = {
                Type: l.entity_type,
                EntityRef: { value: l.entity_id, name: l.entity_name },
              };
            }
            if (l.class_id) {
              line.JournalEntryLineDetail.ClassRef = { value: l.class_id, name: l.class_name };
            }
            if (l.department_id) {
              line.JournalEntryLineDetail.DepartmentRef = { value: l.department_id };
            }
            return line;
          });

          const payload: any = { Line: jeLines };
          if (txn_date) payload.TxnDate = txn_date;
          if (private_note) payload.PrivateNote = private_note;

          const result = await qboManager.journalEntries.create(realmId, payload);
          const je = (result as any)?.JournalEntry;
          const summary = je
            ? `Journal Entry #${je.DocNumber ?? je.Id} created successfully.\nID: ${je.Id} | SyncToken: ${je.SyncToken} | Date: ${je.TxnDate} | Total: ${formatCurrency(je.TotalAmt)}`
            : JSON.stringify(result, null, 2);
          return { content: [{ type: 'text', text: summary }] };
        } catch (err: any) {
          return { content: [{ type: 'text', text: `Error creating journal entry: ${err?.message ?? err}` }] };
        }
      }
    );

    // ── update_journal_entry ─────────────────────────────────────────────────
    server.tool(
      'update_journal_entry',
      'Update an existing journal entry. Fetches the current JE first, then applies your changes. You can replace all lines or update metadata. Supports class, department, and (where applicable) sales terms at the appropriate QBO level (header or line). NOTE: DepartmentRef is set per-line on JournalEntry, not on the header.',
      {
        client_name: z.string().describe('The name of the client company'),
        journal_entry_id: z.string().describe('The QBO Journal Entry ID to update'),
        txn_date: z.string().optional().describe('New transaction date (YYYY-MM-DD)'),
        private_note: z.string().optional().describe('New private note'),
        lines: z.array(z.object({
          posting_type: z.enum(['Debit', 'Credit']),
          account_id: z.string(),
          account_name: z.string().optional(),
          amount: z.number(),
          description: z.string().optional(),
          entity_type: z.enum(['Customer', 'Vendor', 'Employee']).optional(),
          entity_id: z.string().optional(),
          entity_name: z.string().optional(),
          class_id: z.string().optional(),
          class_name: z.string().optional(),
          department_id: z.string().optional().describe('Line-level DepartmentRef.value'),
        })).optional().describe('Replacement lines (if provided, replaces ALL existing lines). Debits must equal credits.'),
      },
      async ({ client_name, journal_entry_id, txn_date, private_note, lines }) => {
        const realmId = await findRealmId(qboManager, client_name);
        if (!realmId) {
          return { content: [{ type: 'text', text: `Client not found: "${client_name}". Use list_clients to see available companies.` }] };
        }

        try {
          // Fetch existing JE to get SyncToken
          const existing = await qboManager.journalEntries.get(realmId, journal_entry_id) as any;
          const je = existing?.JournalEntry;
          if (!je) {
            return { content: [{ type: 'text', text: `Journal Entry ${journal_entry_id} not found.` }] };
          }

          const payload: any = { ...je };
          if (txn_date) payload.TxnDate = txn_date;
          if (private_note !== undefined) payload.PrivateNote = private_note;

          if (lines) {
            const totalDebits = lines.filter(l => l.posting_type === 'Debit').reduce((sum, l) => sum + l.amount, 0);
            const totalCredits = lines.filter(l => l.posting_type === 'Credit').reduce((sum, l) => sum + l.amount, 0);
            if (Math.abs(totalDebits - totalCredits) > 0.01) {
              return { content: [{ type: 'text', text: `Debits (${totalDebits.toFixed(2)}) must equal Credits (${totalCredits.toFixed(2)}).` }] };
            }

            payload.Line = lines.map(l => {
              const line: any = {
                Amount: l.amount,
                DetailType: 'JournalEntryLineDetail',
                Description: l.description,
                JournalEntryLineDetail: {
                  PostingType: l.posting_type,
                  AccountRef: { value: l.account_id, name: l.account_name },
                },
              };
              if (l.entity_type && l.entity_id) {
                line.JournalEntryLineDetail.Entity = {
                  Type: l.entity_type,
                  EntityRef: { value: l.entity_id, name: l.entity_name },
                };
              }
              if (l.class_id) {
                line.JournalEntryLineDetail.ClassRef = { value: l.class_id, name: l.class_name };
              }
              if (l.department_id) {
                line.JournalEntryLineDetail.DepartmentRef = { value: l.department_id };
              }
              return line;
            });
          }

          const result = await qboManager.journalEntries.update(realmId, payload);
          const updated = (result as any)?.JournalEntry;
          if (updated && lines) {
            const failure = await verifyLinesAndMaybeRollback({
              entityLabel: 'Journal Entry',
              original: je,
              submitted: postedLineStats(payload.Line),
              updated,
              rollback: async (p) => ((await qboManager.journalEntries.update(realmId, p)) as any)?.JournalEntry ?? null,
            });
            if (failure) return { content: [{ type: 'text', text: failure }] };
          }
          const summary = updated
            ? `Journal Entry #${updated.DocNumber ?? updated.Id} updated successfully.\nID: ${updated.Id} | SyncToken: ${updated.SyncToken} | Date: ${updated.TxnDate}`
            : JSON.stringify(result, null, 2);
          return { content: [{ type: 'text', text: summary }] };
        } catch (err: any) {
          return { content: [{ type: 'text', text: `Error updating journal entry: ${err?.message ?? err}` }] };
        }
      }
    );

    // ── delete_journal_entry ─────────────────────────────────────────────────
    server.tool(
      'delete_journal_entry',
      'Delete (soft-delete) a journal entry from QuickBooks Online',
      {
        client_name: z.string().describe('The name of the client company'),
        journal_entry_id: z.string().describe('The QBO Journal Entry ID to delete'),
      },
      async ({ client_name, journal_entry_id }) => {
        const realmId = await findRealmId(qboManager, client_name);
        if (!realmId) {
          return { content: [{ type: 'text', text: `Client not found: "${client_name}". Use list_clients to see available companies.` }] };
        }

        try {
          // Fetch to get SyncToken
          const existing = await qboManager.journalEntries.get(realmId, journal_entry_id) as any;
          const je = existing?.JournalEntry;
          if (!je) {
            return { content: [{ type: 'text', text: `Journal Entry ${journal_entry_id} not found.` }] };
          }

          await qboManager.journalEntries.delete(realmId, journal_entry_id, je.SyncToken);
          return { content: [{ type: 'text', text: `Journal Entry #${je.DocNumber ?? journal_entry_id} (ID: ${journal_entry_id}) deleted successfully.` }] };
        } catch (err: any) {
          return { content: [{ type: 'text', text: `Error deleting journal entry: ${err?.message ?? err}` }] };
        }
      }
    );

    // ── create_invoice ───────────────────────────────────────────────────────
    server.tool(
      'create_invoice',
      'Create an invoice in QuickBooks Online. Supports class, department, and (where applicable) sales terms at the appropriate QBO level (header or line).',
      {
        client_name: z.string().describe('The name of the client company'),
        customer_id: z.string().describe('QBO Customer ID (use get_customers to find IDs)'),
        customer_name: z.string().optional().describe('Customer display name (for readability)'),
        txn_date: z.string().optional().describe('Invoice date (YYYY-MM-DD). Defaults to today.'),
        due_date: z.string().optional().describe('Due date (YYYY-MM-DD)'),
        private_note: z.string().optional().describe('Private memo'),
        department_id: z.string().optional().describe('Header DepartmentRef.value'),
        sales_term_id: z.string().optional().describe('Header SalesTermRef.value. QBO computes DueDate from TxnDate + term unless due_date is also set.'),
        lines: z.array(z.object({
          description: z.string().optional().describe('Line item description'),
          amount: z.number().describe('Line amount'),
          detail_type: z.enum(['SalesItemLineDetail', 'DescriptionOnly']).default('SalesItemLineDetail').describe('Line detail type'),
          item_id: z.string().optional().describe('Item/Service ID (if SalesItemLineDetail)'),
          item_name: z.string().optional().describe('Item name (for readability)'),
          quantity: z.number().optional().describe('Quantity (default 1)'),
          unit_price: z.number().optional().describe('Unit price'),
        })).describe('Invoice line items'),
      },
      async ({ client_name, customer_id, customer_name, txn_date, due_date, private_note, department_id, sales_term_id, lines }) => {
        const realmId = await findRealmId(qboManager, client_name);
        if (!realmId) {
          return { content: [{ type: 'text', text: `Client not found: "${client_name}". Use list_clients to see available companies.` }] };
        }

        try {
          const invoiceLines = lines.map(l => {
            const line: any = {
              Amount: l.amount,
              DetailType: l.detail_type,
              Description: l.description,
            };
            if (l.detail_type === 'SalesItemLineDetail') {
              line.SalesItemLineDetail = {
                Qty: l.quantity ?? 1,
                UnitPrice: l.unit_price ?? l.amount,
              };
              if (l.item_id) {
                line.SalesItemLineDetail.ItemRef = { value: l.item_id, name: l.item_name };
              }
            }
            return line;
          });

          const payload: any = {
            CustomerRef: { value: customer_id, name: customer_name },
            Line: invoiceLines,
          };
          if (txn_date) payload.TxnDate = txn_date;
          if (department_id) payload.DepartmentRef = { value: department_id };
          if (sales_term_id) payload.SalesTermRef = { value: sales_term_id };
          if (due_date) payload.DueDate = due_date;
          if (private_note) payload.PrivateNote = private_note;

          const result = await qboManager.transactions.createInvoice(realmId, payload);
          const inv = (result as any)?.Invoice;
          const summary = inv
            ? `Invoice #${inv.DocNumber ?? inv.Id} created successfully.\nID: ${inv.Id} | SyncToken: ${inv.SyncToken} | Customer: ${inv.CustomerRef?.name ?? customer_id} | Total: ${formatCurrency(inv.TotalAmt)} | Balance: ${formatCurrency(inv.Balance)}`
            : JSON.stringify(result, null, 2);
          return { content: [{ type: 'text', text: summary }] };
        } catch (err: any) {
          return { content: [{ type: 'text', text: `Error creating invoice: ${err?.message ?? err}` }] };
        }
      }
    );

    // ── update_invoice ───────────────────────────────────────────────────────
    server.tool(
      'update_invoice',
      'Update an existing invoice. Fetches the current invoice first, then applies changes. Use sparse update: only provided fields are changed. Supports class, department, and (where applicable) sales terms at the appropriate QBO level (header or line).',
      {
        client_name: z.string().describe('The name of the client company'),
        invoice_id: z.string().describe('The QBO Invoice ID to update'),
        customer_id: z.string().optional().describe('New customer ID'),
        txn_date: z.string().optional().describe('New invoice date (YYYY-MM-DD)'),
        due_date: z.string().optional().describe('New due date (YYYY-MM-DD)'),
        private_note: z.string().optional().describe('New private note'),
        department_id: z.string().optional().describe('New header DepartmentRef.value'),
        sales_term_id: z.string().optional().describe('New header SalesTermRef.value'),
        lines: z.array(z.object({
          description: z.string().optional(),
          amount: z.number(),
          detail_type: z.enum(['SalesItemLineDetail', 'DescriptionOnly']).default('SalesItemLineDetail'),
          item_id: z.string().optional(),
          item_name: z.string().optional(),
          quantity: z.number().optional(),
          unit_price: z.number().optional(),
        })).optional().describe('Replacement line items (replaces ALL existing lines if provided)'),
      },
      async ({ client_name, invoice_id, customer_id, txn_date, due_date, private_note, department_id, sales_term_id, lines }) => {
        const realmId = await findRealmId(qboManager, client_name);
        if (!realmId) {
          return { content: [{ type: 'text', text: `Client not found: "${client_name}". Use list_clients to see available companies.` }] };
        }

        try {
          const existing = await qboManager.transactions.getInvoice(realmId, invoice_id) as any;
          const inv = existing?.Invoice;
          if (!inv) {
            return { content: [{ type: 'text', text: `Invoice ${invoice_id} not found.` }] };
          }

          const payload: any = { ...inv };
          if (customer_id) payload.CustomerRef = { value: customer_id };
          if (txn_date) payload.TxnDate = txn_date;
          if (department_id) payload.DepartmentRef = { value: department_id };
          if (sales_term_id) payload.SalesTermRef = { value: sales_term_id };
          if (due_date) payload.DueDate = due_date;
          if (private_note !== undefined) payload.PrivateNote = private_note;

          if (lines) {
            payload.Line = lines.map(l => {
              const line: any = { Amount: l.amount, DetailType: l.detail_type, Description: l.description };
              if (l.detail_type === 'SalesItemLineDetail') {
                line.SalesItemLineDetail = { Qty: l.quantity ?? 1, UnitPrice: l.unit_price ?? l.amount };
                if (l.item_id) line.SalesItemLineDetail.ItemRef = { value: l.item_id, name: l.item_name };
              }
              return line;
            });
          }

          const result = await qboManager.transactions.updateInvoice(realmId, payload);
          const updated = (result as any)?.Invoice;
          if (updated && lines) {
            const failure = await verifyLinesAndMaybeRollback({
              entityLabel: 'Invoice',
              original: inv,
              submitted: postedLineStats(payload.Line),
              updated,
              rollback: async (p) => ((await qboManager.transactions.updateInvoice(realmId, p)) as any)?.Invoice ?? null,
            });
            if (failure) return { content: [{ type: 'text', text: failure }] };
          }
          const summary = updated
            ? `Invoice #${updated.DocNumber ?? updated.Id} updated.\nID: ${updated.Id} | SyncToken: ${updated.SyncToken} | Total: ${formatCurrency(updated.TotalAmt)}`
            : JSON.stringify(result, null, 2);
          return { content: [{ type: 'text', text: summary }] };
        } catch (err: any) {
          return { content: [{ type: 'text', text: `Error updating invoice: ${err?.message ?? err}` }] };
        }
      }
    );

    // ── delete_invoice ───────────────────────────────────────────────────────
    server.tool(
      'delete_invoice',
      'Delete (void) an invoice from QuickBooks Online',
      {
        client_name: z.string().describe('The name of the client company'),
        invoice_id: z.string().describe('The QBO Invoice ID to delete'),
      },
      async ({ client_name, invoice_id }) => {
        const realmId = await findRealmId(qboManager, client_name);
        if (!realmId) {
          return { content: [{ type: 'text', text: `Client not found: "${client_name}". Use list_clients to see available companies.` }] };
        }

        try {
          const existing = await qboManager.transactions.getInvoice(realmId, invoice_id) as any;
          const inv = existing?.Invoice;
          if (!inv) {
            return { content: [{ type: 'text', text: `Invoice ${invoice_id} not found.` }] };
          }

          await qboManager.transactions.deleteInvoice(realmId, invoice_id, inv.SyncToken);
          return { content: [{ type: 'text', text: `Invoice #${inv.DocNumber ?? invoice_id} (ID: ${invoice_id}) deleted successfully.` }] };
        } catch (err: any) {
          return { content: [{ type: 'text', text: `Error deleting invoice: ${err?.message ?? err}` }] };
        }
      }
    );

    // ── create_bill ──────────────────────────────────────────────────────────
    server.tool(
      'create_bill',
      'Create a bill (accounts payable) in QuickBooks Online. Supports class, department, and (where applicable) sales terms at the appropriate QBO level (header or line).',
      {
        client_name: z.string().describe('The name of the client company'),
        vendor_id: z.string().describe('QBO Vendor ID (use get_vendors to find IDs)'),
        vendor_name: z.string().optional().describe('Vendor display name'),
        txn_date: z.string().optional().describe('Bill date (YYYY-MM-DD)'),
        due_date: z.string().optional().describe('Due date (YYYY-MM-DD). If omitted but sales_term_id is set, QBO computes from TxnDate + term.'),
        private_note: z.string().optional().describe('Private memo'),
        department_id: z.string().optional().describe('Header DepartmentRef.value (use get_departments to find IDs)'),
        sales_term_id: z.string().optional().describe('Header SalesTermRef.value. QBO computes DueDate from TxnDate + term unless due_date is also set.'),
        lines: z.array(z.object({
          description: z.string().optional().describe('Line description'),
          amount: z.number().describe('Line amount'),
          detail_type: z.enum(['AccountBasedExpenseLineDetail', 'ItemBasedExpenseLineDetail']).default('AccountBasedExpenseLineDetail'),
          account_id: z.string().optional().describe('Expense account ID (for AccountBasedExpenseLineDetail)'),
          account_name: z.string().optional().describe('Account name (for readability)'),
          item_id: z.string().optional().describe('Item ID (for ItemBasedExpenseLineDetail)'),
          quantity: z.number().optional().describe('Quantity'),
          unit_price: z.number().optional().describe('Unit price'),
          class_id: z.string().optional().describe('Class ID for tracking'),
        })).describe('Bill line items'),
      },
      async ({ client_name, vendor_id, vendor_name, txn_date, due_date, private_note, department_id, sales_term_id, lines }) => {
        const realmId = await findRealmId(qboManager, client_name);
        if (!realmId) {
          return { content: [{ type: 'text', text: `Client not found: "${client_name}". Use list_clients to see available companies.` }] };
        }

        try {
          const billLines = lines.map(l => {
            const line: any = { Amount: l.amount, DetailType: l.detail_type, Description: l.description };
            if (l.detail_type === 'AccountBasedExpenseLineDetail') {
              line.AccountBasedExpenseLineDetail = {};
              if (l.account_id) line.AccountBasedExpenseLineDetail.AccountRef = { value: l.account_id, name: l.account_name };
              if (l.class_id) line.AccountBasedExpenseLineDetail.ClassRef = { value: l.class_id };
            } else {
              line.ItemBasedExpenseLineDetail = { Qty: l.quantity ?? 1, UnitPrice: l.unit_price ?? l.amount };
              if (l.item_id) line.ItemBasedExpenseLineDetail.ItemRef = { value: l.item_id };
              if (l.class_id) line.ItemBasedExpenseLineDetail.ClassRef = { value: l.class_id };
            }
            return line;
          });

          const payload: any = {
            VendorRef: { value: vendor_id, name: vendor_name },
            Line: billLines,
          };
          if (txn_date) payload.TxnDate = txn_date;
          if (department_id) payload.DepartmentRef = { value: department_id };
          if (sales_term_id) payload.SalesTermRef = { value: sales_term_id };
          // due_date wins over sales-term-computed DueDate per task spec
          if (due_date) payload.DueDate = due_date;
          if (private_note) payload.PrivateNote = private_note;

          const result = await qboManager.transactions.createBill(realmId, payload);
          const bill = (result as any)?.Bill;
          const summary = bill
            ? `Bill #${bill.DocNumber ?? bill.Id} created successfully.\nID: ${bill.Id} | SyncToken: ${bill.SyncToken} | Vendor: ${bill.VendorRef?.name ?? vendor_id} | Total: ${formatCurrency(bill.TotalAmt)} | Balance: ${formatCurrency(bill.Balance)}`
            : JSON.stringify(result, null, 2);
          return { content: [{ type: 'text', text: summary }] };
        } catch (err: any) {
          return { content: [{ type: 'text', text: `Error creating bill: ${err?.message ?? err}` }] };
        }
      }
    );

    // ── update_bill ──────────────────────────────────────────────────────────
    server.tool(
      'update_bill',
      'Update an existing bill. Fetches current bill first, then applies changes. Supports class, department, and (where applicable) sales terms at the appropriate QBO level (header or line).',
      {
        client_name: z.string().describe('The name of the client company'),
        bill_id: z.string().describe('The QBO Bill ID to update'),
        vendor_id: z.string().optional().describe('New vendor ID'),
        txn_date: z.string().optional().describe('New bill date (YYYY-MM-DD)'),
        due_date: z.string().optional().describe('New due date (YYYY-MM-DD)'),
        private_note: z.string().optional().describe('New private note'),
        department_id: z.string().optional().describe('New header DepartmentRef.value'),
        sales_term_id: z.string().optional().describe('New header SalesTermRef.value'),
        lines: z.array(z.object({
          description: z.string().optional(),
          amount: z.number(),
          detail_type: z.enum(['AccountBasedExpenseLineDetail', 'ItemBasedExpenseLineDetail']).default('AccountBasedExpenseLineDetail'),
          account_id: z.string().optional(),
          account_name: z.string().optional(),
          item_id: z.string().optional(),
          quantity: z.number().optional(),
          unit_price: z.number().optional(),
          class_id: z.string().optional(),
        })).optional().describe('Replacement line items (replaces ALL lines if provided)'),
      },
      async ({ client_name, bill_id, vendor_id, txn_date, due_date, private_note, department_id, sales_term_id, lines }) => {
        const realmId = await findRealmId(qboManager, client_name);
        if (!realmId) {
          return { content: [{ type: 'text', text: `Client not found: "${client_name}". Use list_clients to see available companies.` }] };
        }

        try {
          const existing = await qboManager.transactions.getBill(realmId, bill_id) as any;
          const bill = existing?.Bill;
          if (!bill) {
            return { content: [{ type: 'text', text: `Bill ${bill_id} not found.` }] };
          }

          const payload: any = { ...bill };
          if (vendor_id) payload.VendorRef = { value: vendor_id };
          if (txn_date) payload.TxnDate = txn_date;
          if (department_id) payload.DepartmentRef = { value: department_id };
          if (sales_term_id) payload.SalesTermRef = { value: sales_term_id };
          if (due_date) payload.DueDate = due_date;
          if (private_note !== undefined) payload.PrivateNote = private_note;

          if (lines) {
            payload.Line = lines.map(l => {
              const line: any = { Amount: l.amount, DetailType: l.detail_type, Description: l.description };
              if (l.detail_type === 'AccountBasedExpenseLineDetail') {
                line.AccountBasedExpenseLineDetail = {};
                if (l.account_id) line.AccountBasedExpenseLineDetail.AccountRef = { value: l.account_id, name: l.account_name };
                if (l.class_id) line.AccountBasedExpenseLineDetail.ClassRef = { value: l.class_id };
              } else {
                line.ItemBasedExpenseLineDetail = { Qty: l.quantity ?? 1, UnitPrice: l.unit_price ?? l.amount };
                if (l.item_id) line.ItemBasedExpenseLineDetail.ItemRef = { value: l.item_id };
              }
              return line;
            });
          }

          const result = await qboManager.transactions.updateBill(realmId, payload);
          const updated = (result as any)?.Bill;
          if (updated && lines) {
            const failure = await verifyLinesAndMaybeRollback({
              entityLabel: 'Bill',
              original: bill,
              submitted: postedLineStats(payload.Line),
              updated,
              rollback: async (p) => ((await qboManager.transactions.updateBill(realmId, p)) as any)?.Bill ?? null,
            });
            if (failure) return { content: [{ type: 'text', text: failure }] };
          }
          const summary = updated
            ? `Bill #${updated.DocNumber ?? updated.Id} updated.\nID: ${updated.Id} | SyncToken: ${updated.SyncToken} | Total: ${formatCurrency(updated.TotalAmt)}`
            : JSON.stringify(result, null, 2);
          return { content: [{ type: 'text', text: summary }] };
        } catch (err: any) {
          return { content: [{ type: 'text', text: `Error updating bill: ${err?.message ?? err}` }] };
        }
      }
    );

    // ── delete_bill ──────────────────────────────────────────────────────────
    server.tool(
      'delete_bill',
      'Delete (void) a bill from QuickBooks Online',
      {
        client_name: z.string().describe('The name of the client company'),
        bill_id: z.string().describe('The QBO Bill ID to delete'),
      },
      async ({ client_name, bill_id }) => {
        const realmId = await findRealmId(qboManager, client_name);
        if (!realmId) {
          return { content: [{ type: 'text', text: `Client not found: "${client_name}". Use list_clients to see available companies.` }] };
        }

        try {
          const existing = await qboManager.transactions.getBill(realmId, bill_id) as any;
          const bill = existing?.Bill;
          if (!bill) {
            return { content: [{ type: 'text', text: `Bill ${bill_id} not found.` }] };
          }

          await qboManager.transactions.deleteBill(realmId, bill_id, bill.SyncToken);
          return { content: [{ type: 'text', text: `Bill #${bill.DocNumber ?? bill_id} (ID: ${bill_id}) deleted successfully.` }] };
        } catch (err: any) {
          return { content: [{ type: 'text', text: `Error deleting bill: ${err?.message ?? err}` }] };
        }
      }
    );

    // ── create_payment ───────────────────────────────────────────────────────
    server.tool(
      'create_payment',
      'Record a customer payment in QuickBooks Online. Can be applied to specific invoices or as an unapplied payment. Supports class, department, and (where applicable) sales terms at the appropriate QBO level (header or line).',
      {
        client_name: z.string().describe('The name of the client company'),
        customer_id: z.string().describe('QBO Customer ID'),
        customer_name: z.string().optional().describe('Customer name (for readability)'),
        total_amount: z.number().describe('Total payment amount'),
        txn_date: z.string().optional().describe('Payment date (YYYY-MM-DD)'),
        payment_method_id: z.string().optional().describe('Payment method ID'),
        deposit_to_account_id: z.string().optional().describe('Deposit-to account ID (bank account)'),
        private_note: z.string().optional().describe('Private memo'),
        department_id: z.string().optional().describe('Header DepartmentRef.value'),
        invoice_ids: z.array(z.object({
          invoice_id: z.string().describe('Invoice ID to apply payment to'),
          amount: z.number().optional().describe('Amount to apply to this invoice (defaults to full invoice balance)'),
        })).optional().describe('Invoices to apply payment to. If omitted, payment is unapplied.'),
      },
      async ({ client_name, customer_id, customer_name, total_amount, txn_date, payment_method_id, deposit_to_account_id, private_note, department_id, invoice_ids }) => {
        const realmId = await findRealmId(qboManager, client_name);
        if (!realmId) {
          return { content: [{ type: 'text', text: `Client not found: "${client_name}". Use list_clients to see available companies.` }] };
        }

        try {
          const payload: any = {
            CustomerRef: { value: customer_id, name: customer_name },
            TotalAmt: total_amount,
          };
          if (txn_date) payload.TxnDate = txn_date;
          if (payment_method_id) payload.PaymentMethodRef = { value: payment_method_id };
          if (deposit_to_account_id) payload.DepositToAccountRef = { value: deposit_to_account_id };
          if (department_id) payload.DepartmentRef = { value: department_id };
          if (private_note) payload.PrivateNote = private_note;

          if (invoice_ids && invoice_ids.length > 0) {
            payload.Line = invoice_ids.map(inv => ({
              Amount: inv.amount ?? total_amount,
              LinkedTxn: [{ TxnId: inv.invoice_id, TxnType: 'Invoice' }],
            }));
          }

          const result = await qboManager.transactions.createPayment(realmId, payload);
          const pmt = (result as any)?.Payment;
          const summary = pmt
            ? `Payment #${pmt.DocNumber ?? pmt.Id} recorded successfully.\nID: ${pmt.Id} | SyncToken: ${pmt.SyncToken} | Customer: ${pmt.CustomerRef?.name ?? customer_id} | Amount: ${formatCurrency(pmt.TotalAmt)}`
            : JSON.stringify(result, null, 2);
          return { content: [{ type: 'text', text: summary }] };
        } catch (err: any) {
          return { content: [{ type: 'text', text: `Error creating payment: ${err?.message ?? err}` }] };
        }
      }
    );

    // ── create_bill_payment ──────────────────────────────────────────────────
    server.tool(
      'create_bill_payment',
      'Record a bill payment (pay a vendor) in QuickBooks Online. Supports class, department, and (where applicable) sales terms at the appropriate QBO level (header or line).',
      {
        client_name: z.string().describe('The name of the client company'),
        vendor_id: z.string().describe('QBO Vendor ID'),
        vendor_name: z.string().optional().describe('Vendor name (for readability)'),
        total_amount: z.number().describe('Total payment amount'),
        txn_date: z.string().optional().describe('Payment date (YYYY-MM-DD)'),
        doc_number: z.string().max(21).optional().describe(DOC_NUMBER_DESCRIPTION),
        pay_type: z.enum(['Check', 'CreditCard']).describe('Payment type'),
        bank_account_id: z.string().optional().describe('Bank account ID (for Check payments)'),
        credit_card_account_id: z.string().optional().describe('Credit card account ID (for CreditCard payments)'),
        private_note: z.string().optional().describe('Private memo'),
        department_id: z.string().optional().describe('Header DepartmentRef.value'),
        bill_ids: z.array(z.object({
          bill_id: z.string().describe('Bill ID to apply payment to'),
          amount: z.number().optional().describe('Amount to apply to this bill'),
        })).optional().describe('Bills to apply payment to'),
      },
      async ({ client_name, vendor_id, vendor_name, total_amount, txn_date, doc_number, pay_type, bank_account_id, credit_card_account_id, private_note, department_id, bill_ids }) => {
        const realmId = await findRealmId(qboManager, client_name);
        if (!realmId) {
          return { content: [{ type: 'text', text: `Client not found: "${client_name}". Use list_clients to see available companies.` }] };
        }

        try {
          const payload: any = {
            VendorRef: { value: vendor_id, name: vendor_name },
            TotalAmt: total_amount,
            PayType: pay_type,
          };
          if (txn_date) payload.TxnDate = txn_date;
          // Omit DocNumber entirely when not supplied — QBO stores "" verbatim
          // and it sorts differently from null in reports.
          if (doc_number) payload.DocNumber = doc_number;
          if (department_id) payload.DepartmentRef = { value: department_id };
          if (private_note) payload.PrivateNote = private_note;

          if (pay_type === 'Check' && bank_account_id) {
            payload.CheckPayment = { BankAccountRef: { value: bank_account_id } };
          } else if (pay_type === 'CreditCard' && credit_card_account_id) {
            payload.CreditCardPayment = { CCAccountRef: { value: credit_card_account_id } };
          }

          if (bill_ids && bill_ids.length > 0) {
            payload.Line = bill_ids.map(b => ({
              Amount: b.amount ?? total_amount,
              LinkedTxn: [{ TxnId: b.bill_id, TxnType: 'Bill' }],
            }));
          }

          const result = await qboManager.transactions.createBillPayment(realmId, payload);
          const bp = (result as any)?.BillPayment;
          const summary = bp
            ? `Bill Payment #${bp.DocNumber ?? bp.Id} recorded successfully.\nID: ${bp.Id} | SyncToken: ${bp.SyncToken} | Vendor: ${bp.VendorRef?.name ?? vendor_id} | Amount: ${formatCurrency(bp.TotalAmt)}`
            : JSON.stringify(result, null, 2);
          return { content: [{ type: 'text', text: summary }] };
        } catch (err: any) {
          return { content: [{ type: 'text', text: `Error creating bill payment: ${err?.message ?? err}` }] };
        }
      }
    );

    // ── update_bill_payment ──────────────────────────────────────────────────
    server.tool(
      'update_bill_payment',
      'Update an existing bill payment in place — amount, date, ref number, memo, pay account, and/or the linked-bill line amounts. Read-modify-write: fetches the current BillPayment, merges only what you pass, writes the full object back with a fresh SyncToken; untouched fields are preserved. Changing the amount adjusts the linked bill\'s open balance by the difference (the fix for a payment recorded at the wrong amount vs. the actual bank wire). If total_amt is changed and the payment has exactly ONE linked bill line, that line amount is synced automatically; with multiple linked bills pass `lines` explicitly so the split is deliberate.',
      {
        client_name: z.string().describe('The name of the client company'),
        bill_payment_id: z.string().describe('The QBO BillPayment ID to update'),
        total_amt: z.number().optional().describe('New total payment amount'),
        txn_date: z.string().optional().describe('New payment date (YYYY-MM-DD)'),
        doc_number: z.string().max(21).optional().describe('New reference / check number'),
        private_note: z.string().optional().describe('New private memo'),
        pay_account_id: z.string().optional().describe('New pay-from account: a bank account for Check payments, a credit card account for CreditCard payments (matched to the payment\'s existing PayType)'),
        lines: z.array(z.object({
          bill_id: z.string().describe('Linked Bill ID this portion pays'),
          amount: z.number().describe('Amount applied to that bill'),
        })).optional().describe('Replacement application lines (replaces ALL existing linked-bill lines if provided). Line amounts should sum to total_amt.'),
      },
      async ({ client_name, bill_payment_id, total_amt, txn_date, doc_number, private_note, pay_account_id, lines }) => {
        const realmId = await findRealmId(qboManager, client_name);
        if (!realmId) return { content: [{ type: 'text', text: `Client not found: "${client_name}". Use list_clients to see available companies.` }] };
        try {
          const existing = await qboManager.transactions.getBillPayment(realmId, bill_payment_id) as any;
          const bp = existing?.BillPayment;
          if (!bp) return { content: [{ type: 'text', text: `Bill Payment ${bill_payment_id} not found.` }] };

          const payload: any = { ...bp };
          if (txn_date) payload.TxnDate = txn_date;
          if (doc_number) payload.DocNumber = doc_number;
          if (private_note !== undefined) payload.PrivateNote = private_note;
          if (pay_account_id) {
            if (bp.PayType === 'CreditCard') {
              payload.CreditCardPayment = { CCAccountRef: { value: pay_account_id } };
            } else {
              payload.CheckPayment = { BankAccountRef: { value: pay_account_id } };
            }
          }

          if (lines) {
            payload.Line = lines.map(l => ({
              Amount: l.amount,
              LinkedTxn: [{ TxnId: l.bill_id, TxnType: 'Bill' }],
            }));
            const lineSum = lines.reduce((s, l) => s + l.amount, 0);
            if (total_amt !== undefined && Math.abs(lineSum - total_amt) > 0.01) {
              return { content: [{ type: 'text', text: `Line amounts (${formatCurrency(lineSum)}) must sum to total_amt (${formatCurrency(total_amt)}). Nothing was posted.` }] };
            }
            payload.TotalAmt = total_amt ?? lineSum;
          } else if (total_amt !== undefined) {
            const existingLines: any[] = bp.Line ?? [];
            if (existingLines.length === 1) {
              payload.Line = [{ ...existingLines[0], Amount: total_amt }];
            } else if (existingLines.length > 1) {
              return { content: [{ type: 'text', text: `Bill Payment ${bill_payment_id} pays ${existingLines.length} bills — pass \`lines\` explicitly so the new split across bills is deliberate. Nothing was posted.` }] };
            }
            payload.TotalAmt = total_amt;
          }

          const result = await qboManager.transactions.updateBillPayment(realmId, payload);
          const updated = (result as any)?.BillPayment;
          const summary = updated
            ? `Bill Payment #${updated.DocNumber ?? updated.Id} updated.\nID: ${updated.Id} | SyncToken: ${updated.SyncToken} | Vendor: ${updated.VendorRef?.name ?? updated.VendorRef?.value} | Amount: ${formatCurrency(updated.TotalAmt)}`
            : JSON.stringify(result, null, 2);
          return { content: [{ type: 'text', text: summary }] };
        } catch (err: any) {
          return { content: [{ type: 'text', text: `Error updating bill payment: ${err?.message ?? err}` }] };
        }
      }
    );

    // ── delete_bill_payment ──────────────────────────────────────────────────
    server.tool(
      'delete_bill_payment',
      'Permanently delete a bill payment from QuickBooks Online. This is a QBO HARD delete — recoverable only via the QBO Audit Log — and the linked bill\'s open balance reopens by the deleted payment\'s amount. The response echoes what was deleted for the conversation audit trail.',
      {
        client_name: z.string().describe('The name of the client company'),
        bill_payment_id: z.string().describe('The QBO BillPayment ID to delete'),
      },
      async ({ client_name, bill_payment_id }) => {
        const realmId = await findRealmId(qboManager, client_name);
        if (!realmId) return { content: [{ type: 'text', text: `Client not found: "${client_name}". Use list_clients to see available companies.` }] };
        try {
          const existing = await qboManager.transactions.getBillPayment(realmId, bill_payment_id) as any;
          const bp = existing?.BillPayment;
          if (!bp) return { content: [{ type: 'text', text: `Bill Payment ${bill_payment_id} not found.` }] };
          await qboManager.transactions.deleteBillPayment(realmId, bill_payment_id, bp.SyncToken);
          const summary = `Deleted bill payment ${bill_payment_id}: ${bp.TxnDate}, ${formatCurrency(bp.TotalAmt)} to ${bp.VendorRef?.name ?? bp.VendorRef?.value ?? 'unknown vendor'}${bp.DocNumber ? ` (ref ${bp.DocNumber})` : ''}.\nQBO hard delete — recoverable only via the Audit Log; the linked bill's open balance reopens by this amount.`;
          return { content: [{ type: 'text', text: summary }] };
        } catch (err: any) {
          return { content: [{ type: 'text', text: `Error deleting bill payment: ${err?.message ?? err}` }] };
        }
      }
    );

    // ── create_expense ───────────────────────────────────────────────────────
    server.tool(
      'create_expense',
      'Create an expense (check, cash purchase, or credit card charge) in QuickBooks Online. Supports class, department, and (where applicable) sales terms at the appropriate QBO level (header or line).',
      {
        client_name: z.string().describe('The name of the client company'),
        payment_type: z.enum(['Cash', 'Check', 'CreditCard']).describe('How the expense was paid'),
        account_id: z.string().describe('Bank or credit card account ID the expense is paid from'),
        account_name: z.string().optional().describe('Account name (for readability)'),
        txn_date: z.string().optional().describe('Transaction date (YYYY-MM-DD)'),
        doc_number: z.string().max(21).optional().describe(DOC_NUMBER_DESCRIPTION),
        vendor_id: z.string().optional().describe('Vendor ID (the payee). Preferred over vendor_name.'),
        vendor_name: z.string().optional().describe('Vendor name. If vendor_id is omitted, this is resolved to the payee by EXACT DisplayName match and the call fails if no unique match exists — nothing is silently dropped. When vendor_id is provided, this is display-only.'),
        private_note: z.string().optional().describe('Private memo'),
        department_id: z.string().optional().describe('Header DepartmentRef.value'),
        lines: z.array(z.object({
          description: z.string().optional(),
          amount: z.number().describe('Line amount'),
          detail_type: z.enum(['AccountBasedExpenseLineDetail', 'ItemBasedExpenseLineDetail']).default('AccountBasedExpenseLineDetail'),
          expense_account_id: z.string().optional().describe('Expense account ID'),
          expense_account_name: z.string().optional().describe('Expense account name'),
          item_id: z.string().optional(),
          quantity: z.number().optional(),
          unit_price: z.number().optional(),
          class_id: z.string().optional(),
        })).describe('Expense line items'),
      },
      async ({ client_name, payment_type, account_id, account_name, txn_date, doc_number, vendor_id, vendor_name, private_note, department_id, lines }) => {
        const realmId = await findRealmId(qboManager, client_name);
        if (!realmId) {
          return { content: [{ type: 'text', text: `Client not found: "${client_name}". Use list_clients to see available companies.` }] };
        }

        try {
          // Resolve vendor_name to a real payee when no vendor_id was given —
          // never silently post a payee-less transaction.
          let entityRef: { value: string; name?: string } | null = vendor_id
            ? { value: vendor_id, name: vendor_name }
            : null;
          if (!entityRef && vendor_name) {
            const resolved = await resolveVendorByName(qboManager, realmId, vendor_name);
            if ('error' in resolved) {
              return { content: [{ type: 'text', text: resolved.error }] };
            }
            entityRef = { value: resolved.id, name: resolved.name };
          }

          const expenseLines = lines.map(l => {
            const line: any = { Amount: l.amount, DetailType: l.detail_type, Description: l.description };
            if (l.detail_type === 'AccountBasedExpenseLineDetail') {
              line.AccountBasedExpenseLineDetail = {};
              if (l.expense_account_id) line.AccountBasedExpenseLineDetail.AccountRef = { value: l.expense_account_id, name: l.expense_account_name };
              if (l.class_id) line.AccountBasedExpenseLineDetail.ClassRef = { value: l.class_id };
            } else {
              line.ItemBasedExpenseLineDetail = { Qty: l.quantity ?? 1, UnitPrice: l.unit_price ?? l.amount };
              if (l.item_id) line.ItemBasedExpenseLineDetail.ItemRef = { value: l.item_id };
            }
            return line;
          });

          const payload: any = {
            PaymentType: payment_type,
            AccountRef: { value: account_id, name: account_name },
            Line: expenseLines,
          };
          if (txn_date) payload.TxnDate = txn_date;
          // Omit DocNumber entirely when not supplied — an empty string would
          // be stored by QBO and look null in the UI but sort differently.
          if (doc_number) payload.DocNumber = doc_number;
          if (entityRef) payload.EntityRef = { ...entityRef, type: 'Vendor' };
          if (department_id) payload.DepartmentRef = { value: department_id };
          if (private_note) payload.PrivateNote = private_note;

          const result = await qboManager.transactions.createExpense(realmId, payload);
          const exp = (result as any)?.Purchase;
          const summary = exp
            ? `Expense #${exp.DocNumber ?? exp.Id} created successfully.\nID: ${exp.Id} | SyncToken: ${exp.SyncToken} | Type: ${exp.PaymentType} | Total: ${formatCurrency(exp.TotalAmt)}${exp.EntityRef ? ` | Payee: ${exp.EntityRef.name ?? exp.EntityRef.value}` : ' | Payee: NONE'}${exp.DocNumber ? ` | Ref No: ${exp.DocNumber}` : ''}`
            : JSON.stringify(result, null, 2);
          return { content: [{ type: 'text', text: summary }] };
        } catch (err: any) {
          return { content: [{ type: 'text', text: `Error creating expense: ${err?.message ?? err}` }] };
        }
      }
    );

    // ── update_expense ───────────────────────────────────────────────────────
    server.tool(
      'update_expense',
      'Update an existing expense (Purchase) in place — edits the original transaction rather than creating a correcting entry. Auto-fetches the current Purchase + SyncToken by ID first, so you only pass the ID plus the fields you want changed. Header fields use sparse update (only provided fields change). If `lines` is provided it REPLACES ALL existing lines (same replace-all behavior as update_bill / update_journal_entry). Account/vendor/class refs are validated by QBO server-side; its error message (wrong ID, inactive entity, closed period, stale SyncToken) is surfaced on failure.',
      {
        client_name: z.string().describe('The name of the client company'),
        expense_id: z.string().describe('The QBO Expense (Purchase) ID to update'),
        payment_type: z.enum(['Cash', 'Check', 'CreditCard']).optional().describe('How the expense was paid'),
        account_id: z.string().optional().describe('New bank or credit card account ID the expense is paid from'),
        account_name: z.string().optional().describe('Pay-from account name (for readability)'),
        txn_date: z.string().optional().describe('New transaction date (YYYY-MM-DD)'),
        doc_number: z.string().max(21).optional().describe(`${DOC_NUMBER_DESCRIPTION} Only changes when provided — existing values are left alone, so numbers can be backfilled onto expenses created without them.`),
        vendor_id: z.string().optional().describe('New vendor ID (the payee). Preferred over vendor_name.'),
        vendor_name: z.string().optional().describe('Vendor name. If vendor_id is omitted, this is resolved to the payee by EXACT DisplayName match and the call fails if no unique match exists. When vendor_id is provided, this is display-only.'),
        private_note: z.string().optional().describe('New private memo'),
        department_id: z.string().optional().describe('New header DepartmentRef.value'),
        lines: z.array(z.object({
          description: z.string().optional(),
          amount: z.number().describe('Line amount'),
          detail_type: z.enum(['AccountBasedExpenseLineDetail', 'ItemBasedExpenseLineDetail']).default('AccountBasedExpenseLineDetail'),
          expense_account_id: z.string().optional().describe('Expense account ID'),
          expense_account_name: z.string().optional().describe('Expense account name'),
          item_id: z.string().optional(),
          quantity: z.number().optional(),
          unit_price: z.number().optional(),
          class_id: z.string().optional(),
        })).optional().describe('Replacement line items (replaces ALL existing lines if provided)'),
      },
      async ({ client_name, expense_id, payment_type, account_id, account_name, txn_date, doc_number, vendor_id, vendor_name, private_note, department_id, lines }) => {
        const realmId = await findRealmId(qboManager, client_name);
        if (!realmId) {
          return { content: [{ type: 'text', text: `Client not found: "${client_name}". Use list_clients to see available companies.` }] };
        }

        try {
          // Resolve vendor_name to a real payee when no vendor_id was given —
          // never silently ignore a caller-supplied payee.
          let entityRef: { value: string; name?: string } | null = vendor_id
            ? { value: vendor_id, name: vendor_name }
            : null;
          if (!entityRef && vendor_name) {
            const resolved = await resolveVendorByName(qboManager, realmId, vendor_name);
            if ('error' in resolved) {
              return { content: [{ type: 'text', text: resolved.error }] };
            }
            entityRef = { value: resolved.id, name: resolved.name };
          }

          // Fetch existing Purchase to get SyncToken (mirror update_journal_entry / update_bill)
          const existing = await qboManager.transactions.getExpense(realmId, expense_id) as any;
          const exp = existing?.Purchase;
          if (!exp) {
            return { content: [{ type: 'text', text: `Expense ${expense_id} not found.` }] };
          }

          const payload: any = { ...exp };
          if (payment_type) payload.PaymentType = payment_type;
          if (account_id) payload.AccountRef = { value: account_id, name: account_name };
          if (txn_date) payload.TxnDate = txn_date;
          if (doc_number) payload.DocNumber = doc_number;
          if (entityRef) payload.EntityRef = { ...entityRef, type: 'Vendor' };
          if (department_id) payload.DepartmentRef = { value: department_id };
          if (private_note !== undefined) payload.PrivateNote = private_note;

          if (lines) {
            payload.Line = lines.map(l => {
              const line: any = { Amount: l.amount, DetailType: l.detail_type, Description: l.description };
              if (l.detail_type === 'AccountBasedExpenseLineDetail') {
                line.AccountBasedExpenseLineDetail = {};
                if (l.expense_account_id) line.AccountBasedExpenseLineDetail.AccountRef = { value: l.expense_account_id, name: l.expense_account_name };
                if (l.class_id) line.AccountBasedExpenseLineDetail.ClassRef = { value: l.class_id };
              } else {
                line.ItemBasedExpenseLineDetail = { Qty: l.quantity ?? 1, UnitPrice: l.unit_price ?? l.amount };
                if (l.item_id) line.ItemBasedExpenseLineDetail.ItemRef = { value: l.item_id };
                if (l.class_id) line.ItemBasedExpenseLineDetail.ClassRef = { value: l.class_id };
              }
              return line;
            });
          }

          const result = await qboManager.transactions.updateExpense(realmId, payload);
          const updated = (result as any)?.Purchase;
          if (updated && lines) {
            const failure = await verifyLinesAndMaybeRollback({
              entityLabel: 'Expense',
              original: exp,
              submitted: postedLineStats(payload.Line),
              updated,
              rollback: async (p) => ((await qboManager.transactions.updateExpense(realmId, p)) as any)?.Purchase ?? null,
            });
            if (failure) return { content: [{ type: 'text', text: failure }] };
          }
          const summary = updated
            ? `Expense #${updated.DocNumber ?? updated.Id} updated.\nID: ${updated.Id} | SyncToken: ${updated.SyncToken} | Type: ${updated.PaymentType} | Date: ${updated.TxnDate} | Total: ${formatCurrency(updated.TotalAmt)}`
            : JSON.stringify(result, null, 2);
          return { content: [{ type: 'text', text: summary }] };
        } catch (err: any) {
          return { content: [{ type: 'text', text: `Error updating expense: ${err?.message ?? err}` }] };
        }
      }
    );

    // ── delete_expense ───────────────────────────────────────────────────────
    server.tool(
      'delete_expense',
      'Permanently delete an expense (Purchase) from QuickBooks Online. This is a QBO HARD delete — the transaction is removed from the books and recoverable only via the QBO Audit Log. The response echoes what was deleted (id, date, amount, payee, account) for the conversation audit trail.',
      {
        client_name: z.string().describe('The name of the client company'),
        expense_id: z.string().describe('The QBO Expense (Purchase) ID to delete'),
      },
      async ({ client_name, expense_id }) => {
        const realmId = await findRealmId(qboManager, client_name);
        if (!realmId) return { content: [{ type: 'text', text: `Client not found: "${client_name}". Use list_clients to see available companies.` }] };
        try {
          const existing = await qboManager.transactions.getExpense(realmId, expense_id) as any;
          const exp = existing?.Purchase;
          if (!exp) return { content: [{ type: 'text', text: `Expense ${expense_id} not found.` }] };
          await qboManager.transactions.deleteExpense(realmId, expense_id, exp.SyncToken);
          const summary = `Deleted expense ${expense_id}: ${exp.TxnDate}, ${formatCurrency(exp.TotalAmt)} paid from ${exp.AccountRef?.name ?? exp.AccountRef?.value ?? 'unknown account'}${exp.EntityRef ? ` to ${exp.EntityRef.name ?? exp.EntityRef.value}` : ' (no payee)'}${exp.DocNumber ? ` (ref ${exp.DocNumber})` : ''}.\nQBO hard delete — recoverable only via the Audit Log.`;
          return { content: [{ type: 'text', text: summary }] };
        } catch (err: any) {
          return { content: [{ type: 'text', text: `Error deleting expense: ${err?.message ?? err}` }] };
        }
      }
    );

    // ── create_account ───────────────────────────────────────────────────────
    server.tool(
      'create_account',
      'Create a new account in the Chart of Accounts',
      {
        client_name: z.string().describe('The name of the client company'),
        name: z.string().describe('Account name'),
        account_type: z.enum([
          'Bank', 'Other Current Asset', 'Fixed Asset', 'Other Asset',
          'Accounts Receivable', 'Equity', 'Expense', 'Other Expense',
          'Cost of Goods Sold', 'Accounts Payable', 'Credit Card',
          'Long Term Liability', 'Other Current Liability', 'Income', 'Other Income',
        ]).describe('QBO account type'),
        account_sub_type: z.string().optional().describe('Account sub-type (e.g., "Checking", "Savings", "OfficeGeneralAdministrativeExpenses")'),
        acct_num: z.string().optional().describe('Account number'),
        description: z.string().optional().describe('Account description'),
        currency: z.string().optional().describe('Currency code (e.g., USD). Only for multi-currency companies.'),
      },
      async ({ client_name, name, account_type, account_sub_type, acct_num, description, currency }) => {
        const realmId = await findRealmId(qboManager, client_name);
        if (!realmId) {
          return { content: [{ type: 'text', text: `Client not found: "${client_name}". Use list_clients to see available companies.` }] };
        }

        try {
          const payload: any = { Name: name, AccountType: account_type };
          if (account_sub_type) payload.AccountSubType = account_sub_type;
          if (acct_num) payload.AcctNum = acct_num;
          if (description) payload.Description = description;
          if (currency) payload.CurrencyRef = { value: currency };

          const result = await qboManager.accounts.create(realmId, payload);
          const acct = (result as any)?.Account;
          const summary = acct
            ? `Account "${acct.Name}" created successfully.\nID: ${acct.Id} | SyncToken: ${acct.SyncToken} | Type: ${acct.AccountType} | SubType: ${acct.AccountSubType ?? 'N/A'}${acct.AcctNum ? ` | Number: ${acct.AcctNum}` : ''}`
            : JSON.stringify(result, null, 2);
          return { content: [{ type: 'text', text: summary }] };
        } catch (err: any) {
          return { content: [{ type: 'text', text: `Error creating account: ${err?.message ?? err}` }] };
        }
      }
    );

    // ── update_account ───────────────────────────────────────────────────────
    server.tool(
      'update_account',
      'Update an existing account in the Chart of Accounts. Fetches the current account first.',
      {
        client_name: z.string().describe('The name of the client company'),
        account_id: z.string().describe('The QBO Account ID to update'),
        name: z.string().optional().describe('New account name'),
        acct_num: z.string().optional().describe('New account number'),
        description: z.string().optional().describe('New description'),
        active: z.boolean().optional().describe('Set active/inactive status'),
      },
      async ({ client_name, account_id, name, acct_num, description, active }) => {
        const realmId = await findRealmId(qboManager, client_name);
        if (!realmId) {
          return { content: [{ type: 'text', text: `Client not found: "${client_name}". Use list_clients to see available companies.` }] };
        }

        try {
          const existing = await qboManager.accounts.get(realmId, account_id) as any;
          const acct = existing?.Account;
          if (!acct) {
            return { content: [{ type: 'text', text: `Account ${account_id} not found.` }] };
          }

          const payload: any = { ...acct };
          if (name) payload.Name = name;
          if (acct_num !== undefined) payload.AcctNum = acct_num;
          if (description !== undefined) payload.Description = description;
          if (active !== undefined) payload.Active = active;

          const result = await qboManager.accounts.update(realmId, payload);
          const updated = (result as any)?.Account;
          const summary = updated
            ? `Account "${updated.Name}" updated.\nID: ${updated.Id} | SyncToken: ${updated.SyncToken} | Type: ${updated.AccountType}${updated.AcctNum ? ` | Number: ${updated.AcctNum}` : ''} | Active: ${updated.Active}`
            : JSON.stringify(result, null, 2);
          return { content: [{ type: 'text', text: summary }] };
        } catch (err: any) {
          return { content: [{ type: 'text', text: `Error updating account: ${err?.message ?? err}` }] };
        }
      }
    );

    // ── create_vendor ────────────────────────────────────────────────────────
    server.tool(
      'create_vendor',
      'Create a new vendor in QuickBooks Online, including billing address, contact details, and 1099/terms fields. Vendors have a billing address only (no shipping address).',
      {
        client_name: z.string().describe('The name of the client company'),
        display_name: z.string().describe('Vendor display name'),
        company_name: z.string().optional().describe('Company name'),
        given_name: z.string().optional().describe('First name'),
        family_name: z.string().optional().describe('Last name'),
        email: z.string().optional().describe(EMAIL_PARAM_DESCRIPTION),
        phone: z.string().optional().describe('Phone number'),
        vendor_1099: z.boolean().optional().describe('Is this a 1099 vendor?'),
        bill_addr: addressInput.optional().describe('Billing address'),
        ...contactInputShape,
        tax_identifier: z.string().optional().describe('Tax ID / EIN (QBO TaxIdentifier)'),
        account_number: z.string().optional().describe('Account number with this vendor (QBO AcctNum)'),
        bill_rate: z.number().optional().describe('Default billable rate (QBO BillRate)'),
        term_id: z.string().optional().describe('Default payment terms (Term ID → TermRef)'),
      },
      async (args) => {
        const { client_name, display_name, company_name, given_name, family_name, email, phone, vendor_1099 } = args;
        const realmId = await findRealmId(qboManager, client_name);
        if (!realmId) {
          return { content: [{ type: 'text', text: `Client not found: "${client_name}". Use list_clients to see available companies.` }] };
        }

        try {
          const payload: any = { DisplayName: display_name };
          if (company_name) payload.CompanyName = company_name;
          if (given_name) payload.GivenName = given_name;
          if (family_name) payload.FamilyName = family_name;
          if (email) payload.PrimaryEmailAddr = { Address: email };
          if (phone) payload.PrimaryPhone = { FreeFormNumber: phone };
          if (vendor_1099 !== undefined) payload.Vendor1099 = vendor_1099;
          if (args.bill_addr) payload.BillAddr = toQboAddress(args.bill_addr);
          applyContactFields(payload, args);
          if (args.tax_identifier !== undefined) payload.TaxIdentifier = args.tax_identifier;
          if (args.account_number !== undefined) payload.AcctNum = args.account_number;
          if (args.bill_rate !== undefined) payload.BillRate = args.bill_rate;
          if (args.term_id !== undefined) payload.TermRef = { value: args.term_id };

          const result = await qboManager.transactions.createVendor(realmId, payload);
          const v = (result as any)?.Vendor;
          const summary = v
            ? `Vendor "${v.DisplayName}" created.\nID: ${v.Id} | SyncToken: ${v.SyncToken}${v.CompanyName ? ` | Company: ${v.CompanyName}` : ''}${v.Vendor1099 ? ' | 1099: Yes' : ''}${v.BillAddr ? `\nBill addr: ${[v.BillAddr.Line1, v.BillAddr.City, v.BillAddr.CountrySubDivisionCode, v.BillAddr.PostalCode].filter(Boolean).join(', ')}` : ''}`
            : JSON.stringify(result, null, 2);
          return { content: [{ type: 'text', text: summary }] };
        } catch (err: any) {
          return { content: [{ type: 'text', text: `Error creating vendor: ${err?.message ?? err}` }] };
        }
      }
    );

    // ── create_customer ──────────────────────────────────────────────────────
    server.tool(
      'create_customer',
      'Create a new customer in QuickBooks Online, including billing/shipping address and full contact details',
      {
        client_name: z.string().describe('The name of the client company'),
        display_name: z.string().describe('Customer display name'),
        company_name: z.string().optional().describe('Company name'),
        given_name: z.string().optional().describe('First name'),
        family_name: z.string().optional().describe('Last name'),
        email: z.string().optional().describe(EMAIL_PARAM_DESCRIPTION),
        phone: z.string().optional().describe('Phone number'),
        bill_addr: addressInput.optional().describe('Billing address'),
        ship_addr: addressInput.optional().describe('Shipping address'),
        ship_same_as_bill: z.boolean().optional().describe('Copy the billing address to the shipping address'),
        ...contactInputShape,
        preferred_delivery_method: z.enum(['Print', 'Email', 'None']).optional().describe('How invoices default to being delivered. Set "Email" so invoice sends default to emailed delivery.'),
        sales_term_id: z.string().optional().describe('Default payment terms (Term ID → SalesTermRef)'),
        resale_num: z.string().optional().describe('Resale number'),
        taxable: z.boolean().optional().describe('Is this customer taxable?'),
      },
      async (args) => {
        const { client_name, display_name, company_name, given_name, family_name, email, phone } = args;
        const realmId = await findRealmId(qboManager, client_name);
        if (!realmId) {
          return { content: [{ type: 'text', text: `Client not found: "${client_name}". Use list_clients to see available companies.` }] };
        }

        try {
          const payload: any = { DisplayName: display_name };
          if (company_name) payload.CompanyName = company_name;
          if (given_name) payload.GivenName = given_name;
          if (family_name) payload.FamilyName = family_name;
          if (email) payload.PrimaryEmailAddr = { Address: email };
          if (phone) payload.PrimaryPhone = { FreeFormNumber: phone };
          if (args.bill_addr) payload.BillAddr = toQboAddress(args.bill_addr);
          if (args.ship_same_as_bill && payload.BillAddr) payload.ShipAddr = { ...payload.BillAddr };
          else if (args.ship_addr) payload.ShipAddr = toQboAddress(args.ship_addr);
          applyContactFields(payload, args);
          if (args.preferred_delivery_method !== undefined) payload.PreferredDeliveryMethod = args.preferred_delivery_method;
          if (args.sales_term_id !== undefined) payload.SalesTermRef = { value: args.sales_term_id };
          if (args.resale_num !== undefined) payload.ResaleNum = args.resale_num;
          if (args.taxable !== undefined) payload.Taxable = args.taxable;

          const result = await qboManager.transactions.createCustomer(realmId, payload);
          const c = (result as any)?.Customer;
          const summary = c
            ? `Customer "${c.DisplayName}" created.\nID: ${c.Id} | SyncToken: ${c.SyncToken}${c.CompanyName ? ` | Company: ${c.CompanyName}` : ''}${c.BillAddr ? `\nBill addr: ${[c.BillAddr.Line1, c.BillAddr.City, c.BillAddr.CountrySubDivisionCode, c.BillAddr.PostalCode].filter(Boolean).join(', ')}` : ''}`
            : JSON.stringify(result, null, 2);
          return { content: [{ type: 'text', text: summary }] };
        } catch (err: any) {
          return { content: [{ type: 'text', text: `Error creating customer: ${err?.message ?? err}` }] };
        }
      }
    );

    // ═══════════════════════════════════════════════════════════════════════════
    // SLICE C — LISTS & DIMENSIONS
    // ═══════════════════════════════════════════════════════════════════════════

    // ── get_items ─────────────────────────────────────────────────────────────
    server.tool(
      'get_items',
      'Get products and services (items) for a QBO client. Items are used as line-item references on invoices, bills, and sales receipts.',
      {
        client_name: z.string().describe('The name of the client company'),
        active_only: z.boolean().optional().describe('Return only active items (default: true)'),
        type_filter: z.enum(['Service', 'NonInventory', 'Inventory', 'Category', 'All']).optional().describe('Filter by item type (default: All)'),
      },
      async ({ client_name, active_only = true, type_filter = 'All' }) => {
        const realmId = await findRealmId(qboManager, client_name);
        if (!realmId) return { content: [{ type: 'text', text: `Client not found: "${client_name}". Use list_clients to see available companies.` }] };
        try {
          const result = await qboManager.lists.getItems(realmId, { activeOnly: false });
          let items: any[] = (result as any)?.QueryResponse?.Item ?? [];
          if (active_only) items = items.filter((i: any) => i.Active !== false);
          if (type_filter !== 'All') items = items.filter((i: any) => i.Type === type_filter);
          if (items.length === 0) return { content: [{ type: 'text', text: `No items found for ${client_name}.` }] };
          const lines = [
            `ITEMS — ${client_name}`,
            `Total: ${items.length}${type_filter !== 'All' ? ` | Type: ${type_filter}` : ''}`,
            '─'.repeat(100),
            `${'ID'.padEnd(10)} ${'Name'.padEnd(35)} ${'Type'.padEnd(14)} ${'Unit Price'.padStart(12)} ${'Active'.padEnd(8)}`,
            '─'.repeat(100),
          ];
          for (const item of items) {
            lines.push(
              `${(item.Id ?? '').padEnd(10)} ${(item.Name ?? '').substring(0, 34).padEnd(35)} ${(item.Type ?? '').padEnd(14)} ${formatCurrency(item.UnitPrice ?? 0).padStart(12)} ${item.Active !== false ? 'Yes' : 'No'}`
            );
          }
          return { content: [{ type: 'text', text: lines.join('\n') }] };
        } catch (err: any) {
          return { content: [{ type: 'text', text: `Error fetching items: ${err?.message ?? err}` }] };
        }
      }
    );

    // ── create_item ───────────────────────────────────────────────────────────
    server.tool(
      'create_item',
      'Create a product or service item in QuickBooks Online. Service and NonInventory items require an income account. Inventory items also require an asset account, expense (COGS) account, and opening quantity.',
      {
        client_name: z.string().describe('The name of the client company'),
        name: z.string().describe('Item name'),
        type: z.enum(['Service', 'NonInventory', 'Inventory']).describe('Item type'),
        description: z.string().optional().describe('Sales description'),
        unit_price: z.number().optional().describe('Default unit price / rate'),
        income_account_id: z.string().optional().describe('Income account ID (required for Service/NonInventory)'),
        expense_account_id: z.string().optional().describe('Expense / COGS account ID (required for Inventory)'),
        asset_account_id: z.string().optional().describe('Asset (inventory) account ID (required for Inventory)'),
        sku: z.string().optional().describe('SKU / item number'),
        qty_on_hand: z.number().optional().describe('Opening quantity on hand (Inventory items only, defaults to 0)'),
        inv_start_date: z.string().optional().describe('Inventory start date YYYY-MM-DD (required when qty_on_hand > 0)'),
      },
      async ({ client_name, name, type, description, unit_price, income_account_id, expense_account_id, asset_account_id, sku, qty_on_hand, inv_start_date }) => {
        const realmId = await findRealmId(qboManager, client_name);
        if (!realmId) return { content: [{ type: 'text', text: `Client not found: "${client_name}". Use list_clients to see available companies.` }] };
        try {
          const payload: any = { Name: name, Type: type };
          if (description) payload.Description = description;
          if (unit_price !== undefined) payload.UnitPrice = unit_price;
          if (sku) payload.Sku = sku;
          if (income_account_id) payload.IncomeAccountRef = { value: income_account_id };
          if (expense_account_id) payload.ExpenseAccountRef = { value: expense_account_id };
          if (asset_account_id) payload.AssetAccountRef = { value: asset_account_id };
          if (type === 'Inventory') {
            payload.TrackQtyOnHand = true;
            payload.QtyOnHand = qty_on_hand ?? 0;
            if (inv_start_date) payload.InvStartDate = inv_start_date;
          }
          const result = await qboManager.lists.createItem(realmId, payload);
          const item = (result as any)?.Item;
          const summary = item
            ? `Item "${item.Name}" created.\nID: ${item.Id} | SyncToken: ${item.SyncToken} | Type: ${item.Type}${item.UnitPrice !== undefined ? ` | Price: ${formatCurrency(item.UnitPrice)}` : ''}`
            : JSON.stringify(result, null, 2);
          return { content: [{ type: 'text', text: summary }] };
        } catch (err: any) {
          return { content: [{ type: 'text', text: `Error creating item: ${err?.message ?? err}` }] };
        }
      }
    );

    // ── update_item ───────────────────────────────────────────────────────────
    server.tool(
      'update_item',
      'Update an existing product/service item. Fetches current item first, then applies sparse changes.',
      {
        client_name: z.string().describe('The name of the client company'),
        item_id: z.string().describe('QBO Item ID to update'),
        name: z.string().optional().describe('New name'),
        description: z.string().optional().describe('New description'),
        unit_price: z.number().optional().describe('New unit price'),
        income_account_id: z.string().optional().describe('New income account ID'),
        active: z.boolean().optional().describe('Set active/inactive'),
      },
      async ({ client_name, item_id, name, description, unit_price, income_account_id, active }) => {
        const realmId = await findRealmId(qboManager, client_name);
        if (!realmId) return { content: [{ type: 'text', text: `Client not found: "${client_name}". Use list_clients to see available companies.` }] };
        try {
          const existing = await qboManager.lists.getItem(realmId, item_id) as any;
          const item = existing?.Item;
          if (!item) return { content: [{ type: 'text', text: `Item ${item_id} not found.` }] };
          const payload: any = { ...item };
          if (name !== undefined) payload.Name = name;
          if (description !== undefined) payload.Description = description;
          if (unit_price !== undefined) payload.UnitPrice = unit_price;
          if (income_account_id) payload.IncomeAccountRef = { value: income_account_id };
          if (active !== undefined) payload.Active = active;
          const result = await qboManager.lists.updateItem(realmId, payload);
          const updated = (result as any)?.Item;
          const summary = updated
            ? `Item "${updated.Name}" updated.\nID: ${updated.Id} | SyncToken: ${updated.SyncToken} | Active: ${updated.Active}`
            : JSON.stringify(result, null, 2);
          return { content: [{ type: 'text', text: summary }] };
        } catch (err: any) {
          return { content: [{ type: 'text', text: `Error updating item: ${err?.message ?? err}` }] };
        }
      }
    );

    // ── get_classes ───────────────────────────────────────────────────────────
    server.tool(
      'get_classes',
      'Get the list of classes for a QBO client. Classes are used for segment reporting on transactions.',
      {
        client_name: z.string().describe('The name of the client company'),
        active_only: z.boolean().optional().describe('Return only active classes (default: true)'),
      },
      async ({ client_name, active_only = true }) => {
        const realmId = await findRealmId(qboManager, client_name);
        if (!realmId) return { content: [{ type: 'text', text: `Client not found: "${client_name}". Use list_clients to see available companies.` }] };
        try {
          const result = await qboManager.lists.getClasses(realmId, { activeOnly: active_only });
          const classes: any[] = (result as any)?.QueryResponse?.Class ?? [];
          if (classes.length === 0) return { content: [{ type: 'text', text: `No classes found for ${client_name}.` }] };
          const lines = [
            `CLASSES — ${client_name}`,
            '─'.repeat(60),
            ...classes.map((c: any) => `  ${(c.Id ?? '').padEnd(10)} ${c.FullyQualifiedName ?? c.Name ?? ''}${c.Active === false ? ' (inactive)' : ''}`),
          ];
          return { content: [{ type: 'text', text: lines.join('\n') }] };
        } catch (err: any) {
          return { content: [{ type: 'text', text: `Error fetching classes: ${err?.message ?? err}` }] };
        }
      }
    );

    // ── create_class ──────────────────────────────────────────────────────────
    server.tool(
      'create_class',
      'Create a new class for segment reporting in QuickBooks Online.',
      {
        client_name: z.string().describe('The name of the client company'),
        name: z.string().describe('Class name'),
        parent_class_id: z.string().optional().describe('Parent class ID for sub-classes'),
      },
      async ({ client_name, name, parent_class_id }) => {
        const realmId = await findRealmId(qboManager, client_name);
        if (!realmId) return { content: [{ type: 'text', text: `Client not found: "${client_name}". Use list_clients to see available companies.` }] };
        try {
          const payload: any = { Name: name };
          if (parent_class_id) payload.ParentRef = { value: parent_class_id };
          const result = await qboManager.lists.createClass(realmId, payload);
          const cls = (result as any)?.Class;
          const summary = cls
            ? `Class "${cls.Name}" created.\nID: ${cls.Id} | SyncToken: ${cls.SyncToken}${cls.ParentRef ? ` | Parent ID: ${cls.ParentRef.value}` : ''}`
            : JSON.stringify(result, null, 2);
          return { content: [{ type: 'text', text: summary }] };
        } catch (err: any) {
          return { content: [{ type: 'text', text: `Error creating class: ${err?.message ?? err}` }] };
        }
      }
    );

    // ── get_departments ───────────────────────────────────────────────────────
    server.tool(
      'get_departments',
      'Get the list of departments (locations) for a QBO client.',
      {
        client_name: z.string().describe('The name of the client company'),
        active_only: z.boolean().optional().describe('Return only active departments (default: true)'),
      },
      async ({ client_name, active_only = true }) => {
        const realmId = await findRealmId(qboManager, client_name);
        if (!realmId) return { content: [{ type: 'text', text: `Client not found: "${client_name}". Use list_clients to see available companies.` }] };
        try {
          const result = await qboManager.lists.getDepartments(realmId, { activeOnly: active_only });
          const depts: any[] = (result as any)?.QueryResponse?.Department ?? [];
          if (depts.length === 0) return { content: [{ type: 'text', text: `No departments found for ${client_name}.` }] };
          const lines = [
            `DEPARTMENTS — ${client_name}`,
            '─'.repeat(60),
            ...depts.map((d: any) => `  ${(d.Id ?? '').padEnd(10)} ${d.FullyQualifiedName ?? d.Name ?? ''}${d.Active === false ? ' (inactive)' : ''}`),
          ];
          return { content: [{ type: 'text', text: lines.join('\n') }] };
        } catch (err: any) {
          return { content: [{ type: 'text', text: `Error fetching departments: ${err?.message ?? err}` }] };
        }
      }
    );

    // ── create_department ─────────────────────────────────────────────────────
    server.tool(
      'create_department',
      'Create a new department (location) in QuickBooks Online.',
      {
        client_name: z.string().describe('The name of the client company'),
        name: z.string().describe('Department name'),
        parent_department_id: z.string().optional().describe('Parent department ID for sub-departments'),
        sub_department: z.boolean().optional().describe('Whether this is a sub-department'),
      },
      async ({ client_name, name, parent_department_id, sub_department }) => {
        const realmId = await findRealmId(qboManager, client_name);
        if (!realmId) return { content: [{ type: 'text', text: `Client not found: "${client_name}". Use list_clients to see available companies.` }] };
        try {
          const payload: any = { Name: name };
          if (parent_department_id) payload.ParentRef = { value: parent_department_id };
          if (sub_department !== undefined) payload.SubDepartment = sub_department;
          const result = await qboManager.lists.createDepartment(realmId, payload);
          const dept = (result as any)?.Department;
          const summary = dept
            ? `Department "${dept.Name}" created.\nID: ${dept.Id} | SyncToken: ${dept.SyncToken}${dept.ParentRef ? ` | Parent ID: ${dept.ParentRef.value}` : ''}`
            : JSON.stringify(result, null, 2);
          return { content: [{ type: 'text', text: summary }] };
        } catch (err: any) {
          return { content: [{ type: 'text', text: `Error creating department: ${err?.message ?? err}` }] };
        }
      }
    );

    // ── get_employees ─────────────────────────────────────────────────────────
    server.tool(
      'get_employees',
      'Get the list of employees for a QBO client.',
      {
        client_name: z.string().describe('The name of the client company'),
        active_only: z.boolean().optional().describe('Return only active employees (default: true)'),
      },
      async ({ client_name, active_only = true }) => {
        const realmId = await findRealmId(qboManager, client_name);
        if (!realmId) return { content: [{ type: 'text', text: `Client not found: "${client_name}". Use list_clients to see available companies.` }] };
        try {
          const result = await qboManager.lists.getEmployees(realmId, { activeOnly: active_only });
          const emps: any[] = (result as any)?.QueryResponse?.Employee ?? [];
          if (emps.length === 0) return { content: [{ type: 'text', text: `No employees found for ${client_name}.` }] };
          const lines = [
            `EMPLOYEES — ${client_name}`,
            `Total: ${emps.length}`,
            '─'.repeat(80),
            `${'ID'.padEnd(10)} ${'Name'.padEnd(35)} ${'Email'.padEnd(28)} ${'Active'}`,
            '─'.repeat(80),
            ...emps.map((e: any) =>
              `${(e.Id ?? '').padEnd(10)} ${(e.DisplayName ?? `${e.GivenName ?? ''} ${e.FamilyName ?? ''}`.trim()).substring(0, 34).padEnd(35)} ${(e.PrimaryEmailAddr?.Address ?? '').substring(0, 27).padEnd(28)} ${e.Active !== false ? 'Yes' : 'No'}`
            ),
          ];
          return { content: [{ type: 'text', text: lines.join('\n') }] };
        } catch (err: any) {
          return { content: [{ type: 'text', text: `Error fetching employees: ${err?.message ?? err}` }] };
        }
      }
    );

    // ── create_employee ───────────────────────────────────────────────────────
    server.tool(
      'create_employee',
      'Create a new employee record in QuickBooks Online.',
      {
        client_name: z.string().describe('The name of the client company'),
        given_name: z.string().describe('First name'),
        family_name: z.string().describe('Last name'),
        display_name: z.string().optional().describe('Display name (defaults to "First Last")'),
        email: z.string().optional().describe('Email address'),
        phone: z.string().optional().describe('Phone number'),
        hire_date: z.string().optional().describe('Hire date YYYY-MM-DD'),
      },
      async ({ client_name, given_name, family_name, display_name, email, phone, hire_date }) => {
        const realmId = await findRealmId(qboManager, client_name);
        if (!realmId) return { content: [{ type: 'text', text: `Client not found: "${client_name}". Use list_clients to see available companies.` }] };
        try {
          const payload: any = {
            GivenName: given_name,
            FamilyName: family_name,
            DisplayName: display_name ?? `${given_name} ${family_name}`,
          };
          if (email) payload.PrimaryEmailAddr = { Address: email };
          if (phone) payload.PrimaryPhone = { FreeFormNumber: phone };
          if (hire_date) payload.HiredDate = hire_date;
          const result = await qboManager.lists.createEmployee(realmId, payload);
          const emp = (result as any)?.Employee;
          const summary = emp
            ? `Employee "${emp.DisplayName}" created.\nID: ${emp.Id} | SyncToken: ${emp.SyncToken}`
            : JSON.stringify(result, null, 2);
          return { content: [{ type: 'text', text: summary }] };
        } catch (err: any) {
          return { content: [{ type: 'text', text: `Error creating employee: ${err?.message ?? err}` }] };
        }
      }
    );

    // ═══════════════════════════════════════════════════════════════════════════
    // SLICE B — PARTIAL CRUD FILLS
    // ═══════════════════════════════════════════════════════════════════════════

    // ── update_customer ───────────────────────────────────────────────────────
    server.tool(
      'update_customer',
      'Update an existing customer. Fetches current record first, then applies sparse changes. Address subfields are MERGED over the existing address by default (updating only postal_code preserves Line1/City/State); pass replace_address:true for a clean overwrite.',
      {
        client_name: z.string().describe('The name of the client company'),
        customer_id: z.string().describe('QBO Customer ID'),
        display_name: z.string().optional().describe('New display name'),
        company_name: z.string().optional().describe('New company name'),
        given_name: z.string().optional().describe('New first name'),
        family_name: z.string().optional().describe('New last name'),
        email: z.string().optional().describe(EMAIL_PARAM_DESCRIPTION),
        phone: z.string().optional().describe('New phone'),
        active: z.boolean().optional().describe('Set active/inactive'),
        bill_addr: addressInput.optional().describe('Billing address subfields to set (merged over the existing address unless replace_address is true)'),
        ship_addr: addressInput.optional().describe('Shipping address subfields to set (merged over the existing address unless replace_address is true)'),
        ship_same_as_bill: z.boolean().optional().describe('Copy the (resulting) billing address to the shipping address'),
        replace_address: z.boolean().optional().describe('Replace the address(es) outright instead of merging subfields over the existing values'),
        ...contactInputShape,
        preferred_delivery_method: z.enum(['Print', 'Email', 'None']).optional().describe('How invoices default to being delivered. Set "Email" so invoice sends default to emailed delivery.'),
        sales_term_id: z.string().optional().describe('Default payment terms (Term ID → SalesTermRef)'),
        resale_num: z.string().optional().describe('Resale number'),
        taxable: z.boolean().optional().describe('Is this customer taxable?'),
      },
      async (args) => {
        const { client_name, customer_id } = args;
        const realmId = await findRealmId(qboManager, client_name);
        if (!realmId) return { content: [{ type: 'text', text: `Client not found: "${client_name}".` }] };
        try {
          const existing = await qboManager.transactions.getCustomer(realmId, customer_id) as any;
          const cust = existing?.Customer;
          if (!cust) return { content: [{ type: 'text', text: `Customer ${customer_id} not found.` }] };
          // Sparse update: only caller-provided fields are sent, so untouched
          // addresses are never in the payload and QBO cannot rewrite them.
          const payload = buildCustomerUpdatePayload(cust, args);
          const result = await qboManager.transactions.updateCustomer(realmId, payload);
          const updated = (result as any)?.Customer;
          return { content: [{ type: 'text', text: updated ? `Customer "${updated.DisplayName}" updated.\nID: ${updated.Id} | SyncToken: ${updated.SyncToken}${updated.BillAddr ? `\nBill addr: ${[updated.BillAddr.Line1, updated.BillAddr.City, updated.BillAddr.CountrySubDivisionCode, updated.BillAddr.PostalCode].filter(Boolean).join(', ')}` : ''}` : JSON.stringify(result, null, 2) }] };
        } catch (err: any) {
          return { content: [{ type: 'text', text: `Error updating customer: ${err?.message ?? err}` }] };
        }
      }
    );

    // ── delete_customer ───────────────────────────────────────────────────────
    server.tool(
      'delete_customer',
      'Deactivate a customer in QuickBooks Online. QBO does not support hard delete — this sets Active=false.',
      {
        client_name: z.string().describe('The name of the client company'),
        customer_id: z.string().describe('QBO Customer ID to deactivate'),
      },
      async ({ client_name, customer_id }) => {
        const realmId = await findRealmId(qboManager, client_name);
        if (!realmId) return { content: [{ type: 'text', text: `Client not found: "${client_name}".` }] };
        try {
          const existing = await qboManager.transactions.getCustomer(realmId, customer_id) as any;
          const cust = existing?.Customer;
          if (!cust) return { content: [{ type: 'text', text: `Customer ${customer_id} not found.` }] };
          await qboManager.transactions.deleteCustomer(realmId, cust);
          return { content: [{ type: 'text', text: `Customer "${cust.DisplayName}" (ID: ${customer_id}) deactivated.` }] };
        } catch (err: any) {
          return { content: [{ type: 'text', text: `Error deactivating customer: ${err?.message ?? err}` }] };
        }
      }
    );

    // ── update_vendor ─────────────────────────────────────────────────────────
    server.tool(
      'update_vendor',
      'Update an existing vendor. Fetches current record first, then applies sparse changes. Address subfields are MERGED over the existing billing address by default; pass replace_address:true for a clean overwrite. Vendors have a billing address only (no shipping address).',
      {
        client_name: z.string().describe('The name of the client company'),
        vendor_id: z.string().describe('QBO Vendor ID'),
        display_name: z.string().optional().describe('New display name'),
        company_name: z.string().optional().describe('New company name'),
        given_name: z.string().optional().describe('New first name'),
        family_name: z.string().optional().describe('New last name'),
        email: z.string().optional().describe(EMAIL_PARAM_DESCRIPTION),
        phone: z.string().optional().describe('New phone'),
        vendor_1099: z.boolean().optional().describe('Update 1099 tracking'),
        active: z.boolean().optional().describe('Set active/inactive'),
        bill_addr: addressInput.optional().describe('Billing address subfields to set (merged over the existing address unless replace_address is true)'),
        replace_address: z.boolean().optional().describe('Replace the billing address outright instead of merging subfields over the existing values'),
        ...contactInputShape,
        tax_identifier: z.string().optional().describe('Tax ID / EIN (QBO TaxIdentifier)'),
        account_number: z.string().optional().describe('Account number with this vendor (QBO AcctNum)'),
        bill_rate: z.number().optional().describe('Default billable rate (QBO BillRate)'),
        term_id: z.string().optional().describe('Default payment terms (Term ID → TermRef)'),
      },
      async (args) => {
        const { client_name, vendor_id } = args;
        const realmId = await findRealmId(qboManager, client_name);
        if (!realmId) return { content: [{ type: 'text', text: `Client not found: "${client_name}".` }] };
        try {
          const existing = await qboManager.transactions.getVendor(realmId, vendor_id) as any;
          const vendor = existing?.Vendor;
          if (!vendor) return { content: [{ type: 'text', text: `Vendor ${vendor_id} not found.` }] };
          // Sparse update: only caller-provided fields are sent, so an
          // untouched billing address is never in the payload.
          const payload = buildVendorUpdatePayload(vendor, args);
          const result = await qboManager.transactions.updateVendor(realmId, payload);
          const updated = (result as any)?.Vendor;
          return { content: [{ type: 'text', text: updated ? `Vendor "${updated.DisplayName}" updated.\nID: ${updated.Id} | SyncToken: ${updated.SyncToken}${updated.BillAddr ? `\nBill addr: ${[updated.BillAddr.Line1, updated.BillAddr.City, updated.BillAddr.CountrySubDivisionCode, updated.BillAddr.PostalCode].filter(Boolean).join(', ')}` : ''}` : JSON.stringify(result, null, 2) }] };
        } catch (err: any) {
          return { content: [{ type: 'text', text: `Error updating vendor: ${err?.message ?? err}` }] };
        }
      }
    );

    // ── delete_vendor ─────────────────────────────────────────────────────────
    server.tool(
      'delete_vendor',
      'Deactivate a vendor in QuickBooks Online. QBO does not support hard delete — this sets Active=false.',
      {
        client_name: z.string().describe('The name of the client company'),
        vendor_id: z.string().describe('QBO Vendor ID to deactivate'),
      },
      async ({ client_name, vendor_id }) => {
        const realmId = await findRealmId(qboManager, client_name);
        if (!realmId) return { content: [{ type: 'text', text: `Client not found: "${client_name}".` }] };
        try {
          const existing = await qboManager.transactions.getVendor(realmId, vendor_id) as any;
          const vendor = existing?.Vendor;
          if (!vendor) return { content: [{ type: 'text', text: `Vendor ${vendor_id} not found.` }] };
          await qboManager.transactions.deleteVendor(realmId, vendor);
          return { content: [{ type: 'text', text: `Vendor "${vendor.DisplayName}" (ID: ${vendor_id}) deactivated.` }] };
        } catch (err: any) {
          return { content: [{ type: 'text', text: `Error deactivating vendor: ${err?.message ?? err}` }] };
        }
      }
    );

    // ── delete_account ────────────────────────────────────────────────────────
    server.tool(
      'delete_account',
      'Deactivate a Chart of Accounts account in QuickBooks Online.',
      {
        client_name: z.string().describe('The name of the client company'),
        account_id: z.string().describe('QBO Account ID to deactivate'),
      },
      async ({ client_name, account_id }) => {
        const realmId = await findRealmId(qboManager, client_name);
        if (!realmId) return { content: [{ type: 'text', text: `Client not found: "${client_name}".` }] };
        try {
          const existing = await qboManager.accounts.get(realmId, account_id) as any;
          const acct = existing?.Account;
          if (!acct) return { content: [{ type: 'text', text: `Account ${account_id} not found.` }] };
          await qboManager.accounts.deactivate(realmId, acct);
          return { content: [{ type: 'text', text: `Account "${acct.Name}" (ID: ${account_id}) deactivated.` }] };
        } catch (err: any) {
          return { content: [{ type: 'text', text: `Error deactivating account: ${err?.message ?? err}` }] };
        }
      }
    );

    // ── create_sales_receipt ──────────────────────────────────────────────────
    server.tool(
      'create_sales_receipt',
      'Create a sales receipt in QuickBooks Online. Use when payment is received at the time of sale (no invoice needed). Supports class, department, and (where applicable) sales terms at the appropriate QBO level (header or line).',
      {
        client_name: z.string().describe('The name of the client company'),
        customer_id: z.string().describe('Customer ID'),
        customer_name: z.string().optional().describe('Customer name for readability'),
        deposit_account_id: z.string().optional().describe('Bank account to deposit to (omit to use Undeposited Funds)'),
        txn_date: z.string().optional().describe('Sale date YYYY-MM-DD'),
        payment_method_id: z.string().optional().describe('Payment method ID (use get_payment_methods)'),
        private_note: z.string().optional().describe('Memo'),
        department_id: z.string().optional().describe('Header DepartmentRef.value'),
        lines: z.array(z.object({
          description: z.string().optional(),
          amount: z.number(),
          item_id: z.string().optional().describe('Item/service ID'),
          item_name: z.string().optional(),
          quantity: z.number().optional(),
          unit_price: z.number().optional(),
        })).describe('Line items'),
      },
      async ({ client_name, customer_id, customer_name, deposit_account_id, txn_date, payment_method_id, private_note, department_id, lines }) => {
        const realmId = await findRealmId(qboManager, client_name);
        if (!realmId) return { content: [{ type: 'text', text: `Client not found: "${client_name}".` }] };
        try {
          const srLines = lines.map(l => {
            const line: any = { Amount: l.amount, DetailType: 'SalesItemLineDetail', Description: l.description };
            line.SalesItemLineDetail = { Qty: l.quantity ?? 1, UnitPrice: l.unit_price ?? l.amount };
            if (l.item_id) line.SalesItemLineDetail.ItemRef = { value: l.item_id, name: l.item_name };
            return line;
          });
          const payload: any = { CustomerRef: { value: customer_id, name: customer_name }, Line: srLines };
          if (txn_date) payload.TxnDate = txn_date;
          if (deposit_account_id) payload.DepositToAccountRef = { value: deposit_account_id };
          if (payment_method_id) payload.PaymentMethodRef = { value: payment_method_id };
          if (department_id) payload.DepartmentRef = { value: department_id };
          if (private_note) payload.PrivateNote = private_note;
          const result = await qboManager.transactions.createSalesReceipt(realmId, payload);
          const sr = (result as any)?.SalesReceipt;
          return { content: [{ type: 'text', text: sr ? `Sales Receipt #${sr.DocNumber ?? sr.Id} created.\nID: ${sr.Id} | SyncToken: ${sr.SyncToken} | Total: ${formatCurrency(sr.TotalAmt)}` : JSON.stringify(result, null, 2) }] };
        } catch (err: any) {
          return { content: [{ type: 'text', text: `Error creating sales receipt: ${err?.message ?? err}` }] };
        }
      }
    );

    // ── update_sales_receipt ──────────────────────────────────────────────────
    server.tool(
      'update_sales_receipt',
      'Update an existing sales receipt. Fetches current record first, then applies changes. Supports class, department, and (where applicable) sales terms at the appropriate QBO level (header or line).',
      {
        client_name: z.string().describe('The name of the client company'),
        sales_receipt_id: z.string().describe('QBO Sales Receipt ID'),
        txn_date: z.string().optional().describe('New date YYYY-MM-DD'),
        private_note: z.string().optional().describe('New memo'),
        department_id: z.string().optional().describe('New header DepartmentRef.value'),
        lines: z.array(z.object({
          description: z.string().optional(),
          amount: z.number(),
          item_id: z.string().optional(),
          item_name: z.string().optional(),
          quantity: z.number().optional(),
          unit_price: z.number().optional(),
        })).optional().describe('Replacement line items'),
      },
      async ({ client_name, sales_receipt_id, txn_date, private_note, department_id, lines }) => {
        const realmId = await findRealmId(qboManager, client_name);
        if (!realmId) return { content: [{ type: 'text', text: `Client not found: "${client_name}".` }] };
        try {
          const existing = await qboManager.transactions.getSalesReceipt(realmId, sales_receipt_id) as any;
          const sr = existing?.SalesReceipt;
          if (!sr) return { content: [{ type: 'text', text: `Sales Receipt ${sales_receipt_id} not found.` }] };
          const payload: any = { ...sr };
          if (txn_date) payload.TxnDate = txn_date;
          if (department_id) payload.DepartmentRef = { value: department_id };
          if (private_note !== undefined) payload.PrivateNote = private_note;
          if (lines) {
            payload.Line = lines.map(l => {
              const line: any = { Amount: l.amount, DetailType: 'SalesItemLineDetail', Description: l.description };
              line.SalesItemLineDetail = { Qty: l.quantity ?? 1, UnitPrice: l.unit_price ?? l.amount };
              if (l.item_id) line.SalesItemLineDetail.ItemRef = { value: l.item_id, name: l.item_name };
              return line;
            });
          }
          const result = await qboManager.transactions.updateSalesReceipt(realmId, payload);
          const updated = (result as any)?.SalesReceipt;
          if (updated && lines) {
            const failure = await verifyLinesAndMaybeRollback({
              entityLabel: 'Sales Receipt',
              original: sr,
              submitted: postedLineStats(payload.Line),
              updated,
              rollback: async (p) => ((await qboManager.transactions.updateSalesReceipt(realmId, p)) as any)?.SalesReceipt ?? null,
            });
            if (failure) return { content: [{ type: 'text', text: failure }] };
          }
          return { content: [{ type: 'text', text: updated ? `Sales Receipt #${updated.DocNumber ?? updated.Id} updated.\nID: ${updated.Id} | SyncToken: ${updated.SyncToken} | Total: ${formatCurrency(updated.TotalAmt)}` : JSON.stringify(result, null, 2) }] };
        } catch (err: any) {
          return { content: [{ type: 'text', text: `Error updating sales receipt: ${err?.message ?? err}` }] };
        }
      }
    );

    // ── create_refund_receipt ─────────────────────────────────────────────────
    server.tool(
      'create_refund_receipt',
      'Create a refund receipt to issue a cash/check/credit card refund to a customer. Supports class, department, and (where applicable) sales terms at the appropriate QBO level (header or line).',
      {
        client_name: z.string().describe('The name of the client company'),
        customer_id: z.string().describe('Customer ID'),
        customer_name: z.string().optional(),
        refund_from_account_id: z.string().describe('Account the refund is paid from (bank or CC account)'),
        txn_date: z.string().optional().describe('Date YYYY-MM-DD'),
        payment_method_id: z.string().optional().describe('Payment method ID'),
        private_note: z.string().optional().describe('Memo'),
        department_id: z.string().optional().describe('Header DepartmentRef.value'),
        lines: z.array(z.object({
          description: z.string().optional(),
          amount: z.number(),
          item_id: z.string().optional(),
          item_name: z.string().optional(),
          quantity: z.number().optional(),
          unit_price: z.number().optional(),
        })).describe('Refund line items'),
      },
      async ({ client_name, customer_id, customer_name, refund_from_account_id, txn_date, payment_method_id, private_note, department_id, lines }) => {
        const realmId = await findRealmId(qboManager, client_name);
        if (!realmId) return { content: [{ type: 'text', text: `Client not found: "${client_name}".` }] };
        try {
          const rrLines = lines.map(l => {
            const line: any = { Amount: l.amount, DetailType: 'SalesItemLineDetail', Description: l.description };
            line.SalesItemLineDetail = { Qty: l.quantity ?? 1, UnitPrice: l.unit_price ?? l.amount };
            if (l.item_id) line.SalesItemLineDetail.ItemRef = { value: l.item_id, name: l.item_name };
            return line;
          });
          const payload: any = {
            CustomerRef: { value: customer_id, name: customer_name },
            DepositToAccountRef: { value: refund_from_account_id },
            Line: rrLines,
          };
          if (txn_date) payload.TxnDate = txn_date;
          if (payment_method_id) payload.PaymentMethodRef = { value: payment_method_id };
          if (department_id) payload.DepartmentRef = { value: department_id };
          if (private_note) payload.PrivateNote = private_note;
          const result = await qboManager.transactions.createRefundReceipt(realmId, payload);
          const rr = (result as any)?.RefundReceipt;
          return { content: [{ type: 'text', text: rr ? `Refund Receipt #${rr.DocNumber ?? rr.Id} created.\nID: ${rr.Id} | SyncToken: ${rr.SyncToken} | Total: ${formatCurrency(rr.TotalAmt)}` : JSON.stringify(result, null, 2) }] };
        } catch (err: any) {
          return { content: [{ type: 'text', text: `Error creating refund receipt: ${err?.message ?? err}` }] };
        }
      }
    );

    // ── create_credit_memo ────────────────────────────────────────────────────
    server.tool(
      'create_credit_memo',
      'Create a credit memo for a customer in QuickBooks Online. Supports class, department, and (where applicable) sales terms at the appropriate QBO level (header or line).',
      {
        client_name: z.string().describe('The name of the client company'),
        customer_id: z.string().describe('Customer ID'),
        customer_name: z.string().optional(),
        txn_date: z.string().optional().describe('Date YYYY-MM-DD'),
        private_note: z.string().optional().describe('Memo'),
        department_id: z.string().optional().describe('Header DepartmentRef.value'),
        sales_term_id: z.string().optional().describe('Header SalesTermRef.value'),
        lines: z.array(z.object({
          description: z.string().optional(),
          amount: z.number(),
          item_id: z.string().optional(),
          item_name: z.string().optional(),
          quantity: z.number().optional(),
          unit_price: z.number().optional(),
        })).describe('Credit memo line items'),
      },
      async ({ client_name, customer_id, customer_name, txn_date, private_note, department_id, sales_term_id, lines }) => {
        const realmId = await findRealmId(qboManager, client_name);
        if (!realmId) return { content: [{ type: 'text', text: `Client not found: "${client_name}".` }] };
        try {
          const cmLines = lines.map(l => {
            const line: any = { Amount: l.amount, DetailType: 'SalesItemLineDetail', Description: l.description };
            line.SalesItemLineDetail = { Qty: l.quantity ?? 1, UnitPrice: l.unit_price ?? l.amount };
            if (l.item_id) line.SalesItemLineDetail.ItemRef = { value: l.item_id, name: l.item_name };
            return line;
          });
          const payload: any = { CustomerRef: { value: customer_id, name: customer_name }, Line: cmLines };
          if (txn_date) payload.TxnDate = txn_date;
          if (department_id) payload.DepartmentRef = { value: department_id };
          if (sales_term_id) payload.SalesTermRef = { value: sales_term_id };
          if (private_note) payload.PrivateNote = private_note;
          const result = await qboManager.transactions.createCreditMemo(realmId, payload);
          const cm = (result as any)?.CreditMemo;
          return { content: [{ type: 'text', text: cm ? `Credit Memo #${cm.DocNumber ?? cm.Id} created.\nID: ${cm.Id} | SyncToken: ${cm.SyncToken} | Total: ${formatCurrency(cm.TotalAmt)} | Remaining: ${formatCurrency(cm.RemainingCredit)}` : JSON.stringify(result, null, 2) }] };
        } catch (err: any) {
          return { content: [{ type: 'text', text: `Error creating credit memo: ${err?.message ?? err}` }] };
        }
      }
    );

    // ── update_credit_memo ────────────────────────────────────────────────────
    server.tool(
      'update_credit_memo',
      'Update an existing credit memo. Fetches current record first. Supports class, department, and (where applicable) sales terms at the appropriate QBO level (header or line).',
      {
        client_name: z.string().describe('The name of the client company'),
        credit_memo_id: z.string().describe('QBO Credit Memo ID'),
        txn_date: z.string().optional(),
        private_note: z.string().optional(),
        department_id: z.string().optional().describe('New header DepartmentRef.value'),
        sales_term_id: z.string().optional().describe('New header SalesTermRef.value'),
        lines: z.array(z.object({
          description: z.string().optional(),
          amount: z.number(),
          item_id: z.string().optional(),
          item_name: z.string().optional(),
          quantity: z.number().optional(),
          unit_price: z.number().optional(),
        })).optional().describe('Replacement lines'),
      },
      async ({ client_name, credit_memo_id, txn_date, private_note, department_id, sales_term_id, lines }) => {
        const realmId = await findRealmId(qboManager, client_name);
        if (!realmId) return { content: [{ type: 'text', text: `Client not found: "${client_name}".` }] };
        try {
          const existing = await qboManager.transactions.getCreditMemo(realmId, credit_memo_id) as any;
          const cm = existing?.CreditMemo;
          if (!cm) return { content: [{ type: 'text', text: `Credit Memo ${credit_memo_id} not found.` }] };
          const payload: any = { ...cm };
          if (txn_date) payload.TxnDate = txn_date;
          if (department_id) payload.DepartmentRef = { value: department_id };
          if (sales_term_id) payload.SalesTermRef = { value: sales_term_id };
          if (private_note !== undefined) payload.PrivateNote = private_note;
          if (lines) {
            payload.Line = lines.map(l => {
              const line: any = { Amount: l.amount, DetailType: 'SalesItemLineDetail', Description: l.description };
              line.SalesItemLineDetail = { Qty: l.quantity ?? 1, UnitPrice: l.unit_price ?? l.amount };
              if (l.item_id) line.SalesItemLineDetail.ItemRef = { value: l.item_id, name: l.item_name };
              return line;
            });
          }
          const result = await qboManager.transactions.updateCreditMemo(realmId, payload);
          const updated = (result as any)?.CreditMemo;
          if (updated && lines) {
            const failure = await verifyLinesAndMaybeRollback({
              entityLabel: 'Credit Memo',
              original: cm,
              submitted: postedLineStats(payload.Line),
              updated,
              rollback: async (p) => ((await qboManager.transactions.updateCreditMemo(realmId, p)) as any)?.CreditMemo ?? null,
            });
            if (failure) return { content: [{ type: 'text', text: failure }] };
          }
          return { content: [{ type: 'text', text: updated ? `Credit Memo #${updated.DocNumber ?? updated.Id} updated.\nID: ${updated.Id} | SyncToken: ${updated.SyncToken}` : JSON.stringify(result, null, 2) }] };
        } catch (err: any) {
          return { content: [{ type: 'text', text: `Error updating credit memo: ${err?.message ?? err}` }] };
        }
      }
    );

    // ── apply_credit_memo ─────────────────────────────────────────────────────
    server.tool(
      'apply_credit_memo',
      'Apply a credit memo to an open invoice. Creates a zero-dollar (or partial) Payment that links the credit memo and invoice together.',
      {
        client_name: z.string().describe('The name of the client company'),
        customer_id: z.string().describe('Customer ID'),
        credit_memo_id: z.string().describe('Credit Memo ID to apply'),
        invoice_id: z.string().describe('Invoice ID to apply credit to'),
        amount: z.number().describe('Amount of credit to apply'),
        txn_date: z.string().optional().describe('Application date YYYY-MM-DD'),
      },
      async ({ client_name, customer_id, credit_memo_id, invoice_id, amount, txn_date }) => {
        const realmId = await findRealmId(qboManager, client_name);
        if (!realmId) return { content: [{ type: 'text', text: `Client not found: "${client_name}".` }] };
        try {
          const payload: any = {
            CustomerRef: { value: customer_id },
            TotalAmt: 0,
            Line: [{
              Amount: amount,
              LinkedTxn: [
                { TxnId: credit_memo_id, TxnType: 'CreditMemo' },
                { TxnId: invoice_id, TxnType: 'Invoice' },
              ],
            }],
          };
          if (txn_date) payload.TxnDate = txn_date;
          const result = await qboManager.transactions.createPayment(realmId, payload);
          const pmt = (result as any)?.Payment;
          return { content: [{ type: 'text', text: pmt ? `Credit Memo ${credit_memo_id} applied to Invoice ${invoice_id}. Payment ID: ${pmt.Id}` : JSON.stringify(result, null, 2) }] };
        } catch (err: any) {
          return { content: [{ type: 'text', text: `Error applying credit memo: ${err?.message ?? err}` }] };
        }
      }
    );

    // ── create_estimate ───────────────────────────────────────────────────────
    server.tool(
      'create_estimate',
      'Create a customer estimate/quote in QuickBooks Online. Supports class, department, and (where applicable) sales terms at the appropriate QBO level (header or line).',
      {
        client_name: z.string().describe('The name of the client company'),
        customer_id: z.string().describe('Customer ID'),
        customer_name: z.string().optional(),
        txn_date: z.string().optional().describe('Estimate date YYYY-MM-DD'),
        expiry_date: z.string().optional().describe('Expiry date YYYY-MM-DD'),
        private_note: z.string().optional().describe('Memo'),
        department_id: z.string().optional().describe('Header DepartmentRef.value'),
        sales_term_id: z.string().optional().describe('Header SalesTermRef.value'),
        lines: z.array(z.object({
          description: z.string().optional(),
          amount: z.number(),
          item_id: z.string().optional(),
          item_name: z.string().optional(),
          quantity: z.number().optional(),
          unit_price: z.number().optional(),
        })).describe('Line items'),
      },
      async ({ client_name, customer_id, customer_name, txn_date, expiry_date, private_note, department_id, sales_term_id, lines }) => {
        const realmId = await findRealmId(qboManager, client_name);
        if (!realmId) return { content: [{ type: 'text', text: `Client not found: "${client_name}".` }] };
        try {
          const estLines = lines.map(l => {
            const line: any = { Amount: l.amount, DetailType: 'SalesItemLineDetail', Description: l.description };
            line.SalesItemLineDetail = { Qty: l.quantity ?? 1, UnitPrice: l.unit_price ?? l.amount };
            if (l.item_id) line.SalesItemLineDetail.ItemRef = { value: l.item_id, name: l.item_name };
            return line;
          });
          const payload: any = { CustomerRef: { value: customer_id, name: customer_name }, Line: estLines };
          if (txn_date) payload.TxnDate = txn_date;
          if (expiry_date) payload.ExpirationDate = expiry_date;
          if (department_id) payload.DepartmentRef = { value: department_id };
          if (sales_term_id) payload.SalesTermRef = { value: sales_term_id };
          if (private_note) payload.PrivateNote = private_note;
          const result = await qboManager.transactions.createEstimate(realmId, payload);
          const est = (result as any)?.Estimate;
          return { content: [{ type: 'text', text: est ? `Estimate #${est.DocNumber ?? est.Id} created.\nID: ${est.Id} | SyncToken: ${est.SyncToken} | Total: ${formatCurrency(est.TotalAmt)}` : JSON.stringify(result, null, 2) }] };
        } catch (err: any) {
          return { content: [{ type: 'text', text: `Error creating estimate: ${err?.message ?? err}` }] };
        }
      }
    );

    // ── update_estimate ───────────────────────────────────────────────────────
    server.tool(
      'update_estimate',
      'Update an existing estimate. Fetches current record first. Supports class, department, and (where applicable) sales terms at the appropriate QBO level (header or line).',
      {
        client_name: z.string().describe('The name of the client company'),
        estimate_id: z.string().describe('QBO Estimate ID'),
        txn_date: z.string().optional(),
        expiry_date: z.string().optional(),
        private_note: z.string().optional(),
        department_id: z.string().optional().describe('New header DepartmentRef.value'),
        sales_term_id: z.string().optional().describe('New header SalesTermRef.value'),
        txn_status: z.enum(['Pending', 'Accepted', 'Closed', 'Rejected']).optional().describe('Estimate status'),
        lines: z.array(z.object({
          description: z.string().optional(),
          amount: z.number(),
          item_id: z.string().optional(),
          item_name: z.string().optional(),
          quantity: z.number().optional(),
          unit_price: z.number().optional(),
        })).optional(),
      },
      async ({ client_name, estimate_id, txn_date, expiry_date, private_note, department_id, sales_term_id, txn_status, lines }) => {
        const realmId = await findRealmId(qboManager, client_name);
        if (!realmId) return { content: [{ type: 'text', text: `Client not found: "${client_name}".` }] };
        try {
          const existing = await qboManager.transactions.getEstimate(realmId, estimate_id) as any;
          const est = existing?.Estimate;
          if (!est) return { content: [{ type: 'text', text: `Estimate ${estimate_id} not found.` }] };
          const payload: any = { ...est };
          if (txn_date) payload.TxnDate = txn_date;
          if (expiry_date) payload.ExpirationDate = expiry_date;
          if (department_id) payload.DepartmentRef = { value: department_id };
          if (sales_term_id) payload.SalesTermRef = { value: sales_term_id };
          if (private_note !== undefined) payload.PrivateNote = private_note;
          if (txn_status) payload.TxnStatus = txn_status;
          if (lines) {
            payload.Line = lines.map(l => {
              const line: any = { Amount: l.amount, DetailType: 'SalesItemLineDetail', Description: l.description };
              line.SalesItemLineDetail = { Qty: l.quantity ?? 1, UnitPrice: l.unit_price ?? l.amount };
              if (l.item_id) line.SalesItemLineDetail.ItemRef = { value: l.item_id, name: l.item_name };
              return line;
            });
          }
          const result = await qboManager.transactions.updateEstimate(realmId, payload);
          const updated = (result as any)?.Estimate;
          if (updated && lines) {
            const failure = await verifyLinesAndMaybeRollback({
              entityLabel: 'Estimate',
              original: est,
              submitted: postedLineStats(payload.Line),
              updated,
              rollback: async (p) => ((await qboManager.transactions.updateEstimate(realmId, p)) as any)?.Estimate ?? null,
            });
            if (failure) return { content: [{ type: 'text', text: failure }] };
          }
          return { content: [{ type: 'text', text: updated ? `Estimate #${updated.DocNumber ?? updated.Id} updated.\nID: ${updated.Id} | SyncToken: ${updated.SyncToken} | Status: ${updated.TxnStatus}` : JSON.stringify(result, null, 2) }] };
        } catch (err: any) {
          return { content: [{ type: 'text', text: `Error updating estimate: ${err?.message ?? err}` }] };
        }
      }
    );

    // ── convert_estimate_to_invoice ───────────────────────────────────────────
    server.tool(
      'convert_estimate_to_invoice',
      'Convert an accepted estimate into an invoice by creating an Invoice linked to the Estimate.',
      {
        client_name: z.string().describe('The name of the client company'),
        estimate_id: z.string().describe('Estimate ID to convert'),
        txn_date: z.string().optional().describe('Invoice date YYYY-MM-DD (defaults to today)'),
        due_date: z.string().optional().describe('Invoice due date YYYY-MM-DD'),
      },
      async ({ client_name, estimate_id, txn_date, due_date }) => {
        const realmId = await findRealmId(qboManager, client_name);
        if (!realmId) return { content: [{ type: 'text', text: `Client not found: "${client_name}".` }] };
        try {
          const existing = await qboManager.transactions.getEstimate(realmId, estimate_id) as any;
          const est = existing?.Estimate;
          if (!est) return { content: [{ type: 'text', text: `Estimate ${estimate_id} not found.` }] };
          // Build invoice from estimate, linking back to the estimate
          const payload: any = {
            CustomerRef: est.CustomerRef,
            Line: est.Line,
            LinkedTxn: [{ TxnId: estimate_id, TxnType: 'Estimate' }],
          };
          if (txn_date) payload.TxnDate = txn_date;
          if (due_date) payload.DueDate = due_date;
          const result = await qboManager.transactions.createInvoice(realmId, payload);
          const inv = (result as any)?.Invoice;
          return { content: [{ type: 'text', text: inv ? `Invoice #${inv.DocNumber ?? inv.Id} created from Estimate ${estimate_id}.\nID: ${inv.Id} | SyncToken: ${inv.SyncToken} | Total: ${formatCurrency(inv.TotalAmt)} | Balance: ${formatCurrency(inv.Balance)}` : JSON.stringify(result, null, 2) }] };
        } catch (err: any) {
          return { content: [{ type: 'text', text: `Error converting estimate to invoice: ${err?.message ?? err}` }] };
        }
      }
    );

    // ── create_purchase_order ─────────────────────────────────────────────────
    server.tool(
      'create_purchase_order',
      'Create a purchase order to a vendor in QuickBooks Online. Supports class, department, and (where applicable) sales terms at the appropriate QBO level (header or line).',
      {
        client_name: z.string().describe('The name of the client company'),
        vendor_id: z.string().describe('Vendor ID'),
        vendor_name: z.string().optional(),
        txn_date: z.string().optional().describe('PO date YYYY-MM-DD'),
        ship_to_id: z.string().optional().describe('Customer ID for drop-ship (optional)'),
        private_note: z.string().optional().describe('Memo'),
        department_id: z.string().optional().describe('Header DepartmentRef.value'),
        sales_term_id: z.string().optional().describe('Header SalesTermRef.value'),
        lines: z.array(z.object({
          description: z.string().optional(),
          amount: z.number(),
          item_id: z.string().optional().describe('Item ID'),
          item_name: z.string().optional(),
          quantity: z.number().optional(),
          unit_price: z.number().optional(),
          account_id: z.string().optional().describe('Expense account ID (if no item)'),
        })).describe('Purchase order lines'),
      },
      async ({ client_name, vendor_id, vendor_name, txn_date, ship_to_id, private_note, department_id, sales_term_id, lines }) => {
        const realmId = await findRealmId(qboManager, client_name);
        if (!realmId) return { content: [{ type: 'text', text: `Client not found: "${client_name}".` }] };
        try {
          const poLines = lines.map(l => {
            const line: any = { Amount: l.amount, Description: l.description };
            if (l.item_id) {
              line.DetailType = 'ItemBasedExpenseLineDetail';
              line.ItemBasedExpenseLineDetail = { Qty: l.quantity ?? 1, UnitPrice: l.unit_price ?? l.amount, ItemRef: { value: l.item_id, name: l.item_name } };
            } else {
              line.DetailType = 'AccountBasedExpenseLineDetail';
              line.AccountBasedExpenseLineDetail = {};
              if (l.account_id) line.AccountBasedExpenseLineDetail.AccountRef = { value: l.account_id };
            }
            return line;
          });
          const payload: any = { VendorRef: { value: vendor_id, name: vendor_name }, Line: poLines };
          if (txn_date) payload.TxnDate = txn_date;
          if (ship_to_id) payload.ShipTo = { value: ship_to_id };
          if (department_id) payload.DepartmentRef = { value: department_id };
          if (sales_term_id) payload.SalesTermRef = { value: sales_term_id };
          if (private_note) payload.PrivateNote = private_note;
          const result = await qboManager.transactions.createPurchaseOrder(realmId, payload);
          const po = (result as any)?.PurchaseOrder;
          return { content: [{ type: 'text', text: po ? `Purchase Order #${po.DocNumber ?? po.Id} created.\nID: ${po.Id} | SyncToken: ${po.SyncToken} | Vendor: ${po.VendorRef?.name ?? vendor_id} | Total: ${formatCurrency(po.TotalAmt)}` : JSON.stringify(result, null, 2) }] };
        } catch (err: any) {
          return { content: [{ type: 'text', text: `Error creating purchase order: ${err?.message ?? err}` }] };
        }
      }
    );

    // ── update_purchase_order ─────────────────────────────────────────────────
    server.tool(
      'update_purchase_order',
      'Update an existing purchase order. Fetches current record first. Supports class, department, and (where applicable) sales terms at the appropriate QBO level (header or line).',
      {
        client_name: z.string().describe('The name of the client company'),
        po_id: z.string().describe('Purchase Order ID'),
        txn_date: z.string().optional(),
        private_note: z.string().optional(),
        department_id: z.string().optional().describe('New header DepartmentRef.value'),
        sales_term_id: z.string().optional().describe('New header SalesTermRef.value'),
        lines: z.array(z.object({
          description: z.string().optional(),
          amount: z.number(),
          item_id: z.string().optional(),
          item_name: z.string().optional(),
          quantity: z.number().optional(),
          unit_price: z.number().optional(),
          account_id: z.string().optional(),
        })).optional().describe('Replacement lines'),
      },
      async ({ client_name, po_id, txn_date, private_note, department_id, sales_term_id, lines }) => {
        const realmId = await findRealmId(qboManager, client_name);
        if (!realmId) return { content: [{ type: 'text', text: `Client not found: "${client_name}".` }] };
        try {
          const existing = await qboManager.transactions.getPurchaseOrder(realmId, po_id) as any;
          const po = existing?.PurchaseOrder;
          if (!po) return { content: [{ type: 'text', text: `Purchase Order ${po_id} not found.` }] };
          const payload: any = { ...po };
          if (txn_date) payload.TxnDate = txn_date;
          if (department_id) payload.DepartmentRef = { value: department_id };
          if (sales_term_id) payload.SalesTermRef = { value: sales_term_id };
          if (private_note !== undefined) payload.PrivateNote = private_note;
          if (lines) {
            payload.Line = lines.map(l => {
              const line: any = { Amount: l.amount, Description: l.description };
              if (l.item_id) {
                line.DetailType = 'ItemBasedExpenseLineDetail';
                line.ItemBasedExpenseLineDetail = { Qty: l.quantity ?? 1, UnitPrice: l.unit_price ?? l.amount, ItemRef: { value: l.item_id, name: l.item_name } };
              } else {
                line.DetailType = 'AccountBasedExpenseLineDetail';
                line.AccountBasedExpenseLineDetail = {};
                if (l.account_id) line.AccountBasedExpenseLineDetail.AccountRef = { value: l.account_id };
              }
              return line;
            });
          }
          const result = await qboManager.transactions.updatePurchaseOrder(realmId, payload);
          const updated = (result as any)?.PurchaseOrder;
          if (updated && lines) {
            const failure = await verifyLinesAndMaybeRollback({
              entityLabel: 'Purchase Order',
              original: po,
              submitted: postedLineStats(payload.Line),
              updated,
              rollback: async (p) => ((await qboManager.transactions.updatePurchaseOrder(realmId, p)) as any)?.PurchaseOrder ?? null,
            });
            if (failure) return { content: [{ type: 'text', text: failure }] };
          }
          return { content: [{ type: 'text', text: updated ? `Purchase Order #${updated.DocNumber ?? updated.Id} updated.\nID: ${updated.Id} | SyncToken: ${updated.SyncToken}` : JSON.stringify(result, null, 2) }] };
        } catch (err: any) {
          return { content: [{ type: 'text', text: `Error updating purchase order: ${err?.message ?? err}` }] };
        }
      }
    );

    // ── close_purchase_order ──────────────────────────────────────────────────
    server.tool(
      'close_purchase_order',
      'Close a purchase order (set POStatus=Closed). Use when the PO is fully received or no longer needed.',
      {
        client_name: z.string().describe('The name of the client company'),
        po_id: z.string().describe('Purchase Order ID to close'),
      },
      async ({ client_name, po_id }) => {
        const realmId = await findRealmId(qboManager, client_name);
        if (!realmId) return { content: [{ type: 'text', text: `Client not found: "${client_name}".` }] };
        try {
          const existing = await qboManager.transactions.getPurchaseOrder(realmId, po_id) as any;
          const po = existing?.PurchaseOrder;
          if (!po) return { content: [{ type: 'text', text: `Purchase Order ${po_id} not found.` }] };
          const payload: any = { ...po, POStatus: 'Closed' };
          // Mark all lines as closed
          if (payload.Line) {
            payload.Line = payload.Line.map((l: any) => ({ ...l, ItemBasedExpenseLineDetail: l.ItemBasedExpenseLineDetail ? { ...l.ItemBasedExpenseLineDetail, ItemAccountBasedExpenseLineDetail: undefined } : undefined, Closed: true }));
          }
          const result = await qboManager.transactions.updatePurchaseOrder(realmId, payload);
          const updated = (result as any)?.PurchaseOrder;
          return { content: [{ type: 'text', text: updated ? `Purchase Order #${updated.DocNumber ?? po_id} closed.\nID: ${updated.Id} | Status: ${updated.POStatus}` : JSON.stringify(result, null, 2) }] };
        } catch (err: any) {
          return { content: [{ type: 'text', text: `Error closing purchase order: ${err?.message ?? err}` }] };
        }
      }
    );

    // ── get_tax_codes ─────────────────────────────────────────────────────────
    server.tool(
      'get_tax_codes',
      'Get the list of sales tax codes for a QBO client.',
      { client_name: z.string().describe('The name of the client company') },
      async ({ client_name }) => {
        const realmId = await findRealmId(qboManager, client_name);
        if (!realmId) return { content: [{ type: 'text', text: `Client not found: "${client_name}". Use list_clients to see available companies.` }] };
        try {
          const result = await qboManager.lists.getTaxCodes(realmId);
          const codes: any[] = (result as any)?.QueryResponse?.TaxCode ?? [];
          if (codes.length === 0) return { content: [{ type: 'text', text: `No tax codes found for ${client_name}.` }] };
          const lines = [
            `TAX CODES — ${client_name}`,
            '─'.repeat(60),
            ...codes.map((c: any) => `  ${(c.Id ?? '').padEnd(10)} ${(c.Name ?? '').padEnd(20)} Taxable: ${c.Taxable ? 'Yes' : 'No'}${c.Description ? ` — ${c.Description}` : ''}`),
          ];
          return { content: [{ type: 'text', text: lines.join('\n') }] };
        } catch (err: any) {
          return { content: [{ type: 'text', text: `Error fetching tax codes: ${err?.message ?? err}` }] };
        }
      }
    );

    // ── get_tax_rates ─────────────────────────────────────────────────────────
    server.tool(
      'get_tax_rates',
      'Get the list of sales tax rates for a QBO client.',
      { client_name: z.string().describe('The name of the client company') },
      async ({ client_name }) => {
        const realmId = await findRealmId(qboManager, client_name);
        if (!realmId) return { content: [{ type: 'text', text: `Client not found: "${client_name}". Use list_clients to see available companies.` }] };
        try {
          const result = await qboManager.lists.getTaxRates(realmId);
          const rates: any[] = (result as any)?.QueryResponse?.TaxRate ?? [];
          if (rates.length === 0) return { content: [{ type: 'text', text: `No tax rates found for ${client_name}.` }] };
          const lines = [
            `TAX RATES — ${client_name}`,
            '─'.repeat(60),
            ...rates.map((r: any) => `  ${(r.Id ?? '').padEnd(10)} ${(r.Name ?? '').padEnd(30)} Rate: ${r.RateValue ?? 0}%${r.AgencyRef ? ` | Agency: ${r.AgencyRef.name ?? r.AgencyRef.value}` : ''}`),
          ];
          return { content: [{ type: 'text', text: lines.join('\n') }] };
        } catch (err: any) {
          return { content: [{ type: 'text', text: `Error fetching tax rates: ${err?.message ?? err}` }] };
        }
      }
    );

    // ═══════════════════════════════════════════════════════════════════════════
    // SLICE A — BANKING & CASH OPS
    // Note: QBO's "For Review" bank feed queue is NOT accessible via the
    // public API. These tools operate on transactions already posted to the
    // register.
    // ═══════════════════════════════════════════════════════════════════════════

    // ── get_bank_register ─────────────────────────────────────────────────────
    server.tool(
      'get_bank_register',
      'Read the posted transaction register for a bank or credit card account. Uses the QBO TransactionList report. Returns date, type, number, name, memo, cleared status, amount, and running balance.',
      {
        client_name: z.string().describe('The name of the client company'),
        account_id: z.string().describe('QBO Account ID for the bank or credit card account (use get_accounts to find IDs)'),
        account_name: z.string().optional().describe('Account name for display'),
        start_date: z.string().describe('Start date YYYY-MM-DD'),
        end_date: z.string().describe('End date YYYY-MM-DD'),
      },
      async ({ client_name, account_id, account_name, start_date, end_date }) => {
        const realmId = await findRealmId(qboManager, client_name);
        if (!realmId) return { content: [{ type: 'text', text: `Client not found: "${client_name}". Use list_clients to see available companies.` }] };
        try {
          const report = await qboManager.banking.transactionList(realmId, {
            startDate: start_date,
            endDate: end_date,
            accountId: account_id,
          });
          const formatted = formatTransactionList(report, client_name, account_name ?? account_id, 'BANK REGISTER');
          return { content: [{ type: 'text', text: formatted }] };
        } catch (err: any) {
          return { content: [{ type: 'text', text: `Error fetching bank register: ${err?.message ?? err}` }] };
        }
      }
    );

    // ── get_uncleared_transactions ────────────────────────────────────────────
    server.tool(
      'get_uncleared_transactions',
      'Get uncleared (outstanding) transactions for a bank or credit card account. Useful for reconciliation prep.',
      {
        client_name: z.string().describe('The name of the client company'),
        account_id: z.string().describe('QBO Account ID for the bank or credit card account'),
        account_name: z.string().optional().describe('Account name for display'),
        start_date: z.string().optional().describe('Start date YYYY-MM-DD'),
        end_date: z.string().optional().describe('End date YYYY-MM-DD'),
      },
      async ({ client_name, account_id, account_name, start_date, end_date }) => {
        const realmId = await findRealmId(qboManager, client_name);
        if (!realmId) return { content: [{ type: 'text', text: `Client not found: "${client_name}". Use list_clients to see available companies.` }] };
        try {
          const report = await qboManager.banking.transactionList(realmId, {
            startDate: start_date,
            endDate: end_date,
            accountId: account_id,
            cleared: 'Uncleared',
          });
          const formatted = formatTransactionList(report, client_name, account_name ?? account_id, 'UNCLEARED TRANSACTIONS');
          return { content: [{ type: 'text', text: formatted }] };
        } catch (err: any) {
          return { content: [{ type: 'text', text: `Error fetching uncleared transactions: ${err?.message ?? err}` }] };
        }
      }
    );

    // ── create_deposit ────────────────────────────────────────────────────────
    server.tool(
      'create_deposit',
      'Create a bank deposit in QuickBooks Online. Can deposit existing customer payments from Undeposited Funds (via linked_payment_ids) or record direct deposits. Each direct line accepts a "Received From" entity (entity_id + entity_type: Vendor | Customer | Employee) — use a Vendor entity for vendor-refund deposits so the refund is attributed to the vendor. customer_id remains supported as a Customer alias.',
      {
        client_name: z.string().describe('The name of the client company'),
        deposit_account_id: z.string().describe('Bank account ID to deposit into'),
        txn_date: z.string().optional().describe('Deposit date YYYY-MM-DD (defaults to today)'),
        private_note: z.string().optional().describe('Memo'),
        department_id: z.string().optional().describe('Header DepartmentRef.value'),
        linked_payment_ids: z.array(z.object({
          payment_id: z.string().describe('Payment ID to include in this deposit (from Undeposited Funds)'),
          amount: z.number().describe('Amount of this payment to deposit'),
        })).optional().describe('Existing customer payments to move from Undeposited Funds into the bank account'),
        deposit_lines: z.array(z.object({
          amount: z.number().describe('Amount'),
          account_id: z.string().describe('Income or liability account ID'),
          description: z.string().optional().describe('Line memo'),
          customer_id: z.string().optional().describe('Alias for entity_id with entity_type "Customer" (kept for backward compatibility)'),
          entity_id: z.string().optional().describe('"Received From" entity ID — the vendor, customer, or employee the funds came from. Requires entity_type. Use this to attribute vendor-refund deposits to the vendor.'),
          entity_type: z.enum(['Vendor', 'Customer', 'Employee']).optional().describe('Type of entity_id'),
        })).optional().describe('Direct deposit lines (when not using Undeposited Funds)'),
      },
      async ({ client_name, deposit_account_id, txn_date, private_note, department_id, linked_payment_ids, deposit_lines }) => {
        const realmId = await findRealmId(qboManager, client_name);
        if (!realmId) return { content: [{ type: 'text', text: `Client not found: "${client_name}". Use list_clients to see available companies.` }] };
        try {
          const entityError = depositLineEntityError(deposit_lines);
          if (entityError) return { content: [{ type: 'text', text: entityError }] };
          const payload: any = {
            DepositToAccountRef: { value: deposit_account_id },
            Line: buildDepositTxnLines(linked_payment_ids, deposit_lines),
          };
          if (txn_date) payload.TxnDate = txn_date;
          if (department_id) payload.DepartmentRef = { value: department_id };
          if (private_note) payload.PrivateNote = private_note;
          const result = await qboManager.banking.createDeposit(realmId, payload);
          const dep = (result as any)?.Deposit;
          const summary = dep
            ? `Deposit created.\nID: ${dep.Id} | SyncToken: ${dep.SyncToken} | Date: ${dep.TxnDate} | Total: ${formatCurrency(dep.TotalAmt)}`
            : JSON.stringify(result, null, 2);
          return { content: [{ type: 'text', text: summary }] };
        } catch (err: any) {
          return { content: [{ type: 'text', text: `Error creating deposit: ${err?.message ?? err}` }] };
        }
      }
    );

    // ── update_deposit ────────────────────────────────────────────────────────
    server.tool(
      'update_deposit',
      'Update an existing bank deposit in place. Read-modify-write: fetches the current Deposit, merges only what you pass, and writes the FULL object back with a fresh SyncToken — untouched fields are preserved. Line semantics, per array independently: a PROVIDED array replaces that kind of line with exactly what you pass; an OMITTED array preserves the existing lines of that kind (so re-coding a direct line never silently unlinks payments); linked_payment_ids: [] explicitly removes the linked payments (they return to Undeposited Funds); omit both arrays for a metadata-only update that leaves lines untouched. Every line change is verified against QBO after the write and automatically rolled back to the original lines if the result does not match. Deposit lines accept a "Received From" entity (entity_id + entity_type: Vendor | Customer | Employee) so vendor-refund deposits can be attributed to the vendor.',
      {
        client_name: z.string().describe('The name of the client company'),
        deposit_id: z.string().describe('The QBO Deposit ID to update'),
        deposit_account_id: z.string().optional().describe('New bank account ID the deposit goes into'),
        txn_date: z.string().optional().describe('New deposit date (YYYY-MM-DD)'),
        private_note: z.string().optional().describe('New memo'),
        linked_payment_ids: z.array(z.object({
          payment_id: z.string().describe('Payment ID included in this deposit (from Undeposited Funds)'),
          amount: z.number().describe('Amount of this payment'),
        })).optional().describe('Replacement set of linked customer payments (part of the full line replacement)'),
        deposit_lines: z.array(z.object({
          amount: z.number().describe('Amount'),
          account_id: z.string().describe('Income or liability account ID'),
          description: z.string().optional().describe('Line memo'),
          customer_id: z.string().optional().describe('Alias for entity_id with entity_type "Customer" (kept for backward compatibility)'),
          entity_id: z.string().optional().describe('"Received From" entity ID — the vendor, customer, or employee the funds came from. Requires entity_type. Use this to attribute vendor-refund deposits to the vendor.'),
          entity_type: z.enum(['Vendor', 'Customer', 'Employee']).optional().describe('Type of entity_id'),
        })).optional().describe('Replacement set of direct deposit lines (part of the full line replacement)'),
      },
      async ({ client_name, deposit_id, deposit_account_id, txn_date, private_note, linked_payment_ids, deposit_lines }) => {
        const realmId = await findRealmId(qboManager, client_name);
        if (!realmId) return { content: [{ type: 'text', text: `Client not found: "${client_name}". Use list_clients to see available companies.` }] };
        try {
          const entityError = depositLineEntityError(deposit_lines);
          if (entityError) return { content: [{ type: 'text', text: entityError }] };

          const existing = await qboManager.banking.getDeposit(realmId, deposit_id) as any;
          const dep = existing?.Deposit;
          if (!dep) return { content: [{ type: 'text', text: `Deposit ${deposit_id} not found.` }] };

          const replacingLines = Boolean(linked_payment_ids || deposit_lines);
          const payload = buildDepositUpdatePayload(dep, {
            deposit_account_id,
            txn_date,
            private_note,
            linked_payment_ids,
            deposit_lines,
          });

          const result = await qboManager.banking.updateDeposit(realmId, payload);
          const updated = (result as any)?.Deposit;
          if (!updated) {
            return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
          }

          // Post-write verification against what was actually sent (submitted
          // + preserved lines). On drift, the original lines are re-posted so
          // an appended/inflated deposit never survives silently.
          if (replacingLines) {
            const failure = await verifyLinesAndMaybeRollback({
              entityLabel: 'Deposit',
              original: dep,
              submitted: postedLineStats(payload.Line),
              updated,
              rollback: async (p) => ((await qboManager.banking.updateDeposit(realmId, p)) as any)?.Deposit ?? null,
            });
            if (failure) return { content: [{ type: 'text', text: failure }] };
          }

          const summary = `Deposit ${updated.Id} updated.\nID: ${updated.Id} | SyncToken: ${updated.SyncToken} | Date: ${updated.TxnDate} | Total: ${formatCurrency(updated.TotalAmt)}${replacingLines ? ` | Lines: ${(updated.Line ?? []).length} (verified line replacement)` : ''}`;
          return { content: [{ type: 'text', text: summary }] };
        } catch (err: any) {
          return { content: [{ type: 'text', text: `Error updating deposit: ${err?.message ?? err}` }] };
        }
      }
    );

    // ── delete_deposit ────────────────────────────────────────────────────────
    server.tool(
      'delete_deposit',
      'Permanently delete a bank deposit from QuickBooks Online. This is a QBO HARD delete — recoverable only via the QBO Audit Log. Any customer payments that were in the deposit return to Undeposited Funds. The response echoes what was deleted for the conversation audit trail.',
      {
        client_name: z.string().describe('The name of the client company'),
        deposit_id: z.string().describe('The QBO Deposit ID to delete'),
      },
      async ({ client_name, deposit_id }) => {
        const realmId = await findRealmId(qboManager, client_name);
        if (!realmId) return { content: [{ type: 'text', text: `Client not found: "${client_name}". Use list_clients to see available companies.` }] };
        try {
          const existing = await qboManager.banking.getDeposit(realmId, deposit_id) as any;
          const dep = existing?.Deposit;
          if (!dep) return { content: [{ type: 'text', text: `Deposit ${deposit_id} not found.` }] };
          await qboManager.banking.deleteDeposit(realmId, deposit_id, dep.SyncToken);
          const summary = `Deleted deposit ${deposit_id}: ${dep.TxnDate}, ${formatCurrency(dep.TotalAmt)} into ${dep.DepositToAccountRef?.name ?? dep.DepositToAccountRef?.value ?? 'unknown account'}, ${(dep.Line ?? []).length} line(s).\nQBO hard delete — recoverable only via the Audit Log.`;
          return { content: [{ type: 'text', text: summary }] };
        } catch (err: any) {
          return { content: [{ type: 'text', text: `Error deleting deposit: ${err?.message ?? err}` }] };
        }
      }
    );

    // ── create_transfer ───────────────────────────────────────────────────────
    server.tool(
      'create_transfer',
      'Create a funds transfer between two bank or credit card accounts in QuickBooks Online. Supports class, department, and (where applicable) sales terms at the appropriate QBO level (header or line).',
      {
        client_name: z.string().describe('The name of the client company'),
        from_account_id: z.string().describe('Source account ID (funds leave this account)'),
        to_account_id: z.string().describe('Destination account ID (funds arrive here)'),
        amount: z.number().describe('Transfer amount'),
        txn_date: z.string().optional().describe('Transfer date YYYY-MM-DD (defaults to today)'),
        private_note: z.string().optional().describe('Memo'),
        department_id: z.string().optional().describe('Header DepartmentRef.value (where supported by QBO)'),
      },
      async ({ client_name, from_account_id, to_account_id, amount, txn_date, private_note, department_id }) => {
        const realmId = await findRealmId(qboManager, client_name);
        if (!realmId) return { content: [{ type: 'text', text: `Client not found: "${client_name}". Use list_clients to see available companies.` }] };
        try {
          const payload: any = {
            FromAccountRef: { value: from_account_id },
            ToAccountRef: { value: to_account_id },
            Amount: amount,
          };
          if (txn_date) payload.TxnDate = txn_date;
          if (department_id) payload.DepartmentRef = { value: department_id };
          if (private_note) payload.PrivateNote = private_note;
          const result = await qboManager.banking.createTransfer(realmId, payload);
          const txfr = (result as any)?.Transfer;
          const summary = txfr
            ? `Transfer created.\nID: ${txfr.Id} | SyncToken: ${txfr.SyncToken} | Date: ${txfr.TxnDate} | Amount: ${formatCurrency(txfr.Amount)}\nFrom: ${txfr.FromAccountRef?.name ?? from_account_id} → To: ${txfr.ToAccountRef?.name ?? to_account_id}`
            : JSON.stringify(result, null, 2);
          return { content: [{ type: 'text', text: summary }] };
        } catch (err: any) {
          return { content: [{ type: 'text', text: `Error creating transfer: ${err?.message ?? err}` }] };
        }
      }
    );

    // ── create_credit_card_payment ────────────────────────────────────────────
    server.tool(
      'create_credit_card_payment',
      'Record a credit card payment — pay down a credit card balance from a bank account. This creates a CreditCardPaymentTxn in QBO.',
      {
        client_name: z.string().describe('The name of the client company'),
        bank_account_id: z.string().describe('Bank account ID the payment is drawn from'),
        credit_card_account_id: z.string().describe('Credit card account ID being paid'),
        amount: z.number().describe('Payment amount'),
        txn_date: z.string().optional().describe('Payment date YYYY-MM-DD (defaults to today)'),
      },
      async ({ client_name, bank_account_id, credit_card_account_id, amount, txn_date }) => {
        const realmId = await findRealmId(qboManager, client_name);
        if (!realmId) return { content: [{ type: 'text', text: `Client not found: "${client_name}". Use list_clients to see available companies.` }] };
        try {
          const payload: any = {
            BankAccountRef: { value: bank_account_id },
            CreditCardAccountRef: { value: credit_card_account_id },
            Amount: amount,
          };
          if (txn_date) payload.TxnDate = txn_date;
          const result = await qboManager.banking.createCreditCardPayment(realmId, payload);
          const ccpmt = (result as any)?.CreditCardPaymentTxn;
          const summary = ccpmt
            ? `Credit card payment created.\nID: ${ccpmt.Id} | Date: ${ccpmt.TxnDate} | Amount: ${formatCurrency(ccpmt.Amount)}`
            : JSON.stringify(result, null, 2);
          return { content: [{ type: 'text', text: summary }] };
        } catch (err: any) {
          return { content: [{ type: 'text', text: `Error creating credit card payment: ${err?.message ?? err}` }] };
        }
      }
    );

    // ── match_transaction ─────────────────────────────────────────────────────
    server.tool(
      'match_transaction',
      'Best-effort "match" a bank register entry to an existing QBO transaction. Since QBO\'s public API does not expose the For Review queue or a native match endpoint, this creates the appropriate linking transaction:\n- Match to an Invoice → creates a Payment with LinkedTxn\n- Match to a Bill → creates a BillPayment with LinkedTxn\n- Move Payments from Undeposited Funds → creates a Deposit with LinkedTxn',
      {
        client_name: z.string().describe('The name of the client company'),
        match_type: z.enum(['invoice', 'bill', 'deposit_payment']).describe(
          'invoice: create a Payment applied to an Invoice. bill: create a BillPayment applied to a Bill. deposit_payment: create a Deposit to move a Payment from Undeposited Funds.'
        ),
        amount: z.number().describe('Amount of the bank register entry'),
        txn_date: z.string().optional().describe('Date YYYY-MM-DD (defaults to today)'),
        bank_account_id: z.string().describe('Bank/CC account ID seen in the register'),
        // invoice match fields
        customer_id: z.string().optional().describe('[invoice] Customer ID'),
        invoice_id: z.string().optional().describe('[invoice] Invoice ID to apply payment to'),
        // bill match fields
        vendor_id: z.string().optional().describe('[bill] Vendor ID'),
        bill_id: z.string().optional().describe('[bill] Bill ID to apply payment to'),
        // deposit_payment fields
        payment_id: z.string().optional().describe('[deposit_payment] Payment ID currently in Undeposited Funds'),
        private_note: z.string().optional().describe('Memo'),
      },
      async ({ client_name, match_type, amount, txn_date, bank_account_id, customer_id, invoice_id, vendor_id, bill_id, payment_id, private_note }) => {
        const realmId = await findRealmId(qboManager, client_name);
        if (!realmId) return { content: [{ type: 'text', text: `Client not found: "${client_name}". Use list_clients to see available companies.` }] };
        try {
          if (match_type === 'invoice') {
            if (!customer_id || !invoice_id) return { content: [{ type: 'text', text: 'match_type=invoice requires customer_id and invoice_id.' }] };
            const payload: any = {
              CustomerRef: { value: customer_id },
              TotalAmt: amount,
              DepositToAccountRef: { value: bank_account_id },
              Line: [{ Amount: amount, LinkedTxn: [{ TxnId: invoice_id, TxnType: 'Invoice' }] }],
            };
            if (txn_date) payload.TxnDate = txn_date;
            if (private_note) payload.PrivateNote = private_note;
            const result = await qboManager.transactions.createPayment(realmId, payload);
            const pmt = (result as any)?.Payment;
            return { content: [{ type: 'text', text: pmt ? `Matched: Payment #${pmt.Id} created and applied to Invoice ${invoice_id}. Amount: ${formatCurrency(pmt.TotalAmt)}` : JSON.stringify(result, null, 2) }] };
          } else if (match_type === 'bill') {
            if (!vendor_id || !bill_id) return { content: [{ type: 'text', text: 'match_type=bill requires vendor_id and bill_id.' }] };
            const payload: any = {
              VendorRef: { value: vendor_id },
              TotalAmt: amount,
              PayType: 'Check',
              CheckPayment: { BankAccountRef: { value: bank_account_id } },
              Line: [{ Amount: amount, LinkedTxn: [{ TxnId: bill_id, TxnType: 'Bill' }] }],
            };
            if (txn_date) payload.TxnDate = txn_date;
            if (private_note) payload.PrivateNote = private_note;
            const result = await qboManager.transactions.createBillPayment(realmId, payload);
            const bp = (result as any)?.BillPayment;
            return { content: [{ type: 'text', text: bp ? `Matched: BillPayment #${bp.Id} created and applied to Bill ${bill_id}. Amount: ${formatCurrency(bp.TotalAmt)}` : JSON.stringify(result, null, 2) }] };
          } else {
            // deposit_payment
            if (!payment_id) return { content: [{ type: 'text', text: 'match_type=deposit_payment requires payment_id.' }] };
            const payload: any = {
              DepositToAccountRef: { value: bank_account_id },
              Line: [{ Amount: amount, LinkedTxn: [{ TxnId: payment_id, TxnType: 'Payment' }] }],
            };
            if (txn_date) payload.TxnDate = txn_date;
            if (private_note) payload.PrivateNote = private_note;
            const result = await qboManager.banking.createDeposit(realmId, payload);
            const dep = (result as any)?.Deposit;
            return { content: [{ type: 'text', text: dep ? `Matched: Deposit #${dep.Id} created, Payment ${payment_id} moved from Undeposited Funds. Total: ${formatCurrency(dep.TotalAmt)}` : JSON.stringify(result, null, 2) }] };
          }
        } catch (err: any) {
          return { content: [{ type: 'text', text: `Error matching transaction: ${err?.message ?? err}` }] };
        }
      }
    );

    // ═══════════════════════════════════════════════════════════════════════════
    // GET_<ENTITY> — fetch records in update-ready shape for round-trip editing
    // ═══════════════════════════════════════════════════════════════════════════

    // ── get_sales_receipt ─────────────────────────────────────────────────────
    server.tool(
      'get_sales_receipt',
      'Fetch a sales receipt in update-ready shape. The returned `lines` array can be passed directly to update_sales_receipt with no reshaping.',
      {
        client_name: z.string().describe('The name of the client company'),
        sales_receipt_id: z.string().describe('QBO Sales Receipt ID'),
      },
      async ({ client_name, sales_receipt_id }) => {
        const realmId = await findRealmId(qboManager, client_name);
        if (!realmId) return { content: [{ type: 'text', text: `Client not found: "${client_name}".` }] };
        try {
          const raw = await qboManager.transactions.getSalesReceipt(realmId, sales_receipt_id) as any;
          const sr = raw?.SalesReceipt;
          if (!sr) return { content: [{ type: 'text', text: `Sales Receipt ${sales_receipt_id} not found.` }] };
          const result = {
            id: sr.Id,
            sync_token: sr.SyncToken,
            doc_number: sr.DocNumber,
            customer_id: sr.CustomerRef?.value,
            customer_name: sr.CustomerRef?.name,
            txn_date: sr.TxnDate,
            private_note: sr.PrivateNote,
            deposit_account_id: sr.DepositToAccountRef?.value,
            payment_method_id: sr.PaymentMethodRef?.value,
            department_id: sr.DepartmentRef?.value,
            total_amt: sr.TotalAmt,
            lines: qboSalesLinesToUpdateShape(sr.Line ?? []),
          };
          return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        } catch (err: any) {
          return { content: [{ type: 'text', text: `Error fetching sales receipt: ${err?.message ?? err}` }] };
        }
      }
    );

    // ── get_invoice ───────────────────────────────────────────────────────────
    server.tool(
      'get_invoice',
      'Fetch an invoice in update-ready shape. The returned `lines` array can be passed directly to update_invoice with no reshaping.',
      {
        client_name: z.string().describe('The name of the client company'),
        invoice_id: z.string().describe('QBO Invoice ID'),
      },
      async ({ client_name, invoice_id }) => {
        const realmId = await findRealmId(qboManager, client_name);
        if (!realmId) return { content: [{ type: 'text', text: `Client not found: "${client_name}".` }] };
        try {
          const raw = await qboManager.transactions.getInvoice(realmId, invoice_id) as any;
          const inv = raw?.Invoice;
          if (!inv) return { content: [{ type: 'text', text: `Invoice ${invoice_id} not found.` }] };
          const result = {
            id: inv.Id,
            sync_token: inv.SyncToken,
            doc_number: inv.DocNumber,
            customer_id: inv.CustomerRef?.value,
            customer_name: inv.CustomerRef?.name,
            txn_date: inv.TxnDate,
            due_date: inv.DueDate,
            private_note: inv.PrivateNote,
            department_id: inv.DepartmentRef?.value,
            sales_term_id: inv.SalesTermRef?.value,
            total_amt: inv.TotalAmt,
            balance: inv.Balance,
            lines: qboSalesLinesToUpdateShape(inv.Line ?? []),
          };
          return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        } catch (err: any) {
          return { content: [{ type: 'text', text: `Error fetching invoice: ${err?.message ?? err}` }] };
        }
      }
    );

    // ── get_bill ──────────────────────────────────────────────────────────────
    server.tool(
      'get_bill',
      'Fetch a bill in update-ready shape. The returned `lines` array can be passed directly to update_bill with no reshaping.',
      {
        client_name: z.string().describe('The name of the client company'),
        bill_id: z.string().describe('QBO Bill ID'),
      },
      async ({ client_name, bill_id }) => {
        const realmId = await findRealmId(qboManager, client_name);
        if (!realmId) return { content: [{ type: 'text', text: `Client not found: "${client_name}".` }] };
        try {
          const raw = await qboManager.transactions.getBill(realmId, bill_id) as any;
          const bill = raw?.Bill;
          if (!bill) return { content: [{ type: 'text', text: `Bill ${bill_id} not found.` }] };
          const result = {
            id: bill.Id,
            sync_token: bill.SyncToken,
            doc_number: bill.DocNumber,
            vendor_id: bill.VendorRef?.value,
            vendor_name: bill.VendorRef?.name,
            txn_date: bill.TxnDate,
            due_date: bill.DueDate,
            private_note: bill.PrivateNote,
            department_id: bill.DepartmentRef?.value,
            sales_term_id: bill.SalesTermRef?.value,
            total_amt: bill.TotalAmt,
            balance: bill.Balance,
            lines: qboBillLinesToUpdateShape(bill.Line ?? []),
          };
          return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        } catch (err: any) {
          return { content: [{ type: 'text', text: `Error fetching bill: ${err?.message ?? err}` }] };
        }
      }
    );

    // ── get_journal_entry ─────────────────────────────────────────────────────
    server.tool(
      'get_journal_entry',
      'Fetch a journal entry in update-ready shape. The returned `lines` array can be passed directly to update_journal_entry with no reshaping.',
      {
        client_name: z.string().describe('The name of the client company'),
        journal_entry_id: z.string().describe('QBO Journal Entry ID'),
      },
      async ({ client_name, journal_entry_id }) => {
        const realmId = await findRealmId(qboManager, client_name);
        if (!realmId) return { content: [{ type: 'text', text: `Client not found: "${client_name}".` }] };
        try {
          const raw = await qboManager.journalEntries.get(realmId, journal_entry_id) as any;
          const je = raw?.JournalEntry;
          if (!je) return { content: [{ type: 'text', text: `Journal Entry ${journal_entry_id} not found.` }] };
          const result = {
            id: je.Id,
            sync_token: je.SyncToken,
            doc_number: je.DocNumber,
            txn_date: je.TxnDate,
            private_note: je.PrivateNote,
            total_amt: je.TotalAmt,
            // NOTE: JournalEntry uses per-line DepartmentRef (see lines[].department_id), not a header DepartmentRef.
            lines: qboJournalLinesToUpdateShape(je.Line ?? []),
          };
          return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        } catch (err: any) {
          return { content: [{ type: 'text', text: `Error fetching journal entry: ${err?.message ?? err}` }] };
        }
      }
    );

    // ── get_expense ───────────────────────────────────────────────────────────
    server.tool(
      'get_expense',
      'Fetch an expense (Purchase) in update-ready shape. The returned `lines` array matches the create_expense line schema (expense_account_id for account-based lines).',
      {
        client_name: z.string().describe('The name of the client company'),
        expense_id: z.string().describe('QBO Expense (Purchase) ID'),
      },
      async ({ client_name, expense_id }) => {
        const realmId = await findRealmId(qboManager, client_name);
        if (!realmId) return { content: [{ type: 'text', text: `Client not found: "${client_name}".` }] };
        try {
          const raw = await qboManager.transactions.getExpense(realmId, expense_id) as any;
          const exp = raw?.Purchase;
          if (!exp) return { content: [{ type: 'text', text: `Expense ${expense_id} not found.` }] };
          const result = {
            id: exp.Id,
            sync_token: exp.SyncToken,
            doc_number: exp.DocNumber,
            payment_type: exp.PaymentType,
            account_id: exp.AccountRef?.value,
            account_name: exp.AccountRef?.name,
            vendor_id: exp.EntityRef?.value,
            vendor_name: exp.EntityRef?.name,
            txn_date: exp.TxnDate,
            private_note: exp.PrivateNote,
            department_id: exp.DepartmentRef?.value,
            total_amt: exp.TotalAmt,
            lines: qboExpenseLinesToUpdateShape(exp.Line ?? []),
          };
          return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        } catch (err: any) {
          return { content: [{ type: 'text', text: `Error fetching expense: ${err?.message ?? err}` }] };
        }
      }
    );

    // ── get_deposit ───────────────────────────────────────────────────────────
    server.tool(
      'get_deposit',
      'Fetch a deposit in update-ready shape. Returns linked_payment_ids (payments from Undeposited Funds) and deposit_lines (direct income lines) — both preserved on round-trip.',
      {
        client_name: z.string().describe('The name of the client company'),
        deposit_id: z.string().describe('QBO Deposit ID'),
      },
      async ({ client_name, deposit_id }) => {
        const realmId = await findRealmId(qboManager, client_name);
        if (!realmId) return { content: [{ type: 'text', text: `Client not found: "${client_name}".` }] };
        try {
          const raw = await qboManager.banking.getDeposit(realmId, deposit_id) as any;
          const dep = raw?.Deposit;
          if (!dep) return { content: [{ type: 'text', text: `Deposit ${deposit_id} not found.` }] };
          const { linked_payment_ids, deposit_lines } = qboDepositLinesToUpdateShape(dep.Line ?? []);
          const result = {
            id: dep.Id,
            sync_token: dep.SyncToken,
            deposit_account_id: dep.DepositToAccountRef?.value,
            deposit_account_name: dep.DepositToAccountRef?.name,
            txn_date: dep.TxnDate,
            private_note: dep.PrivateNote,
            department_id: dep.DepartmentRef?.value,
            total_amt: dep.TotalAmt,
            linked_payment_ids,
            deposit_lines,
          };
          return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        } catch (err: any) {
          return { content: [{ type: 'text', text: `Error fetching deposit: ${err?.message ?? err}` }] };
        }
      }
    );

    // ── get_credit_memo ───────────────────────────────────────────────────────
    server.tool(
      'get_credit_memo',
      'Fetch a credit memo in update-ready shape. The returned `lines` array can be passed directly to update_credit_memo with no reshaping.',
      {
        client_name: z.string().describe('The name of the client company'),
        credit_memo_id: z.string().describe('QBO Credit Memo ID'),
      },
      async ({ client_name, credit_memo_id }) => {
        const realmId = await findRealmId(qboManager, client_name);
        if (!realmId) return { content: [{ type: 'text', text: `Client not found: "${client_name}".` }] };
        try {
          const raw = await qboManager.transactions.getCreditMemo(realmId, credit_memo_id) as any;
          const cm = raw?.CreditMemo;
          if (!cm) return { content: [{ type: 'text', text: `Credit Memo ${credit_memo_id} not found.` }] };
          const result = {
            id: cm.Id,
            sync_token: cm.SyncToken,
            doc_number: cm.DocNumber,
            customer_id: cm.CustomerRef?.value,
            customer_name: cm.CustomerRef?.name,
            txn_date: cm.TxnDate,
            private_note: cm.PrivateNote,
            department_id: cm.DepartmentRef?.value,
            sales_term_id: cm.SalesTermRef?.value,
            total_amt: cm.TotalAmt,
            remaining_credit: cm.RemainingCredit,
            lines: qboSalesLinesToUpdateShape(cm.Line ?? []),
          };
          return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        } catch (err: any) {
          return { content: [{ type: 'text', text: `Error fetching credit memo: ${err?.message ?? err}` }] };
        }
      }
    );

    // ── get_estimate ──────────────────────────────────────────────────────────
    server.tool(
      'get_estimate',
      'Fetch an estimate in update-ready shape. The returned `lines` array can be passed directly to update_estimate with no reshaping.',
      {
        client_name: z.string().describe('The name of the client company'),
        estimate_id: z.string().describe('QBO Estimate ID'),
      },
      async ({ client_name, estimate_id }) => {
        const realmId = await findRealmId(qboManager, client_name);
        if (!realmId) return { content: [{ type: 'text', text: `Client not found: "${client_name}".` }] };
        try {
          const raw = await qboManager.transactions.getEstimate(realmId, estimate_id) as any;
          const est = raw?.Estimate;
          if (!est) return { content: [{ type: 'text', text: `Estimate ${estimate_id} not found.` }] };
          const result = {
            id: est.Id,
            sync_token: est.SyncToken,
            doc_number: est.DocNumber,
            customer_id: est.CustomerRef?.value,
            customer_name: est.CustomerRef?.name,
            txn_date: est.TxnDate,
            expiry_date: est.ExpirationDate,
            txn_status: est.TxnStatus,
            private_note: est.PrivateNote,
            department_id: est.DepartmentRef?.value,
            sales_term_id: est.SalesTermRef?.value,
            total_amt: est.TotalAmt,
            lines: qboSalesLinesToUpdateShape(est.Line ?? []),
          };
          return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        } catch (err: any) {
          return { content: [{ type: 'text', text: `Error fetching estimate: ${err?.message ?? err}` }] };
        }
      }
    );

    // ── get_purchase_order ────────────────────────────────────────────────────
    server.tool(
      'get_purchase_order',
      'Fetch a purchase order in update-ready shape. The returned `lines` array can be passed directly to update_purchase_order with no reshaping.',
      {
        client_name: z.string().describe('The name of the client company'),
        po_id: z.string().describe('QBO Purchase Order ID'),
      },
      async ({ client_name, po_id }) => {
        const realmId = await findRealmId(qboManager, client_name);
        if (!realmId) return { content: [{ type: 'text', text: `Client not found: "${client_name}".` }] };
        try {
          const raw = await qboManager.transactions.getPurchaseOrder(realmId, po_id) as any;
          const po = raw?.PurchaseOrder;
          if (!po) return { content: [{ type: 'text', text: `Purchase Order ${po_id} not found.` }] };
          const result = {
            id: po.Id,
            sync_token: po.SyncToken,
            doc_number: po.DocNumber,
            vendor_id: po.VendorRef?.value,
            vendor_name: po.VendorRef?.name,
            txn_date: po.TxnDate,
            private_note: po.PrivateNote,
            department_id: po.DepartmentRef?.value,
            sales_term_id: po.SalesTermRef?.value,
            po_status: po.POStatus,
            total_amt: po.TotalAmt,
            lines: qboPoLinesToUpdateShape(po.Line ?? []),
          };
          return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        } catch (err: any) {
          return { content: [{ type: 'text', text: `Error fetching purchase order: ${err?.message ?? err}` }] };
        }
      }
    );

    // ═══════════════════════════════════════════════════════════════════════════
    // SWAP_ITEM_OR_ACCOUNT — bulk-swap a line ref across many transactions
    // ═══════════════════════════════════════════════════════════════════════════

    server.tool(
      'swap_item_or_account',
      'Bulk-swap an item or account reference across multiple transactions. Fetches each record, replaces all matching line refs, and posts the update. Use dry_run=true to preview before committing.',
      {
        client_name: z.string().describe('The name of the client company'),
        old_id: z.string().describe('Item ID or account ID to replace'),
        new_id: z.string().describe('Item ID or account ID to swap in'),
        id_type: z.enum(['item', 'account']).describe('Whether old_id/new_id are item IDs or account IDs'),
        transaction_ids: z.array(z.string()).min(1).describe('Transaction IDs to modify'),
        entity_types: z.array(z.string()).min(1).describe(
          'Entity type for each transaction: one value (applies to all) or same length as transaction_ids (paired). ' +
          'Supported: SalesReceipt, Invoice, Bill, Expense, JournalEntry, CreditMemo, Deposit.'
        ),
        dry_run: z.boolean().default(false).describe('If true, report what would change without writing to QBO'),
        stop_on_error: z.boolean().default(true).describe('If true, halt on first failure; if false, continue through all transactions'),
      },
      async ({ client_name, old_id, new_id, id_type, transaction_ids, entity_types, dry_run, stop_on_error }) => {
        const realmId = await findRealmId(qboManager, client_name);
        if (!realmId) return { content: [{ type: 'text', text: `Client not found: "${client_name}".` }] };

        const SUPPORTED = ['SalesReceipt', 'Invoice', 'Bill', 'Expense', 'JournalEntry', 'CreditMemo', 'Deposit'];

        // ── Validate entity_types ───────────────────────────────────────────
        const unsupported = entity_types.filter(t => !SUPPORTED.includes(t));
        if (unsupported.length) {
          return { content: [{ type: 'text', text: `Unsupported entity type(s): ${unsupported.join(', ')}. Supported: ${SUPPORTED.join(', ')}.` }] };
        }

        // ── Validate id_type + entity_type combos ────────────────────────────
        if (id_type === 'item') {
          const itemInvalid = entity_types.filter(t => t === 'JournalEntry' || t === 'Deposit');
          if (itemInvalid.length) {
            return { content: [{ type: 'text', text: `id_type="item" is incompatible with entity type(s): ${itemInvalid.join(', ')}. Journal entries and deposits use accounts, not items.` }] };
          }
        }

        // ── Map txn_id → entity_type ─────────────────────────────────────────
        let txnEntityMap: Map<string, string>;
        if (entity_types.length === 1) {
          txnEntityMap = new Map(transaction_ids.map(id => [id, entity_types[0]]));
        } else if (entity_types.length === transaction_ids.length) {
          txnEntityMap = new Map(transaction_ids.map((id, i) => [id, entity_types[i]]));
        } else {
          return { content: [{ type: 'text', text: `entity_types must have 1 element (applied to all) or the same count as transaction_ids (${transaction_ids.length}). Got ${entity_types.length}.` }] };
        }

        // ── Helper: fetch raw entity ─────────────────────────────────────────
        async function fetchRaw(entityType: string, txnId: string): Promise<any> {
          switch (entityType) {
            case 'SalesReceipt': return qboManager.transactions.getSalesReceipt(realmId!, txnId);
            case 'Invoice': return qboManager.transactions.getInvoice(realmId!, txnId);
            case 'Bill': return qboManager.transactions.getBill(realmId!, txnId);
            case 'Expense': return qboManager.transactions.getExpense(realmId!, txnId);
            case 'JournalEntry': return qboManager.journalEntries.get(realmId!, txnId);
            case 'CreditMemo': return qboManager.transactions.getCreditMemo(realmId!, txnId);
            case 'Deposit': return qboManager.banking.getDeposit(realmId!, txnId);
            default: throw new Error(`Unsupported: ${entityType}`);
          }
        }

        function extractEntity(raw: any, entityType: string): any {
          switch (entityType) {
            case 'SalesReceipt': return raw?.SalesReceipt;
            case 'Invoice': return raw?.Invoice;
            case 'Bill': return raw?.Bill;
            case 'Expense': return raw?.Purchase;
            case 'JournalEntry': return raw?.JournalEntry;
            case 'CreditMemo': return raw?.CreditMemo;
            case 'Deposit': return raw?.Deposit;
            default: return null;
          }
        }

        async function postUpdate(entityType: string, payload: any): Promise<any> {
          switch (entityType) {
            case 'SalesReceipt': return qboManager.transactions.updateSalesReceipt(realmId!, payload);
            case 'Invoice': return qboManager.transactions.updateInvoice(realmId!, payload);
            case 'Bill': return qboManager.transactions.updateBill(realmId!, payload);
            case 'Expense': return qboManager.transactions.updateExpense(realmId!, payload);
            case 'JournalEntry': return qboManager.journalEntries.update(realmId!, payload);
            case 'CreditMemo': return qboManager.transactions.updateCreditMemo(realmId!, payload);
            case 'Deposit': return qboManager.banking.updateDeposit(realmId!, payload);
            default: throw new Error(`Unsupported: ${entityType}`);
          }
        }

        // ── Process each transaction ─────────────────────────────────────────
        const results: Array<{
          txn_id: string;
          entity_type: string;
          status: 'updated' | 'would_update' | 'no_match' | 'failed';
          lines_changed: number;
          error?: string;
        }> = [];

        for (const txnId of transaction_ids) {
          const entityType = txnEntityMap.get(txnId)!;

          try {
            const raw = await fetchRaw(entityType, txnId);
            const entity = extractEntity(raw, entityType);
            if (!entity) {
              const entry = { txn_id: txnId, entity_type: entityType, status: 'failed' as const, lines_changed: 0, error: `${entityType} ${txnId} not found` };
              results.push(entry);
              if (stop_on_error) break;
              continue;
            }

            const lines: any[] = entity.Line ?? [];
            const { updatedLines, linesChanged } = id_type === 'item'
              ? swapItemInLines(lines, old_id, new_id)
              : swapAccountInLines(lines, old_id, new_id);

            if (linesChanged === 0) {
              results.push({ txn_id: txnId, entity_type: entityType, status: 'no_match', lines_changed: 0 });
              continue;
            }

            if (dry_run) {
              results.push({ txn_id: txnId, entity_type: entityType, status: 'would_update', lines_changed: linesChanged });
              continue;
            }

            const payload = { ...entity, Line: updatedLines };
            await postUpdate(entityType, payload);
            results.push({ txn_id: txnId, entity_type: entityType, status: 'updated', lines_changed: linesChanged });
          } catch (err: any) {
            const entry = { txn_id: txnId, entity_type: entityType, status: 'failed' as const, lines_changed: 0, error: err?.message ?? String(err) };
            results.push(entry);
            if (stop_on_error) break;
          }
        }

        // ── Summary ──────────────────────────────────────────────────────────
        const updated = results.filter(r => r.status === 'updated').length;
        const wouldUpdate = results.filter(r => r.status === 'would_update').length;
        const noMatch = results.filter(r => r.status === 'no_match').length;
        const failed = results.filter(r => r.status === 'failed').length;
        const processed = results.length;
        const total = transaction_ids.length;

        const header = dry_run
          ? `DRY RUN — swap_item_or_account (${id_type}: ${old_id} → ${new_id})`
          : `swap_item_or_account (${id_type}: ${old_id} → ${new_id})`;

        const summary = [
          header,
          `Processed: ${processed}/${total} | Would update: ${wouldUpdate} | Updated: ${updated} | No match: ${noMatch} | Failed: ${failed}`,
          '─'.repeat(70),
          ...results.map(r => {
            const base = `  ${r.txn_id.padEnd(20)} [${r.entity_type.padEnd(13)}] ${r.status.padEnd(12)} lines_changed=${r.lines_changed}`;
            return r.error ? `${base}  ERROR: ${r.error}` : base;
          }),
        ].join('\n');

        return { content: [{ type: 'text', text: summary + '\n\n' + JSON.stringify(results, null, 2) }] };
      }
    );

    // ═══════════════════════════════════════════════════════════════════════════
    // BULK_SET_DEPARTMENT — backfill DepartmentRef across many transactions
    // ═══════════════════════════════════════════════════════════════════════════

    server.tool(
      'bulk_set_department',
      'Bulk-set the DepartmentRef on multiple transactions. Fetches each record, sets the department at the header (or per-line for JournalEntry), and posts the update. Use dry_run=true to preview. Supports class, department, and (where applicable) sales terms at the appropriate QBO level (header or line).',
      {
        client_name: z.string().describe('The name of the client company'),
        entity_type: z.enum([
          'Bill', 'Invoice', 'Estimate', 'SalesReceipt', 'CreditMemo', 'RefundReceipt',
          'Payment', 'Expense', 'PurchaseOrder', 'BillPayment', 'Deposit', 'Transfer',
          'JournalEntry',
        ]).describe('QBO entity type for all transactions in this batch'),
        transaction_ids: z.array(z.string()).min(1).describe('Transaction IDs to modify'),
        department_id: z.string().describe('DepartmentRef.value to set (use get_departments to find IDs)'),
        dry_run: z.boolean().default(false).describe('If true, report what would change without writing to QBO'),
        stop_on_error: z.boolean().default(true).describe('If true, halt on first failure; if false, continue through all transactions'),
      },
      async ({ client_name, entity_type, transaction_ids, department_id, dry_run, stop_on_error }) => {
        const realmId = await findRealmId(qboManager, client_name);
        if (!realmId) return { content: [{ type: 'text', text: `Client not found: "${client_name}".` }] };

        async function fetchEntity(txnId: string): Promise<any> {
          switch (entity_type) {
            case 'Bill': return qboManager.transactions.getBill(realmId!, txnId);
            case 'Invoice': return qboManager.transactions.getInvoice(realmId!, txnId);
            case 'Estimate': return qboManager.transactions.getEstimate(realmId!, txnId);
            case 'SalesReceipt': return qboManager.transactions.getSalesReceipt(realmId!, txnId);
            case 'CreditMemo': return qboManager.transactions.getCreditMemo(realmId!, txnId);
            case 'RefundReceipt': return qboManager.transactions.getRefundReceipt(realmId!, txnId);
            case 'Payment': return qboManager.transactions.getPayment(realmId!, txnId);
            case 'Expense': return qboManager.transactions.getExpense(realmId!, txnId);
            case 'PurchaseOrder': return qboManager.transactions.getPurchaseOrder(realmId!, txnId);
            case 'BillPayment': return qboManager.transactions.getBillPayment(realmId!, txnId);
            case 'Deposit': return qboManager.banking.getDeposit(realmId!, txnId);
            case 'Transfer': return qboManager.banking.getTransfer(realmId!, txnId);
            case 'JournalEntry': return qboManager.journalEntries.get(realmId!, txnId);
          }
        }

        function extractEntity(raw: any): any {
          switch (entity_type) {
            case 'Bill': return raw?.Bill;
            case 'Invoice': return raw?.Invoice;
            case 'Estimate': return raw?.Estimate;
            case 'SalesReceipt': return raw?.SalesReceipt;
            case 'CreditMemo': return raw?.CreditMemo;
            case 'RefundReceipt': return raw?.RefundReceipt;
            case 'Payment': return raw?.Payment;
            case 'Expense': return raw?.Purchase;
            case 'PurchaseOrder': return raw?.PurchaseOrder;
            case 'BillPayment': return raw?.BillPayment;
            case 'Deposit': return raw?.Deposit;
            case 'Transfer': return raw?.Transfer;
            case 'JournalEntry': return raw?.JournalEntry;
          }
        }

        async function postUpdate(payload: any): Promise<any> {
          switch (entity_type) {
            case 'Bill': return qboManager.transactions.updateBill(realmId!, payload);
            case 'Invoice': return qboManager.transactions.updateInvoice(realmId!, payload);
            case 'Estimate': return qboManager.transactions.updateEstimate(realmId!, payload);
            case 'SalesReceipt': return qboManager.transactions.updateSalesReceipt(realmId!, payload);
            case 'CreditMemo': return qboManager.transactions.updateCreditMemo(realmId!, payload);
            case 'RefundReceipt': return qboManager.transactions.updateRefundReceipt(realmId!, payload);
            case 'Payment': return qboManager.transactions.updatePayment(realmId!, payload);
            case 'Expense': return qboManager.transactions.updateExpense(realmId!, payload);
            case 'PurchaseOrder': return qboManager.transactions.updatePurchaseOrder(realmId!, payload);
            case 'BillPayment': return qboManager.transactions.updateBillPayment(realmId!, payload);
            case 'Deposit': return qboManager.banking.updateDeposit(realmId!, payload);
            case 'Transfer': return qboManager.banking.updateTransfer(realmId!, payload);
            case 'JournalEntry': return qboManager.journalEntries.update(realmId!, payload);
          }
        }

        const results: Array<{
          txn_id: string;
          status: 'updated' | 'would_update' | 'no_change' | 'failed';
          previous_department_id?: string;
          new_department_id: string;
          lines_changed?: number;
          error?: string;
        }> = [];

        for (const txnId of transaction_ids) {
          try {
            const raw = await fetchEntity(txnId);
            const entity = extractEntity(raw);
            if (!entity) {
              results.push({ txn_id: txnId, status: 'failed', new_department_id: department_id, error: `${entity_type} ${txnId} not found` });
              if (stop_on_error) break;
              continue;
            }

            if (entity_type === 'JournalEntry') {
              const existingLines: any[] = entity.Line ?? [];
              // Treat as no_change if every JE line already targets this department
              const jeLines = existingLines.filter((l: any) => l.DetailType === 'JournalEntryLineDetail');
              const allAlreadySet = jeLines.length > 0 && jeLines.every((l: any) =>
                l.JournalEntryLineDetail?.DepartmentRef?.value === department_id
              );
              if (allAlreadySet) {
                results.push({ txn_id: txnId, status: 'no_change', previous_department_id: department_id, new_department_id: department_id, lines_changed: 0 });
                continue;
              }
              let linesChanged = 0;
              const updatedLines = existingLines.map((l: any) => {
                if (l.DetailType !== 'JournalEntryLineDetail') return l;
                const prev = l.JournalEntryLineDetail?.DepartmentRef?.value;
                if (prev === department_id) return l;
                linesChanged++;
                return {
                  ...l,
                  JournalEntryLineDetail: {
                    ...l.JournalEntryLineDetail,
                    DepartmentRef: { value: department_id },
                  },
                };
              });
              if (dry_run) {
                results.push({ txn_id: txnId, status: 'would_update', new_department_id: department_id, lines_changed: linesChanged });
                continue;
              }
              await postUpdate({ ...entity, Line: updatedLines });
              results.push({ txn_id: txnId, status: 'updated', new_department_id: department_id, lines_changed: linesChanged });
            } else {
              const previous = entity.DepartmentRef?.value;
              if (previous === department_id) {
                results.push({ txn_id: txnId, status: 'no_change', previous_department_id: previous, new_department_id: department_id });
                continue;
              }
              if (dry_run) {
                results.push({ txn_id: txnId, status: 'would_update', previous_department_id: previous, new_department_id: department_id });
                continue;
              }
              const payload = { ...entity, DepartmentRef: { value: department_id } };
              await postUpdate(payload);
              results.push({ txn_id: txnId, status: 'updated', previous_department_id: previous, new_department_id: department_id });
            }
          } catch (err: any) {
            results.push({ txn_id: txnId, status: 'failed', new_department_id: department_id, error: err?.message ?? String(err) });
            if (stop_on_error) break;
          }
        }

        const updated = results.filter(r => r.status === 'updated').length;
        const wouldUpdate = results.filter(r => r.status === 'would_update').length;
        const noChange = results.filter(r => r.status === 'no_change').length;
        const failed = results.filter(r => r.status === 'failed').length;
        const processed = results.length;
        const total = transaction_ids.length;

        const header = dry_run
          ? `DRY RUN — bulk_set_department (${entity_type} → DepartmentRef.value=${department_id})`
          : `bulk_set_department (${entity_type} → DepartmentRef.value=${department_id})`;

        const summary = [
          header,
          `Processed: ${processed}/${total} | Would update: ${wouldUpdate} | Updated: ${updated} | No change: ${noChange} | Failed: ${failed}`,
          '─'.repeat(70),
          ...results.map(r => {
            const prev = r.previous_department_id ?? '(none)';
            const linesPart = r.lines_changed !== undefined ? ` lines_changed=${r.lines_changed}` : '';
            const base = `  ${r.txn_id.padEnd(20)} ${r.status.padEnd(12)} ${prev} → ${r.new_department_id}${linesPart}`;
            return r.error ? `${base}  ERROR: ${r.error}` : base;
          }),
        ].join('\n');

        return { content: [{ type: 'text', text: summary + '\n\n' + JSON.stringify(results, null, 2) }] };
      }
    );

    // ── get_payment_methods ───────────────────────────────────────────────────
    server.tool(
      'get_payment_methods',
      'Get the list of payment methods (Cash, Check, Visa, etc.) for a QBO client.',
      { client_name: z.string().describe('The name of the client company') },
      async ({ client_name }) => {
        const realmId = await findRealmId(qboManager, client_name);
        if (!realmId) return { content: [{ type: 'text', text: `Client not found: "${client_name}". Use list_clients to see available companies.` }] };
        try {
          const result = await qboManager.lists.getPaymentMethods(realmId);
          const methods: any[] = (result as any)?.QueryResponse?.PaymentMethod ?? [];
          if (methods.length === 0) return { content: [{ type: 'text', text: `No payment methods found for ${client_name}.` }] };
          const lines = [
            `PAYMENT METHODS — ${client_name}`,
            '─'.repeat(50),
            ...methods.map((m: any) => `  ${(m.Id ?? '').padEnd(10)} ${m.Name ?? ''}${m.Active === false ? ' (inactive)' : ''}`),
          ];
          return { content: [{ type: 'text', text: lines.join('\n') }] };
        } catch (err: any) {
          return { content: [{ type: 'text', text: `Error fetching payment methods: ${err?.message ?? err}` }] };
        }
      }
    );

    // ═══════════════════════════════════════════════════════════════════════════
    // ATTACHMENTS (Attachable)
    // ═══════════════════════════════════════════════════════════════════════════

    // Load file bytes from exactly one of the three supported sources.
    async function loadAttachmentBytes(src: {
      file_path?: string;
      file_url?: string;
      file_base64?: string;
      file_name?: string;
    }): Promise<{ fileName: string; bytes: Uint8Array }> {
      const sources = [src.file_path, src.file_url, src.file_base64].filter((s) => s !== undefined);
      if (sources.length !== 1) {
        throw new Error('Provide exactly one of file_path, file_url, or file_base64.');
      }

      let fileName: string;
      let bytes: Uint8Array;
      if (src.file_path !== undefined) {
        if (!attachmentsDir) {
          throw new Error(
            'file_path is not available on this deployment (no attachments staging directory configured). Use file_url, or the REST endpoint POST /api/company/:realmId/attachments to upload bytes directly.'
          );
        }
        const resolved = resolveAttachmentPath(src.file_path, attachmentsDir);
        try {
          bytes = await readFile(resolved);
        } catch (err: any) {
          if (err?.code === 'ENOENT') {
            // Self-documenting boundary error: the caller almost certainly
            // passed a path from THEIR machine.
            throw new Error(
              `File not found on the server: ${resolved}\n\n` +
                `file_path resolves against the SERVER's filesystem — this MCP server runs remotely and cannot see files on your machine.\n` +
                `  - Server staging directory: ${attachmentsDir}\n` +
                `  - Call list_staging_files to see what is currently staged there.\n` +
                `  - For files on YOUR machine: call create_upload_session, then upload the bytes with the curl command it returns.\n` +
                `  - Alternatively pass file_url (an https URL the server can fetch) or file_base64 (small files only).\n` +
                `  - Call get_server_info for the full picture of the file boundary and limits.`
            );
          }
          throw err;
        }
        fileName = src.file_name ?? basename(resolved);
      } else if (src.file_url !== undefined) {
        const url = assertSafeUrl(src.file_url);
        const res = await fetch(url);
        if (!res.ok) throw new Error(`Failed to fetch file_url (HTTP ${res.status})`);
        bytes = new Uint8Array(await res.arrayBuffer());
        fileName = src.file_name ?? (basename(url.pathname) || 'attachment');
      } else {
        if (!src.file_name) throw new Error('file_name is required when using file_base64.');
        bytes = Uint8Array.from(Buffer.from(src.file_base64!, 'base64'));
        fileName = src.file_name;
      }

      if (bytes.length === 0) throw new Error(`File is empty: ${fileName}`);
      if (bytes.length > MAX_ATTACHMENT_BYTES) {
        throw new Error(`File exceeds QBO's 20 MB attachment limit: ${fileName} (${bytes.length} bytes)`);
      }
      return { fileName, bytes };
    }

    function buildEntityRef(entity_type?: string, entity_id?: string): { type: string; id: string } | undefined {
      // Both-or-neither: one without the other would silently create an
      // orphaned attachment (same bug class as vendor_name-without-vendor_id).
      if ((entity_type === undefined) !== (entity_id === undefined)) {
        throw new Error('entity_type and entity_id must be provided together (or both omitted for a standalone attachment). Nothing was uploaded.');
      }
      return entity_type !== undefined ? { type: entity_type, id: entity_id! } : undefined;
    }

    function describeUploadResult(r: { ok: boolean; attachable?: any; error?: string }, entityRef?: { type: string; id: string }): string {
      if (!r.ok) return `FAILED: ${r.error}`;
      const a = r.attachable;
      const link = a.AttachableRef?.[0]?.EntityRef
        ? `${a.AttachableRef[0].EntityRef.type ?? entityRef?.type} ${a.AttachableRef[0].EntityRef.value}`
        : entityRef
          ? `${entityRef.type} ${entityRef.id}`
          : 'none (standalone)';
      return `Attachable ID: ${a.Id} | File: ${a.FileName} | Size: ${a.Size ?? 'n/a'} bytes | Linked to: ${link}`;
    }

    // ── create_attachment ─────────────────────────────────────────────────────
    server.tool(
      'create_attachment',
      'Upload a file as a QBO attachment (Attachable), optionally linked to a transaction or entity (e.g. attach a scanned check image to a Purchase). IMPORTANT — the file boundary: this server runs remotely and CANNOT read files on your machine. For files local to you, call create_upload_session first and push the bytes with the curl command it returns; call get_server_info to see the full boundary, limits, and workflow. Provide the file via exactly one of file_path / file_url / file_base64.',
      {
        client_name: z.string().describe('The name of the client company'),
        file_path: z.string().optional().describe("Path on the SERVER's filesystem, inside its attachments staging directory — NOT a path on your machine (the server cannot read your files; use create_upload_session for those). Call list_staging_files to see what is staged."),
        file_url: z.string().optional().describe('https URL the SERVER fetches the file from (must be publicly reachable)'),
        file_base64: z.string().optional().describe('Base64-encoded file bytes inline (small files only — ~50 KB max is sensible; requires file_name). For bulk or larger files use create_upload_session + curl instead.'),
        file_name: z.string().optional().describe('File name (defaults to the basename of file_path/file_url; required with file_base64)'),
        entity_type: z.string().optional().describe('QBO entity type to attach to: Purchase, Invoice, Bill, JournalEntry, Vendor, Customer, Estimate, CreditMemo, Payment, BillPayment, SalesReceipt, Deposit, Transfer, PurchaseOrder. Must be provided together with entity_id.'),
        entity_id: z.string().optional().describe('QBO Id of the entity to attach to. Must be provided together with entity_type.'),
        note: z.string().optional().describe('Attachable.Note'),
        include_on_send: z.boolean().optional().describe('Include this attachment when the linked transaction is emailed (default false)'),
        content_type: z.string().optional().describe('Override the MIME type (otherwise inferred from the file extension)'),
      },
      async ({ client_name, file_path, file_url, file_base64, file_name, entity_type, entity_id, note, include_on_send, content_type }) => {
        const realmId = await findRealmId(qboManager, client_name);
        if (!realmId) {
          return { content: [{ type: 'text', text: `Client not found: "${client_name}". Use list_clients to see available companies.` }] };
        }
        try {
          const entityRef = buildEntityRef(entity_type, entity_id);
          const { fileName, bytes } = await loadAttachmentBytes({ file_path, file_url, file_base64, file_name });
          const contentType = content_type ?? contentTypeForFile(fileName);
          if (!contentType) {
            return { content: [{ type: 'text', text: `Cannot infer content type from "${fileName}". Supported extensions: ${supportedExtensions()} — or pass content_type explicitly.` }] };
          }
          const [result] = await qboManager.attachments.upload(realmId, [
            { fileName, contentType, bytes, note, includeOnSend: include_on_send, entityRef },
          ]);
          const text = result.ok
            ? `Attachment uploaded.\n${describeUploadResult(result, entityRef)}`
            : `Attachment upload failed: ${result.error}`;
          return { content: [{ type: 'text', text }] };
        } catch (err: any) {
          return { content: [{ type: 'text', text: `Error creating attachment: ${err?.message ?? err}` }] };
        }
      }
    );

    // ── create_attachments_batch ──────────────────────────────────────────────
    server.tool(
      'create_attachments_batch',
      `Upload multiple files as QBO attachments in batched requests (up to ${MAX_FILES_PER_UPLOAD} files per QBO round trip). Returns PER-ITEM results — failed items do not abort the batch, so callers can retry only the failures. IMPORTANT — the file boundary: this server runs remotely and CANNOT read files on your machine; file_path refers to the SERVER's staging directory (see list_staging_files / get_server_info). For bulk uploads of files local to YOU, call create_upload_session and loop the curl command it returns instead.`,
      {
        client_name: z.string().describe('The name of the client company'),
        items: z.array(z.object({
          file_path: z.string().optional().describe("Path on the SERVER's filesystem inside its staging directory — NOT on your machine"),
          file_url: z.string().optional().describe('https URL the SERVER fetches the file from'),
          file_name: z.string().optional().describe('File name override'),
          entity_type: z.string().optional().describe('QBO entity type to attach to (with entity_id)'),
          entity_id: z.string().optional().describe('QBO Id to attach to (with entity_type)'),
          note: z.string().optional(),
        })).min(1).max(100).describe('Files to upload (max 100 per call)'),
        include_on_send: z.boolean().optional().describe('Applied to every item (default false)'),
      },
      async ({ client_name, items, include_on_send }) => {
        const realmId = await findRealmId(qboManager, client_name);
        if (!realmId) {
          return { content: [{ type: 'text', text: `Client not found: "${client_name}". Use list_clients to see available companies.` }] };
        }

        type ItemOutcome = { label: string; status: 'uploaded' | 'failed'; attachableId?: string; error?: string };
        const outcomes: ItemOutcome[] = [];
        // Load and validate every item individually; a bad item fails alone.
        const loaded: Array<{ item: AttachmentUploadItem; label: string } | null> = [];
        for (const item of items) {
          const label = item.file_path ?? item.file_url ?? item.file_name ?? 'item';
          try {
            const entityRef = buildEntityRef(item.entity_type, item.entity_id);
            const { fileName, bytes } = await loadAttachmentBytes(item);
            const contentType = contentTypeForFile(fileName);
            if (!contentType) throw new Error(`Cannot infer content type from "${fileName}" (supported: ${supportedExtensions()})`);
            loaded.push({ label, item: { fileName, contentType, bytes, note: item.note, includeOnSend: include_on_send, entityRef } });
          } catch (err: any) {
            outcomes.push({ label, status: 'failed', error: err?.message ?? String(err) });
            loaded.push(null);
          }
        }

        // Upload in chunks; a failed chunk marks only its own items failed.
        const ready = loaded.filter((l): l is NonNullable<typeof l> => l !== null);
        for (let i = 0; i < ready.length; i += MAX_FILES_PER_UPLOAD) {
          const chunk = ready.slice(i, i + MAX_FILES_PER_UPLOAD);
          try {
            const results = await qboManager.attachments.upload(realmId, chunk.map((c) => c.item));
            results.forEach((r, j) => {
              outcomes.push(r.ok
                ? { label: chunk[j].label, status: 'uploaded', attachableId: r.attachable.Id }
                : { label: chunk[j].label, status: 'failed', error: r.error });
            });
          } catch (err: any) {
            for (const c of chunk) outcomes.push({ label: c.label, status: 'failed', error: err?.message ?? String(err) });
          }
        }

        const ok = outcomes.filter((o) => o.status === 'uploaded').length;
        const failed = outcomes.length - ok;
        const lines = [
          `ATTACHMENT BATCH — ${client_name}: ${ok} uploaded, ${failed} failed (of ${outcomes.length})`,
          '─'.repeat(80),
          ...outcomes.map((o) => o.status === 'uploaded'
            ? `  OK      ${o.label} → Attachable ${o.attachableId}`
            : `  FAILED  ${o.label} — ${o.error}`),
        ];
        if (failed > 0) lines.push('', 'Retry only the FAILED items — uploaded items must not be resent (they would duplicate).');
        return { content: [{ type: 'text', text: lines.join('\n') }] };
      }
    );

    // ── delete_attachment ─────────────────────────────────────────────────────
    server.tool(
      'delete_attachment',
      'Delete a QBO attachment (Attachable) by Id. Removes the file and its links to any transactions. Use query_transactions (SELECT * FROM Attachable ...) to find attachment Ids.',
      {
        client_name: z.string().describe('The name of the client company'),
        attachable_id: z.string().describe('The Attachable Id to delete'),
      },
      async ({ client_name, attachable_id }) => {
        const realmId = await findRealmId(qboManager, client_name);
        if (!realmId) {
          return { content: [{ type: 'text', text: `Client not found: "${client_name}". Use list_clients to see available companies.` }] };
        }
        try {
          const attachable = await qboManager.attachments.get(realmId, attachable_id);
          if (!attachable) {
            return { content: [{ type: 'text', text: `Attachable ${attachable_id} not found.` }] };
          }
          await qboManager.attachments.remove(realmId, attachable);
          return { content: [{ type: 'text', text: `Attachment "${attachable.FileName ?? attachable_id}" (ID: ${attachable_id}) deleted.` }] };
        } catch (err: any) {
          return { content: [{ type: 'text', text: `Error deleting attachment: ${err?.message ?? err}` }] };
        }
      }
    );

    // ── create_upload_session ─────────────────────────────────────────────────
    server.tool(
      'create_upload_session',
      'Mint a short-lived upload credential for pushing LOCAL files to QBO as attachments. This server cannot read files on your machine — but you (or a shell you control) can push the bytes to its REST endpoint. Returns a one-hour, single-company upload token plus ready-to-run curl commands. Workflow for bulk jobs: call this once, then loop the curl command over your files from the machine where they live.',
      {
        client_name: z.string().describe('The name of the client company the uploads are for'),
      },
      async ({ client_name }) => {
        const realmId = await findRealmId(qboManager, client_name);
        if (!realmId) {
          return { content: [{ type: 'text', text: `Client not found: "${client_name}". Use list_clients to see available companies.` }] };
        }
        if (!baseUrl) {
          return { content: [{ type: 'text', text: 'Cannot determine this server\'s public URL. Set QBO_PUBLIC_URL on the deployment (e.g. https://qbo.yourfirm.com) and retry.' }] };
        }
        try {
          const { token, expiresAt } = await qboManager.uploadTokens.issue(realmId, scope.userName);
          const uploadUrl = `${baseUrl}/api/company/${encodeURIComponent(realmId)}/attachments`;
          const text = [
            `Upload session created for ${client_name} (realm ${realmId}).`,
            `Token (valid until ${expiresAt.toISOString()}, this company only, uploads only):`,
            `  ${token}`,
            '',
            'Single file — attach a local file to a transaction:',
            '```bash',
            `curl -sS -H "Authorization: Bearer ${token}" \\`,
            `  -F "file=@/path/to/check-10259.png" \\`,
            `  -F "entity_type=Purchase" -F "entity_id=756" \\`,
            `  "${uploadUrl}"`,
            '```',
            'Response per file: {"attachableId":"...","fileName":"...","size":...} on success, or {"error","message"} on failure — retry only failures.',
            '',
            'Bulk — given manifest.csv lines of "filepath,entity_type,entity_id", 8 uploads in parallel:',
            '```bash',
            `while IFS=, read -r f etype eid; do printf '%s\\0%s\\0%s\\0' "$f" "$etype" "$eid"; done < manifest.csv | \\`,
            `  xargs -0 -n 3 -P 8 sh -c 'curl -sS -H "Authorization: Bearer ${token}" -F "file=@$0" -F "entity_type=$1" -F "entity_id=$2" "${uploadUrl}"; echo " <- $0"'`,
            '```',
            '',
            'Optional form fields: note, include_on_send=true. Omit entity_type/entity_id together for a standalone (unlinked) attachment.',
            `Limits: max ${Math.floor(MAX_ATTACHMENT_BYTES / (1024 * 1024))} MB per file. Verify afterwards with query_transactions: SELECT * FROM Attachable.`,
          ].join('\n');
          return { content: [{ type: 'text', text }] };
        } catch (err: any) {
          return { content: [{ type: 'text', text: `Error creating upload session: ${err?.message ?? err}` }] };
        }
      }
    );

    // ── get_server_info ───────────────────────────────────────────────────────
    server.tool(
      'get_server_info',
      'Describe this MCP server\'s environment: where it runs, which filesystem file_path parameters resolve against, how to move local files across the boundary, attachment limits, and the REST upload endpoint. Call this BEFORE attempting file operations if you are unsure how paths work.',
      {
        client_name: z.string().optional().describe('Optional: a client company, to include a ready-to-use upload URL for its realm'),
      },
      async ({ client_name }) => {
        let realmId: string | null = null;
        if (client_name) realmId = await findRealmId(qboManager, client_name);
        const info = {
          server: {
            deployment: 'remote',
            note: 'This MCP server runs on its own host (typically Railway). It shares NO filesystem with you — file_path parameters refer to ITS disk, never yours.',
            public_base_url: baseUrl,
          },
          filesystem: {
            staging_dir: attachmentsDir ?? null,
            accepts_absolute_paths: false,
            shared_with_caller: false,
            how_to_stage:
              'You cannot write to the staging directory through MCP. To upload files from your machine, call create_upload_session and push the bytes with curl to the REST endpoint. list_staging_files shows what is already staged server-side (relevant mainly for self-hosted deployments).',
          },
          attachments: {
            max_file_bytes: MAX_ATTACHMENT_BYTES,
            supported_extensions: supportedExtensions(),
            batch_max_items: 100,
            batch_files_per_qbo_request: MAX_FILES_PER_UPLOAD,
            sources: {
              file_path: "server-side staging directory only (see 'filesystem')",
              file_url: 'https URLs the server can reach (public internet; internal hosts blocked)',
              file_base64: 'inline, small files only — impractical beyond ~50 KB',
              rest_endpoint: 'the right choice for files on your machine, any size or count',
            },
          },
          rest_endpoints: {
            upload_attachment: {
              method: 'POST',
              url: realmId
                ? `${baseUrl ?? '<base-url>'}/api/company/${realmId}/attachments`
                : `${baseUrl ?? '<base-url>'}/api/company/:realmId/attachments`,
              content_type: 'multipart/form-data',
              parts: 'file (binary) + optional fields entity_type, entity_id (both or neither), note, include_on_send',
              auth: 'Authorization: Bearer <token from create_upload_session> — or a write-capable API key if you have one',
              reachable_from_caller: true,
              per_file_response: '{"attachableId","fileName","size","contentType","entity"} or {"error","message"}',
            },
          },
          recommended_bulk_workflow: [
            '1. create_upload_session(client_name) → token + curl commands',
            '2. From the machine holding the files, loop/parallelize the curl upload (per-file JSON results; retry only failures)',
            "3. Verify with query_transactions: SELECT * FROM Attachable — check AttachableRef links",
          ],
        };
        return { content: [{ type: 'text', text: JSON.stringify(info, null, 2) }] };
      }
    );

    // ── list_staging_files ────────────────────────────────────────────────────
    server.tool(
      'list_staging_files',
      "List files currently in the SERVER's attachments staging directory (the place file_path parameters resolve against). Use it to confirm staged files exist before referencing them.",
      {
        prefix: z.string().optional().describe('Only list entries whose path starts with this prefix'),
      },
      async ({ prefix }) => {
        if (!attachmentsDir) {
          return { content: [{ type: 'text', text: 'No staging directory is configured on this deployment. Use create_upload_session to upload local files instead.' }] };
        }
        try {
          const entries: Array<{ name: string; size: number; modified: string }> = [];
          const MAX_ENTRIES = 500;
          async function walk(dir: string, rel: string): Promise<void> {
            let names: string[];
            try {
              names = await readdir(dir);
            } catch (err: any) {
              if (err?.code === 'ENOENT') return; // staging dir not created yet
              throw err;
            }
            for (const name of names.sort()) {
              if (entries.length >= MAX_ENTRIES) return;
              const relPath = rel ? `${rel}/${name}` : name;
              const s = await stat(`${dir}/${name}`);
              if (s.isDirectory()) await walk(`${dir}/${name}`, relPath);
              else if (!prefix || relPath.startsWith(prefix)) {
                entries.push({ name: relPath, size: s.size, modified: s.mtime.toISOString() });
              }
            }
          }
          await walk(attachmentsDir, '');
          if (entries.length === 0) {
            return { content: [{ type: 'text', text: `Staging directory ${attachmentsDir} is empty${prefix ? ` (no entries matching "${prefix}")` : ''}. Files from your machine reach QBO via create_upload_session + curl — they do not need staging.` }] };
          }
          const lines = [
            `STAGED FILES — ${attachmentsDir}${prefix ? ` (prefix: ${prefix})` : ''}`,
            `Total: ${entries.length}${entries.length >= MAX_ENTRIES ? ' (truncated at 500)' : ''}`,
            '─'.repeat(80),
            ...entries.map((e) => `  ${e.name}  (${e.size} bytes, modified ${e.modified})`),
          ];
          return { content: [{ type: 'text', text: lines.join('\n') }] };
        } catch (err: any) {
          return { content: [{ type: 'text', text: `Error listing staging files: ${err?.message ?? err}` }] };
        }
      }
    );

    return server;
  }

  // ── Auth middleware helper ─────────────────────────────────────────────────
  // Accepts Bearer token in Authorization header OR ?key= query param (for
  // Claude.ai connectors). Resolves to a scope: the master key and admin
  // users see everything; member users see only their assigned companies.
  function checkAuth(authHeader: string | undefined, queryKey?: string): Promise<AuthScope | null> {
    return resolveAuth(qboRoot, masterApiKey, authHeader, queryKey);
  }

  /**
   * 401 with the RFC 9728 challenge. The resource_metadata pointer is what
   * makes per-user OAuth sign-in work: an MCP client that gets this response
   * discovers the authorization server, registers itself, and walks the user
   * through signing in — instead of needing an API key baked into the URL.
   */
  function unauthorized(request: FastifyRequest, reply: FastifyReply) {
    const base = publicBaseUrl(request);
    return reply
      .code(401)
      .header(
        'WWW-Authenticate',
        `Bearer realm="QBO Multi-Connect", resource_metadata="${base}/.well-known/oauth-protected-resource"`
      )
      .send({
        error: 'Unauthorized',
        message: 'Authentication required. Sign in through the connector, or present a valid API key.',
      });
  }

  // ── POST /mcp — client sends JSON-RPC requests ────────────────────────────
  // Stateless mode: each request gets a fresh server + transport that is torn
  // down when the response closes. There is no in-memory session map, so a
  // Railway restart (deploy/idle/crash) or a second instance can no longer
  // orphan an in-flight conversation with "Session not found" mid-batch.
  fastify.post('/mcp', async (request, reply) => {
    const queryKey = (request.query as Record<string, string>)?.key;
    const scope = await checkAuth(request.headers.authorization, queryKey);
    if (!scope) {
      return unauthorized(request, reply);
    }

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless — no session id issued or validated
    });
    // Public base URL of this deployment, for tools that hand out REST upload
    // instructions. Follows the hostname the request came in on, so a custom
    // domain shows up in those instructions with no config change.
    const { baseUrl } = resolvePublicUrl(request);

    const mcpServer = createMcpServer(scope, baseUrl);

    // Clean up the per-request server/transport once the response is done.
    reply.raw.on('close', () => {
      transport.close().catch(() => {});
      mcpServer.close().catch(() => {});
    });

    await mcpServer.connect(transport);
    // Hand off raw Node.js req/res to the transport
    await transport.handleRequest(request.raw, reply.raw, request.body);
  });

  // ── GET /mcp — not supported in stateless mode ────────────────────────────
  // Server→client SSE streaming requires a persistent session, which stateless
  // mode does not provide. Tool calls use POST and are unaffected.
  fastify.get('/mcp', async (request, reply) => {
    const queryKey = (request.query as Record<string, string>)?.key;
    if (!(await checkAuth(request.headers.authorization, queryKey))) {
      return unauthorized(request, reply);
    }
    return reply.code(405).send({
      error: 'Method Not Allowed',
      message: 'This server runs in stateless mode; use POST /mcp for JSON-RPC requests.',
    });
  });

  // ── DELETE /mcp — nothing to tear down in stateless mode ──────────────────
  fastify.delete('/mcp', async (request, reply) => {
    const queryKey = (request.query as Record<string, string>)?.key;
    if (!(await checkAuth(request.headers.authorization, queryKey))) {
      return unauthorized(request, reply);
    }
    return reply.code(200).send({ success: true });
  });
}
