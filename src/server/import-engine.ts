// ─── Bulk import engine: names, items, transactions, index, rollback ────────
//
// Orchestration behind the six bulk-import MCP tools. Talks to QBO only
// through the injected QueryFn / preferences getter / BatchRunner, and to the
// mapping store through ImportStore, so the whole flow is testable with a
// mocked QBO (tests/support/fake-qbo-ledger.ts).
//
// Philosophy (same as batch_create_accounts): every row gets its own status
// and plain-English message; nothing a single row does aborts the batch.

import { createHash } from 'node:crypto';
import type { BatchOp, BatchOpResult, BatchRunner, QboFault } from './qbo-batch.js';
import { formatFault } from './qbo-batch.js';
import { displayName as accountDisplayName, type QboAccount } from './account-hierarchy.js';
import {
  loadCompanyContext,
  queryAll,
  queryByIds,
  resolveAccount,
  resolveNamed,
  itemNameForAccount,
  addNameToIndex,
  type CompanyContext,
  type QueryFn,
} from './import-context.js';
import {
  buildTransaction,
  cents,
  hasStamp,
  isValidDate,
  parseStamps,
  qboDocNumber,
  qboTxnAmount,
  txnTypeForQbo,
  type BuildOptions,
  type LinkLookup,
} from './import-build.js';
import { stampLineIds, stampDepositLineIds, journalLineKind, expenseLineKind, salesLineKind } from './line-converters.js';
import { DOC_NUMBER_MAX_LENGTH } from './doc-number.js';
import type { ImportRecord, ImportStore } from '../db/import-store.js';
import {
  DEFAULT_ITEM_NAME_PATTERN,
  IMPORT_QBO_ENTITIES,
  PAYMENT_TYPES,
  QBO_ENTITY_FOR,
  type ItemRow,
  type NameRow,
  type NameType,
  type NormalizedTransaction,
  type TxnType,
} from './import-schema.js';

export interface EngineDeps {
  realmId: string;
  clientName: string;
  query: QueryFn;
  getPrefs: () => Promise<any>;
  runner: BatchRunner;
  store: ImportStore;
}

export type RowStatus =
  | 'created' | 'updated' | 'unchanged' | 'skipped' | 'blocked' | 'failed'
  | 'would_create' | 'would_update';

const ALL_STATUSES: RowStatus[] = ['created', 'updated', 'unchanged', 'skipped', 'blocked', 'failed', 'would_create', 'would_update'];

function emptyCounts(): Record<RowStatus, number> {
  return Object.fromEntries(ALL_STATUSES.map((s) => [s, 0])) as Record<RowStatus, number>;
}

/** Stable JSON (sorted keys) → sha256, so key order never makes a row "changed". */
export function payloadHash(value: unknown): string {
  const stable = (v: any): any => {
    if (Array.isArray(v)) return v.map(stable);
    if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => [k, stable(v[k])]));
    return v;
  };
  return createHash('sha256').update(JSON.stringify(stable(value))).digest('hex').slice(0, 32);
}

/** Total of a normalized transaction, computed the way the builder does. */
export function normalizedAmount(t: NormalizedTransaction): number {
  const lines = t.lines ?? [];
  if (t.txn_type === 'JournalEntry') return lines.filter((l) => l.posting_type === 'Debit').reduce((s, l) => s + cents(l.amount), 0) / 100;
  if (t.txn_type === 'Transfer') return t.amount ?? (lines.length === 1 ? lines[0].amount : 0);
  if (t.txn_type === 'Payment' || t.txn_type === 'BillPayment') return t.amount ?? (t.linked ?? []).reduce((s, l) => s + cents(l.amount), 0) / 100;
  return lines.reduce((s, l) => s + cents(l.amount), 0) / 100;
}

/** Plain-English explanation for faults an import commonly hits, QBO's text kept verbatim. */
export function explainImportFault(f: QboFault | undefined, opts: { allowSuffix: boolean; docNumber?: string }): string {
  const raw = formatFault(f);
  const code = String(f?.code ?? '');
  const text = `${f?.message ?? ''} ${f?.detail ?? ''}`.toLowerCase();
  if (code === '6140' || text.includes('duplicate document number')) {
    return `Duplicate document number${opts.docNumber ? ` "${opts.docNumber}"` : ''}: QBO already has a transaction with this number. During the import either turn off Settings → Advanced → Other preferences → "Warn if duplicate check number is used" / "Warn if duplicate bill number is used"${opts.allowSuffix ? '' : ', or re-run with allow_doc_number_suffix=true to let the tool append "-2", "-3", …'}. QBO said: ${raw}`;
  }
  if (text.includes('closed') && (text.includes('period') || text.includes('closing date') || text.includes('password'))) {
    return `QBO rejected a write into the closed period (closing-date password rule). Clear or move the closing date in QBO for the import, or leave this row out. QBO said: ${raw}`;
  }
  if (code === '6000' && text.includes('balance')) return `Journal entry does not balance in QBO's view. QBO said: ${raw}`;
  if (code === '610' || text.includes('object not found') || text.includes('made inactive')) {
    return `A referenced account, name, item or class is inactive or missing in QBO. QBO said: ${raw}`;
  }
  if (code === '5010' || text.includes('stale object')) return `The transaction changed in QBO after it was read (stale SyncToken); re-run — the update re-reads it. QBO said: ${raw}`;
  return `QBO rejected the row: ${raw}`;
}

function nextDocNumber(base: string, n: number): string {
  const suffix = `-${n}`;
  return `${base.slice(0, DOC_NUMBER_MAX_LENGTH - suffix.length)}${suffix}`;
}

// ═════════════════════════════════════════════════════════════════════════════
// import_transactions
// ═════════════════════════════════════════════════════════════════════════════

export interface ImportOptions {
  dryRun: boolean;
  onExisting: 'skip' | 'update' | 'fail';
  runId: string;
  stopOnFirstFailure: boolean;
  allowClosedPeriod: boolean;
  allowDocNumberSuffix: boolean;
  truncateDocNumbers: boolean;
  itemNamePattern: string;
}

export interface ImportRowResult {
  row: number;
  source_id: string;
  txn_type: string;
  txn_date: string;
  amount: number;
  status: RowStatus;
  qbo_type?: string;
  qbo_id?: string;
  doc_number?: string;
  message?: string;
  warnings: string[];
  fault?: QboFault;
}

export interface ImportOutcome {
  results: ImportRowResult[];
  counts: Record<RowStatus, number>;
  notices: string[];
  stats: { batchRequests: number; retries: number; throttled: number; waitedMs: number };
}

