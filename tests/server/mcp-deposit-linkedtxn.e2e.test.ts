import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { QBOManager } from '../../src/index.js';
import { registerMcpRoutes } from '../../src/server/mcp.js';
import {
  buildDepositTxnLines,
  buildDepositUpdatePayload,
  qboDepositLinesToUpdateShape,
} from '../../src/server/line-converters.js';

// QBO error 2020 "LinkedTxn.TxnLineId is missing" (FCCCG Deposit 85740,
// 2026-11-09): update_deposit / create_deposit / match_transaction sent
// Deposit LinkedTxn entries without TxnLineId. The mocked Intuit Deposit
// endpoint below rejects exactly that, the way QBO does.

const MASTER_KEY = 'master-key-for-tests';
const REALM = '9130000000000002';
const CLIENT = 'Mock Deposit Co';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
const fault = (msg: string, code = '6000') =>
  json({ Fault: { Error: [{ Message: msg, Detail: msg, code }], type: 'ValidationFault' } }, 400);

/** Deposit 85740 minus the $20 Payment 85780 that fell back into Undeposited Funds. */
function seed(): any {
  return {
    Id: '85740', SyncToken: '4', TxnDate: '2026-10-15', PrivateNote: 'Oct deposit',
    DepositToAccountRef: { value: '35', name: 'Operating' }, TotalAmt: 10852,
    Line: [
      { Id: '1', LineNum: 1, Amount: 5000, LinkedTxn: [{ TxnId: '85700', TxnType: 'Payment', TxnLineId: '0' }] },
      { Id: '2', LineNum: 2, Amount: 852, LinkedTxn: [{ TxnId: '85701', TxnType: 'SalesReceipt', TxnLineId: '0' }] },
      { Id: '3', LineNum: 3, Amount: 5000, DetailType: 'DepositLineDetail', Description: 'grant',
        DepositLineDetail: { AccountRef: { value: '4000', name: 'Grants' } } },
    ],
  };
}

/** QBO's rule: every LinkedTxn on a Deposit line carries TxnLineId. */
function missingTxnLineId(lines: any[]): boolean {
  return (lines ?? []).some((l: any) => (l.LinkedTxn ?? []).some((lt: any) => lt.TxnLineId == null || lt.TxnLineId === ''));
}

