import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { QBOManager } from '../../src/index.js';
import { registerMcpRoutes } from '../../src/server/mcp.js';

// bulk_create_expenses / bulk_create_deposits / get_transactions_by_reference
// over real MCP against a mocked Intuit query + create endpoint.

const MASTER_KEY = 'master-key-for-tests';
const REALM = '9130000000000003';
const CLIENT = 'Mock Co';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
const fault = (msg: string) => json({ Fault: { Error: [{ Message: msg, Detail: msg, code: '6000' }], type: 'ValidationFault' } }, 400);

describe('bulk create + reference search — end to end over MCP (mocked Intuit)', () => {
  let app: FastifyInstance; let qbo: QBOManager; let mcp: Client;
  let store: { Purchase: any[]; Deposit: any[] };
  let nextId = 1000;
  const queries: string[] = [];
  const creates: any[] = [];
  let failAmount: number | null = null;

  const call = async (name: string, args: Record<string, unknown>): Promise<string> => {
    const res: any = await mcp.callTool({ name, arguments: args });
    return (res.content ?? []).map((c: any) => c.text ?? '').join('\n');
  };
  const results = (out: string) => JSON.parse(out.slice(out.indexOf('[')));

  function runQuery(sql: string) {
    const m = sql.match(/FROM (\w+)(?: WHERE (.*?))? ORDERBY .* STARTPOSITION (\d+) MAXRESULTS (\d+)/);
    if (!m) {
      const v = sql.match(/DisplayName = '(.*)'/);
      if (v) return json({ QueryResponse: v[1] === 'Acme' ? { Vendor: [{ Id: '12', DisplayName: 'Acme' }] } : {} });
      return fault(`unparsed ${sql}`);
    }
    const [, entity, where = '', start, max] = m;
    let rows: any[] = (store as any)[entity] ?? [];
    for (const cond of where.split(' AND ').filter(Boolean)) {
      const c = cond.match(/(\w+) (=|>=|<=) '(.*)'/)!;
      rows = rows.filter((r) => (c[2] === '=' ? r[c[1]] === c[3] : c[2] === '>=' ? r[c[1]] >= c[3] : r[c[1]] <= c[3]));
    }
    const page = rows.slice(Number(start) - 1, Number(start) - 1 + Number(max));
    return json({ QueryResponse: page.length ? { [entity]: page } : {} });
  }

  async function fakeIntuit(input: any, init?: RequestInit): Promise<Response> {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const path = url.pathname.replace(/^.*\/company\/[^/]+\//, '');
    const method = (init?.method ?? 'GET').toUpperCase();
    if (method === 'GET' && path === 'query') { const q = url.searchParams.get('query')!; queries.push(q); return runQuery(q); }
    if (method === 'POST' && (path === 'purchase' || path === 'deposit')) {
      const body = JSON.parse(String(init?.body));
      creates.push(body);
      const total = body.Line.reduce((s: number, l: any) => s + l.Amount, 0);
      if (total === failAmount) return fault('Account is inactive');
      const entity = path === 'purchase' ? 'Purchase' : 'Deposit';
      const saved = { ...body, Id: String(nextId++), SyncToken: '0', TotalAmt: total };
      store[entity].push(saved);
      return json({ [entity]: saved });
    }
    return fault(`unmocked ${method} ${path}`);
  }

  beforeAll(async () => {
    const realFetch = globalThis.fetch;
    vi.stubGlobal('fetch', (input: any, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      return url.hostname.endsWith('intuit.com') ? fakeIntuit(input, init) : realFetch(input, init);
    });
    qbo = new QBOManager({ dbPath: ':memory:', encryptionKey: 'a'.repeat(64) });
    await (qbo as any).tokenStore.storeConnection({
      clientName: CLIENT, realmId: REALM, accessToken: 'at', refreshToken: 'rt',
      tokenExpiry: new Date(Date.now() + 3600_000), refreshExpiry: new Date(Date.now() + 90 * 86400_000),
      scopes: ['com.intuit.quickbooks.accounting'],
    });
    app = Fastify();
    await registerMcpRoutes(app, qbo, MASTER_KEY);
    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    mcp = new Client({ name: 'bulk-e2e', version: '1.0.0' });
    await mcp.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${MASTER_KEY}` } },
    }));
  }, 60_000);

  afterAll(async () => { await mcp?.close().catch(() => {}); await app?.close(); qbo?.close(); vi.unstubAllGlobals(); });

  beforeEach(() => {
    store = { Purchase: [{ Id: '5', TxnDate: '2026-10-02', TotalAmt: 9, PaymentType: 'Cash', PrivateNote: 'old [ik:ISS-1]', DocNumber: 'CHK100', AccountRef: { value: '35', name: 'Checking' } }], Deposit: [] };
    queries.length = 0; creates.length = 0; failAmount = null;
  });

  const exp = (k: string, extra: any = {}) => ({ idempotency_key: k, txn_date: '2026-10-02', account_id: '35', amount: 10, expense_account_id: '60', class_id: '7', vendor_name: 'Acme', ...extra });

  it('annotations: bulk tools write, reference search is read-only', async () => {
    const byName = Object.fromEntries((await mcp.listTools()).tools.map((t) => [t.name, t]));
    expect(byName.bulk_create_expenses.annotations?.readOnlyHint).toBe(false);
    expect(byName.bulk_create_deposits.annotations?.readOnlyHint).toBe(false);
    expect(byName.get_transactions_by_reference.annotations?.readOnlyHint).toBe(true);
  });

  it('creates, skips existing + in-batch duplicate keys, continues on error', async () => {
    failAmount = 13;
    const out = await call('bulk_create_expenses', { client_name: CLIENT, rows: [
      exp('ISS-1'), exp('ISS-2'), exp('ISS-2'), exp('ISS-3', { amount: 13 }), exp('ISS-4', { vendor_name: 'Nobody' }),
      exp('ISS-5', { amount: undefined, expense_account_id: undefined, lines: [{ amount: 4, expense_account_id: '61' }, { amount: 6, expense_account_id: '62', class_id: '8' }] }),
    ] });
    const r = results(out);
    expect(r.map((x: any) => x.status)).toEqual(['skipped', 'created', 'skipped', 'failed', 'failed', 'created']);
    expect(r[0].id).toBe('5');
    expect(r[3].error).toMatch(/inactive/);
    expect(r[4].error).toMatch(/No vendor found/);
    expect(creates[0]).toMatchObject({ PaymentType: 'Cash', AccountRef: { value: '35' }, EntityRef: { value: '12', type: 'Vendor' }, PrivateNote: '[ik:ISS-2]' });
    expect(creates[0].Line[0].AccountBasedExpenseLineDetail).toMatchObject({ AccountRef: { value: '60' }, ClassRef: { value: '7' } });
    expect(creates[2].Line.map((l: any) => l.AccountBasedExpenseLineDetail.ClassRef.value)).toEqual(['7', '8']);
    // one key lookup query for the single date, one vendor lookup per distinct name
    expect(queries.filter((q) => q.includes('FROM Purchase')).length).toBe(1);
    // rerun: everything that posted is now skipped
    const again = results(await call('bulk_create_expenses', { client_name: CLIENT, rows: [exp('ISS-2'), exp('ISS-5', { amount: undefined, expense_account_id: undefined, lines: [{ amount: 1, expense_account_id: '61' }] })] }));
    expect(again.map((x: any) => x.status)).toEqual(['skipped', 'skipped']);
  });

  it('dry run writes nothing', async () => {
    const r = results(await call('bulk_create_expenses', { client_name: CLIENT, rows: [exp('ISS-9')], dry_run: true }));
    expect(r[0].status).toBe('would_create');
    expect(creates).toEqual([]);
  });

  it('deposits: vendor as received-from on every line, class + payment method', async () => {
    const r = results(await call('bulk_create_deposits', { client_name: CLIENT, rows: [
      { idempotency_key: 'D-1', txn_date: '2026-10-03', deposit_account_id: '40', vendor_id: '12', amount: 50, account_id: '400', class_id: '7', payment_method_id: '2', doc_number: 'R1' },
      { idempotency_key: 'D-2', txn_date: '2026-10-03', deposit_account_id: '40', vendor_id: '12', customer_id: '3', amount: 5, account_id: '400' },
      { idempotency_key: 'D-3', txn_date: '2026-10-03', deposit_account_id: '40' },
    ] }));
    expect(r.map((x: any) => x.status)).toEqual(['created', 'failed', 'failed']);
    expect(creates[0]).toMatchObject({ DepositToAccountRef: { value: '40' }, DocNumber: 'R1', PrivateNote: '[ik:D-1]' });
    expect(creates[0].Line[0].DepositLineDetail).toMatchObject({ AccountRef: { value: '400' }, ClassRef: { value: '7' }, PaymentMethodRef: { value: '2' }, Entity: { value: '12', type: 'VENDOR' } });
  });

  it('get_transactions_by_reference: DocNumber server-side, memo/key client-side', async () => {
    let out = JSON.parse(await call('get_transactions_by_reference', { client_name: CLIENT, entity: 'Purchase', doc_number: 'CHK100' }));
    expect(out.results.map((x: any) => x.id)).toEqual(['5']);
    expect(queries.at(-1)).toContain("DocNumber = 'CHK100'");
    out = JSON.parse(await call('get_transactions_by_reference', { client_name: CLIENT, entity: 'Purchase', private_note_contains: 'OLD', start_date: '2026-10-01' }));
    expect(out.matched).toBe(1);
    out = JSON.parse(await call('get_transactions_by_reference', { client_name: CLIENT, entity: 'Purchase', idempotency_key: 'ISS-2' }));
    expect(out.matched).toBe(0);
    expect(await call('get_transactions_by_reference', { client_name: CLIENT, entity: 'Transfer', doc_number: 'x' })).toMatch(/no DocNumber/);
  });
});
