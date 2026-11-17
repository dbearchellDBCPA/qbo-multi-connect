import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { QBOManager } from '../../src/index.js';
import { registerMcpRoutes } from '../../src/server/mcp.js';
import { QBOError } from '../../src/api/client.js';
import { paymentToUpdateShape } from '../../src/server/payment-tools.js';

const ENCRYPTION_KEY = 'a'.repeat(64);
const MASTER_KEY = 'master-key-for-payment-tools-tests';
const CLIENT = 'United Way of the CSRA';
const REALM = '9341454121860748';

function paymentFixture(overrides: Record<string, unknown> = {}) {
  return {
    Payment: {
      Id: '55',
      SyncToken: '2',
      DocNumber: '1001',
      TxnDate: '2026-11-10',
      TotalAmt: 100,
      UnappliedAmt: 0,
      PrivateNote: 'Wire',
      CustomerRef: { value: '9', name: 'Acme' },
      DepositToAccountRef: { value: '4', name: 'Checking' },
      PaymentMethodRef: { value: '3' },
      Line: [{ Amount: 100, LinkedTxn: [{ TxnId: '20', TxnType: 'Invoice' }] }],
      ...overrides,
    },
  };
}

describe('paymentToUpdateShape', () => {
  it('maps header fields and application lines', () => {
    const shape = paymentToUpdateShape(paymentFixture().Payment);
    expect(shape).toMatchObject({
      id: '55',
      sync_token: '2',
      doc_number: '1001',
      customer_id: '9',
      total_amt: 100,
      deposit_to_account_id: '4',
      lines: [{ amount: 100, txn_id: '20', txn_type: 'Invoice' }],
    });
  });
});

describe('MCP payment get/update/void/delete (mocked QBO only)', () => {
  let qbo: QBOManager;
  let app: FastifyInstance;
  let baseUrl: string;
  let stored: any;
  let getSpy: ReturnType<typeof vi.fn>;
  let postSpy: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    stored = paymentFixture();
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
      if (path === 'payment/55') return Promise.resolve(stored);
      return Promise.reject(new QBOError('not found', 404));
    });
    postSpy = vi.fn().mockImplementation((_realm: string, path: string, body: any) => {
      if (path === 'payment?operation=void') {
        return Promise.resolve({ Payment: { ...stored.Payment, SyncToken: '3', PrivateNote: 'Voided' } });
      }
      if (path === 'payment?operation=delete') {
        return Promise.resolve({ Payment: { ...stored.Payment, status: 'Deleted' } });
      }
      if (path === 'payment') {
        stored = { Payment: { ...body, SyncToken: String(Number(body.SyncToken) + 1) } };
        return Promise.resolve(stored);
      }
      return Promise.reject(new QBOError(`unexpected post ${path}`, 400));
    });
    (qbo as any).client.get = getSpy;
    (qbo as any).client.post = postSpy;

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

  const lastJson = (texts: string[]) => JSON.parse(texts[texts.length - 1]);

  it('get_payment returns an update-ready shape', async () => {
    const { texts, isError } = await callTool('get_payment', { client_name: CLIENT, payment_id: '55' });
    expect(isError).toBe(false);
    expect(lastJson(texts)).toMatchObject({ id: '55', sync_token: '2', total_amt: 100, lines: [{ txn_id: '20', txn_type: 'Invoice' }] });
    expect(getSpy).toHaveBeenCalledWith(REALM, 'payment/55', {});
  });

  it('update_payment merges header fields and syncs a single invoice line when total_amt changes', async () => {
    const { texts, isError } = await callTool('update_payment', {
      client_name: CLIENT,
      payment_id: '55',
      total_amt: 80,
      private_note: 'Corrected wire',
    });
    expect(isError).toBe(false);
    const body = lastJson(texts);
    expect(body.total_amt).toBe(80);
    expect(body.private_note).toBe('Corrected wire');
    expect(body.sync_token).toBe('3');
    const posted = postSpy.mock.calls[0][2];
    expect(postSpy.mock.calls[0][1]).toBe('payment');
    expect(posted.TotalAmt).toBe(80);
    expect(posted.Line[0].Amount).toBe(80);
    expect(posted.SyncToken).toBe('2');
  });

  it('void_payment defaults to a dry run and does not POST operation=void', async () => {
    const { texts, isError } = await callTool('void_payment', { client_name: CLIENT, payment_id: '55' });
    expect(isError).toBe(false);
    const body = lastJson(texts);
    expect(body.dry_run).toBe(true);
    expect(body.voided).toBe(false);
    expect(body.payment.id).toBe('55');
    expect(body.message).toMatch(/confirm_void=true/);
    expect(postSpy).not.toHaveBeenCalled();
  });

  it('void_payment posts operation=void with Id and SyncToken when confirm_void=true', async () => {
    const { texts, isError } = await callTool('void_payment', {
      client_name: CLIENT,
      payment_id: '55',
      confirm_void: true,
    });
    expect(isError).toBe(false);
    expect(lastJson(texts).voided).toBe(true);
    expect(postSpy).toHaveBeenCalledWith(REALM, 'payment?operation=void', { Id: '55', SyncToken: '2', sparse: true });
  });

  it('delete_payment defaults to a dry run and posts operation=delete only when confirm=true', async () => {
    const dry = lastJson((await callTool('delete_payment', { client_name: CLIENT, payment_id: '55' })).texts);
    expect(dry.dry_run).toBe(true);
    expect(dry.deleted).toBe(false);
    expect(postSpy).not.toHaveBeenCalled();

    const { texts, isError } = await callTool('delete_payment', { client_name: CLIENT, payment_id: '55', confirm: true });
    expect(isError).toBe(false);
    expect(lastJson(texts).deleted).toBe(true);
    expect(postSpy).toHaveBeenCalledWith(REALM, 'payment?operation=delete', { Id: '55', SyncToken: '2' });
  });
});
