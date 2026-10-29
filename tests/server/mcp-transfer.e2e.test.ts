import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { QBOManager } from '../../src/index.js';
import { registerMcpRoutes } from '../../src/server/mcp.js';

// get/update/delete_transfer + convert_to_transfer over real MCP against
// mocked Intuit endpoints. Nothing here reaches a real QBO company.

const MASTER_KEY = 'master-key-for-tests';
const REALM = '9130000000000002';
const CLIENT = 'Mock Co';
const OWNER = '300'; // Owner's Pay & Personal Expenses

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
const fault = (msg: string) => json({ Fault: { Error: [{ Message: msg, Detail: msg, code: '6000' }], type: 'ValidationFault' } }, 400);

describe('transfer tools — end to end over MCP (mocked Intuit)', () => {
  let app: FastifyInstance; let qbo: QBOManager; let mcp: Client;
  let db: { purchases: Record<string, any>; deposits: Record<string, any>; transfers: Record<string, any> };
  let nextId = 900;
  const writes: string[] = [];
  const mode = { reconciledIds: [] as string[], reportFails: false, corruptTransfer: false, refuseDepositDelete: false, mangleUpdate: false };

  const call = async (name: string, args: Record<string, unknown>): Promise<string> => {
    const res: any = await mcp.callTool({ name, arguments: args });
    return (res.content ?? []).map((c: any) => c.text ?? '').join('\n');
  };
  const parse = (out: string) => JSON.parse(out.slice(out.indexOf('[')));

  async function fakeIntuit(input: any, init?: RequestInit): Promise<Response> {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const path = url.pathname.replace(/^.*\/company\/[^/]+\//, '');
    const method = (init?.method ?? 'GET').toUpperCase();
    const op = url.searchParams.get('operation');
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const get = (m: RegExpMatchArray | null, table: Record<string, any>, key: string) =>
      m && (table[m[1]] ? json({ [key]: table[m[1]] }) : fault('Object Not Found'));
    if (method === 'GET') {
      if (path === 'reports/TransactionList') {
        if (mode.reportFails) return fault('report unavailable');
        return json({ Rows: { Row: mode.reconciledIds.map((id) => ({ ColData: [{ value: '2026-10-01' }, { value: 'Expense', id }] })) } });
      }
      return get(path.match(/^purchase\/(\w+)$/), db.purchases, 'Purchase')
        ?? get(path.match(/^deposit\/(\w+)$/), db.deposits, 'Deposit')
        ?? get(path.match(/^transfer\/(\w+)$/), db.transfers, 'Transfer')
        ?? fault(`unmocked GET ${path}`);
    }
    writes.push(`${path}${op ? `?${op}` : ''}`);
    if (path === 'transfer' && op === 'delete') { delete db.transfers[body.Id]; return json({ Transfer: { Id: body.Id, status: 'Deleted' } }); }
    if (path === 'purchase' && op === 'delete') { delete db.purchases[body.Id]; return json({ Purchase: { Id: body.Id, status: 'Deleted' } }); }
    if (path === 'deposit' && op === 'delete') {
      if (mode.refuseDepositDelete) return fault('Deposit is locked');
      delete db.deposits[body.Id]; return json({ Deposit: { Id: body.Id, status: 'Deleted' } });
    }
    if (path === 'transfer' && !op) {
      if (body.Id) {
        const cur = db.transfers[body.Id];
        if (body.SyncToken !== cur.SyncToken) return fault('Stale Object Error');
        const next = { ...cur, ...body, SyncToken: String(Number(cur.SyncToken) + 1) };
        delete next.sparse;
        if (mode.mangleUpdate) { next.Amount = 1; mode.mangleUpdate = false; }
        db.transfers[body.Id] = next; return json({ Transfer: next });
      }
      const id = String(nextId++);
      const t = { ...body, Id: id, SyncToken: '0', ...(mode.corruptTransfer ? { Amount: body.Amount + 1 } : {}) };
      db.transfers[id] = t; return json({ Transfer: t });
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
    mcp = new Client({ name: 'txfr-e2e', version: '1.0.0' });
    await mcp.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${MASTER_KEY}` } },
    }));
  }, 60_000);

  afterAll(async () => { await mcp?.close().catch(() => {}); await app?.close(); qbo?.close(); vi.unstubAllGlobals(); });

  beforeEach(() => {
    writes.length = 0;
    Object.assign(mode, { reconciledIds: [], reportFails: false, corruptTransfer: false, refuseDepositDelete: false, mangleUpdate: false });
    db = {
      purchases: {
        '55': { Id: '55', SyncToken: '2', TxnDate: '2026-10-01', TotalAmt: 250, PaymentType: 'Cash', PrivateNote: 'owner draw',
          AccountRef: { value: '35', name: 'Checking' }, EntityRef: { value: '9', name: 'Owner' },
          Line: [{ Id: '1', Amount: 250, DetailType: 'AccountBasedExpenseLineDetail', AccountBasedExpenseLineDetail: { AccountRef: { value: OWNER } } }] },
        '56': { Id: '56', SyncToken: '0', TxnDate: '2026-10-01', TotalAmt: 80, PaymentType: 'Cash',
          AccountRef: { value: '35' }, Line: [{ Id: '1', Amount: 80, DetailType: 'AccountBasedExpenseLineDetail', AccountBasedExpenseLineDetail: { AccountRef: { value: '60' } } }] },
      },
      deposits: {
        '66': { Id: '66', SyncToken: '1', TxnDate: '2026-10-01', TotalAmt: 250, DepositToAccountRef: { value: '40', name: 'Owner Bank' },
          Line: [{ Id: '1', Amount: 250, DetailType: 'DepositLineDetail', DepositLineDetail: { AccountRef: { value: OWNER } } }] },
      },
      transfers: { '700': { Id: '700', SyncToken: '4', TxnDate: '2026-09-30', Amount: 100, FromAccountRef: { value: '35', name: 'Checking' }, ToAccountRef: { value: '40', name: 'Owner Bank' }, PrivateNote: 'x' } },
    };
  });

  it('registers with correct annotations; convert defaults to dry run', async () => {
    const byName = Object.fromEntries((await mcp.listTools()).tools.map((t) => [t.name, t]));
    expect(byName.get_transfer.annotations?.readOnlyHint).toBe(true);
    expect(byName.delete_transfer.annotations?.destructiveHint).toBe(true);
    expect(byName.convert_to_transfer.annotations?.destructiveHint).toBe(true);
    expect(byName.update_transfer.annotations?.readOnlyHint).toBe(false);
    expect(byName.convert_to_transfer.description).toMatch(/bank-feed matches/i);
  });

  it('get / update (sparse, verified) / delete transfer', async () => {
    expect(JSON.parse(await call('get_transfer', { client_name: CLIENT, transfer_id: '700' }))).toMatchObject({ id: '700', amount: 100, from_account_id: '35', to_account_id: '40' });
    const out = await call('update_transfer', { client_name: CLIENT, transfer_id: '700', amount: 125.5 });
    expect(out).toMatch(/updated \(verified\)/);
    expect(db.transfers['700']).toMatchObject({ Amount: 125.5, SyncToken: '5', TxnDate: '2026-09-30' });
    expect(await call('update_transfer', { client_name: CLIENT, transfer_id: '700', to_account_id: '35' })).toMatch(/both 35/);
    expect(await call('delete_transfer', { client_name: CLIENT, transfer_id: '700' })).toMatch(/Deleted transfer 700/);
    expect(db.transfers['700']).toBeUndefined();
  });

  it('update_transfer rolls back when QBO saves something else', async () => {
    mode.mangleUpdate = true;
    const out = await call('update_transfer', { client_name: CLIENT, transfer_id: '700', amount: 300 });
    expect(out).toMatch(/did not verify.*original values restored/);
    expect(db.transfers['700'].Amount).toBe(100);
  });

  it('dry run (default) validates a pair and writes nothing', async () => {
    const out = await call('convert_to_transfer', { client_name: CLIENT, items: [{ expense_id: '55', deposit_id: '66' }], expected_line_account_id: OWNER });
    expect(out).toMatch(/DRY RUN/);
    const [r] = parse(out);
    expect(r.status).toBe('ready');
    expect(r.plan).toMatchObject({ amount: 250, txn_date: '2026-10-01', from_account: { id: '35' }, to_account: { id: '40' } });
    expect(writes).toEqual([]);
  });

  it('live pair: creates, verifies, deletes both originals', async () => {
    const [r] = parse(await call('convert_to_transfer', { client_name: CLIENT, items: [{ expense_id: '55', deposit_id: '66' }], dry_run: false }));
    expect(r.status).toBe('converted');
    expect(db.transfers[r.transfer_id]).toMatchObject({ Amount: 250, FromAccountRef: { value: '35' }, ToAccountRef: { value: '40' }, PrivateNote: 'owner draw [converted from Expense 55 + Deposit 66]' });
    expect(db.purchases['55']).toBeUndefined();
    expect(db.deposits['66']).toBeUndefined();
  });

  it('single expense + counter account', async () => {
    const [r] = parse(await call('convert_to_transfer', { client_name: CLIENT, items: [{ expense_id: '55', counter_account_id: '41' }], dry_run: false }));
    expect(r.status).toBe('converted');
    expect(db.transfers[r.transfer_id]).toMatchObject({ FromAccountRef: { value: '35' }, ToAccountRef: { value: '41' } });
  });

  it('refuses mismatches, wrong coding, reconciled, unknown reconcile — and continues', async () => {
    db.deposits['66'].TotalAmt = 249.99;
    let rs = parse(await call('convert_to_transfer', { client_name: CLIENT, items: [
      { expense_id: '55', deposit_id: '66' },
      { expense_id: '56', counter_account_id: '41' },
      { deposit_id: '66' },
    ], expected_line_account_id: OWNER, dry_run: false }));
    expect(rs.map((r: any) => r.status)).toEqual(['failed', 'failed', 'failed']);
    expect(rs[0].error).toMatch(/Amounts differ/);
    expect(rs[1].error).toMatch(/not coded to account 300/);
    expect(rs[2].error).toMatch(/counter_account_id is required/);
    mode.reconciledIds = ['55'];
    rs = parse(await call('convert_to_transfer', { client_name: CLIENT, items: [{ expense_id: '55', counter_account_id: '41' }], dry_run: false }));
    expect(rs[0].error).toMatch(/reconciled — refused/);
    mode.reconciledIds = []; mode.reportFails = true;
    rs = parse(await call('convert_to_transfer', { client_name: CLIENT, items: [{ expense_id: '55', counter_account_id: '41' }], dry_run: false }));
    expect(rs[0].error).toMatch(/unknown — refused/);
    expect(writes).toEqual([]);
  });

  it('verification failure deletes the new transfer and leaves originals', async () => {
    mode.corruptTransfer = true;
    const [r] = parse(await call('convert_to_transfer', { client_name: CLIENT, items: [{ expense_id: '55', counter_account_id: '41' }], dry_run: false }));
    expect(r.status).toBe('failed');
    expect(r.error).toMatch(/did not verify.*deleted again.*Originals untouched/);
    expect(Object.keys(db.transfers)).toEqual(['700']);
    expect(db.purchases['55']).toBeDefined();
  });

  it('second-original delete failure is flagged needs_attention', async () => {
    mode.refuseDepositDelete = true;
    const [r] = parse(await call('convert_to_transfer', { client_name: CLIENT, items: [{ expense_id: '55', deposit_id: '66' }], dry_run: false }));
    expect(r.status).toBe('needs_attention');
    expect(r.error).toMatch(/Deposit 66 now double-counts/);
  });
});
