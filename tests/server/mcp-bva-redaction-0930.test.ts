import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { QBOManager } from '../../src/index.js';
import { registerMcpRoutes } from '../../src/server/mcp.js';
import { redactUrl, redactUrlsInText, redactToolResult } from '../../src/server/redaction.js';

// ─────────────────────────────────────────────────────────────────────────────
// 2026-09-30 (Northway Church, realm 9130353483179106):
//  1. get_budget_vs_actuals(2026-07-01..2026-09-28, Cash) returned ALL-TIME
//     actuals, and FY25 / FY26 / FY27 requests all came back as FY27 — the
//     budget was sent as `budget_id`, which Intuit silently ignores.
//  2. get_attachments echoed TempDownloadUri, whose query string carries
//     intuit_apikey and user-auth-info.
// These drive the real MCP handlers over a real listener with the Intuit
// HTTP layer faked.
// ─────────────────────────────────────────────────────────────────────────────

const ENCRYPTION_KEY = 'a'.repeat(64);
const MASTER_KEY = 'master-key-for-bva-tests';
const CLIENT = 'Northway Church';
const REALM = '9130353483179106';

const META = [
  { Id: '1000000041', Name: 'ALL Budgets-2024-2025 (By Class)', StartDate: '2024-07-01', EndDate: '2025-06-30', BudgetType: 'ProfitAndLoss', BudgetEntryType: 'Monthly', Active: true },
  { Id: '1000000131', Name: 'FY26 Budget by Class', StartDate: '2025-07-01', EndDate: '2026-06-30', BudgetType: 'ProfitAndLoss', BudgetEntryType: 'Monthly', Active: true },
  { Id: '1000000141', Name: 'FY27 Budget by Class', StartDate: '2026-07-01', EndDate: '2027-06-30', BudgetType: 'ProfitAndLoss', BudgetEntryType: 'Monthly', Active: true },
];

/** 24 months of budget lines from 2024-07 to 2027-06 so any range has data in the "right" budget only. */
function fullBudget(id: string): any {
  const meta = META.find((b) => b.Id === id)!;
  const perMonth: Record<string, number> = { '1000000041': 100, '1000000131': 200, '1000000141': 300 };
  const [y, m] = meta.StartDate.split('-').map(Number);
  const BudgetDetail = Array.from({ length: 12 }, (_, i) => [
    { BudgetDate: new Date(Date.UTC(y, m - 1 + i, 1)).toISOString().slice(0, 10), Amount: perMonth[id], AccountRef: { value: '10' }, ClassRef: { value: '5' } },
    { BudgetDate: new Date(Date.UTC(y, m - 1 + i, 1)).toISOString().slice(0, 10), Amount: perMonth[id] / 2, AccountRef: { value: '10' }, ClassRef: { value: '6' } },
  ]).flat();
  return { ...meta, BudgetDetail };
}

const ACCOUNTS = [{ Id: '10', Name: 'Tithes', AcctNum: '4000', AccountType: 'Income', Classification: 'Revenue' }];
const CLASSES = [{ Id: '5', Name: 'Worship' }, { Id: '6', Name: 'Youth' }];

/** P&L whose amount depends on the dates it was asked for (so all-time vs range is visible). */
function pnlFor(query: Record<string, string>): any {
  const days = Math.round((Date.parse(query.end_date) - Date.parse(query.start_date)) / 86400000) + 1;
  const total = days * 10; // $10/day of tithes
  const byClass = query.summarize_column_by === 'Classes';
  const cols = byClass
    ? [{ ColTitle: '', ColType: 'Account' }, { ColTitle: 'Worship', ColType: 'Money' }, { ColTitle: 'Youth', ColType: 'Money' }, { ColTitle: 'Total', ColType: 'Money' }]
    : [{ ColTitle: '', ColType: 'Account' }, { ColTitle: 'Total', ColType: 'Money' }];
  const vals = (n: number) => (byClass ? [{ value: (n * 0.6).toFixed(2) }, { value: (n * 0.4).toFixed(2) }, { value: n.toFixed(2) }] : [{ value: n.toFixed(2) }]);
  return {
    Header: { ReportName: 'ProfitAndLoss', StartPeriod: query.start_date, EndPeriod: query.end_date, ReportBasis: query.accounting_method },
    Columns: { Column: cols },
    Rows: {
      Row: [
        { group: 'Income', Header: { ColData: [{ value: 'Income' }] }, Rows: { Row: [{ ColData: [{ value: '4000 Tithes', id: '10' }, ...vals(total)] }] }, Summary: { ColData: [{ value: 'Total Income' }, ...vals(total)] } },
        { group: 'NetIncome', Summary: { ColData: [{ value: 'Net Income' }, ...vals(total)] } },
      ],
    },
  };
}

