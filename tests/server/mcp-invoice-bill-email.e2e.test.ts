import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { QBOManager } from '../../src/index.js';
import { registerMcpRoutes } from '../../src/server/mcp.js';
import { QBOError } from '../../src/api/client.js';

const ENCRYPTION_KEY = 'a'.repeat(64);
const MASTER_KEY = 'master-key-for-bill-email-tests';
const CLIENT = 'United Way of the CSRA';
const REALM = '9341454121860748';

function invoiceFixture() {
  return {
    Invoice: {
      Id: '20',
      SyncToken: '3',
      DocNumber: '501',
      TxnDate: '2026-11-10',
      DueDate: '2026-12-10',
      TotalAmt: 74.36,
      Balance: 74.36,
      CustomerRef: { value: '9', name: 'Acme' },
      EmailStatus: 'NotSet',
      Line: [{ Id: '1', Amount: 74.36, DetailType: 'SalesItemLineDetail', SalesItemLineDetail: { ItemRef: { value: '3' } } }],
    },
  };
}

describe('MCP invoice BillEmail (mocked QBO only)', () => {
  let qbo: QBOManager;
  let app: FastifyInstance;
  let baseUrl: string;
  let storedInv: any;
  let postSpy: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    storedInv = invoiceFixture();
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

    const getSpy = vi.fn().mockImplementation((_realm: string, path: string) => {
      if (path === 'invoice/20') return Promise.resolve(storedInv);
      return Promise.reject(new QBOError(`unexpected get ${path}`, 404));
    });
    postSpy = vi.fn().mockImplementation((_realm: string, path: string, body: any) => {
      if (path === 'invoice') {
        const id = body.Id ?? '20';
        storedInv = { Invoice: { ...storedInv.Invoice, ...body, Id: id, SyncToken: String(Number(body.SyncToken ?? 0) + 1) } };
        return Promise.resolve(storedInv);
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

  it('create_invoice posts BillEmail / BillEmailCc / BillEmailBcc when provided', async () => {
    const { texts, isError } = await callTool('create_invoice', {
      client_name: CLIENT,
      customer_id: '9',
      customer_name: 'Acme',
      bill_email: 'ap@example.org',
      bill_email_cc: 'cc@example.org',
      bill_email_bcc: 'bcc@example.org',
      lines: [{ amount: 74.36, item_id: '3' }],
    });
    expect(isError).toBe(false);
    expect(texts[texts.length - 1]).toMatch(/created successfully/);
    expect(postSpy).toHaveBeenCalledWith(REALM, 'invoice', expect.objectContaining({
      CustomerRef: { value: '9', name: 'Acme' },
      BillEmail: { Address: 'ap@example.org' },
      BillEmailCc: { Address: 'cc@example.org' },
      BillEmailBcc: { Address: 'bcc@example.org' },
    }));
  });

  it('update_invoice posts a sparse BillEmail update (Id + SyncToken only besides email)', async () => {
    const { isError } = await callTool('update_invoice', {
      client_name: CLIENT,
      invoice_id: '20',
      bill_email: 'ap@example.org',
      bill_email_cc: 'cc@example.org',
    });
    expect(isError).toBe(false);
    const posted = postSpy.mock.calls[0][2];
    expect(posted).toEqual({
      Id: '20',
      SyncToken: '3',
      sparse: true,
      BillEmail: { Address: 'ap@example.org' },
      BillEmailCc: { Address: 'cc@example.org' },
    });
    expect(posted.Line).toBeUndefined();
    expect(posted.TotalAmt).toBeUndefined();
  });
});
