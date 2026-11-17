import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { QBOManager } from '../../src/index.js';
import { registerMcpRoutes } from '../../src/server/mcp.js';
import { QBOError } from '../../src/api/client.js';

const ENCRYPTION_KEY = 'a'.repeat(64);
const MASTER_KEY = 'master-key-for-recurring-tests';
const CLIENT = 'United Way of the CSRA';
const REALM = '9341454121860748';

function monthlyBill() {
  return {
    Bill: {
      Id: '20',
      SyncToken: '3',
      domain: 'QBO',
      sparse: false,
      RecurringInfo: {
        Name: 'Monthly Telephone',
        RecurType: 'Automated',
        Active: true,
        ScheduleInfo: {
          IntervalType: 'Monthly',
          NumInterval: 1,
          DayOfMonth: 1,
          DaysBefore: 5,
          StartDate: '2026-01-01',
          NextDate: '2026-12-01',
          PreviousDate: '2026-11-01',
        },
      },
      RecurDataRef: { value: '2' },
      TotalAmt: 74.36,
      VendorRef: { value: '32', name: 'Cal Telephone' },
      Line: [
        {
          Id: '1',
          LineNum: 1,
          Description: 'Monthly Phone Bill',
          Amount: 74.36,
          DetailType: 'AccountBasedExpenseLineDetail',
          AccountBasedExpenseLineDetail: { AccountRef: { value: '77' } },
        },
      ],
    },
  };
}

function monthlyJe() {
  return {
    JournalEntry: {
      Id: '88',
      SyncToken: '5',
      domain: 'QBO',
      RecurringInfo: {
        Name: 'Prepaid Insurance Amortization',
        RecurType: 'Automated',
        Active: true,
        ScheduleInfo: {
          IntervalType: 'Monthly',
          NumInterval: 1,
          DayOfMonth: 1,
          DaysBefore: 5,
          StartDate: '2026-01-01',
          NextDate: '2026-12-01',
          PreviousDate: '2026-11-01',
        },
      },
      RecurDataRef: { value: '7' },
      Line: [
        { Id: '1', Amount: 100, DetailType: 'JournalEntryLineDetail', JournalEntryLineDetail: { PostingType: 'Debit', AccountRef: { value: '91' } } },
        { Id: '2', Amount: 100, DetailType: 'JournalEntryLineDetail', JournalEntryLineDetail: { PostingType: 'Credit', AccountRef: { value: '44' } } },
      ],
    },
  };
}

function getEnvelope(wrapper: any) {
  return { QueryResponse: { startPosition: 1, maxResults: 1, RecurringTransaction: [wrapper] } };
}