interface Existing {
  record?: ImportRecord;
  qboType: string;
  qboId: string;
  syncToken?: string | null;
  txnDate?: string | null;
  amount?: number | null;
  docNumber?: string | null;
  hash: string | null;
  recovered: boolean;
}

interface Pending {
  idx: number;
  txn: NormalizedTransaction;
  mode: 'create' | 'update';
  existing?: Existing;
  hash: string;
  firstRunId?: string;
}

function lineKindFor(qboType: string) {
  if (qboType === 'JournalEntry') return journalLineKind;
  if (qboType === 'Purchase' || qboType === 'Bill' || qboType === 'VendorCredit') return expenseLineKind;
  if (['Invoice', 'CreditMemo', 'SalesReceipt', 'RefundReceipt'].includes(qboType)) return salesLineKind;
  return undefined;
}

/** Carry the fetched transaction's Line.Ids onto the rebuilt lines (QBO appends Id-less lines). */
function stampForUpdate(qboType: string, existing: any, payload: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = { ...payload, Id: String(existing.Id), SyncToken: String(existing.SyncToken ?? '0'), sparse: false };
  if (Array.isArray(payload.Line)) {
    if (qboType === 'Deposit') out.Line = stampDepositLineIds(existing.Line, payload.Line);
    else {
      const kind = lineKindFor(qboType);
      out.Line = stampLineIds(existing.Line, payload.Line, kind ? { lineKind: kind } : {});
    }
  }
  return out;
}

