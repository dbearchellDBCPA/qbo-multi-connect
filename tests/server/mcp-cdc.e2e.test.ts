import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { QBOManager } from '../../src/index.js';
import { registerMcpRoutes } from '../../src/server/mcp.js';
import { QBOError } from '../../src/api/client.js';

const ENCRYPTION_KEY = 'a'.repeat(64);
const MASTER_KEY = 'master-key-for-cdc-tests';
const CLIENT = 'United Way of the CSRA';
const REALM = '9341454121860748';

const CDC_BODY = {
  CDCResponse: [
    {
      QueryResponse: [
        {
          Invoice: [
            { Id: '101', SyncToken: '1', DocNumber: '501', TxnDate: '2026-11-10', MetaData: { LastUpdatedTime: '2026-11-10T18:00:00-05:00' } },
            { Id: '99', status: 'Deleted' },
          ],
        },
        {
          Payment: [
            { Id: '55', SyncToken: '2', TotalAmt: 100, MetaData: { LastUpdatedTime: '2026-11-12T09:00:00-05:00' } },
          ],
        },
      ],
    },
  ],
  time: '2026-11-17T14:00:00-05:00',
};

describe('MCP get_changed_entities (mocked QBO only)', () => {
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

    getSpy = vi.fn().mockImplementation((_realm: string, path: string, query?: Record<string, string>) => {
      if (path === 'cdc') return Promise.resolve(CDC_BODY);
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

  it('calls /cdc with entities and changedSince and returns the CDC payload', async () => {
    const day = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const { texts, isError } = await callTool('get_changed_entities', {
      client_name: CLIENT,
      entities: ['Invoice', 'Payment'],
      changed_since: day,
    });
    expect(isError).toBe(false);
    const body = JSON.parse(texts[texts.length - 1]);
    expect(body.CDCResponse[0].QueryResponse[0].Invoice).toHaveLength(2);
    expect(body.CDCResponse[0].QueryResponse[0].Invoice[1]).toEqual({ Id: '99', status: 'Deleted' });
    expect(body.CDCResponse[0].QueryResponse[1].Payment[0].Id).toBe('55');
    expect(getSpy).toHaveBeenCalledWith(REALM, 'cdc', {
      entities: 'Invoice,Payment',
      changedSince: `${day}T00:00:00Z`,
    });
  });

  it('passes a full ISO changed_since through to QBO', async () => {
    const since = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
    const { isError } = await callTool('get_changed_entities', {
      client_name: CLIENT,
      entities: ['Customer'],
      changed_since: since,
    });
    expect(isError).toBe(false);
    expect(getSpy).toHaveBeenCalledWith(REALM, 'cdc', {
      entities: 'Customer',
      changedSince: since,
    });
  });

  it('refuses a changed_since older than Intuit\'s 30-day lookback without calling QBO', async () => {
    const { texts, isError } = await callTool('get_changed_entities', {
      client_name: CLIENT,
      entities: ['Invoice'],
      changed_since: '2020-01-01',
    });
    expect(isError).toBe(true);
    expect(texts[0]).toMatch(/30-day CDC lookback/);
    expect(getSpy).not.toHaveBeenCalled();
  });
});
