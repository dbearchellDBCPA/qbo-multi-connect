// ─── QBO batch-endpoint writer: chunking, throttling, backoff ────────────────
//
// Every bulk tool (batch_create_names, ensure_items, import_transactions,
// delete_imported_transactions) writes through here.
//
// Intuit's published limits ("API call limits and throttling",
// help.developer.intuit.com, re-checked 2026-09-30):
//   - 500 requests per minute, per realm ID
//   - 10 concurrent requests per realm ID and app
//   - 40 batch requests per minute, per realm ID
//   - at most 30 payloads in a single batch request
// A throttled request answers HTTP 429 with fault "ThrottleExceeded"
// (errorCode 003001 / code 3001). Intuit's guidance: resend the SAME request
// with the SAME requestid, which QBO replays instead of re-executing — so a
// retry can never double-write.
//
// Policy here: one batch request in flight per realm (no concurrency), a
// sliding-window limiter at 40 batch requests/minute per realm shared by
// every call in the process, and on 429 / throttle fault / transient 5xx /
// timeout an exponential backoff (honouring Retry-After) that resends the
// same chunk with the same requestid. Item-level throttle faults inside an
// otherwise successful batch are retried as a new chunk. Every other
// item-level fault is returned verbatim to the caller.

import { createHash, randomUUID } from 'node:crypto';

export const BATCH_MAX_OPERATIONS = 30;
export const BATCH_REQUESTS_PER_MINUTE = 40;

export type BatchOperation = 'create' | 'update' | 'delete';

export interface BatchOp {
  /** Unique within one run() call. */
  bId: string;
  operation: BatchOperation;
  /** QBO entity name: JournalEntry, Purchase, Vendor, Item, … */
  entity: string;
  payload: Record<string, unknown>;
  /** Shown in fault logs (the row's source_id or display name). */
  label?: string;
}

export interface QboFault {
  type?: string;
  code?: string;
  message?: string;
  detail?: string;
  element?: string;
}

export interface BatchOpResult {
  bId: string;
  ok: boolean;
  entity?: any;
  fault?: QboFault;
  /** How many times this op was sent (1 = first try). */
  attempts: number;
}

/** POST one batch body; resolves the parsed JSON or throws (QBOError-like: statusCode, response). */
export type BatchTransport = (realmId: string, items: unknown[], requestId: string) => Promise<any>;

export interface BatchRunnerOptions {
  maxBatchesPerMinute?: number;
  maxOperationsPerBatch?: number;
  /** Retries of one chunk after a throttle / transient error (default 6). */
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Fault log sink; default console.error. Never receives tokens. */
  log?: (line: string) => void;
}

export interface BatchRunStats {
  requests: number;
  retries: number;
  throttled: number;
  waitedMs: number;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Per-realm sliding-window limiter shared by every BatchRunner in the process. */
const sharedWindows = new Map<string, number[]>();

export class BatchRunner {
  private readonly perMinute: number;
  private readonly chunkSize: number;
  private readonly maxRetries: number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private readonly windows: Map<string, number[]>;
  readonly stats: BatchRunStats = { requests: 0, retries: 0, throttled: 0, waitedMs: 0 };

  constructor(private readonly transport: BatchTransport, options: BatchRunnerOptions = {}, windows: Map<string, number[]> = sharedWindows) {
    this.perMinute = options.maxBatchesPerMinute ?? BATCH_REQUESTS_PER_MINUTE;
    this.chunkSize = Math.min(options.maxOperationsPerBatch ?? BATCH_MAX_OPERATIONS, BATCH_MAX_OPERATIONS);
    this.maxRetries = options.maxRetries ?? 6;
    this.baseDelayMs = options.baseDelayMs ?? 2000;
    this.maxDelayMs = options.maxDelayMs ?? 60_000;
    this.sleep = options.sleep ?? defaultSleep;
    this.now = options.now ?? Date.now;
    this.log = options.log ?? ((line) => console.error(line));
    this.windows = windows;
  }