export async function importTransactions(deps: EngineDeps, txns: NormalizedTransaction[], options: ImportOptions): Promise<ImportOutcome> {
  const notices: string[] = [];
  const ctx = await loadCompanyContext(deps.query, deps.getPrefs, { accounts: true, names: true, classes: true, items: true, terms: true, prefs: true });
  const prefs = ctx.prefs;
  const classTrackingOn = prefs.classTrackingPerTxn || prefs.classTrackingPerLine;
  if (prefs.useAccountNumbers === false) notices.push('Account numbers are turned OFF in this company (Settings → Advanced → Chart of accounts). Accounts still resolve by AcctNum, but QBO screens will not show the numbers.');
  if (!classTrackingOn && txns.some((t) => t.class || (t.lines ?? []).some((l) => l.class))) notices.push('Class tracking is OFF in this company: classes on these rows are dropped (each affected row says so).');
  if (prefs.closeDate) notices.push(`Books closing date: ${prefs.closeDate}${options.allowClosedPeriod ? ' (allow_closed_period=true)' : ' — rows on or before it fail unless allow_closed_period=true'}.`);

  const buildOpts: BuildOptions = {
    closeDate: prefs.closeDate,
    allowClosedPeriod: options.allowClosedPeriod,
    classTrackingOn,
    classPerTxn: prefs.classTrackingPerTxn,
    truncateDocNumbers: options.truncateDocNumbers,
    itemNamePattern: options.itemNamePattern || DEFAULT_ITEM_NAME_PATTERN,
  };

  const results: ImportRowResult[] = txns.map((t, i) => ({
    row: i + 1,
    source_id: t.source_id,
    txn_type: t.txn_type,
    txn_date: t.txn_date,
    amount: normalizedAmount(t),
    status: 'failed',
    warnings: [],
  }));
  const decided = new Set<number>();
  const decide = (idx: number, patch: Partial<ImportRowResult>) => {
    Object.assign(results[idx], patch);
    decided.add(idx);
  };

  // Duplicate source_ids inside this call: the first row keeps it.
  const firstRow = new Map<string, number>();
  txns.forEach((t, i) => {
    const prev = firstRow.get(t.source_id);
    if (prev != null) decide(i, { status: 'failed', message: `Duplicate source_id within this call: row ${prev + 1} already uses "${t.source_id}". source_id must be unique per company.` });
    else firstRow.set(t.source_id, i);
  });

  // ── Existing mappings: the store first, then the stamps already in QBO ──
  const live = deps.store.getLive(deps.realmId, [...firstRow.keys()]);
  const existingFor = new Map<string, Existing>();
  for (const [sid, rec] of live) {
    existingFor.set(sid, { record: rec, qboType: rec.qbo_type, qboId: rec.qbo_id, syncToken: rec.sync_token, txnDate: rec.txn_date, amount: rec.amount, docNumber: rec.doc_number, hash: rec.payload_hash, recovered: rec.payload_hash == null });
  }
  const unknown = [...firstRow.entries()].filter(([sid, i]) => !existingFor.has(sid) && !decided.has(i) && isValidDate(txns[i].txn_date));
  if (unknown.length > 0) {
    const byEntity = new Map<string, { min: string; max: string; ids: Set<string> }>();
    for (const [sid, i] of unknown) {
      const ent = QBO_ENTITY_FOR[txns[i].txn_type];
      const r = byEntity.get(ent) ?? { min: txns[i].txn_date, max: txns[i].txn_date, ids: new Set<string>() };
      if (txns[i].txn_date < r.min) r.min = txns[i].txn_date;
      if (txns[i].txn_date > r.max) r.max = txns[i].txn_date;
      r.ids.add(sid);
      byEntity.set(ent, r);
    }
    for (const [ent, r] of byEntity) {
      const found = await queryAll(deps.query, ent, `TxnDate >= '${r.min}' AND TxnDate <= '${r.max}'`);
      const hits = new Map<string, any[]>();
      for (const e of found) for (const sid of parseStamps(e.PrivateNote)) if (r.ids.has(sid)) hits.set(sid, [...(hits.get(sid) ?? []), e]);
      for (const [sid, list] of hits) {
        const idx = firstRow.get(sid)!;
        if (list.length > 1) {
          decide(idx, { status: 'failed', qbo_type: ent, message: `source_id "${sid}" is already stamped on ${list.length} QBO ${ent} transactions (Ids ${list.map((e) => e.Id).join(', ')}). Resolve the duplicates in QBO (or with delete_imported_transactions force=true) before re-importing.` });
          continue;
        }
        const e = list[0];
        const ex: Existing = { qboType: ent, qboId: String(e.Id), syncToken: e.SyncToken, txnDate: e.TxnDate, amount: qboTxnAmount(ent, e), docNumber: qboDocNumber(ent, e), hash: null, recovered: true };
        existingFor.set(sid, ex);
        if (!options.dryRun) {
          deps.store.upsertLive({
            client: deps.clientName, realm_id: deps.realmId, source_id: sid, run_id: options.runId,
            txn_type: txnTypeForQbo(ent, e) ?? txns[idx].txn_type, qbo_type: ent, qbo_id: String(e.Id), sync_token: e.SyncToken ?? null,
            doc_number: ex.docNumber, txn_date: e.TxnDate ?? null, amount: ex.amount, status: 'indexed', payload_hash: null,
            message: 'found in QBO by its [src:] stamp during import_transactions (not in the store)',
          });
          ex.record = deps.store.getLive(deps.realmId, [sid]).get(sid);
        }
      }
    }
  }

  // ── Classify every row ──
  const pending: Pending[] = [];
  txns.forEach((t, idx) => {
    if (decided.has(idx)) return;
    const hash = payloadHash(t);
    const ex = existingFor.get(t.source_id);
    const wantEntity = QBO_ENTITY_FOR[t.txn_type];
    if (!ex) {
      pending.push({ idx, txn: t, mode: 'create', hash });
      return;
    }
    const base = { qbo_type: ex.qboType, qbo_id: ex.qboId, doc_number: ex.docNumber ?? undefined };
    if (ex.qboType !== wantEntity) {
      decide(idx, { ...base, status: 'failed', message: `source_id "${t.source_id}" is already imported as a ${ex.qboType} (Id ${ex.qboId})${ex.record ? `, ${ex.record.txn_type}` : ''}; it cannot become a ${t.txn_type} (${wantEntity}). Delete it first with delete_imported_transactions, or use a different source_id.` });
      return;
    }
    let same = ex.hash != null && ex.hash === hash;
    if (ex.hash == null) {
      // Recovered from a stamp: no hash to compare, so compare what QBO shows.
      const dateSame = !ex.txnDate || ex.txnDate === t.txn_date;
      const amtSame = ex.amount == null || cents(ex.amount) === cents(normalizedAmount(t));
      same = dateSame && amtSame;
      if (same && ex.record && !options.dryRun) deps.store.setPayloadHash(ex.record.id, hash);
    }
    if (same) {
      decide(idx, { ...base, status: 'unchanged', message: `already imported as ${ex.qboType} ${ex.qboId}${ex.recovered ? ' (matched by date and amount to the stamped QBO transaction)' : ''}` });
      return;
    }
    if (options.onExisting === 'skip') {
      decide(idx, { ...base, status: 'skipped', message: `already imported as ${ex.qboType} ${ex.qboId}, but this row differs from what was imported. Re-run with on_existing="update" to apply the changes.` });
      return;
    }
    if (options.onExisting === 'fail') {
      decide(idx, { ...base, status: 'failed', message: `already imported as ${ex.qboType} ${ex.qboId} and this row differs (on_existing="fail").` });
      return;
    }
    pending.push({ idx, txn: t, mode: 'update', existing: ex, hash, firstRunId: ex.record?.run_id });
  });

  // ── Link resolution for Payment / BillPayment ──
  const linkFor = (sid: string): LinkLookup => {
    const inCall = firstRow.get(sid);
    if (inCall != null) {
      const r = results[inCall];
      if (decided.has(inCall)) {
        if (['created', 'updated', 'unchanged', 'skipped'].includes(r.status) && r.qbo_id) return { status: 'ready', qboId: r.qbo_id, qboType: r.qbo_type ?? QBO_ENTITY_FOR[txns[inCall].txn_type] };
        if (r.status === 'would_create' || r.status === 'would_update') return r.qbo_id ? { status: 'ready', qboId: r.qbo_id, qboType: r.qbo_type! } : { status: 'pending', qboType: r.qbo_type ?? QBO_ENTITY_FOR[txns[inCall].txn_type] };
        return { status: 'blocked', reason: `Linked ${txns[inCall].txn_type} ${sid} (row ${inCall + 1}) did not load (${r.status}); this row loads on the next pass once it does.` };
      }
    }
    const rec = existingFor.get(sid) ?? (() => {
      const l = deps.store.getLive(deps.realmId, [sid]).get(sid);
      return l ? { qboType: l.qbo_type, qboId: l.qbo_id } as Existing : undefined;
    })();
    if (rec) return { status: 'ready', qboId: rec.qboId, qboType: rec.qboType };
    return { status: 'blocked', reason: `Linked transaction ${sid} is not imported yet (not in the import store). This row is blocked, not failed: load ${sid} first and re-run — it will then link.` };
  };

  const stats = { batchRequests: 0, retries: 0, throttled: 0, waitedMs: 0 };
  let stopped = false;
  const stopNote = (why: string) => `not attempted: stop_on_first_failure — ${why}`;

  const phases: Pending[][] = [
    pending.filter((p) => !PAYMENT_TYPES.has(p.txn.txn_type)),
    pending.filter((p) => PAYMENT_TYPES.has(p.txn.txn_type)),
  ];

  for (const phase of phases) {
    if (phase.length === 0) continue;
    if (stopped) {
      for (const p of phase) decide(p.idx, { status: 'skipped', message: stopNote('an earlier row failed') });
      continue;
    }
    // Fetch current versions of rows being updated (SyncToken + Line Ids).
    const current = new Map<string, any>();
    const updates = phase.filter((p) => p.mode === 'update');
    if (updates.length > 0) {
      const byType = new Map<string, string[]>();
      for (const p of updates) byType.set(p.existing!.qboType, [...(byType.get(p.existing!.qboType) ?? []), p.existing!.qboId]);
      for (const [type, ids] of byType) {
        const got = await queryByIds(deps.query, type, ids);
        for (const [id, e] of got) current.set(`${type}:${id}`, e);
      }
    }

    const ops: Array<{ op: BatchOp; p: Pending; docNumber?: string; built: ReturnType<typeof buildTransaction> & { kind: 'ok' } }> = [];
    for (const p of phase) {
      const r = buildTransaction(p.txn, ctx, buildOpts, linkFor);
      const warnings = r.kind === 'ok' ? r.built.warnings : r.warnings;
      if (r.kind === 'failed') {
        decide(p.idx, { status: 'failed', warnings, message: r.errors.join(' '), qbo_type: p.existing?.qboType, qbo_id: p.existing?.qboId });
        continue;
      }
      if (r.kind === 'blocked') {
        decide(p.idx, { status: 'blocked', warnings, message: r.reason });
        continue;
      }
      const built = r.built;
      if (p.mode === 'update') {
        const cur = current.get(`${p.existing!.qboType}:${p.existing!.qboId}`);
        if (!cur) {
          decide(p.idx, { status: 'failed', warnings, qbo_type: p.existing!.qboType, qbo_id: p.existing!.qboId, message: `The store maps this row to ${p.existing!.qboType} ${p.existing!.qboId}, but QBO no longer has it. Run rebuild_import_index to verify, or delete_imported_transactions for this source_id, then re-import.` });
          continue;
        }
        if (options.dryRun) {
          decide(p.idx, { status: 'would_update', warnings, qbo_type: built.qboType, qbo_id: p.existing!.qboId, doc_number: built.docNumber, amount: built.amount, message: `would update ${built.qboType} ${p.existing!.qboId}` });
          continue;
        }
        ops.push({ p, built: r, docNumber: built.docNumber, op: { bId: `r${p.idx + 1}`, operation: 'update', entity: built.qboType, payload: stampForUpdate(built.qboType, cur, built.payload), label: p.txn.source_id } });
      } else {
        if (options.dryRun) {
          decide(p.idx, { status: 'would_create', warnings, qbo_type: built.qboType, doc_number: built.docNumber, amount: built.amount, message: `would create ${built.qboType}` });
          continue;
        }
        ops.push({ p, built: r, docNumber: built.docNumber, op: { bId: `r${p.idx + 1}`, operation: 'create', entity: built.qboType, payload: built.payload, label: p.txn.source_id } });
      }
    }

    const phaseFailed = results.some((r, i) => r.status === 'failed' && decided.has(i));
    if (options.stopOnFirstFailure && phaseFailed) {
      for (const o of ops) decide(o.p.idx, { status: 'skipped', warnings: o.built.built.warnings, message: stopNote('a row failed validation, so nothing in this phase was written') });
      stopped = true;
      continue;
    }
    if (ops.length === 0) continue;

    let queue = ops;
    let suffixRound = 1;
    while (queue.length > 0) {
      const res: Map<string, BatchOpResult> = await deps.runner.run(deps.realmId, queue.map((o) => o.op), { context: `run=${options.runId} tool=import_transactions`, stopOnFault: options.stopOnFirstFailure });
      const retry: typeof ops = [];
      for (const o of queue) {
        const r = res.get(o.op.bId);
        const warnings = o.built.built.warnings;
        if (!r) {
          decide(o.p.idx, { status: 'skipped', warnings, message: stopNote('an earlier batch request had a failure') });
          continue;
        }
        if (r.ok) {
          const e = r.entity ?? {};
          const qboId = String(e.Id ?? '');
          const docNumber = qboDocNumber(o.op.entity, e) ?? o.docNumber;
          const status: RowStatus = o.p.mode === 'update' ? 'updated' : 'created';
          deps.store.upsertLive({
            client: deps.clientName, realm_id: deps.realmId, source_id: o.p.txn.source_id,
            run_id: o.p.mode === 'update' ? (o.p.firstRunId ?? options.runId) : options.runId,
            txn_type: o.p.txn.txn_type, qbo_type: o.op.entity, qbo_id: qboId, sync_token: e.SyncToken ?? null,
            doc_number: docNumber ?? null, txn_date: o.p.txn.txn_date, amount: o.built.built.amount, status,
            payload_hash: o.p.hash,
            message: o.p.mode === 'update' ? `updated by run ${options.runId}` : null,
          });
          const suffixed = o.docNumber && o.docNumber !== o.built.built.docNumber ? [`DocNumber changed to "${o.docNumber}" (the original was a duplicate, QBO code 6140)`] : [];
          decide(o.p.idx, { status, warnings: [...warnings, ...suffixed], qbo_type: o.op.entity, qbo_id: qboId, doc_number: docNumber ?? undefined, amount: o.built.built.amount, message: o.p.mode === 'update' ? `updated ${o.op.entity} ${qboId}` : undefined });
          continue;
        }
        const isDup = String(r.fault?.code ?? '') === '6140' || /duplicate document number/i.test(`${r.fault?.message ?? ''} ${r.fault?.detail ?? ''}`);
        const baseDoc = o.built.built.docNumber;
        if (isDup && options.allowDocNumberSuffix && baseDoc && suffixRound <= 3) {
          const nextDoc = nextDocNumber(baseDoc, suffixRound + 1);
          const field = o.op.entity === 'Payment' ? 'PaymentRefNum' : 'DocNumber';
          retry.push({ ...o, docNumber: nextDoc, op: { ...o.op, bId: `${o.op.bId}s${suffixRound}`, payload: { ...o.op.payload, [field]: nextDoc } } });
          continue;
        }
        decide(o.p.idx, { status: 'failed', warnings, fault: r.fault, qbo_type: o.op.entity, qbo_id: o.p.existing?.qboId, message: explainImportFault(r.fault, { allowSuffix: options.allowDocNumberSuffix, docNumber: o.docNumber }) });
        if (options.stopOnFirstFailure) stopped = true;
      }
      queue = stopped ? [] : retry;
      if (stopped) for (const o of retry) decide(o.p.idx, { status: 'skipped', message: stopNote('a row failed') });
      suffixRound++;
    }
    stats.batchRequests = deps.runner.stats.requests;
    stats.retries = deps.runner.stats.retries;
    stats.throttled = deps.runner.stats.throttled;
    stats.waitedMs = deps.runner.stats.waitedMs;
  }

  const counts = emptyCounts();
  for (const r of results) counts[r.status]++;
  return { results, counts, notices, stats };
}

