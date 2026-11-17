import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { QBOManager } from '../../src/index.js';
import { registerMcpRoutes } from '../../src/server/mcp.js';
import { QBOError } from '../../src/api/client.js';
import { ENHANCED_CUSTOM_FIELDS_QUERY } from '../../src/api/custom-fields.js';

const ENCRYPTION_KEY = 'a'.repeat(64);
const MASTER_KEY = 'master-key-for-cf-ta-tests';
const CLIENT = 'United Way of the CSRA';
const REALM = '9341454121860748';

function invoiceFixture() {
  return {
    Invoice: {
      Id: '20',
      SyncToken: '3',
      DocNumber: '501',
      TxnDate: '2026-11-10',
      TotalAmt: 74.36,
      Balance: 74.36,
      CustomerRef: { value: '9', name: 'Acme' },
      CustomField: [{ DefinitionId: '1', Name: 'JobCode', Type: 'StringType', StringValue: 'NW-12' }],
      Line: [{ Id: '1', Amount: 74.36, DetailType: 'SalesItemLineDetail', SalesItemLineDetail: { ItemRef: { value: '3' } } }],
    },
  };
}

function timeActivityFixture(overrides: Record<string, unknown> = {}) {
  return {
    TimeActivity: {
      Id: '44',
      SyncToken: '1',
      NameOf: 'Employee',
      EmployeeRef: { value: '8', name: 'Pat' },
      CustomerRef: { value: '9', name: 'Acme' },
      TxnDate: '2026-11-10',
      Hours: 2,
      Minutes: 30,
      Description: 'Grant reporting',
      BillableStatus: 'NotBillable',
      ...overrides,
    },
  };
}

describe('MCP custom fields + TimeActivity (mocked QBO only)', () => {
  let qbo: QBOManager;
  let app: FastifyInstance;
  let baseUrl: string;
  let storedInv: any;
  let storedTa: any;
  let getSpy: ReturnType<typeof vi.fn>;
  let postSpy: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    storedInv = invoiceFixture();
    storedTa = timeActivityFixture();
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

    getSpy = vi.fn().mockImplementation((_realm: string, path: string, query?: Record<string, string>) => {
      if (path === 'invoice/20') return Promise.resolve(storedInv);
      if (path === 'timeactivity/44') return Promise.resolve(storedTa);
      return Promise.reject(new QBOError(`unexpected get ${path}`, 404));
    });
    postSpy = vi.fn().mockImplementation((_realm: string, path: string, body: any) => {
      if (path === 'invoice') {
        storedInv = { Invoice: { ...body, SyncToken: String(Number(body.SyncToken) + 1) } };
        return Promise.resolve(storedInv);
      }
      if (path === 'timeactivity') {
        const id = body.Id ?? '44';
        storedTa = { TimeActivity: { ...body, Id: id, SyncToken: String(Number(body.SyncToken ?? 0) + 1) } };
        return Promise.resolve(storedTa);
      }
      if (path === 'timeactivity?operation=delete') {
        return Promise.resolve({ TimeActivity: { Id: body.Id, status: 'Deleted' } });
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

  it('get_invoice requests include=enhancedAllCustomFields and returns custom_fields', async () => {
    const { texts, isError } = await callTool('get_invoice', { client_name: CLIENT, invoice_id: '20' });
    expect(isError).toBe(false);
    const body = lastJson(texts);
    expect(body.custom_fields).toEqual([
      { definition_id: '1', name: 'JobCode', type: 'StringType', string_value: 'NW-12' },
    ]);
    expect(getSpy).toHaveBeenCalledWith(REALM, 'invoice/20', ENHANCED_CUSTOM_FIELDS_QUERY);
  });

  it('update_invoice writes CustomField when custom_fields is passed', async () => {
    const { isError } = await callTool('update_invoice', {
      client_name: CLIENT,
      invoice_id: '20',
      custom_fields: [{ definition_id: '1', name: 'JobCode', type: 'StringType', string_value: 'NW-99' }],
    });
    expect(isError).toBe(false);
    const posted = postSpy.mock.calls[0][2];
    expect(posted.CustomField).toEqual([
      { DefinitionId: '1', Name: 'JobCode', Type: 'StringType', StringValue: 'NW-99' },
    ]);
    expect(getSpy).toHaveBeenCalledWith(REALM, 'invoice/20', ENHANCED_CUSTOM_FIELDS_QUERY);
  });

  it('get/create/update/delete TimeActivity (delete requires confirm=true)', async () => {
    const got = lastJson((await callTool('get_time_activity', { client_name: CLIENT, time_activity_id: '44' })).texts);
    expect(got).toMatchObject({ id: '44', name_of: 'Employee', hours: 2, minutes: 30 });

    const created = lastJson((await callTool('create_time_activity', {
      client_name: CLIENT,
      name_of: 'Employee',
      employee_id: '8',
      txn_date: '2026-11-11',
      hours: 1,
      minutes: 0,
      description: 'Board prep',
    })).texts);
    expect(created.description).toBe('Board prep');
    expect(postSpy).toHaveBeenCalledWith(REALM, 'timeactivity', expect.objectContaining({
      NameOf: 'Employee', EmployeeRef: { value: '8' }, Hours: 1, Description: 'Board prep',
    }));

    const updated = lastJson((await callTool('update_time_activity', {
      client_name: CLIENT,
      time_activity_id: '44',
      hours: 3,
    })).texts);
    expect(updated.hours).toBe(3);

    const dry = lastJson((await callTool('delete_time_activity', { client_name: CLIENT, time_activity_id: '44' })).texts);
    expect(dry.dry_run).toBe(true);
    expect(dry.deleted).toBe(false);

    const live = lastJson((await callTool('delete_time_activity', { client_name: CLIENT, time_activity_id: '44', confirm: true })).texts);
    expect(live.deleted).toBe(true);
    expect(postSpy).toHaveBeenCalledWith(REALM, 'timeactivity?operation=delete', { Id: '44', SyncToken: expect.any(String) });
  });
});