  /**
   * Send ops in chunks of ≤30, sequentially, in the order given. Returns one
   * result per op (keyed by bId). With stopOnFault, chunks after the first
   * one containing a fault are not sent (their ops come back without a
   * result — the caller reports them as not attempted).
   */
  async run(
    realmId: string,
    ops: BatchOp[],
    options: { context?: string; stopOnFault?: boolean } = {}
  ): Promise<Map<string, BatchOpResult>> {
    const results = new Map<string, BatchOpResult>();
    const nonce = randomUUID();
    const opThrottles = new Map<string, number>();
    let queue = ops.slice();
    let chunkNo = 0;
    while (queue.length > 0) {
      const chunk = queue.slice(0, this.chunkSize);
      queue = queue.slice(this.chunkSize);
      chunkNo++;
      const outcome = await this.sendChunk(realmId, chunk, `${nonce}:${chunkNo}`, options.context);
      const throttledOps: BatchOp[] = [];
      let sawFault = false;
      for (const op of chunk) {
        const r = outcome.get(op.bId)!;
        if (r.fault && isThrottleFault(r.fault)) {
          const n = (opThrottles.get(op.bId) ?? 0) + 1;
          opThrottles.set(op.bId, n);
          if (n <= this.maxRetries) {
            throttledOps.push(op);
            continue;
          }
          r.attempts += n - 1;
        }
        results.set(op.bId, r);
        if (!r.ok) {
          sawFault = true;
          this.logFault(realmId, op, r.fault, options.context);
        }
      }
      if (throttledOps.length > 0) {
        // Item-level throttle: back off, then resend just those ops (a new
        // body, so a new requestid — they were rejected, not committed).
        this.stats.throttled++;
        this.stats.retries++;
        await this.backoff(Math.max(...throttledOps.map((o) => opThrottles.get(o.bId) ?? 1)), null);
        queue = [...throttledOps, ...queue];
      }
      if (sawFault && options.stopOnFault) break;
    }
    return results;
  }

  private async sendChunk(realmId: string, chunk: BatchOp[], key: string, context?: string): Promise<Map<string, BatchOpResult>> {
    const items = chunk.map((op) => {
      const item: Record<string, unknown> = { bId: op.bId, operation: op.operation, [op.entity]: op.payload };
      return item;
    });
    const requestId = createHash('sha256').update(`${realmId}|batch|${key}|${chunk.map((c) => c.bId).join(',')}`).digest('hex').slice(0, 40);
    let attempt = 0;
    for (;;) {
      attempt++;
      await this.acquire(realmId);
      this.stats.requests++;
      try {
        const body = await this.transport(realmId, items, requestId);
        const topFault = body?.Fault ? faultFrom(body.Fault) : null;
        if (topFault && isThrottleFault(topFault) && attempt <= this.maxRetries) {
          this.stats.throttled++;
          this.stats.retries++;
          await this.backoff(attempt, null);
          continue;
        }
        const out = new Map<string, BatchOpResult>();
        const responses: any[] = body?.BatchItemResponse ?? [];
        const byId = new Map<string, any>();
        for (const r of responses) if (r?.bId != null) byId.set(String(r.bId), r);
        for (const op of chunk) {
          const r = byId.get(op.bId);
          if (!r) {
            out.set(op.bId, {
              bId: op.bId, ok: false, attempts: attempt,
              fault: topFault ?? { code: 'no_response', message: 'QBO returned no BatchItemResponse for this operation', detail: JSON.stringify(body ?? null).slice(0, 300) },
            });
            continue;
          }
          if (r.Fault) {
            out.set(op.bId, { bId: op.bId, ok: false, fault: faultFrom(r.Fault), attempts: attempt });
            continue;
          }
          out.set(op.bId, { bId: op.bId, ok: true, entity: r[op.entity] ?? firstEntity(r), attempts: attempt });
        }
        return out;
      } catch (err: any) {
        const status = Number(err?.statusCode ?? 0);
        const fault = faultFromError(err);
        const retryable = status === 429 || status === 408 || status === 502 || status === 503 || status === 504 || (fault != null && isThrottleFault(fault)) || isNetworkError(err);
        if (retryable && attempt <= this.maxRetries) {
          if (status === 429 || (fault && isThrottleFault(fault))) this.stats.throttled++;
          this.stats.retries++;
          this.log(`[qbo-batch] realm=${realmId}${context ? ` ${context}` : ''} chunk of ${chunk.length} got ${status || err?.name || 'error'}${fault?.code ? ` (QBO code ${fault.code})` : ''}; retry ${attempt}/${this.maxRetries} with the same requestid`);
          await this.backoff(attempt, retryAfterMs(err));
          continue;
        }
        const failure: QboFault = fault ?? { code: status ? `http_${status}` : 'request_failed', message: String(err?.message ?? err) };
        if (retryable) failure.message = `${failure.message ?? ''} — gave up after ${attempt} attempts (throttled / unavailable). Nothing in this chunk was confirmed; re-run the same call (already-written rows will report unchanged).`.trim();
        const out = new Map<string, BatchOpResult>();
        for (const op of chunk) out.set(op.bId, { bId: op.bId, ok: false, fault: failure, attempts: attempt });
        return out;
      }
    }
  }