// ═════════════════════════════════════════════════════════════════════════════
// batch_create_names
// ═════════════════════════════════════════════════════════════════════════════

export interface NameRowResult {
  row: number;
  display_name: string;
  name_type: NameType;
  status: RowStatus;
  id?: string;
  source_id?: string;
  message?: string;
}

function nameDiffs(existing: any, row: NameRow, termId: string | null): { diffs: string[]; patch: Record<string, unknown> } {
  const diffs: string[] = [];
  const patch: Record<string, unknown> = {};
  const cmp = (label: string, field: string, want: unknown, have: unknown) => {
    if (want === undefined) return;
    if (String(have ?? '') !== String(want ?? '')) {
      diffs.push(`${label} "${have ?? ''}" → "${want}"`);
      patch[field] = want;
    }
  };
  cmp('company name', 'CompanyName', row.company_name, existing.CompanyName);
  cmp('first name', 'GivenName', row.given_name, existing.GivenName);
  cmp('last name', 'FamilyName', row.family_name, existing.FamilyName);
  if (row.email !== undefined && (existing.PrimaryEmailAddr?.Address ?? '') !== row.email) {
    diffs.push(`email "${existing.PrimaryEmailAddr?.Address ?? ''}" → "${row.email}"`);
    patch.PrimaryEmailAddr = { Address: row.email };
  }
  if (row.phone !== undefined && (existing.PrimaryPhone?.FreeFormNumber ?? '') !== row.phone) {
    diffs.push(`phone "${existing.PrimaryPhone?.FreeFormNumber ?? ''}" → "${row.phone}"`);
    patch.PrimaryPhone = { FreeFormNumber: row.phone };
  }
  if (row.billing_address) {
    const field = row.name_type === 'Employee' ? 'PrimaryAddr' : 'BillAddr';
    const have = existing[field] ?? {};
    const want = toAddress(row.billing_address);
    const changed = Object.entries(want).some(([k, v]) => String(have[k] ?? '') !== String(v));
    if (changed) {
      diffs.push('billing address');
      patch[field] = { ...(have.Id ? { Id: have.Id } : {}), ...want };
    }
  }
  if (row.name_type === 'Vendor') {
    if (row.vendor_1099 !== undefined && Boolean(existing.Vendor1099) !== row.vendor_1099) {
      diffs.push(`1099 ${Boolean(existing.Vendor1099)} → ${row.vendor_1099}`);
      patch.Vendor1099 = row.vendor_1099;
    }
    const acctNum = row.account_number ?? row.source_id;
    cmp('account number', 'AcctNum', acctNum, existing.AcctNum);
    if (termId && String(existing.TermRef?.value ?? '') !== termId) {
      diffs.push('terms');
      patch.TermRef = { value: termId };
    }
  }
  if (row.name_type === 'Customer') {
    const notes = customerNotes(row);
    if (notes !== undefined && String(existing.Notes ?? '') !== notes) {
      diffs.push('notes');
      patch.Notes = notes;
    }
    if (termId && String(existing.SalesTermRef?.value ?? '') !== termId) {
      diffs.push('terms');
      patch.SalesTermRef = { value: termId };
    }
  }
  const wantActive = row.active ?? true;
  if ((existing.Active !== false) !== wantActive) {
    diffs.push(wantActive ? 'inactive → active' : 'active → inactive');
    patch.Active = wantActive;
  }
  return { diffs, patch };
}

