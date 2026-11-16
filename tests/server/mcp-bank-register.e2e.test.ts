import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { QBOManager } from '../../src/index.js';
import { registerMcpRoutes } from '../../src/server/mcp.js';
import { BANK_REGISTER_COLUMNS } from '../../src/server/bank-register.js';

const ENCRYPTION_KEY = 'a'.repeat(64);
const MASTER_KEY = 'master-key-for-bank-register-tests';
const CLIENT = 'United Way of the CSRA';
const REALM = '9341454121860748';

const CHART = [
  { Id: '55', Name: 'Huntington Checking', AcctNum: '1150040001', AccountType: 'Bank', FullyQualifiedName: 'Huntington Checking' },
  { Id: '12', Name: 'FNB Checking', AcctNum: '104', AccountType: 'Bank', FullyQualifiedName: 'FNB Checking' },
  { Id: '104', Name: 'Office Supplies', AcctNum: '6500', AccountType: 'Expense', FullyQualifiedName: 'Office Supplies' },
];

function col(title: string, key: string) {
  return { ColTitle: title, MetaData: [{ Name: 'ColKey', Value: key }] };
}

function registerReport(accountId: string, accountLabel: string, rows: Array<{ date: string; type: string; name: string; clr: string; amount: string; balance: string }>) {
  return {
    Header: { ReportName: 'GeneralLedger', StartPeriod: '2026-10-01', EndPeriod: '2026-10-31' },
    Columns: {
      Column: [
        col('Date', 'tx_date'),
        col('Transaction Type', 'txn_type'),
        col('Num', 'doc_num'),
        col('Name', 'name'),
        col('Memo/Description', 'memo'),
        col('Split', 'split_acc'),
        col('Clr', 'is_cleared'),
        col('Amount', 'subt_nat_amount'),
        col('Balance', 'rbal_nat_amount'),
      ],
    },
    Rows: {
      Row: [{
        type: 'Section',
        Header: { ColData: [{ value: accountLabel, id: accountId }] },
        Rows: {
          Row: rows.map((r) => ({
            type: 'Data',
            ColData: [
              { value: r.date }, { value: r.type }, { value: '' }, { value: r.name },
              { value: '' }, { value: 'Split' }, { value: r.clr }, { value: r.amount }, { value: r.balance },
            ],
          })),
        },
      }],
    },
  };
}

const HUNTINGTON = registerReport('55', '1150040001 Huntington Checking', [
  { date: '2026-10-02', type: 'Deposit', name: 'Huntington lockbox', clr: 'R', amount: '1000.00', balance: '1000.00' },
  { date: '2026-10-15', type: 'Check', name: 'Outstanding check', clr: '', amount: '-50.00', balance: '950.00' },
]);

const FNB = registerReport('12', '104 FNB Checking', [
  { date: '2026-10-05', type: 'Deposit', name: 'FNB grant', clr: '', amount: '5000.00', balance: '5000.00' },
]);

describe('MCP get_bank_register / get_uncleared_transactions (2026-11-16)', () => {
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

    getSpy = vi.fn().mockImplementation((_realm: string, path: string, query: Record<string, string> = {}) => {
      if (path === 'reports/GeneralLedger') {
        if (query.account === '55') return Promise.resolve(HUNTINGTON);
        if (query.account === '12') return Promise.resolve(FNB);
        return Promise.resolve({ Header: { ReportName: 'GeneralLedger' }, Columns: { Column: [] }, Rows: { Row: [] } });
      }
      return Promise.resolve({});
    });
    querySpy = vi.fn().mockImplementation((_realm: string, sql: string) => {
      if (/FROM Account/i.test(sql)) return Promise.resolve({ QueryResponse: { Account: CHART } });
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

  it('get_bank_register: account number 1150040001 and 104 hit different GeneralLedger account filters', async () => {
    const hunt = await callTool('get_bank_register', {
      client_name: CLIENT,
      account_id: '1150040001',
      start_date: '2026-10-01',
      end_date: '2026-10-31',
    });
    const fnb = await callTool('get_bank_register', {
      client_name: CLIENT,
      account_id: '104',
      start_date: '2026-10-01',
      end_date: '2026-10-31',
    });

    expect(hunt.isError).toBe(false);
    expect(fnb.isError).toBe(false);
    expect(hunt.texts[0]).toMatch(/Huntington lockbox/);
    expect(hunt.texts[0]).toMatch(/R\s+.+\$1,000\.00\s+\$1,000\.00/);
    expect(hunt.texts[0]).not.toMatch(/FNB grant/);
    expect(fnb.texts[0]).toMatch(/FNB grant/);
    expect(fnb.texts[0]).toMatch(/\$5,000\.00\s+\$5,000\.00/);
    expect(fnb.texts[0]).not.toMatch(/Huntington lockbox/);

    const glCalls = getSpy.mock.calls.filter((c) => c[1] === 'reports/GeneralLedger');
    expect(glCalls).toHaveLength(2);
    expect(glCalls[0][2]).toEqual({
      start_date: '2026-10-01',
      end_date: '2026-10-31',
      accounting_method: 'Accrual',
      account: '55',
      columns: BANK_REGISTER_COLUMNS,
    });
    expect(glCalls[1][2]).toEqual({
      start_date: '2026-10-01',
      end_date: '2026-10-31',
      accounting_method: 'Accrual',
      account: '12',
      columns: BANK_REGISTER_COLUMNS,
    });
    // Never called the TransactionList report (the pre-fix path that ignored account).
    expect(getSpy.mock.calls.every((c) => c[1] !== 'reports/TransactionList')).toBe(true);
  });

  it('get_uncleared_transactions: filters to blank Clr on the resolved account', async () => {
    const { texts, isError } = await callTool('get_uncleared_transactions', {
      client_name: CLIENT,
      account_id: '1150040001',
      start_date: '2026-10-01',
      end_date: '2026-10-31',
    });
    expect(isError).toBe(false);
    expect(texts[0]).toMatch(/UNCLEARED TRANSACTIONS/);
    expect(texts[0]).toMatch(/Outstanding check/);
    expect(texts[0]).toMatch(/Transactions: 1/);
    expect(texts[0]).not.toMatch(/Huntington lockbox/);
    const glCalls = getSpy.mock.calls.filter((c) => c[1] === 'reports/GeneralLedger');
    expect(glCalls[0][2].account).toBe('55');
    expect(glCalls[0][2].columns).toContain('is_cleared');
  });

  it('get_bank_register: unmatched account errors and does not request an unfiltered GL', async () => {
    const { texts } = await callTool('get_bank_register', {
      client_name: CLIENT,
      account_id: 'no-such-account',
      start_date: '2026-10-01',
      end_date: '2026-10-31',
    });
    expect(texts[0]).toMatch(/No account matched "no-such-account"/);
    expect(getSpy.mock.calls.filter((c) => String(c[1]).startsWith('reports/'))).toHaveLength(0);
  });

  it('match_transaction description says it creates new Payment/BillPayment/Deposit', async () => {
    const tools = await listTools();
    const match = tools.find((t) => t.name === 'match_transaction');
    expect(match?.description).toMatch(/Creates a new Payment, BillPayment, or Deposit/);
    expect(match?.description).toMatch(/NOT a bank-feed/);
  });
});