  /** Wait until this realm has a free slot in its 60-second window. */
  private async acquire(realmId: string): Promise<void> {
    for (;;) {
      const t = this.now();
      const window = (this.windows.get(realmId) ?? []).filter((ts) => t - ts < 60_000);
      if (window.length < this.perMinute) {
        window.push(t);
        this.windows.set(realmId, window);
        return;
      }
      const wait = 60_000 - (t - window[0]) + 5;
      this.windows.set(realmId, window);
      this.stats.waitedMs += wait;
      await this.sleep(wait);
    }
  }

  private async backoff(attempt: number, retryAfter: number | null): Promise<void> {
    const exp = Math.min(this.maxDelayMs, this.baseDelayMs * 2 ** Math.max(0, attempt - 1));
    const wait = retryAfter != null ? Math.min(this.maxDelayMs, Math.max(retryAfter, this.baseDelayMs)) : exp;
    this.stats.waitedMs += wait;
    await this.sleep(wait);
  }

  private logFault(realmId: string, op: BatchOp, fault: QboFault | undefined, context?: string): void {
    this.log(
      `[qbo-batch] realm=${realmId}${context ? ` ${context}` : ''} ${op.operation} ${op.entity}${op.label ? ` source=${op.label}` : ''} bId=${op.bId} fault code=${fault?.code ?? '?'} type=${fault?.type ?? '?'} message=${JSON.stringify(fault?.message ?? '')} detail=${JSON.stringify(fault?.detail ?? '')}`
    );
  }
}

function firstEntity(r: any): any {
  for (const [k, v] of Object.entries(r ?? {})) if (k !== 'bId' && v && typeof v === 'object') return v;
  return undefined;
}

export function faultFrom(fault: any): QboFault {
  const e = fault?.Error?.[0] ?? {};
  return {
    type: fault?.type,
    code: e.code != null ? String(e.code) : undefined,
    message: e.Message ?? e.message,
    detail: e.Detail ?? e.detail,
    element: e.element || undefined,
  };
}

function faultFromError(err: any): QboFault | null {
  const raw = err?.response;
  if (raw == null) return null;
  let body: any = raw;
  if (typeof raw === 'string') {
    try { body = JSON.parse(raw); } catch { return { message: raw.slice(0, 500) }; }
  }
  if (body?.Fault) return faultFrom(body.Fault);
  if (body?.fault) return faultFrom({ Error: body.fault.error ?? body.fault.Error, type: body.fault.type });
  return null;
}

export function isThrottleFault(f: QboFault): boolean {
  const code = String(f.code ?? '').replace(/^0+/, '');
  const text = `${f.message ?? ''} ${f.detail ?? ''}`.toLowerCase();
  return code === '3001' || text.includes('throttleexceeded') || text.includes('throttle exceeded') || text.includes('too many requests');
}

function isNetworkError(err: any): boolean {
  const code = String(err?.code ?? err?.cause?.code ?? '');
  return ['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'ECONNREFUSED', 'UND_ERR_SOCKET'].includes(code);
}

function retryAfterMs(err: any): number | null {
  const v = err?.retryAfter ?? err?.headers?.['retry-after'];
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n * 1000 : null;
}

/** "Message — Detail (QBO code N)", QBO's text verbatim. */
export function formatFault(f: QboFault | undefined): string {
  if (!f) return 'QBO returned a fault';
  const head = [f.message, f.detail].filter(Boolean).join(' — ');
  return `${head || 'QBO returned a fault'}${f.code ? ` (QBO code ${f.code})` : ''}`;
}