function toAddress(a: NonNullable<NameRow['billing_address']>): Record<string, string> {
  const out: Record<string, string> = {};
  if (a.street !== undefined) out.Line1 = a.street;
  if (a.city !== undefined) out.City = a.city;
  if (a.state !== undefined) out.CountrySubDivisionCode = a.state;
  if (a.postal_code !== undefined) out.PostalCode = a.postal_code;
  if (a.country !== undefined) out.Country = a.country;
  return out;
}

function customerNotes(row: NameRow): string | undefined {
  if (row.notes === undefined && !row.source_id) return undefined;
  const parts = [row.notes?.trim(), row.source_id ? `[src:${row.source_id}]` : undefined].filter(Boolean);
  return parts.join(' ');
}

function namePayload(row: NameRow, termId: string | null, notes: string[]): Record<string, unknown> {
  const p: Record<string, unknown> = { DisplayName: row.display_name };
  if (row.company_name) p.CompanyName = row.company_name;
  let given = row.given_name;
  let family = row.family_name;
  if (row.name_type === 'Employee' && !given && !family) {
    const parts = row.display_name.trim().split(/\s+/);
    given = parts[0];
    family = parts.length > 1 ? parts.slice(1).join(' ') : undefined;
    notes.push(`employee first/last name taken from display name ("${given}"${family ? ` / "${family}"` : ''})`);
  }
  if (given) p.GivenName = given;
  if (family) p.FamilyName = family;
  if (row.email) p.PrimaryEmailAddr = { Address: row.email };
  if (row.phone) p.PrimaryPhone = { FreeFormNumber: row.phone };
  if (row.billing_address) p[row.name_type === 'Employee' ? 'PrimaryAddr' : 'BillAddr'] = toAddress(row.billing_address);
  if (row.active === false) p.Active = false;
  if (row.name_type === 'Vendor') {
    if (row.vendor_1099 !== undefined) p.Vendor1099 = row.vendor_1099;
    const acctNum = row.account_number ?? row.source_id;
    if (acctNum) p.AcctNum = acctNum;
    if (row.account_number && row.source_id) notes.push('source_id not stored (AcctNum holds account_number)');
    if (termId) p.TermRef = { value: termId };
    if (row.notes) notes.push('notes ignored (QBO vendors have no Notes field via the API)');
  } else if (row.name_type === 'Customer') {
    const n = customerNotes(row);
    if (n) p.Notes = n;
    if (termId) p.SalesTermRef = { value: termId };
    if (row.vendor_1099 !== undefined || row.account_number) notes.push('vendor_1099 / account_number ignored for a Customer');
  } else {
    if (row.terms || row.vendor_1099 !== undefined || row.account_number || row.notes) notes.push('terms / vendor_1099 / account_number / notes ignored for an Employee');
    if (row.company_name) delete p.CompanyName;
  }
  return p;
}

export function validateDisplayName(name: string): string | null {
  if (!name.trim()) return 'display_name is empty.';
  if (/[:\t\r\n]/.test(name)) return `display_name "${name}" contains a colon, tab or line break; QBO display names cannot (a colon marks a sub-customer).`;
  if (name.length > 500) return `display_name is ${name.length} characters; QBO allows at most 500.`;
  return null;
}

