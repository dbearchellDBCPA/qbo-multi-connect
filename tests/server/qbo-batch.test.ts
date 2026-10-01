import { describe, it, expect } from 'vitest';
import { BatchRunner, isThrottleFault, faultFrom, formatFault, type BatchOp } from '../../src/server/qbo-batch.js';
import { QBOError } from '../../src/api/client.js';

const THROTTLE_BODY = JSON.stringify({ Fault: { Error: [{ Message: 'message=ThrottleExceeded; errorCode=003001; statusCode=429', Detail: 'The request limit was reached.', code: '3001' }], type: 'SERVICE' } });

function ops(n: number, entity = 'Purchase'): BatchOp[] {
  return Array.from({ length: n }, (_, i) => ({ bId: `b${i + 1}`, operation: 'create', entity, payload: { n: i + 1 }, label: `src:${i + 1}` }));
}

function harness(script: (call: number, items: any[], requestId: string) => any) {
  const clock = { now: 0 };
  const calls: Array<{ items: any[]; requestId: string; at: number }> = [];
  const logs: string[] = [];
  const transport = async (_realm: string, items: any[], requestId: string) => {
    calls.push({ items, requestId, at: clock.now });
    return script(calls.length, items, requestId);
  };
  const windows = new Map<string, number[]>();
  const runner = new BatchRunner(transport, {
    now: () => clock.now,
    sleep: async (ms) => { clock.now += ms; },
    log: (l) => logs.push(l),
    baseDelayMs: 1000,
  }, windows);
  return { runner, calls, logs, clock, windows };
}

const okBody = (items: any[]) => ({ BatchItemResponse: items.map((it) => ({ bId: it.bId, Purchase: { Id: `id-${it.bId}`, ...it.Purchase } })) });