const LIVE_URI =
  'https://financialdocument.platform.intuit.com/v2/no-user-cred/documents/24e17aa3/sources/1?realmId=9130353483179106&intuit_apikey=prdakyresSECRETAPIKEY123&Intuit-Company-ID=9130353483179106&user-auth-info=2gIAAAAbSECRETUSERAUTH%2Bxyz&qboTid=1-696f2004';
const ATTACHABLE = {
  Id: '5000000000001', SyncToken: '0', FileName: 'receipt.pdf', ContentType: 'application/pdf', Size: 11,
  FileAccessUri: '/v3/company/9130353483179106/download/5000000000001',
  TempDownloadUri: LIVE_URI,
  ThumbnailTempDownloadUri: LIVE_URI.replace('sources/1', 'thumb'),
  AttachableRef: [{ EntityRef: { type: 'Bill', value: '501' }, IncludeOnSend: false }],
};

describe('MCP get_budget_vs_actuals + attachment URL redaction (2026-09-30)', () => {
  let app: FastifyInstance;
  let qbo: QBOManager;
  let baseUrl: string;
  let getSpy: ReturnType<typeof vi.fn>;
  let querySpy: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    qbo = new QBOManager({ dbPath: ':memory:', encryptionKey: ENCRYPTION_KEY });
    await (qbo as any).tokenStore.storeConnection({
      clientName: CLIENT,
      realmId: REALM,
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      tokenExpiry: new Date(Date.now() + 3600_000),
      refreshExpiry: new Date(Date.now() + 90 * 86400_000),
      scopes: ['com.intuit.quickbooks.accounting'],
    });
    getSpy = vi.fn().mockImplementation((_r: string, path: string, query: Record<string, string> = {}) => {
      if (path === 'reports/ProfitAndLoss') return Promise.resolve(pnlFor(query));
      return Promise.reject(new Error(`unexpected GET ${path}`));
    });
    querySpy = vi.fn().mockImplementation((_r: string, sql: string) => {
      const byId = /FROM Budget WHERE Id = '([^']+)'/i.exec(sql);
      if (byId) return Promise.resolve({ QueryResponse: { Budget: [fullBudget(byId[1])] } });
      if (/FROM Budget/i.test(sql)) return Promise.resolve({ QueryResponse: { Budget: META } });
      if (/FROM Account/i.test(sql)) return Promise.resolve({ QueryResponse: { Account: ACCOUNTS } });
      if (/FROM Class/i.test(sql)) return Promise.resolve({ QueryResponse: { Class: CLASSES } });
      if (/FROM Attachable/i.test(sql)) return Promise.resolve({ QueryResponse: { Attachable: [ATTACHABLE] } });
      return Promise.resolve({ QueryResponse: {} });
    });
    (qbo as any).client.get = getSpy;
    (qbo as any).client.query = querySpy;

    app = Fastify();
    await registerMcpRoutes(app, qbo, MASTER_KEY);
    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address();
    baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await app.close();
    qbo.close();
  });

  async function rpc(method: string, params: any, key = MASTER_KEY): Promise<any> {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    const chunks = text.trimStart().startsWith('{') ? [text] : text.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim());
    for (const chunk of chunks) {
      const parsed = JSON.parse(chunk);
      if (parsed?.error) throw new Error(`MCP error: ${parsed.error.message}`);
      if (parsed?.result) return parsed.result;
    }
    throw new Error(`no result: ${text.slice(0, 200)}`);
  }

  async function callTool(name: string, args: Record<string, unknown>, key = MASTER_KEY): Promise<string[]> {
    const result = await rpc('tools/call', { name, arguments: args }, key);
    return (result.content ?? []).map((c: any) => String(c.text ?? ''));
  }

  const json = (texts: string[]) => JSON.parse(texts[texts.length - 1]);
  const REPRO = { client_name: CLIENT, start_date: '2026-07-01', end_date: '2026-09-28', accounting_method: 'Cash' };

  // ── Budget vs Actuals ──────────────────────────────────────────────────────

  it('actuals cover exactly start_date..end_date on the requested basis (not all-time)', async () => {
    const out = json(await callTool('get_budget_vs_actuals', { ...REPRO, budget_name: 'FY27 Budget by Class' }));
    expect(getSpy).toHaveBeenCalledWith(REALM, 'reports/ProfitAndLoss', { start_date: '2026-07-01', end_date: '2026-09-28', accounting_method: 'Cash' });
    expect(getSpy.mock.calls.some((c) => c[1] === 'reports/BudgetVsActuals')).toBe(false);
    expect(out.period).toEqual({ start: '2026-07-01', end: '2026-09-28' });
    expect(out.actuals_period_applied_by_qbo).toEqual({ start: '2026-07-01', end: '2026-09-28' });
    expect(out.accounting_method).toBe('Cash');
    // 90 days × $10 — the P&L figure for the range, not an all-time total.
    expect(out.net_income.actual).toBe(900);
    expect(out.sections[0].accounts[0].actual).toBe(900);
  });

  it('honours the requested budget: FY25 / FY26 / FY27 by name and by id give different budgets', async () => {
    const fy27 = json(await callTool('get_budget_vs_actuals', { ...REPRO, budget_name: 'FY27 Budget by Class' }));
    const fy26 = json(await callTool('get_budget_vs_actuals', { ...REPRO, budget_name: 'FY26 Budget by Class' }));
    const fy25 = json(await callTool('get_budget_vs_actuals', { ...REPRO, budget_name: 'ALL Budgets-2024-2025 (By Class)' }));
    const fy26ById = json(await callTool('get_budget_vs_actuals', { ...REPRO, budget_id: '1000000131' }));
    expect(fy27.budget).toMatchObject({ budget_id: '1000000141', name: 'FY27 Budget by Class', coverage_of_period: 'full' });
    expect(fy26.budget).toMatchObject({ budget_id: '1000000131', name: 'FY26 Budget by Class', coverage_of_period: 'none' });
    expect(fy25.budget).toMatchObject({ budget_id: '1000000041', name: 'ALL Budgets-2024-2025 (By Class)' });
    expect(fy26ById.budget.budget_id).toBe('1000000131');
    // FY27: Jul + Aug + 28/30 Sep of (300 + 150)/month
    expect(fy27.net_income.budget).toBeCloseTo(450 * (2 + 28 / 30), 2);
    // FY26 does not cover Jul–Sep 2026: budget 0, and the output says so.
    expect(fy26.net_income.budget).toBe(0);
    expect(fy26.warnings.join('\n')).toMatch(/does not cover any of 2026-07-01\.\.2026-09-28/);
    // The full Budget entity fetched was the one asked for.
    const fetched = querySpy.mock.calls.map((c) => c[1]).filter((q: string) => /FROM Budget WHERE Id/.test(q));
    expect(fetched).toEqual([
      "SELECT * FROM Budget WHERE Id = '1000000141'",
      "SELECT * FROM Budget WHERE Id = '1000000131'",
      "SELECT * FROM Budget WHERE Id = '1000000041'",
      "SELECT * FROM Budget WHERE Id = '1000000131'",
    ]);
  });

  it('a range inside FY26 gets FY26 budget amounts; Accrual is the default basis', async () => {
    const out = json(await callTool('get_budget_vs_actuals', { client_name: CLIENT, budget_name: 'FY26', start_date: '2025-07-01', end_date: '2025-09-30' }));
    expect(out.budget.budget_id).toBe('1000000131');
    expect(out.net_income.budget).toBe(900); // 3 × (200 + 100)
    expect(out.accounting_method).toBe('Accrual');
    expect(getSpy).toHaveBeenCalledWith(REALM, 'reports/ProfitAndLoss', { start_date: '2025-07-01', end_date: '2025-09-30', accounting_method: 'Accrual' });
  });

  it('split_by_class asks QBO for P&L by Classes and returns a per-class split', async () => {
    const out = json(await callTool('get_budget_vs_actuals', { ...REPRO, budget_id: '1000000141', split_by_class: true }));
    expect(getSpy).toHaveBeenCalledWith(REALM, 'reports/ProfitAndLoss', expect.objectContaining({ summarize_column_by: 'Classes', accounting_method: 'Cash' }));
    const by = out.sections[0].accounts[0].by_class;
    expect(by.map((c: any) => [c.class_id, c.class_name, c.actual])).toEqual([['5', 'Worship', 540], ['6', 'Youth', 360]]);
    expect(by[0].budget).toBeCloseTo(300 * (2 + 28 / 30), 2);
  });

  it('rejects ambiguous / unknown budgets and missing dates without calling the P&L', async () => {
    expect((await callTool('get_budget_vs_actuals', { ...REPRO, budget_name: 'Budget by Class' }))[0]).toMatch(/matches 2 budgets/);
    expect((await callTool('get_budget_vs_actuals', { ...REPRO, budget_name: 'FY99' }))[0]).toMatch(/No budget named "FY99"/);
    expect((await callTool('get_budget_vs_actuals', { ...REPRO }))[0]).toMatch(/Pass budget_id or budget_name/);
    expect((await callTool('get_budget_vs_actuals', { client_name: CLIENT, budget_id: '1000000141' }))[0]).toMatch(/start_date and end_date are both required/);
    expect((await callTool('get_budget_vs_actuals', { ...REPRO, budget_id: '1000000141', summarize_by: 'Month' }))[0]).toMatch(/only apply to source="qbo_report"/);
    expect(getSpy).not.toHaveBeenCalled();
  });

  it('source="qbo_report" resolves budget_name and sends it as Intuit\'s `budget` param', async () => {
    getSpy.mockResolvedValueOnce({ Header: { ReportName: 'BudgetVsActuals', StartPeriod: '2026-07-01', EndPeriod: '2026-09-28' }, Rows: { Row: [] } });
    await callTool('get_budget_vs_actuals', { ...REPRO, budget_name: 'FY27 Budget by Class', source: 'qbo_report' });
    expect(getSpy).toHaveBeenCalledWith(REALM, 'reports/BudgetVsActuals', {
      start_date: '2026-07-01', end_date: '2026-09-28', accounting_method: 'Cash', budget: '1000000141', rowaxis: 'primary',
    });
  });

  it('advertises the new schema', async () => {
    const { tools } = await rpc('tools/list', {});
    const t = tools.find((x: any) => x.name === 'get_budget_vs_actuals');
    expect(Object.keys(t.inputSchema.properties)).toEqual(expect.arrayContaining([
      'budget_id', 'budget_name', 'start_date', 'end_date', 'accounting_method', 'split_by_class', 'class_id', 'partial_periods', 'include_zero_rows', 'source', 'date_macro', 'summarize_by',
    ]));
    const a = tools.find((x: any) => x.name === 'get_attachments');
    expect(Object.keys(a.inputSchema.properties)).toEqual(expect.arrayContaining(['include_content', 'include_download_url']));
  });

  it('get_budget (full detail) returns class / department / customer refs per line, looking up only unnamed ids', async () => {
    const budget = {
      ...META[1],
      BudgetDetail: [
        { BudgetDate: '2025-07-01', Amount: 200, AccountRef: { value: '10', name: 'REVENUE:Tithes' }, ClassRef: { value: '5', name: 'Worship' } },
        { BudgetDate: '2025-07-01', Amount: 100, AccountRef: { value: '10' }, ClassRef: { value: '6' }, DepartmentRef: { value: '3', name: 'Main Campus' }, CustomerRef: { value: '77' } },
      ],
    };
    const base = querySpy.getMockImplementation()!;
    querySpy.mockImplementation((r: string, sql: string) => {
      if (/FROM Budget WHERE Id/i.test(sql)) return Promise.resolve({ QueryResponse: { Budget: [budget] } });
      if (/FROM Customer WHERE Id IN \('77'\)/i.test(sql)) return Promise.resolve({ QueryResponse: { Customer: [{ Id: '77', DisplayName: 'Smith Family' }] } });
      if (/FROM Class WHERE Id IN \('6'\)/i.test(sql)) return Promise.resolve({ QueryResponse: { Class: [{ Id: '6', Name: 'Youth', FullyQualifiedName: 'Youth' }] } });
      return base(r, sql);
    });
    const out = json(await callTool('get_budget', { client_name: CLIENT, budget_id: '1000000131' }));
    const entries = out.budgets[0].entries;
    expect(entries[0]).toMatchObject({ account_id: '10', account_number: '4000', account_name: '4000 Tithes', class: { id: '5', name: 'Worship' }, department: null, customer: null });
    expect(entries[1]).toMatchObject({ class: { id: '6', name: 'Youth' }, department: { id: '3', name: 'Main Campus' }, customer: { id: '77', name: 'Smith Family' } });
    const sqls = querySpy.mock.calls.map((c) => c[1] as string);
    expect(sqls.some((q) => /FROM Department/.test(q))).toBe(false); // every DepartmentRef already had a name
    expect(sqls).toContain('SELECT * FROM Account WHERE Active IN (true, false) MAXRESULTS 1000');
  });

  it('computed rows use one "NNNN Name" label from the Account entity, even for budget-only accounts', async () => {
    const accounts = [
      { Id: '10', Name: 'Tithes', FullyQualifiedName: 'REVENUE:Tithes', AcctNum: '4000', AccountType: 'Income' },
      { Id: '181', Name: 'Anniversary', FullyQualifiedName: 'PERSONNEL:Anniversary', AcctNum: '5047', AccountType: 'Expense' },
    ];
    const base = querySpy.getMockImplementation()!;
    querySpy.mockImplementation((r: string, sql: string) => {
      if (/FROM Account/i.test(sql)) return Promise.resolve({ QueryResponse: { Account: accounts } });
      if (/FROM Budget WHERE Id/i.test(sql)) {
        const b = fullBudget('1000000141');
        b.BudgetDetail.push({ BudgetDate: '2026-07-01', Amount: 50, AccountRef: { value: '181', name: 'PERSONNEL:Anniversary' } } as any);
        return Promise.resolve({ QueryResponse: { Budget: [b] } });
      }
      return base(r, sql);
    });
    const out = json(await callTool('get_budget_vs_actuals', { ...REPRO, budget_id: '1000000141' }));
    const labels = out.sections.flatMap((s: any) => s.accounts.map((a: any) => a.account_name));
    expect(labels).toEqual(['4000 Tithes', '5047 Anniversary']);
  });

  // ── Redaction ──────────────────────────────────────────────────────────────

  it('get_attachments never echoes intuit_apikey / user-auth-info by default', async () => {
    const texts = await callTool('get_attachments', { client_name: CLIENT, entity_type: 'Bill', entity_id: '501' });
    const all = texts.join('\n');
    expect(all).not.toMatch(/SECRETAPIKEY|SECRETUSERAUTH/);
    const item = json(texts).attachments[0];
    expect(item).not.toHaveProperty('temp_download_url');
    expect(item.download_url_available).toBe(true);
    expect(item.temp_download_url_redacted).toBe(
      'https://financialdocument.platform.intuit.com/v2/no-user-cred/documents/24e17aa3/sources/1?realmId=9130353483179106&intuit_apikey=REDACTED&Intuit-Company-ID=9130353483179106&user-auth-info=REDACTED&qboTid=1-696f2004'
    );
  });

  it('include_download_url=true returns the live URL only when asked', async () => {
    const item = json(await callTool('get_attachments', { client_name: CLIENT, attachable_id: '5000000000001', include_download_url: true })).attachments[0];
    expect(item.temp_download_url).toBe(LIVE_URI);
    expect(item).not.toHaveProperty('temp_download_url_redacted');
  });

  it('include_content still downloads with the real URL — for a realm-scoped key too', async () => {
    const fetchSpy = vi.fn().mockImplementation(() => Promise.resolve(new Response(Buffer.from('hello world'), { status: 200 })));
    const realFetch = globalThis.fetch;
    vi.stubGlobal('fetch', (input: any, init?: any) => (String(input).startsWith(baseUrl) ? realFetch(input, init) : fetchSpy(input, init)));
    const { apiKey } = await qbo.users.create({ name: 'Scoped', realmIds: [REALM] });
    for (const key of [MASTER_KEY, apiKey]) {
      fetchSpy.mockClear();
      const texts = await callTool('get_attachments', { client_name: CLIENT, attachable_id: '5000000000001', include_content: true }, key);
      if (!texts[0].startsWith('{')) throw new Error(texts[0]);
      const item = json(texts).attachments[0];
      expect(item.content_error).toBeUndefined();
      expect(Buffer.from(item.content_base64, 'base64').toString()).toBe('hello world');
      expect(String(fetchSpy.mock.calls[0][0])).toBe(new URL(LIVE_URI).toString());
      expect(texts.join('\n')).not.toMatch(/SECRETAPIKEY|SECRETUSERAUTH/);
    }
  });

  it('query_transactions on Attachable is redacted too (TempDownloadUri and thumbnail)', async () => {
    const texts = await callTool('query_transactions', { client_name: CLIENT, query: 'SELECT * FROM Attachable', raw: true });
    const all = texts.join('\n');
    expect(all).not.toMatch(/SECRETAPIKEY|SECRETUSERAUTH/);
    const a = json(texts).QueryResponse.Attachable[0];
    expect(a.TempDownloadUri).toMatch(/intuit_apikey=REDACTED&.*user-auth-info=REDACTED/);
    expect(a.ThumbnailTempDownloadUri).toMatch(/intuit_apikey=REDACTED/);
    expect(a.FileAccessUri).toBe('/v3/company/9130353483179106/download/5000000000001');
  });
});