export async function batchCreateNames(deps: Omit<EngineDeps, 'store'>, rows: NameRow[], options: { dryRun: boolean; onExisting: 'skip' | 'update' }): Promise<{ results: NameRowResult[]; counts: Record<RowStatus, number> }> {
  const ctx = await loadCompanyContext(deps.query, deps.getPrefs, { names: true, terms: true });
  const results: NameRowResult[] = rows.map((r, i) => ({ row: i + 1, display_name: r.display_name, name_type: r.name_type, status: 'failed', source_id: r.source_id }));
  const seen = new Map<string, number>();
  const ops: Array<{ idx: number; op: BatchOp; mode: 'create' | 'update'; notes: string[]; diffs: string[] }> = [];

  rows.forEach((row, idx) => {
    const res = results[idx];
    const k = row.display_name.trim().toLowerCase();
    const bad = validateDisplayName(row.display_name);
    if (bad) { res.message = bad; return; }
    const prev = seen.get(k);
    if (prev != null) {
      res.message = `Duplicate within this batch: row ${prev + 1} already has display name "${rows[prev].display_name}" (${rows[prev].name_type}). QBO display names are unique across vendors, customers and employees.`;
      return;
    }
    seen.set(k, idx);
    let termId: string | null = null;
    if (row.terms && row.name_type !== 'Employee') {
      const t = resolveNamed(ctx.terms, row.terms, 'term', 'terms', 'Check the name with query_transactions "SELECT * FROM Term".');
      if (!t.ok) { res.message = t.error; return; }
      termId = String(t.value.Id);
    }
    const hits = ctx.names.get(k) ?? [];
    const exact = hits.filter((h) => h.displayName.trim().toLowerCase() === k || h.displayName.replace(/\s*\(deleted\)$/i, '').trim().toLowerCase() === k);
    const same = exact.find((h) => h.type === row.name_type);
    const other = exact.find((h) => h.type !== row.name_type);
    if (!same && other) {
      res.id = undefined;
      res.message = `"${row.display_name}" already exists as a ${other.type} (Id ${other.id}${other.active ? '' : ', inactive'}). QBO requires display names to be unique across vendors, customers and employees combined, so a ${row.name_type} cannot use it — give the ${row.name_type} a distinct display name (e.g. "${row.display_name} (${row.name_type})") or use the existing ${other.type}.`;
      return;
    }
    if (same) {
      res.id = same.id;
      const { diffs, patch } = nameDiffs(same.raw, row, termId);
      if (diffs.length === 0) {
        res.status = 'unchanged';
        res.message = `exists as ${row.name_type} ${same.id}`;
        return;
      }
      if (options.onExisting === 'skip') {
        res.status = 'unchanged';
        res.message = `exists as ${row.name_type} ${same.id}; differs: ${diffs.join('; ')} — re-run with on_existing="update" to apply`;
        return;
      }
      if (options.dryRun) {
        res.status = 'would_update';
        res.message = `would change: ${diffs.join('; ')}`;
        return;
      }
      ops.push({ idx, mode: 'update', notes: [], diffs, op: { bId: `n${idx + 1}`, operation: 'update', entity: row.name_type, payload: { Id: same.id, SyncToken: String(same.raw.SyncToken ?? '0'), sparse: true, ...patch }, label: row.display_name } });
      return;
    }
    const notes: string[] = [];
    const payload = namePayload(row, termId, notes);
    if (options.dryRun) {
      res.status = 'would_create';
      res.message = ['would create', ...notes].join('; ');
      return;
    }
    ops.push({ idx, mode: 'create', notes, diffs: [], op: { bId: `n${idx + 1}`, operation: 'create', entity: row.name_type, payload, label: row.display_name } });
  });

  if (ops.length > 0) {
    const res = await deps.runner.run(deps.realmId, ops.map((o) => o.op), { context: 'tool=batch_create_names' });
    for (const o of ops) {
      const r = res.get(o.op.bId);
      const out = results[o.idx];
      if (r?.ok) {
        out.status = o.mode === 'create' ? 'created' : 'updated';
        out.id = String(r.entity?.Id ?? '');
        const parts = o.mode === 'update' ? [`changed: ${o.diffs.join('; ')}`] : o.notes;
        out.message = parts.length ? parts.join('; ') : undefined;
        if (o.mode === 'create' && r.entity) addNameToIndex(ctx.names, rows[o.idx].name_type, r.entity);
      } else {
        out.status = 'failed';
        const f = r?.fault;
        const dup = String(f?.code ?? '') === '6240' || /duplicate name/i.test(`${f?.message ?? ''} ${f?.detail ?? ''}`);
        out.message = dup
          ? `QBO says the display name is already used (by a vendor, customer, employee or an inactive one). QBO said: ${formatFault(f)}`
          : `QBO rejected the row: ${formatFault(f)}`;
      }
    }
  }
  const counts = emptyCounts();
  for (const r of results) counts[r.status]++;
  return { results, counts };
}

// ═════════════════════════════════════════════════════════════════════════════
// ensure_items
// ═════════════════════════════════════════════════════════════════════════════

export interface ItemRowResult {
  row: number;
  account: string;
  item_name: string;
  status: RowStatus;
  id?: string;
  message?: string;
}

export async function ensureItems(deps: Omit<EngineDeps, 'store'>, rows: ItemRow[], options: { dryRun: boolean; onExisting: 'skip' | 'update'; namePattern: string }): Promise<{ results: ItemRowResult[]; counts: Record<RowStatus, number> }> {
  const ctx: CompanyContext = await loadCompanyContext(deps.query, deps.getPrefs, { accounts: true, items: true });
  const pattern = options.namePattern || DEFAULT_ITEM_NAME_PATTERN;
  const results: ItemRowResult[] = rows.map((r, i) => ({ row: i + 1, account: r.account_number ?? r.account_name ?? '', item_name: r.item_name ?? '', status: 'failed' }));
  const claimed = new Map<string, { idx: number; accountId: string }>();
  const ops: Array<{ idx: number; op: BatchOp; mode: 'create' | 'update' }> = [];

  rows.forEach((row, idx) => {
    const res = results[idx];
    const acct = resolveAccount(ctx, { number: row.account_number, name: row.account_name }, 'income account');
    if (!acct.ok) { res.message = acct.error; return; }
    const account: QboAccount = acct.value;
    res.account = `${account.AcctNum ? `${account.AcctNum} ` : ''}${accountDisplayName(account)}`;
    if (account.AccountType === 'Accounts Receivable' || account.AccountType === 'Accounts Payable') {
      res.message = `Account "${accountDisplayName(account)}" is ${account.AccountType}; QBO does not allow an item to post to A/R or A/P (QBO code 6430). Use an income account.`;
      return;
    }
    let expenseId: string | null = null;
    if (row.expense_account_number || row.expense_account_name) {
      const ex = resolveAccount(ctx, { number: row.expense_account_number, name: row.expense_account_name }, 'expense account');
      if (!ex.ok) { res.message = ex.error; return; }
      expenseId = String(ex.value.Id);
    }
    const name = (row.item_name ?? itemNameForAccount(pattern, account)).trim();
    res.item_name = name;
    if (!name) { res.message = 'Item name is empty.'; return; }
    if (/[:\t\r\n]/.test(name)) { res.message = `Item name "${name}" contains a colon, tab or line break; QBO item names cannot (a colon marks a sub-item).`; return; }
    if (name.length > 100) { res.message = `Item name "${name}" is ${name.length} characters; QBO allows at most 100. Pass a shorter item_name or name_pattern.`; return; }
    const notIncome = !['Income', 'Other Income'].includes(String(account.AccountType));
    const note = notIncome ? `note: "${accountDisplayName(account)}" is ${account.AccountType}, not an income account` : '';
    const k = name.toLowerCase();
    const prior = claimed.get(k);
    if (prior) {
      if (prior.accountId === String(account.Id)) {
        const p = results[prior.idx];
        res.status = p.status === 'failed' ? 'failed' : 'unchanged';
        res.id = p.id;
        res.message = `same item as row ${prior.idx + 1}`;
      } else {
        res.message = `Duplicate within this batch: row ${prior.idx + 1} already uses item name "${name}" for a different account.`;
      }
      return;
    }
    claimed.set(k, { idx, accountId: String(account.Id) });
    const existing = (ctx.items.get(k) ?? []).find((i) => i.Active !== false);
    if (existing) {
      res.id = String(existing.Id);
      const diffs: string[] = [];
      if (String(existing.IncomeAccountRef?.value ?? '') !== String(account.Id)) diffs.push(`income account ${existing.IncomeAccountRef?.value ?? '(none)'} → ${account.Id}`);
      if (expenseId && String(existing.ExpenseAccountRef?.value ?? '') !== expenseId) diffs.push(`expense account ${existing.ExpenseAccountRef?.value ?? '(none)'} → ${expenseId}`);
      if (existing.Type !== 'Service' && existing.Type !== 'NonInventory') diffs.push(`type is ${existing.Type}`);
      if (diffs.length === 0) {
        res.status = 'unchanged';
        res.message = [`exists as item ${existing.Id}`, note].filter(Boolean).join('; ');
        return;
      }
      if (options.onExisting === 'skip' || existing.Type === 'Inventory' || existing.Type === 'Category' || existing.Type === 'Group') {
        res.status = 'skipped';
        res.message = `item "${name}" exists (Id ${existing.Id}) but differs: ${diffs.join('; ')}.${existing.Type === 'Service' || existing.Type === 'NonInventory' ? ' Re-run with on_existing="update" to re-map it.' : ' Choose another item_name.'}`;
        return;
      }
      if (options.dryRun) {
        res.status = 'would_update';
        res.message = `would change: ${diffs.join('; ')}`;
        return;
      }
      const patch: Record<string, unknown> = { Id: String(existing.Id), SyncToken: String(existing.SyncToken ?? '0'), sparse: true, IncomeAccountRef: { value: String(account.Id) } };
      if (expenseId) patch.ExpenseAccountRef = { value: expenseId };
      ops.push({ idx, mode: 'update', op: { bId: `i${idx + 1}`, operation: 'update', entity: 'Item', payload: patch, label: name } });
      return;
    }
    if (options.dryRun) {
      res.status = 'would_create';
      res.message = ['would create Service item', note].filter(Boolean).join('; ');
      return;
    }
    const payload: Record<string, unknown> = { Name: name, Type: 'Service', IncomeAccountRef: { value: String(account.Id) }, Taxable: false };
    if (expenseId) payload.ExpenseAccountRef = { value: expenseId };
    if (row.description) payload.Description = row.description;
    if (note) res.message = note;
    ops.push({ idx, mode: 'create', op: { bId: `i${idx + 1}`, operation: 'create', entity: 'Item', payload, label: name } });
  });

  if (ops.length > 0) {
    const res = await deps.runner.run(deps.realmId, ops.map((o) => o.op), { context: 'tool=ensure_items' });
    for (const o of ops) {
      const r = res.get(o.op.bId);
      const out = results[o.idx];
      if (r?.ok) {
        out.status = o.mode === 'create' ? 'created' : 'updated';
        out.id = String(r.entity?.Id ?? '');
      } else {
        out.status = 'failed';
        out.message = `QBO rejected the item: ${formatFault(r?.fault)}`;
      }
    }
    // Rows that duplicated a created row inherit its Id.
    rows.forEach((_, idx) => {
      const r = results[idx];
      const m = r.message?.match(/^same item as row (\d+)$/);
      if (m) {
        const p = results[Number(m[1]) - 1];
        r.id = p.id;
        r.status = p.status === 'failed' ? 'failed' : 'unchanged';
      }
    });
  }
  const counts = emptyCounts();
  for (const r of results) counts[r.status]++;
  return { results, counts };
}

