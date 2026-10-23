import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { QBOManager } from '../../src/index.js';
import { registerMcpRoutes } from '../../src/server/mcp.js';
import { buildVendorCreditUpdatePayload } from '../../src/server/update-payloads.js';

// update_vendor_credit / delete_vendor_credit / get_vendor_credit driven over
// real MCP against a mocked Intuit VendorCredit endpoint.

const MASTER_KEY = 'master-key-for-tests';
const REALM = '9130000000000001';
const CLIENT = 'Mock Co';

type Mode = { appendLines: boolean; refuseDelete: boolean; refuseVoid: boolean };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
const fault = (msg: string) => json({ Fault: { Error: [{ Message: msg, Detail: msg, code: '6000' }], type: 'ValidationFault' } }, 400);

function seed(): any {
  return {
    Id: '77', SyncToken: '3', DocNumber: 'VC-1', TxnDate: '2026-10-01', PrivateNote: 'orig',
    VendorRef: { value: '12', name: 'Acme Supply' }, TotalAmt: 150, Balance: 150,
    Line: [
      { Id: '1', Amount: 100, DetailType: 'AccountBasedExpenseLineDetail', Description: 'a', AccountBasedExpenseLineDetail: { AccountRef: { value: '60', name: 'Supplies' } } },
      { Id: '2', Amount: 50, DetailType: 'AccountBasedExpenseLineDetail', Description: 'b', AccountBasedExpenseLineDetail: { AccountRef: { value: '61', name: 'Rent' } } },
    ],
  };
}