describe('redaction helpers', () => {
  it('redactUrl replaces only credential params and keeps the rest', () => {
    expect(redactUrl('https://x.test/a?realmId=1&intuit_apikey=k&user-auth-info=u')).toBe('https://x.test/a?realmId=1&intuit_apikey=REDACTED&user-auth-info=REDACTED');
    expect(redactUrl('https://s3.amazonaws.com/f.png?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIA%2F1&X-Amz-Expires=900&X-Amz-Signature=abc'))
      .toBe('https://s3.amazonaws.com/f.png?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=REDACTED&X-Amz-Expires=900&X-Amz-Signature=REDACTED');
    expect(redactUrl('https://x.test/a?access_token=t&id=2#frag')).toBe('https://x.test/a?access_token=REDACTED&id=2#frag');
    expect(redactUrl('https://x.test/a?id=2')).toBe('https://x.test/a?id=2');
    expect(redactUrl('/v3/company/1/download/2')).toBe('/v3/company/1/download/2');
  });

  it('redactUrlsInText / redactToolResult handle JSON text and leave other blocks alone', () => {
    const text = JSON.stringify({ TempDownloadUri: ' https://x.test/d?intuit_apikey=SECRET&realmId=1' });
    expect(redactUrlsInText(text)).not.toMatch(/SECRET/);
    const r = redactToolResult({ content: [{ type: 'text', text }, { type: 'image', data: 'abc' }] });
    expect(r.content[0].text).toMatch(/intuit_apikey=REDACTED&realmId=1/);
    expect(r.content[1]).toEqual({ type: 'image', data: 'abc' });
  });
});