// ═════════════════════════════════════════════════════════════════════════════
// rebuild_import_index
// ═════════════════════════════════════════════════════════════════════════════

export interface RebuildOutcome {
  scanned: number;
  stamped: number;
  newToStore: Array<{ source_id: string; qbo_type: string; qbo_id: string; txn_date: string; amount: number | null }>;
  alreadyInStore: number;
  conflicts: Array<{ source_id: string; store_qbo: string; qbo: string }>;
  duplicates: Array<{ source_id: string; transactions: string[] }>;
  missingFromQbo: Array<{ source_id: string; qbo_type: string; qbo_id: string; status: string }>;
  perEntity: Record<string, { scanned: number; stamped: number }>;
}

export function entitiesForTypes(types?: TxnType[]): string[] {
  if (!types || types.length === 0) return IMPORT_QBO_ENTITIES;
  return [...new Set(types.map((t) => QBO_ENTITY_FOR[t]))];
}

export async function rebuildImportIndex(deps: EngineDeps, options: { startDate: string; endDate: string; txnTypes?: TxnType[]; runId: string; dryRun: boolean }): Promise<RebuildOutcome> {
  const entities = entitiesForTypes(options.txnTypes);
  const hits = new Map<string, Array<{ entity: string; e: any }>>();
  const out: RebuildOutcome = { scanned: 0, stamped: 0, newToStore: [], alreadyInStore: 0, conflicts: [], duplicates: [], missingFromQbo: [], perEntity: {} };
  const seenQbo = new Set<string>();
  for (const entity of entities) {
    const rows = await queryAll(deps.query, entity, `TxnDate >= '${options.startDate}' AND TxnDate <= '${options.endDate}'`);
    const stats = { scanned: rows.length, stamped: 0 };
    for (const e of rows) {
      const stamps = parseStamps(e.PrivateNote);
      if (stamps.length) stats.stamped++;
      for (const sid of stamps) hits.set(sid, [...(hits.get(sid) ?? []), { entity, e }]);
      seenQbo.add(`${entity}:${e.Id}`);
    }
    out.perEntity[entity] = stats;
    out.scanned += stats.scanned;
    out.stamped += stats.stamped;
  }
  const live = deps.store.getLive(deps.realmId, [...hits.keys()]);
  for (const [sid, list] of hits) {
    if (list.length > 1) {
      out.duplicates.push({ source_id: sid, transactions: list.map((h) => `${h.entity} ${h.e.Id} (${h.e.TxnDate ?? '?'})`) });
      continue;
    }
    const { entity, e } = list[0];
    const rec = live.get(sid);
    if (rec) {
      if (rec.qbo_type === entity && rec.qbo_id === String(e.Id)) out.alreadyInStore++;
      else out.conflicts.push({ source_id: sid, store_qbo: `${rec.qbo_type} ${rec.qbo_id}`, qbo: `${entity} ${e.Id}` });
      continue;
    }
    const amount = qboTxnAmount(entity, e);
    out.newToStore.push({ source_id: sid, qbo_type: entity, qbo_id: String(e.Id), txn_date: e.TxnDate, amount });
    if (!options.dryRun) {
      deps.store.upsertLive({
        client: deps.clientName, realm_id: deps.realmId, source_id: sid, run_id: options.runId,
        txn_type: txnTypeForQbo(entity, e) ?? entity, qbo_type: entity, qbo_id: String(e.Id), sync_token: e.SyncToken ?? null,
        doc_number: qboDocNumber(entity, e), txn_date: e.TxnDate ?? null, amount, status: 'indexed', payload_hash: null,
        message: 'recovered by rebuild_import_index from the PrivateNote stamp',
      });
    }
  }
  // Store rows in range that QBO no longer shows with their stamp.
  const inRange = deps.store.query({ realm_id: deps.realmId, start_date: options.startDate, end_date: options.endDate, include_deleted: false });
  for (const rec of inRange) {
    if (!entities.includes(rec.qbo_type)) continue;
    const h = hits.get(rec.source_id);
    if (!h || !h.some((x) => x.entity === rec.qbo_type && String(x.e.Id) === rec.qbo_id)) {
      out.missingFromQbo.push({ source_id: rec.source_id, qbo_type: rec.qbo_type, qbo_id: rec.qbo_id, status: seenQbo.has(`${rec.qbo_type}:${rec.qbo_id}`) ? 'in QBO but its stamp was edited away' : 'not found in QBO in this date range' });
    }
  }
  return out;
}

