import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { QBOManager } from '../../src/index.js';
import { registerMcpRoutes } from '../../src/server/mcp.js';
import { QBOError } from '../../src/api/client.js';

const ENCRYPTION_KEY = 'a'.repeat(64);
const MASTER_KEY = 'master-key-for-run-report-tests';
const CLIENT = 'United Way of the CSRA';
const REALM = '9341454121860748';

const PNL_DETAIL = {
  Header: { ReportName: 'ProfitAndLossDetail', StartPeriod: '2026-10-01', EndPeriod: '2026-10-31', Currency: 'USD' },
  Columns: { Column: [{ ColTitle: 'Date', ColType: 'Date' }, { ColTitle: 'Amount', ColType: 'Money' }] },
  Rows: { Row: [{ type: 'Data', ColData: [{ value: '2026-10-15' }, { value: '74.36' }] }] },
};

describe('MCP run_report (mocked QBO only)', () => {
  let qbo: QBOManager;
  let app: FastifyInstance;
  let baseUrl: string;
  let getSpy: ReturnType<typeof vi.fn>;

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

    getSpy = vi.fn().mockImplementation((_realm: string, path: string) => {
      if (path === 'reports/ProfitAndLossDetail') return Promise.resolve(PNL_DETAIL);
      if (path === 'reports/JournalReport') return Promise.resolve({ Header: { ReportName: 'JournalReport' }, Rows: { Row: [] } });
      return Promise.reject(new QBOError(`unexpected get ${path}`, 400));
    });
    (qbo as any).client.get = getSpy;

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

  it('returns the current Reports API JSON for ProfitAndLossDetail', async () => {
    const { texts, isError } = await callTool('run_report', {
      client_name: CLIENT,
      report_name: 'ProfitAndLossDetail',
      start_date: '2026-10-01',
      end_date: '2026-10-31',
    });
    expect(isError).toBe(false);
    const body = JSON.parse(texts[texts.length - 1]);
    expect(body.Header.ReportName).toBe('ProfitAndLossDetail');
    expect(body.Rows.Row[0].ColData[1].value).toBe('74.36');
    expect(getSpy).toHaveBeenCalledWith(REALM, 'reports/ProfitAndLossDetail', {
      start_date: '2026-10-01',
      end_date: '2026-10-31',
      accounting_method: 'Accrual',
    });
  });

  it('rejects an unknown report_name before calling QBO', async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${MASTER_KEY}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'run_report', arguments: { client_name: CLIENT, report_name: 'NotAReport' } },
      }),
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toMatch(/report_name|Invalid|enum|Allowed/i);
    expect(getSpy).not.toHaveBeenCalled();
  });
});