describe('vendor credit tools — end to end over MCP (mocked Intuit)', () => {
  let app: FastifyInstance;
  let qbo: QBOManager;
  let mcp: Client;
  let vc: any;
  let deleted = false;
  let voided = false;
  const posts: { path: string; body: any }[] = [];
  const mode: Mode = { appendLines: false, refuseDelete: false, refuseVoid: false };

  const call = async (name: string, args: Record<string, unknown>): Promise<string> => {
    const res: any = await mcp.callTool({ name, arguments: args });
    return (res.content ?? []).map((c: any) => c.text ?? '').join('\n');
  };

  async function fakeIntuit(input: any, init?: RequestInit): Promise<Response> {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const path = url.pathname.replace(/^.*\/company\/[^/]+\//, '');
    const method = (init?.method ?? 'GET').toUpperCase();
    if (method === 'GET' && path === 'vendorcredit/77') {
      return deleted ? fault('Object Not Found') : json({ VendorCredit: vc });
    }
    if (method === 'POST' && path === 'vendorcredit' && !url.searchParams.get('operation')) {
      const body = JSON.parse(String(init?.body ?? '{}'));
      posts.push({ path, body });
      if (body.SyncToken !== vc.SyncToken) return fault('Stale Object Error');
      let lines = body.Line.map((l: any, i: number) => ({ ...l, Id: l.Id ?? String(100 + i) }));
      if (mode.appendLines) lines = [...vc.Line, ...lines];
      const total = lines.reduce((s: number, l: any) => s + l.Amount, 0);
      vc = { ...body, Line: lines, TotalAmt: total, SyncToken: String(Number(vc.SyncToken) + 1) };
      delete vc.sparse;
      mode.appendLines = false; // rollback posts behave normally
      return json({ VendorCredit: vc });
    }
    const op = url.searchParams.get('operation');
    if (method === 'POST' && url.pathname.endsWith('/vendorcredit') && op) {
      const body = JSON.parse(String(init?.body ?? '{}'));
      posts.push({ path: `vendorcredit?operation=${op}`, body });
      if (op === 'delete') {
        if (mode.refuseDelete) return fault('Cannot delete: credit is applied to a bill payment');
        deleted = true;
        return json({ VendorCredit: { Id: body.Id, status: 'Deleted' } });
      }
      if (op === 'void') {
        if (mode.refuseVoid) return fault('Operation Void is not supported');
        voided = true;
        return json({ VendorCredit: { ...vc, TotalAmt: 0 } });
      }
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
    mcp = new Client({ name: 'vc-e2e', version: '1.0.0' });
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

  beforeEach(() => {
    vc = seed(); deleted = false; voided = false; posts.length = 0;
    Object.assign(mode, { appendLines: false, refuseDelete: false, refuseVoid: false });
  });

  it('registers the three tools with the right annotations', async () => {
    const tools = (await mcp.listTools()).tools;
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(byName.get_vendor_credit.annotations?.readOnlyHint).toBe(true);
    expect(byName.delete_vendor_credit.annotations?.destructiveHint).toBe(true);
    expect(byName.update_vendor_credit.annotations?.readOnlyHint).toBe(false);
    expect(Object.keys((byName.update_vendor_credit.inputSchema as any).properties).sort())
      .toEqual(['client_name', 'doc_number', 'lines', 'private_note', 'txn_date', 'vendor_credit_id']);
  });

  it('get_vendor_credit returns update-ready lines', async () => {
    const out = JSON.parse(await call('get_vendor_credit', { client_name: CLIENT, vendor_credit_id: '77' }));
    expect(out).toMatchObject({ id: '77', sync_token: '3', doc_number: 'VC-1', vendor_id: '12', total_amt: 150 });
    expect(out.lines).toEqual([
      { line_id: '1', amount: 100, description: 'a', detail_type: 'AccountBasedExpenseLineDetail', account_id: '60', account_name: 'Supplies' },
      { line_id: '2', amount: 50, description: 'b', detail_type: 'AccountBasedExpenseLineDetail', account_id: '61', account_name: 'Rent' },
    ]);
  });

  it('header-only update is sparse and keeps lines untouched with fresh SyncToken', async () => {
    const text = await call('update_vendor_credit', { client_name: CLIENT, vendor_credit_id: '77', private_note: 'new memo', txn_date: '2026-10-05' });
    expect(text).toContain('updated');
    expect(posts).toHaveLength(1);
    const body = posts[0].body;
    expect(body.SyncToken).toBe('3');
    expect(body.PrivateNote).toBe('new memo');
    expect(body.TxnDate).toBe('2026-10-05');
    expect(body.DocNumber).toBe('VC-1');
    expect(body.Line.map((l: any) => l.Id)).toEqual(['1', '2']);
    expect(body.sparse).not.toBe(false);
  });

  it('round-trips get → update lines carrying line_id, and matches by position otherwise', async () => {
    const got = JSON.parse(await call('get_vendor_credit', { client_name: CLIENT, vendor_credit_id: '77' }));
    got.lines[1].amount = 75;
    await call('update_vendor_credit', { client_name: CLIENT, vendor_credit_id: '77', lines: got.lines });
    expect(posts[0].body.Line.map((l: any) => [l.Id, l.Amount])).toEqual([['1', 100], ['2', 75]]);
    expect(posts[0].body.sparse).toBe(false);

    vc = seed(); posts.length = 0;
    await call('update_vendor_credit', { client_name: CLIENT, vendor_credit_id: '77', lines: [{ amount: 10, account_id: '60' }] });
    expect(posts[0].body.Line.map((l: any) => l.Id)).toEqual(['1']);
  });

  it('verifies the write and rolls back on a mismatch', async () => {
    mode.appendLines = true;
    const text = await call('update_vendor_credit', { client_name: CLIENT, vendor_credit_id: '77', lines: [{ line_id: '1', amount: 100, account_id: '60' }, { line_id: '2', amount: 50, account_id: '61' }] });
    expect(text).toContain('VERIFICATION FAILED');
    expect(posts).toHaveLength(2); // write + rollback
    expect(posts[1].body.Line.map((l: any) => l.Id)).toEqual(['1', '2']);
    expect(vc.Line).toHaveLength(2);
    expect(vc.TotalAmt).toBe(150);
  });

  it('delete_vendor_credit deletes with the fetched SyncToken', async () => {
    const text = await call('delete_vendor_credit', { client_name: CLIENT, vendor_credit_id: '77' });
    expect(text).toMatch(/^Deleted vendor credit 77 \(ref VC-1\)/);
    expect(posts).toEqual([{ path: 'vendorcredit?operation=delete', body: { Id: '77', SyncToken: '3' } }]);
    expect(deleted).toBe(true);
  });

  it('delete_vendor_credit voids when QBO refuses the delete', async () => {
    mode.refuseDelete = true;
    const text = await call('delete_vendor_credit', { client_name: CLIENT, vendor_credit_id: '77' });
    expect(text).toContain('QBO refused the delete');
    expect(text).toContain('voided vendor credit 77');
    expect(posts.map((p) => p.path)).toEqual(['vendorcredit?operation=delete', 'vendorcredit?operation=void']);
    expect(voided).toBe(true);
  });

  it('delete_vendor_credit reports both errors when delete and void fail', async () => {
    Object.assign(mode, { refuseDelete: true, refuseVoid: true });
    const text = await call('delete_vendor_credit', { client_name: CLIENT, vendor_credit_id: '77' });
    expect(text).toContain('Error deleting vendor credit');
    expect(text).toContain('Void fallback also failed');
  });

  it('unknown client is rejected before any QBO call', async () => {
    const text = await call('update_vendor_credit', { client_name: 'Nope', vendor_credit_id: '77', private_note: 'x' });
    expect(text).toContain('Client not found');
    expect(posts).toHaveLength(0);
  });
});

describe('buildVendorCreditUpdatePayload', () => {
  it('clears memo with empty string and leaves Line reference untouched without lines', () => {
    const e = seed();
    const p = buildVendorCreditUpdatePayload(e, { private_note: '' });
    expect(p.PrivateNote).toBe('');
    expect(p.Line).toBe(e.Line);
    expect(p.VendorRef).toEqual(e.VendorRef);
  });
});
