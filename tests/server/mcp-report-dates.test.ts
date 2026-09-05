import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { QBOManager } from '../../src/index.js';
import { registerMcpRoutes } from '../../src/server/mcp.js';

// ─────────────────────────────────────────────────────────────────────────────
// Regression (2026-09-05, Erick Erickson, LLC): get_balance_sheet returned the
// "last month" report for every as_of_date, and get_trial_balance(as_of_date)
// returned identical totals for 2024-08-31 and 2025-12-31 because the schema
// silently dropped the unknown argument. These tests drive the real MCP tool
// handlers over a real listener, with the Intuit HTTP layer replaced by a fake
// that echoes the query it received into the report Header — so the assertion
// "Header.EndPeriod equals the requested date" only holds if the date actually
// reached the request.
// ─────────────────────────────────────────────────────────────────────────────

const ENCRYPTION_KEY = 'a'.repeat(64);
const MASTER_KEY = 'master-key-for-report-tests';
const CLIENT = 'Erick Erickson, LLC';
const REALM = '9130347978104336';

const BUDGET_ROWS = [
  { Name: 'Budget_FY25_P&L', StartDate: '2025-01-01', EndDate: '2025-12-31', BudgetType: 'ProfitAndLoss', BudgetEntryType: 'Monthly', Active: true, Id: '1000000011' },
  { Name: 'Budget_FY26_P&L', StartDate: '2026-01-01', EndDate: '2026-12-31', BudgetType: 'ProfitAndLoss', BudgetEntryType: 'Monthly', Active: true, Id: '1000000021' },
];

const NPE_FAULT = {
  Fault: {
    Error: [{ Message: 'An application error has occurred while processing your request', Detail: 'System Failure Error: java.lang.NullPointerException', code: '10000', element: 'SystemFailureError' }],
    type: 'SystemFault',
  },
  time: '2026-09-05T14:59:25.954-07:00',
};

/** Fake Intuit: a report whose Header echoes the period params it was asked for. */
function echoReport(path: string, query: Record<string, string>): any {
  const header: Record<string, string> = { ReportName: path.replace('reports/', ''), Time: '2026-09-05T00:00:00-07:00' };
  if (query.start_date) header.StartPeriod = query.start_date;
  if (query.end_date) header.EndPeriod = query.end_date;
  if (!query.start_date && !query.end_date) {
    // What QBO really does with no usable date: falls back to a macro.
    header.DateMacro = 'last month';
    header.StartPeriod = '2026-08-01';
    header.EndPeriod = '2026-08-31';
  }
  if (query.summarize_column_by) header.SummarizeColumnsBy = query.summarize_column_by;
  return {
    Header: header,
    Columns: { Column: [{ ColTitle: '', ColType: 'Account' }, { ColTitle: 'Debit', ColType: 'Money' }, { ColTitle: 'Credit', ColType: 'Money' }] },
    Rows: {
      Row: [
        { ColData: [{ value: 'Synovus Checking', id: '35' }, { value: '100.00' }, { value: '' }] },
        { ColData: [{ value: 'Opening Balance Equity', id: '44' }, { value: '' }, { value: '100.00' }] },
        { group: 'GrandTotal', ColData: [{ value: 'TOTAL' }, { value: '100.00' }, { value: '100.00' }] },
      ],
    },
  };
}