describe('MCP get/update_recurring_transaction (mocked QBO only)', () => {
  let app: FastifyInstance;
  let qbo: QBOManager;
  let baseUrl: string;
  let getSpy: ReturnType<typeof vi.fn>;
  let postSpy: ReturnType<typeof vi.fn>;
  let querySpy: ReturnType<typeof vi.fn>;
  let storedBill: any;
  let storedJe: any;

  beforeEach(async () => {
    storedBill = monthlyBill();
    storedJe = monthlyJe();
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
      if (path === 'recurringtransaction/20') return Promise.resolve(getEnvelope(storedBill));
      if (path === 'recurringtransaction/88') return Promise.resolve(getEnvelope(storedJe));
      return Promise.reject(new QBOError('not found', 404));
    });
    postSpy = vi.fn().mockImplementation((_realm: string, path: string, body: any) => {
      if (path !== 'recurringtransaction') return Promise.reject(new QBOError(`unexpected post ${path}`, 400));
      if (body?.Bill) {
        storedBill = { Bill: { ...body.Bill, SyncToken: String(Number(body.Bill.SyncToken) + 1) } };
        return Promise.resolve({ RecurringTransaction: storedBill });
      }
      if (body?.JournalEntry) {
        storedJe = { JournalEntry: { ...body.JournalEntry, SyncToken: String(Number(body.JournalEntry.SyncToken) + 1) } };
        return Promise.resolve({ RecurringTransaction: storedJe });
      }
      return Promise.reject(new QBOError('bad wrapper', 400));
    });
    querySpy = vi.fn().mockImplementation((_realm: string, sql: string) => {
      if (/FROM RecurringTransaction/i.test(sql)) {
        return Promise.resolve({ QueryResponse: { RecurringTransaction: [storedBill, storedJe] } });
      }
      return Promise.resolve({ QueryResponse: {} });
    });
    (qbo as any).client.get = getSpy;
    (qbo as any).client.post = postSpy;
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

  const lastJson = (texts: string[]) => JSON.parse(texts[texts.length - 1]);

  it('get_recurring_transaction returns RecurringInfo, type, and total for a Bill by Id', async () => {
    const { texts, isError } = await callTool('get_recurring_transaction', {
      client_name: CLIENT,
      recurring_transaction_id: '20',
    });
    expect(isError).toBe(false);
    const body = lastJson(texts);
    expect(body.txn_type).toBe('Bill');
    expect(body.id).toBe('20');
    expect(body.recur_data_ref).toBe('2');
    expect(body.total_amt).toBe(74.36);
    expect(body.recurring_info.ScheduleInfo).toMatchObject({
      IntervalType: 'Monthly',
      DayOfMonth: 1,
      DaysBefore: 5,
      NextDate: '2026-12-01',
    });
    expect(getSpy).toHaveBeenCalledWith(REALM, 'recurringtransaction/20', {});
    expect(postSpy).not.toHaveBeenCalled();
  });

  it('get_recurring_transaction resolves a RecurDataRef via query after GET 404', async () => {
    const { texts } = await callTool('get_recurring_transaction', {
      client_name: CLIENT,
      recurring_transaction_id: '7',
    });
    const body = lastJson(texts);
    expect(body.txn_type).toBe('JournalEntry');
    expect(body.id).toBe('88');
    expect(body.recur_data_ref).toBe('7');
    expect(body.matched_by).toBe('recur_data_ref');
    expect(body.line_count).toBe(2);
    expect(querySpy).toHaveBeenCalled();
  });

  it('update_recurring_transaction dry_run (default) returns the EndDate diff and full payload without writing', async () => {
    const { texts } = await callTool('update_recurring_transaction', {
      client_name: CLIENT,
      recurring_transaction_id: '20',
      end_date: '2026-12-01',
    });
    const body = lastJson(texts);
    expect(body.dry_run).toBe(true);
    expect(body.written).toBe(false);
    expect(body.txn_type).toBe('Bill');
    expect(body.schedule_after.EndDate).toBe('2026-12-01');
    expect(body.schedule_diff.EndDate).toEqual({ from: null, to: '2026-12-01' });
    expect(body.payload.Bill.RecurringInfo.Active).toBe(true);
    expect(body.payload.Bill.RecurringInfo.ScheduleInfo.EndDate).toBe('2026-12-01');
    expect(body.payload.Bill.sparse).toBe(false);
    expect(body.payload.Bill.Line).toHaveLength(1);
    expect(body.payload.Bill.Line[0].Amount).toBe(74.36);
    expect(body.end_date_semantics).toMatch(/12\/1\/2026/);
    expect(postSpy).not.toHaveBeenCalled();
  });

  it('update_recurring_transaction dry_run for a JournalEntry preserves both lines in the payload', async () => {
    const { texts } = await callTool('update_recurring_transaction', {
      client_name: CLIENT,
      recurring_transaction_id: '88',
      end_date: '2026-12-01',
      dry_run: true,
    });
    const body = lastJson(texts);
    expect(body.txn_type).toBe('JournalEntry');
    expect(body.payload.JournalEntry.Line).toHaveLength(2);
    expect(body.payload.JournalEntry.Line.map((l: any) => l.Id)).toEqual(['1', '2']);
    expect(postSpy).not.toHaveBeenCalled();
  });

  it('update_recurring_transaction dry_run=false posts the full Bill wrapper and verifies EndDate', async () => {
    const { texts } = await callTool('update_recurring_transaction', {
      client_name: CLIENT,
      recurring_transaction_id: '20',
      end_date: '2026-12-01',
      dry_run: false,
    });
    const body = lastJson(texts);
    expect(body.written).toBe(true);
    expect(body.result.recurring_info.ScheduleInfo.EndDate).toBe('2026-12-01');
    expect(body.result.recurring_info.Active).toBe(true);
    expect(postSpy).toHaveBeenCalledTimes(1);
    const posted = postSpy.mock.calls[0][2];
    expect(posted.Bill.Line).toHaveLength(1);
    expect(posted.Bill.Line[0].Id).toBe('1');
    expect(posted.Bill.sparse).toBe(false);
    expect(posted.Bill.SyncToken).toBe('3');
  });

  it('update_recurring_transaction rejects both end_date and max_occurrences without writing', async () => {
    const { texts } = await callTool('update_recurring_transaction', {
      client_name: CLIENT,
      recurring_transaction_id: '20',
      end_date: '2026-12-01',
      max_occurrences: 12,
      dry_run: false,
    });
    expect(texts[0]).toMatch(/exactly one/);
    expect(postSpy).not.toHaveBeenCalled();
  });
});