describe('Deposit LinkedTxn.TxnLineId (QBO error 2020) — end to end over MCP (mocked Intuit)', () => {
  let app: FastifyInstance;
  let qbo: QBOManager;
  let mcp: Client;
  let dep: any;
  const posts: { path: string; body: any }[] = [];

  const call = async (name: string, args: Record<string, unknown>): Promise<string> => {
    const res: any = await mcp.callTool({ name, arguments: args });
    return (res.content ?? []).map((c: any) => c.text ?? '').join('\n');
  };

  async function fakeIntuit(input: any, init?: RequestInit): Promise<Response> {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const path = url.pathname.replace(/^.*\/company\/[^/]+\//, '');
    const method = (init?.method ?? 'GET').toUpperCase();
    if (method === 'GET' && path === 'deposit/85740') return json({ Deposit: dep });
    if (method === 'POST' && path === 'deposit' && !url.searchParams.get('operation')) {
      const body = JSON.parse(String(init?.body ?? '{}'));
      posts.push({ path, body });
      if (missingTxnLineId(body.Line)) return fault('Required param missing, need to supply the required value for the API: LinkedTxn.TxnLineId is missing', '2020');
      if (!body.Id) {
        const lines = body.Line.map((l: any, i: number) => ({ ...l, Id: String(i + 1) }));
        const total = lines.reduce((s: number, l: any) => s + l.Amount, 0);
        return json({ Deposit: { ...body, Id: '99001', SyncToken: '0', Line: lines, TotalAmt: total } });
      }
      if (body.SyncToken !== dep.SyncToken) return fault('Stale Object Error');
      // Deposit semantics: Id → update in place, no Id → add, omitted → dropped (sparse:false).
      let next = 100;
      const lines = body.Line.map((l: any) => ({ ...l, Id: l.Id ?? String(next++) }));
      const total = Math.round(lines.reduce((s: number, l: any) => s + l.Amount, 0) * 100) / 100;
      dep = { ...body, Line: lines, TotalAmt: total, SyncToken: String(Number(dep.SyncToken) + 1) };
      delete dep.sparse;
      return json({ Deposit: dep });
    }
    return fault(`unmocked ${method} ${url.pathname}${url.search}`);
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
    mcp = new Client({ name: 'dep-e2e', version: '1.0.0' });
    await mcp.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${MASTER_KEY}` } },
    }));
  }, 60_000);

  afterAll(async () => {
    await mcp?.close().catch(() => {});
    await app?.close();
    qbo?.close();
    vi.unstubAllGlobals();
  });

  beforeEach(() => { dep = seed(); posts.length = 0; });

  it('the mock reproduces 2020 for the pre-fix payload shape', async () => {
    const r = await fakeIntuit('https://quickbooks.api.intuit.com/v3/company/1/deposit', {
      method: 'POST', body: JSON.stringify({ Line: [{ Amount: 20, LinkedTxn: [{ TxnId: '85780', TxnType: 'Payment' }] }] }),
    });
    expect(r.status).toBe(400);
    expect(await r.text()).toContain('LinkedTxn.TxnLineId is missing');
  });

  it('update_deposit add_linked_payment_ids re-links Payment 85780 ($20) → total 10,872, existing lines kept', async () => {
    const out = await call('update_deposit', {
      client_name: CLIENT, deposit_id: '85740',
      add_linked_payment_ids: [{ payment_id: '85780', amount: 20 }],
    });
    expect(out).toContain('Deposit 85740 updated');
    expect(out).toContain('10,872.00');
    expect(posts).toHaveLength(1);
    const lines = posts[0].body.Line;
    expect(posts[0].body.sparse).toBe(false);
    expect(missingTxnLineId(lines)).toBe(false);
    expect(lines).toHaveLength(4);
    // Existing linked lines re-posted exactly as read back, with their Ids.
    expect(lines[0]).toEqual({ Id: '1', Amount: 5000, LinkedTxn: [{ TxnId: '85700', TxnType: 'Payment', TxnLineId: '0' }] });
    expect(lines[1]).toEqual({ Id: '2', Amount: 852, LinkedTxn: [{ TxnId: '85701', TxnType: 'SalesReceipt', TxnLineId: '0' }] });
    // New linked Payment: Amount + LinkedTxn only, no Id (add), no DepositLineDetail.
    expect(lines[2]).toEqual({ Amount: 20, LinkedTxn: [{ TxnId: '85780', TxnType: 'Payment', TxnLineId: '0' }] });
    // Direct line kept with its Id and account.
    expect(lines[3]).toMatchObject({ Id: '3', Amount: 5000, DepositLineDetail: { AccountRef: { value: '4000' } } });
    expect(dep.TotalAmt).toBe(10872);
  });

  it('update_deposit dry_run returns the payload and new total without writing', async () => {
    const out = await call('update_deposit', {
      client_name: CLIENT, deposit_id: '85740', dry_run: true,
      add_linked_payment_ids: [{ payment_id: '85780', amount: 20 }],
    });
    expect(out).toContain('DRY RUN');
    const preview = JSON.parse(out.slice(out.indexOf('{')));
    expect(preview).toMatchObject({ current_total: 10852, new_total: 10872, line_count: 4 });
    expect(posts).toHaveLength(0);
  });

  it('update_deposit refuses to add a txn that is already linked', async () => {
    const out = await call('update_deposit', {
      client_name: CLIENT, deposit_id: '85740',
      add_linked_payment_ids: [{ payment_id: '85700', amount: 5000 }],
    });
    expect(out).toContain('already linked');
    expect(posts).toHaveLength(0);
  });

  it('update_deposit re-coding a direct line preserves existing linked lines with TxnLineId (no 2020)', async () => {
    const out = await call('update_deposit', {
      client_name: CLIENT, deposit_id: '85740',
      deposit_lines: [{ amount: 5000, account_id: '4010', description: 'grant' }],
    });
    expect(out).toContain('Deposit 85740 updated');
    const lines = posts[0].body.Line;
    expect(missingTxnLineId(lines)).toBe(false);
    expect(lines.slice(0, 2).map((l: any) => l.LinkedTxn[0])).toEqual([
      { TxnId: '85700', TxnType: 'Payment', TxnLineId: '0' },
      { TxnId: '85701', TxnType: 'SalesReceipt', TxnLineId: '0' },
    ]);
    expect(dep.TotalAmt).toBe(10852);
  });

  it('update_deposit fills TxnLineId "0" when QBO read-back omitted it on a preserved Payment line', async () => {
    delete dep.Line[0].LinkedTxn[0].TxnLineId;
    const out = await call('update_deposit', { client_name: CLIENT, deposit_id: '85740', add_linked_payment_ids: [{ payment_id: '85780', amount: 20 }] });
    expect(out).toContain('Deposit 85740 updated');
    expect(posts[0].body.Line[0].LinkedTxn).toEqual([{ TxnId: '85700', TxnType: 'Payment', TxnLineId: '0' }]);
  });

  it('update_deposit with full linked_payment_ids replacement also sends TxnLineId', async () => {
    const out = await call('update_deposit', {
      client_name: CLIENT, deposit_id: '85740',
      linked_payment_ids: [
        { payment_id: '85700', amount: 5000 },
        { payment_id: '85701', amount: 852, txn_type: 'SalesReceipt' },
        { payment_id: '85780', amount: 20 },
      ],
    });
    expect(out).toContain('10,872.00');
    expect(missingTxnLineId(posts[0].body.Line)).toBe(false);
    expect(posts[0].body.Line.slice(0, 3).map((l: any) => l.Id)).toEqual(['1', '2', undefined]);
  });

  it('create_deposit sends TxnLineId on linked payments', async () => {
    const out = await call('create_deposit', {
      client_name: CLIENT, deposit_account_id: '35',
      linked_payment_ids: [{ payment_id: '85780', amount: 20 }, { payment_id: '85790', amount: 15, txn_type: 'RefundReceipt' }],
    });
    expect(out).toContain('Deposit created');
    expect(posts[0].body.Line.map((l: any) => l.LinkedTxn[0])).toEqual([
      { TxnId: '85780', TxnType: 'Payment', TxnLineId: '0' },
      { TxnId: '85790', TxnType: 'RefundReceipt', TxnLineId: '0' },
    ]);
  });

  it('match_transaction deposit_payment sends TxnLineId', async () => {
    const out = await call('match_transaction', {
      client_name: CLIENT, match_type: 'deposit_payment', amount: 20, bank_account_id: '35', payment_id: '85780',
    });
    expect(out).toContain('Matched: Deposit');
    expect(posts[0].body.Line).toEqual([{ Amount: 20, LinkedTxn: [{ TxnId: '85780', TxnType: 'Payment', TxnLineId: '0' }] }]);
  });

  it('linked JournalEntry without txn_line_id is refused before anything is posted', async () => {
    const out = await call('create_deposit', {
      client_name: CLIENT, deposit_account_id: '35',
      linked_payment_ids: [{ payment_id: '500', amount: 10, txn_type: 'JournalEntry' }],
    });
    expect(out).toContain('needs txn_line_id');
    expect(posts).toHaveLength(0);
  });
});

describe('deposit LinkedTxn builders (unit)', () => {
  it('every built LinkedTxn carries TxnLineId; explicit txn_line_id wins', () => {
    const lines = buildDepositTxnLines([
      { payment_id: 'p1', amount: 1 },
      { payment_id: 'je1', amount: 2, txn_type: 'JournalEntry', txn_line_id: '3' },
    ]);
    expect(lines.map((l) => l.LinkedTxn[0])).toEqual([
      { TxnId: 'p1', TxnType: 'Payment', TxnLineId: '0' },
      { TxnId: 'je1', TxnType: 'JournalEntry', TxnLineId: '3' },
    ]);
  });

  it('round-trips non-Payment linked lines and their TxnLineId through get_deposit shape', () => {
    const shape = qboDepositLinesToUpdateShape(seed().Line);
    expect(shape.linked_payment_ids).toEqual([
      { payment_id: '85700', amount: 5000, txn_line_id: '0' },
      { payment_id: '85701', amount: 852, txn_type: 'SalesReceipt', txn_line_id: '0' },
    ]);
    const payload = buildDepositUpdatePayload(seed(), { add_linked_payment_ids: [{ payment_id: '85780', amount: 20 }] });
    const total = payload.Line.reduce((s: number, l: any) => s + l.Amount, 0);
    expect(total).toBe(10872);
  });
});