// ═════════════════════════════════════════════════════════════════════════════
// delete_imported_transactions
// ═════════════════════════════════════════════════════════════════════════════

export type DeleteStatus = 'deleted' | 'would_delete' | 'refused' | 'not_found' | 'failed';

export interface DeleteRowResult {
  source_id: string;
  txn_type: string;
  qbo_type?: string;
  qbo_id?: string;
  txn_date?: string | null;
  amount?: number | null;
  status: DeleteStatus;
  order: number;
  message?: string;
}

export async function deleteImportedTransactions(deps: EngineDeps, options: { runId?: string; sourceIds?: string[]; dryRun: boolean; force: boolean }): Promise<{ results: DeleteRowResult[]; counts: Record<DeleteStatus, number> }> {
  const rows = deps.store.query({ realm_id: deps.realmId, run_id: options.runId, source_ids: options.sourceIds, include_deleted: false });
  const results: DeleteRowResult[] = [];
  if (options.sourceIds) {
    const have = new Set(rows.map((r) => r.source_id));
    for (const sid of options.sourceIds) {
      if (!have.has(sid)) results.push({ source_id: sid, txn_type: '?', status: 'failed', order: 0, message: options.runId ? `not a live import in run "${options.runId}"` : 'not in the import store as a live import (already deleted, never imported, or the store was lost — run rebuild_import_index first)' });
    }
  }
  const byType = new Map<string, string[]>();
  for (const r of rows) byType.set(r.qbo_type, [...(byType.get(r.qbo_type) ?? []), r.qbo_id]);
  const current = new Map<string, any>();
  for (const [type, ids] of byType) {
    const got = await queryByIds(deps.query, type, ids);
    for (const [id, e] of got) current.set(`${type}:${id}`, e);
  }

  const phaseOf = (r: ImportRecord) => (r.qbo_type === 'Payment' || r.qbo_type === 'BillPayment' ? 1 : 2);
  const ordered = rows.slice().sort((a, b) => phaseOf(a) - phaseOf(b) || b.id - a.id);
  const toDelete: Array<{ rec: ImportRecord; res: DeleteRowResult; op: BatchOp; phase: number }> = [];
  ordered.forEach((rec, i) => {
    const res: DeleteRowResult = { source_id: rec.source_id, txn_type: rec.txn_type, qbo_type: rec.qbo_type, qbo_id: rec.qbo_id, txn_date: rec.txn_date, amount: rec.amount, status: 'failed', order: i + 1 };
    results.push(res);
    const e = current.get(`${rec.qbo_type}:${rec.qbo_id}`);
    if (!e) {
      res.status = 'not_found';
      res.message = `${rec.qbo_type} ${rec.qbo_id} is no longer in QBO${options.dryRun ? '; would mark the store row deleted' : '; store row marked deleted'}`;
      if (!options.dryRun) deps.store.markDeleted(rec.id, 'not found in QBO at delete time (already deleted)');
      return;
    }
    const stamped = hasStamp(e.PrivateNote, rec.source_id);
    if (!stamped && !options.force) {
      res.status = 'refused';
      res.message = `refused: ${rec.qbo_type} ${rec.qbo_id}'s PrivateNote no longer carries [src:${rec.source_id}] — someone edited it in QBO. Check it, then pass force=true to delete anyway.`;
      return;
    }
    const note = stamped ? '' : 'stamp missing — deleted because force=true';
    if (options.dryRun) {
      res.status = 'would_delete';
      res.message = note || undefined;
      return;
    }
    res.message = note || undefined;
    toDelete.push({ rec, res, phase: phaseOf(rec), op: { bId: `d${rec.id}`, operation: 'delete', entity: rec.qbo_type, payload: { Id: String(e.Id), SyncToken: String(e.SyncToken ?? '0') }, label: rec.source_id } });
  });

  for (const phase of [1, 2]) {
    const batch = toDelete.filter((d) => d.phase === phase);
    if (batch.length === 0) continue;
    const res = await deps.runner.run(deps.realmId, batch.map((d) => d.op), { context: `tool=delete_imported_transactions${options.runId ? ` run=${options.runId}` : ''}` });
    for (const d of batch) {
      const r = res.get(d.op.bId);
      if (r?.ok) {
        d.res.status = 'deleted';
        deps.store.markDeleted(d.rec.id, `deleted by delete_imported_transactions${options.force ? ' (force)' : ''}`);
      } else {
        d.res.status = 'failed';
        d.res.message = `QBO refused the delete: ${formatFault(r?.fault)}`;
      }
    }
  }
  const counts: Record<DeleteStatus, number> = { deleted: 0, would_delete: 0, refused: 0, not_found: 0, failed: 0 };
  for (const r of results) counts[r.status]++;
  return { results, counts };
}

// ═════════════════════════════════════════════════════════════════════════════
// import_status
// ═════════════════════════════════════════════════════════════════════════════

export interface StatusSummaryRow {
  txn_type: string;
  status: string;
  count: number;
  amount: number;
}

export function summarizeStatus(rows: ImportRecord[]): StatusSummaryRow[] {
  const map = new Map<string, StatusSummaryRow>();
  for (const r of rows) {
    const k = `${r.txn_type}|${r.status}`;
    const s = map.get(k) ?? { txn_type: r.txn_type, status: r.status, count: 0, amount: 0 };
    s.count++;
    s.amount = (cents(s.amount) + cents(r.amount ?? 0)) / 100;
    map.set(k, s);
  }
  return [...map.values()].sort((a, b) => a.txn_type.localeCompare(b.txn_type) || a.status.localeCompare(b.status));
}