describe('BatchRunner', () => {
  it('sends ≤30 operations per request, in order, and maps results by bId', async () => {
    const { runner, calls } = harness((_c, items) => okBody(items));
    const res = await runner.run('R', ops(65));
    expect(calls.map((c) => c.items.length)).toEqual([30, 30, 5]);
    expect(calls[0].items[0]).toEqual({ bId: 'b1', operation: 'create', Purchase: { n: 1 } });
    expect(res.size).toBe(65);
    expect(res.get('b65')).toMatchObject({ ok: true, entity: { Id: 'id-b65' } });
    expect(runner.stats.requests).toBe(3);
  });

  it('never sends more than 40 batch requests in any 60 s for one company', async () => {
    const { runner, calls } = harness((_c, items) => okBody(items));
    await runner.run('R', ops(30 * 85));
    expect(calls).toHaveLength(85);
    const at = calls.map((c) => c.at);
    for (let i = 0; i < at.length; i++) expect(at.filter((t) => t >= at[i] && t < at[i] + 60_000).length).toBeLessThanOrEqual(40);
    expect(at[40]).toBeGreaterThanOrEqual(60_000);
    expect(runner.stats.waitedMs).toBeGreaterThan(0);
  });

  it('the window is shared per realm across runners (two calls in a row stay under the limit)', async () => {
    const clock = { now: 0 };
    const windows = new Map<string, number[]>();
    const at: number[] = [];
    const t = async (_r: string, items: any[]) => { at.push(clock.now); return okBody(items); };
    const opts = { now: () => clock.now, sleep: async (ms: number) => { clock.now += ms; }, log: () => {} };
    await new BatchRunner(t, opts, windows).run('R', ops(30 * 30));
    await new BatchRunner(t, opts, windows).run('R', ops(30 * 30));
    for (let i = 0; i < at.length; i++) expect(at.filter((x) => x >= at[i] && x < at[i] + 60_000).length).toBeLessThanOrEqual(40);
  });

  it('retries HTTP 429 with backoff and the SAME requestid (QBO replays instead of re-writing)', async () => {
    const { runner, calls, logs, clock } = harness((c, items) => {
      if (c <= 2) throw new QBOError('QBO API error: ThrottleExceeded', 429, THROTTLE_BODY);
      return okBody(items);
    });
    const res = await runner.run('R', ops(3), { context: 'import_transactions' });
    expect(calls).toHaveLength(3);
    expect(new Set(calls.map((c) => c.requestId)).size).toBe(1);
    expect([...res.values()].every((r) => r.ok)).toBe(true);
    expect(runner.stats).toMatchObject({ retries: 2, throttled: 2 });
    expect(clock.now).toBe(1000 + 2000); // exponential: 1 s, 2 s
    expect(logs.filter((l) => /got 429 \(QBO code 3001\); retry \d\/6 with the same requestid/.test(l))).toHaveLength(2);
  });

  it('honours Retry-After when given and retries 5xx and network errors', async () => {
    const { runner, calls, clock } = harness((c, items) => {
      if (c === 1) throw Object.assign(new QBOError('bad gateway', 502, 'oops'), { retryAfter: 7 });
      if (c === 2) throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
      return okBody(items);
    });
    const res = await runner.run('R', ops(2));
    expect(calls).toHaveLength(3);
    expect(res.get('b1')!.ok).toBe(true);
    expect(clock.now).toBe(7000 + 2000);
  });

  it('gives up after maxRetries and fails every op of the chunk with a re-run hint', async () => {
    const { runner, calls } = harness(() => { throw new QBOError('throttled', 429, THROTTLE_BODY); });
    const res = await runner.run('R', ops(2));
    expect(calls).toHaveLength(7);
    const r = res.get('b1')!;
    expect(r.ok).toBe(false);
    expect(r.fault?.code).toBe('3001');
    expect(r.fault?.message).toMatch(/gave up after 7 attempts/);
  });

  it('does not retry a non-retryable error (400)', async () => {
    const body = JSON.stringify({ Fault: { Error: [{ Message: 'Bad', Detail: 'nope', code: '2010' }] } });
    const { runner, calls } = harness(() => { throw new QBOError('bad', 400, body); });
    const res = await runner.run('R', ops(1));
    expect(calls).toHaveLength(1);
    expect(res.get('b1')!.fault).toMatchObject({ code: '2010', detail: 'nope' });
  });

  it('re-queues item-level 3001 faults (only those ops) and keeps the others', async () => {
    const { runner, calls } = harness((c, items) => ({
      BatchItemResponse: items.map((it: any, i: number) => (c === 1 && i < 2
        ? { bId: it.bId, Fault: { Error: [{ Message: 'ThrottleExceeded', code: '3001' }] } }
        : { bId: it.bId, Purchase: { Id: `id-${it.bId}` } })),
    }));
    const res = await runner.run('R', ops(5));
    expect(calls.map((c) => c.items.map((i: any) => i.bId))).toEqual([['b1', 'b2', 'b3', 'b4', 'b5'], ['b1', 'b2']]);
    expect(calls[0].requestId).not.toBe(calls[1].requestId);
    expect([...res.values()].every((r) => r.ok)).toBe(true);
  });

  it('reports item faults with QBO\'s text and logs them with the source label', async () => {
    const { runner, logs } = harness((_c, items) => ({
      BatchItemResponse: items.map((it: any) => (it.bId === 'b2'
        ? { bId: it.bId, Fault: { Error: [{ Message: 'Duplicate Document Number Error', Detail: 'DocNumber=1 is assigned', code: '6140', element: 'DocNumber' }], type: 'ValidationFault' } }
        : { bId: it.bId, Purchase: { Id: 'x' } })),
    }));
    const res = await runner.run('R', ops(3), { context: 'import_transactions' });
    expect(res.get('b2')).toMatchObject({ ok: false, fault: { code: '6140', element: 'DocNumber' } });
    expect(formatFault(res.get('b2')!.fault)).toBe('Duplicate Document Number Error — DocNumber=1 is assigned (QBO code 6140)');
    expect(logs.some((l) => l.includes('source=src:2') && l.includes('code=6140'))).toBe(true);
  });

  it('stopOnFault stops sending later chunks', async () => {
    const { runner, calls } = harness((_c, items) => ({
      BatchItemResponse: items.map((it: any) => (it.bId === 'b3' ? { bId: it.bId, Fault: { Error: [{ Message: 'x', code: '6000' }] } } : { bId: it.bId, Purchase: { Id: 'x' } })),
    }));
    const res = await runner.run('R', ops(70), { stopOnFault: true });
    expect(calls).toHaveLength(1);
    expect(res.size).toBe(30);
  });

  it('a missing BatchItemResponse fails that op explicitly', async () => {
    const { runner } = harness(() => ({ BatchItemResponse: [] }));
    const res = await runner.run('R', ops(1));
    expect(res.get('b1')!.fault?.code).toBe('no_response');
  });

  it('throttle fault detection', () => {
    expect(isThrottleFault(faultFrom({ Error: [{ code: '003001' }] }))).toBe(true);
    expect(isThrottleFault({ message: 'message=ThrottleExceeded; errorCode=003001' })).toBe(true);
    expect(isThrottleFault({ code: '6140', message: 'Duplicate Document Number Error' })).toBe(false);
  });
});