describe('MCP report tools — requested dates reach Intuit (2026-09-05)', () => {
  let app: FastifyInstance;
  let qbo: QBOManager;
  let baseUrl: string;
  let getSpy: ReturnType<typeof vi.fn>;
  let querySpy: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    qbo = new QBOManager({ dbPath: ':memory:', encryptionKey: ENCRYPTION_KEY });
    const future = new Date(Date.now() + 60 * 60 * 1000);
    const farFuture = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000);
    await (qbo as any).tokenStore.storeConnection({
      clientName: CLIENT,
      realmId: REALM,
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      tokenExpiry: future,
      refreshExpiry: farFuture,
      scopes: ['com.intuit.quickbooks.accounting'],
    });
    // Replace the Intuit HTTP layer. ReportsAPI / TransactionsAPI hold the
    // same client instance, so patching it here covers every tool.
    getSpy = vi.fn().mockImplementation((_realm: string, path: string, query: Record<string, string> = {}) =>
      Promise.resolve(echoReport(path, query))
    );
    querySpy = vi.fn().mockImplementation((_realm: string, sql: string) =>
      Promise.resolve(/FROM Budget/i.test(sql) ? { QueryResponse: { Budget: BUDGET_ROWS } } : { QueryResponse: {} })
    );
    (qbo as any).client.get = getSpy;
    (qbo as any).client.query = querySpy;

    app = Fastify();
    await registerMcpRoutes(app, qbo, MASTER_KEY);
    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address();
    baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  });

  afterEach(async () => {
    await app.close();
    qbo.close();
  });

  /** Call one tool over stateless streamable-HTTP and return its content blocks. */
  async function callTool(name: string, args: Record<string, unknown>): Promise<{ texts: string[]; isError: boolean }> {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${MASTER_KEY}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    const chunks = text.trimStart().startsWith('{')
      ? [text]
      : text.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim());
    for (const chunk of chunks) {
      const parsed = JSON.parse(chunk);
      if (parsed?.error) throw new Error(`MCP error: ${parsed.error.message}`);
      if (parsed?.result) {
        return {
          texts: (parsed.result.content ?? []).map((c: any) => String(c.text ?? '')),
          isError: Boolean(parsed.result.isError),
        };
      }
    }
    throw new Error(`No tools/call result in response: ${text.slice(0, 200)}`);
  }

  const lastJson = (texts: string[]) => JSON.parse(texts[texts.length - 1]);

  async function listTools(): Promise<any[]> {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { authorization: `Bearer ${MASTER_KEY}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    const text = await res.text();
    const chunks = text.trimStart().startsWith('{')
      ? [text]
      : text.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim());
    for (const chunk of chunks) {
      const parsed = JSON.parse(chunk);
      if (parsed?.result?.tools) return parsed.result.tools;
    }
    throw new Error('no tools/list result');
  }

  it('advertises strict argument schemas (additionalProperties=false) for every tool, with the new date params', async () => {
    const tools = await listTools();
    expect(tools.length).toBeGreaterThan(50);
    const lax = tools.filter((t) => t.inputSchema?.additionalProperties !== false).map((t) => t.name);
    expect(lax).toEqual([]);
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(Object.keys(byName.get_trial_balance.inputSchema.properties)).toEqual(
      expect.arrayContaining(['client_name', 'as_of_date', 'start_date', 'end_date', 'accounting_method'])
    );
    expect(Object.keys(byName.get_balance_sheet.inputSchema.properties)).toEqual(expect.arrayContaining(['as_of_date', 'start_date', 'summarize_by']));
    expect(Object.keys(byName.get_budget_vs_actuals.inputSchema.properties)).toEqual(expect.arrayContaining(['date_macro', 'budget_id']));
    expect(byName.get_budget_vs_actuals.inputSchema.required).toEqual(['client_name']);
    expect(Object.keys(byName.get_budget.inputSchema.properties)).toEqual(expect.arrayContaining(['list_only', 'fiscal_year', 'summary_only']));
    // Annotations still injected by the registration shim.
    expect(byName.get_trial_balance.annotations).toMatchObject({ readOnlyHint: true });
    expect(byName.create_journal_entry.annotations).toMatchObject({ readOnlyHint: false });
    expect(byName.list_clients.inputSchema.additionalProperties).toBe(false);
  });

  it('get_balance_sheet: Header.EndPeriod equals each requested as_of_date', async () => {
    for (const asOf of ['2024-08-31', '2025-12-31']) {
      const { texts, isError } = await callTool('get_balance_sheet', { client_name: CLIENT, as_of_date: asOf, summarize_by: 'Total' });
      expect(isError).toBe(false);
      expect(texts).toHaveLength(1); // no period warning — QBO agreed with the request
      const report = lastJson(texts);
      expect(report.Header.EndPeriod).toBe(asOf);
      expect(report.Header.DateMacro).toBeUndefined();
    }
    const sent = getSpy.mock.calls.map((c) => c[2]);
    expect(sent.map((q) => q.end_date)).toEqual(['2024-08-31', '2025-12-31']);
    expect(sent.every((q) => !('date' in q))).toBe(true);
  });

  it('get_balance_sheet: start_date + as_of_date + summarize_by=Month is one 13-month request', async () => {
    const { texts } = await callTool('get_balance_sheet', {
      client_name: CLIENT,
      as_of_date: '2026-08-31',
      start_date: '2025-08-01',
      summarize_by: 'Month',
    });
    expect(getSpy).toHaveBeenCalledWith(REALM, 'reports/BalanceSheet', {
      start_date: '2025-08-01',
      end_date: '2026-08-31',
      summarize_column_by: 'Month',
    });
    const report = lastJson(texts);
    expect(report.Header.StartPeriod).toBe('2025-08-01');
    expect(report.Header.EndPeriod).toBe('2026-08-31');
    expect(report.Header.SummarizeColumnsBy).toBe('Month');
  });

  it('get_balance_sheet: flags a period QBO did not honor instead of echoing the request', async () => {
    // Simulate the 2026-09-05 production symptom: QBO ignores the date and
    // answers with "last month".
    getSpy.mockImplementation((_r: string, path: string) => Promise.resolve(echoReport(path, {})));
    const { texts } = await callTool('get_balance_sheet', { client_name: CLIENT, as_of_date: '2024-08-31', summarize_by: 'Total' });
    expect(texts).toHaveLength(2);
    expect(texts[0]).toMatch(/end 2026-08-31 \(requested 2024-08-31\)/);
    const formatted = await callTool('get_balance_sheet', { client_name: CLIENT, as_of_date: '2024-08-31' });
    expect(formatted.texts[0]).toMatch(/As of: 2026-08-31/);
    expect(formatted.texts[0]).toMatch(/QBO applied a different period/);
  });

  it('get_trial_balance: as_of_date is sent as end_date and Header.EndPeriod equals it', async () => {
    const responses: any[] = [];
    getSpy.mockImplementation((_r: string, path: string, query: Record<string, string>) => {
      const report = echoReport(path, query);
      responses.push(report);
      return Promise.resolve(report);
    });
    for (const asOf of ['2024-08-31', '2025-12-31']) {
      const { texts, isError } = await callTool('get_trial_balance', { client_name: CLIENT, as_of_date: asOf });
      expect(isError).toBe(false);
      expect(texts[0]).toContain(`to ${asOf}`);
      expect(texts[0]).toContain('Synovus Checking'); // rows come through
      expect(texts[0]).toContain('✓ BALANCED');
      expect(texts[0]).not.toContain('different period');
    }
    expect(getSpy.mock.calls.map((c) => c[2])).toEqual([{ end_date: '2024-08-31' }, { end_date: '2025-12-31' }]);
    expect(responses.map((r) => r.Header.EndPeriod)).toEqual(['2024-08-31', '2025-12-31']);
  });

  it('get_trial_balance: start_date/end_date still work and disagreeing as_of/end dates are refused', async () => {
    await callTool('get_trial_balance', { client_name: CLIENT, start_date: '2024-08-01', end_date: '2024-08-31' });
    expect(getSpy).toHaveBeenLastCalledWith(REALM, 'reports/TrialBalance', { start_date: '2024-08-01', end_date: '2024-08-31' });
    const { texts } = await callTool('get_trial_balance', { client_name: CLIENT, as_of_date: '2024-08-31', end_date: '2025-12-31' });
    expect(texts[0]).toMatch(/disagree/);
    expect(getSpy).toHaveBeenCalledTimes(1);
  });

  it('rejects unknown arguments by name instead of silently dropping them', async () => {
    // The pre-fix failure mode: as_of_date on a tool that did not declare it
    // was stripped, and the report came back for the default period.
    const { texts, isError } = await callTool('get_profit_and_loss', {
      client_name: CLIENT,
      start_date: '2026-01-01',
      end_date: '2026-01-31',
      as_of_date: '2024-08-31',
    });
    expect(isError).toBe(true);
    expect(texts.join('\n')).toMatch(/as_of_date/);
    expect(getSpy).not.toHaveBeenCalled();
  });

  it('get_budget_vs_actuals: refuses a period outside the budget year before calling Intuit', async () => {
    const { texts } = await callTool('get_budget_vs_actuals', {
      client_name: CLIENT,
      start_date: '2025-01-01',
      end_date: '2025-12-31',
      budget_id: '1000000021',
      summarize_by: 'Month',
    });
    expect(texts[0]).toMatch(/outside budget 1000000021 "Budget_FY26_P&L"/);
    expect(texts[0]).toMatch(/1000000011 "Budget_FY25_P&L"/);
    expect(getSpy).not.toHaveBeenCalled();
  });

  it('get_budget_vs_actuals: turns Intuit\'s HTTP-200 Fault into an actionable error', async () => {
    getSpy.mockResolvedValue(NPE_FAULT);
    const { texts } = await callTool('get_budget_vs_actuals', {
      client_name: CLIENT,
      start_date: '2026-01-01',
      end_date: '2026-12-31',
      budget_id: '1000000021',
      summarize_by: 'Month',
    });
    expect(getSpy).toHaveBeenCalledWith(REALM, 'reports/BudgetVsActuals', {
      start_date: '2026-01-01',
      end_date: '2026-12-31',
      summarize_column_by: 'Month',
      budget_id: '1000000021',
    });
    expect(texts[0]).toMatch(/Intuit's report engine rejected/);
    expect(texts[0]).toMatch(/NullPointerException/);
    expect(texts[0]).toMatch(/Sent: budget_id=1000000021, start_date=2026-01-01, end_date=2026-12-31, summarize_column_by=Month/);
    expect(texts[0]).toMatch(/get_profit_and_loss\(summarize_by="Month"\)/);
    expect(texts[0]).not.toMatch(/"Fault"/); // never rendered as if it were report data
  });

  it('get_budget_vs_actuals: flags a response with no report period, passes a confirmed one through clean', async () => {
    // The live Total-mode symptom: no StartPeriod/EndPeriod, all-time actuals.
    getSpy.mockResolvedValueOnce({ Header: { ReportName: 'BudgetVsActuals', SummarizeColumnsBy: 'Total' }, Rows: { Row: [] } });
    const flagged = await callTool('get_budget_vs_actuals', { client_name: CLIENT, start_date: '2026-01-01', end_date: '2026-12-31', budget_id: '1000000021' });
    expect(flagged.texts).toHaveLength(2);
    expect(flagged.texts[0]).toMatch(/did not confirm the requested period \(2026-01-01 to 2026-12-31\)/);
    expect(lastJson(flagged.texts).Header.ReportName).toBe('BudgetVsActuals');

    const clean = await callTool('get_budget_vs_actuals', { client_name: CLIENT, start_date: '2026-01-01', end_date: '2026-12-31', budget_id: '1000000021' });
    expect(clean.texts).toHaveLength(1);
    expect(lastJson(clean.texts).Header.EndPeriod).toBe('2026-12-31');
  });

  it('get_budget_vs_actuals: date_macro replaces start/end dates', async () => {
    await callTool('get_budget_vs_actuals', { client_name: CLIENT, date_macro: 'This Fiscal Year-to-date', budget_id: '1000000021' });
    expect(getSpy).toHaveBeenCalledWith(REALM, 'reports/BudgetVsActuals', {
      date_macro: 'This Fiscal Year-to-date',
      budget_id: '1000000021',
    });
    const { texts } = await callTool('get_budget_vs_actuals', { client_name: CLIENT, budget_id: '1000000021' });
    expect(texts[0]).toMatch(/start_date \+ end_date or date_macro/);
  });

  it('get_budget: list_only and fiscal_year return the id list without entries', async () => {
    querySpy.mockImplementation(() =>
      Promise.resolve({
        QueryResponse: {
          Budget: BUDGET_ROWS.map((b) => ({
            ...b,
            BudgetDetail: Array.from({ length: 24 }, (_, i) => ({ BudgetDate: `${b.StartDate.slice(0, 4)}-${String((i % 12) + 1).padStart(2, '0')}-01`, Amount: '100', AccountRef: { value: String(i) } })),
          })),
        },
      })
    );
    const { texts } = await callTool('get_budget', { client_name: CLIENT, fiscal_year: 2026, list_only: true });
    const out = lastJson(texts);
    expect(out.detail_level).toBe('summary');
    expect(out.budgets).toEqual([
      expect.objectContaining({ budget_id: '1000000021', name: 'Budget_FY26_P&L', budget_type: 'ProfitAndLoss', budget_entry_type: 'Monthly', start_date: '2026-01-01', end_date: '2026-12-31', entry_count: 24 }),
    ]);
    expect(out.budgets[0]).not.toHaveProperty('entries');

    const none = await callTool('get_budget', { client_name: CLIENT, fiscal_year: 2019 });
    expect(none.texts[0]).toMatch(/fiscal year 2019/);
  });
});
