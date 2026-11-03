import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { QBOManager } from '../../src/index.js';
import { registerMcpRoutes } from '../../src/server/mcp.js';

// create_bill_payment with credits[] over real MCP against a mocked Intuit.
// Use case: Spa Medical — bill 11768 $4,512 + VendorCredit 11353 $4,512, vendor 3, 2026-10-07, $0 payment.

const MASTER_KEY = 'master-key-for-tests';
const REALM = '9130000000000002';
const CLIENT = 'Spa Medical Mock';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
const fault = (msg: string) => json({ Fault: { Error: [{ Message: msg, Detail: msg, code: '6000' }], type: 'ValidationFault' } }, 400);

type Mode = { recon: 'Uncleared' | 'Reconciled' | 'Cleared' | 'missing' | 'error'; skipCreditApply: boolean };

describe('create_bill_payment credits[] — e2e (mocked Intuit)', () => {
  let app: FastifyInstance; let qbo: QBOManager; let mcp: Client;
  let bill: any; let vc: any; let bps: Record<string, any>;
  const posts: { path: string; body: any }[] = [];
  const reports: string[] = [];
  const mode: Mode = { recon: 'Uncleared', skipCreditApply: false };

  const call = async (args: Record<string, unknown>) => {
    const res: any = await mcp.callTool({ name: 'create_bill_payment', arguments: { client_name: CLIENT, ...args } });
    return { text: (res.content ?? []).map((c: any) => c.text ?? '').join('\n'), isError: !!res.isError };
  };
  const spa = (extra: Record<string, unknown> = {}) => ({
    vendor_id: '3', total_amount: 0, txn_date: '2026-10-07', pay_type: 'Check', bank_account_id: '35',
    bill_ids: [{ bill_id: '11768', amount: 4512 }], credits: [{ txn_type: 'VendorCredit', txn_id: '11353', amount: 4512 }], ...extra,
  });

  async function fakeIntuit(input: any, init?: RequestInit): Promise<Response> {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const path = url.pathname.replace(/^.*\/company\/[^/]+\//, '');
    const method = (init?.method ?? 'GET').toUpperCase();
    if (method === 'GET' && path === 'bill/11768') return json({ Bill: bill });
    if (method === 'GET' && path === 'vendorcredit/11353') return json({ VendorCredit: vc });
    if (method === 'GET' && path === 'reports/TransactionList') {
      const cleared = url.searchParams.get('cleared')!;
      reports.push(`${cleared}|${url.searchParams.get('vendor')}|${url.searchParams.get('start_date')}`);
      if (mode.recon === 'error') return fault('report unavailable');
      const rows = mode.recon === cleared ? [
        { ColData: [{ value: '2026-10-07' }, { value: 'Bill', id: '11768' }] },
        { ColData: [{ value: '2026-10-07' }, { value: 'Vendor Credit', id: '11353' }] },
      ] : [];
      return json({ Header: {}, Columns: { Column: [] }, Rows: { Row: rows } });
    }
    if (method === 'POST' && path === 'billpayment' && !url.searchParams.get('operation')) {
      const body = JSON.parse(String(init?.body ?? '{}'));
      posts.push({ path, body });
      for (const l of body.Line) {
        const t = l.LinkedTxn[0];
        if (t.TxnType === 'Bill') bill = { ...bill, Balance: bill.Balance - l.Amount };
        if (t.TxnType === 'VendorCredit' && !mode.skipCreditApply) vc = { ...vc, Balance: vc.Balance - l.Amount };
      }
      const bp = { ...body, Id: '9001', SyncToken: '0' };
      bps['9001'] = bp;
      return json({ BillPayment: bp });
    }
    if (method === 'GET' && path.startsWith('billpayment/')) {
      const bp = bps[path.split('/')[1]];
      return bp ? json({ BillPayment: bp }) : fault('Object Not Found');
    }
    if (method === 'POST' && url.pathname.endsWith('/billpayment') && url.searchParams.get('operation') === 'delete') {
      const body = JSON.parse(String(init?.body ?? '{}'));
      posts.push({ path: 'billpayment?operation=delete', body });
      delete bps[body.Id];
      return json({ BillPayment: { Id: body.Id, status: 'Deleted' } });
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
    mcp = new Client({ name: 'bpc-e2e', version: '1.0.0' });
    await mcp.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${MASTER_KEY}` } },
    }));
  }, 60_000);

  afterAll(async () => { await mcp?.close().catch(() => {}); await app?.close(); qbo?.close(); vi.unstubAllGlobals(); });

  beforeEach(() => {
    bill = { Id: '11768', SyncToken: '1', TxnDate: '2026-09-15', VendorRef: { value: '3', name: 'Spa Medical' }, TotalAmt: 4512, Balance: 4512 };
    vc = { Id: '11353', SyncToken: '0', TxnDate: '2026-09-20', VendorRef: { value: '3', name: 'Spa Medical' }, TotalAmt: 4512, Balance: 4512 };
    bps = {}; posts.length = 0; reports.length = 0;
    Object.assign(mode, { recon: 'Uncleared', skipCreditApply: false });
  });

  it('exposes credits/dry_run/allow_reconciled in the schema', async () => {
    const t = (await mcp.listTools()).tools.find((x) => x.name === 'create_bill_payment')!;
    const props = (t.inputSchema as any).properties;
    expect(Object.keys(props)).toEqual(expect.arrayContaining(['credits', 'dry_run', 'allow_reconciled', 'bill_ids']));
    expect(props.credits.items.additionalProperties).toBe(false);
  });

  it('dry run returns the exact payload and checks, posts nothing', async () => {
    const r = await call(spa({ dry_run: true }));
    expect(r.isError).toBe(false);
    expect(r.text).toContain('DRY RUN — nothing was posted. All checks passed.');
    const rep = JSON.parse(r.text.slice(r.text.indexOf('{')));
    expect(rep.payload).toMatchObject({ VendorRef: { value: '3' }, TotalAmt: 0, TxnDate: '2026-10-07', PayType: 'Check', CheckPayment: { BankAccountRef: { value: '35' } } });
    expect(rep.payload.Line).toEqual([
      { Amount: 4512, LinkedTxn: [{ TxnId: '11768', TxnType: 'Bill' }] },
      { Amount: 4512, LinkedTxn: [{ TxnId: '11353', TxnType: 'VendorCredit' }] },
    ]);
    expect(rep.checks.map((c: any) => c.reconcile_status)).toEqual(['not_reconciled', 'not_reconciled']);
    expect(posts).toHaveLength(0);
    expect(reports).toContain('Uncleared|3|2026-09-15');
  });

  it('Spa Medical $0 payment posts, re-reads, and reports zero balances', async () => {
    const r = await call(spa());
    expect(r.isError).toBe(false);
    expect(r.text).toContain('Bill Payment 9001 recorded and verified');
    expect(posts).toHaveLength(1);
    expect(posts[0].body.TotalAmt).toBe(0);
    const out = JSON.parse(r.text.slice(r.text.indexOf('{')));
    expect(out.read_back).toEqual([
      { item: 'BillPayment 9001', total_amt: 0, balance: null },
      { item: 'Bill 11768', balance_before: 4512, applied: 4512, balance_after: 0, expected_balance: 0 },
      { item: 'VendorCredit 11353', balance_before: 4512, applied: 4512, balance_after: 0, expected_balance: 0 },
    ]);
  });

  it.each(['Reconciled', 'Cleared', 'missing', 'error'] as const)('refuses when reconcile status is %s', async (m) => {
    mode.recon = m;
    const r = await call(spa());
    expect(r.isError).toBe(true);
    expect(r.text).toContain('Refused — nothing was posted.');
    expect(r.text).toMatch(/reconcile status is (reconciled|cleared|unknown) — refused/);
    expect(posts).toHaveLength(0);
  });

  it('allow_reconciled overrides', async () => {
    mode.recon = 'Reconciled';
    const r = await call(spa({ allow_reconciled: true }));
    expect(r.text).toContain('recorded and verified');
    expect(r.text).toContain('allowed by allow_reconciled=true');
  });

  it('refuses vendor mismatch and insufficient balances, per item', async () => {
    vc.VendorRef = { value: '4', name: 'Other' };
    bill.Balance = 4000;
    const r = await call(spa());
    expect(r.isError).toBe(true);
    expect(r.text).toContain('Bill 11768: open balance 4000.00 is less than the 4512.00 to apply.');
    expect(r.text).toContain('VendorCredit 11353 belongs to vendor 4 (Other), not vendor 3.');
    expect(posts).toHaveLength(0);

    vc = { ...vc, VendorRef: { value: '3' }, Balance: 100 }; bill.Balance = 4512;
    const r2 = await call(spa());
    expect(r2.text).toContain('VendorCredit 11353: unapplied balance 100.00 is less than the 4512.00 to apply.');
  });

  it('rejects a wrong total before any QBO call', async () => {
    const r = await call(spa({ total_amount: 1 }));
    expect(r.isError).toBe(true);
    expect(r.text).toContain('must equal bills 4512.00 − credits 4512.00 = 0.00');
    expect(reports).toHaveLength(0);
  });

  it('read-back mismatch rolls back the BillPayment', async () => {
    mode.skipCreditApply = true;
    const r = await call(spa());
    expect(r.isError).toBe(true);
    expect(r.text).toContain('VERIFICATION FAILED');
    expect(r.text).toContain('VendorCredit 11353 balance 4512 ≠ expected 0.00');
    expect(r.text).toContain('ROLLED BACK');
    expect(posts.map((p) => p.path)).toEqual(['billpayment', 'billpayment?operation=delete']);
    expect(posts[1].body).toEqual({ Id: '9001', SyncToken: '0' });
  });

  it('without credits/dry_run the legacy path is unchanged (no reads)', async () => {
    const r = await call({ vendor_id: '3', total_amount: 10, pay_type: 'Check', bank_account_id: '35', bill_ids: [{ bill_id: '11768' }] });
    expect(r.text).toContain('recorded successfully');
    expect(reports).toHaveLength(0);
    expect(posts[0].body.Line).toEqual([{ Amount: 10, LinkedTxn: [{ TxnId: '11768', TxnType: 'Bill' }] }]);
  });
});
