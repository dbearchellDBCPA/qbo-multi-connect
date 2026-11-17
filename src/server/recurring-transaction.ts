/**
 * RecurringTransaction helpers for get_recurring_transaction /
 * update_recurring_transaction.
 *
 * A RecurringTransaction is not a flat entity: the API wraps the template
 * under its txn type ({ Bill: {...} }, { JournalEntry: {...} }, …) with a
 * nested RecurringInfo / ScheduleInfo block.
 *
 * Intuit's RecurringTransaction docs document create, read-by-id, query, and
 * delete. They do not document a sparse update for this entity (unlike
 * Invoice). The IntuitEntity `sparse` flag is described as output-only, and
 * delete requires the type-wrapped object (not just Id + SyncToken). Updates
 * therefore always send the full fetched object with sparse:false, changing
 * only the requested schedule field so Line arrays cannot be dropped.
 *
 * Docs: https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/recurringtransaction
 */
import { QBOError } from '../api/client.js';

export const RECURRING_TXN_TYPES = [
  'Bill',
  'JournalEntry',
  'Invoice',
  'Purchase',
  'SalesReceipt',
  'CreditMemo',
  'RefundReceipt',
  'Deposit',
  'Transfer',
  'Estimate',
  'PurchaseOrder',
  'VendorCredit',
] as const;

export type RecurringTxnType = (typeof RECURRING_TXN_TYPES)[number];

const TYPE_SET = new Set<string>(RECURRING_TXN_TYPES);

export const SCHEDULE_INFO_FIELDS = [
  'IntervalType',
  'NumInterval',
  'DayOfMonth',
  'DayOfWeek',
  'WeekOfMonth',
  'MonthOfYear',
  'DaysBefore',
  'RemindDays',
  'StartDate',
  'EndDate',
  'MaxOccurrences',
  'NextDate',
  'PreviousDate',
] as const;

export interface RecurringScheduleInfo {
  IntervalType?: string;
  NumInterval?: number;
  DayOfMonth?: number;
  DayOfWeek?: string;
  WeekOfMonth?: number;
  MonthOfYear?: string;
  DaysBefore?: number;
  RemindDays?: number;
  StartDate?: string;
  EndDate?: string;
  MaxOccurrences?: number;
  NextDate?: string;
  PreviousDate?: string;
  [key: string]: unknown;
}

export interface RecurringInfoView {
  Name?: string;
  RecurType?: string;
  Active?: boolean;
  ScheduleInfo: RecurringScheduleInfo;
}

export interface UnwrappedRecurring {
  txnType: RecurringTxnType;
  txn: any;
}

export interface RecurringSummary {
  id: string | null;
  sync_token: string | null;
  recur_data_ref: string | null;
  txn_type: RecurringTxnType;
  total_amt: number | null;
  line_count: number;
  recurring_info: RecurringInfoView;
}

export type ScheduleChange =
  | { end_date: string; max_occurrences?: undefined }
  | { max_occurrences: number; end_date?: undefined };

export class RecurringRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RecurringRequestError';
  }
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function isWrapper(obj: any): obj is Record<string, any> {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
  return Object.keys(obj).some((k) => TYPE_SET.has(k) && obj[k] && typeof obj[k] === 'object');
}

export function unwrapRecurring(envelope: any): UnwrappedRecurring | null {
  const wrapper = extractWrapper(envelope);
  if (!wrapper) return null;
  for (const key of Object.keys(wrapper)) {
    if (TYPE_SET.has(key) && wrapper[key] && typeof wrapper[key] === 'object') {
      return { txnType: key as RecurringTxnType, txn: wrapper[key] };
    }
  }
  return null;
}

function extractWrapper(envelope: any): any | null {
  if (!envelope) return null;
  const list = envelope?.QueryResponse?.RecurringTransaction;
  if (Array.isArray(list) && list.length > 0) return list[0];
  if (envelope?.RecurringTransaction && isWrapper(envelope.RecurringTransaction)) {
    return envelope.RecurringTransaction;
  }
  if (isWrapper(envelope)) return envelope;
  return null;
}

export function listRecurringWrappers(envelope: any): any[] {
  const list = envelope?.QueryResponse?.RecurringTransaction;
  if (Array.isArray(list)) return list;
  const one = extractWrapper(envelope);
  return one ? [one] : [];
}

export function matchesRecurringId(wrapper: any, id: string): boolean {
  const unwrapped = unwrapRecurring(wrapper);
  if (!unwrapped) return false;
  const raw = String(id);
  const txnId = unwrapped.txn?.Id != null ? String(unwrapped.txn.Id) : null;
  const ref = unwrapped.txn?.RecurDataRef?.value != null ? String(unwrapped.txn.RecurDataRef.value) : null;
  return txnId === raw || ref === raw;
}

export function shapeRecurringInfo(info: any): RecurringInfoView {
  const sched = info?.ScheduleInfo ?? {};
  const schedule: RecurringScheduleInfo = {};
  for (const key of SCHEDULE_INFO_FIELDS) {
    if (sched[key] !== undefined) schedule[key] = sched[key];
  }
  // Preserve any other schedule fields QBO sent (don't hide them).
  for (const [key, value] of Object.entries(sched)) {
    if (!(key in schedule)) schedule[key] = value;
  }
  return {
    Name: info?.Name,
    RecurType: info?.RecurType,
    Active: info?.Active,
    ScheduleInfo: schedule,
  };
}

export function summarizeRecurring(unwrapped: UnwrappedRecurring): RecurringSummary {
  const txn = unwrapped.txn ?? {};
  const lines = Array.isArray(txn.Line) ? txn.Line : [];
  return {
    id: txn.Id != null ? String(txn.Id) : null,
    sync_token: txn.SyncToken != null ? String(txn.SyncToken) : null,
    recur_data_ref: txn.RecurDataRef?.value != null ? String(txn.RecurDataRef.value) : null,
    txn_type: unwrapped.txnType,
    total_amt: txn.TotalAmt != null ? Number(txn.TotalAmt) : null,
    line_count: lines.length,
    recurring_info: shapeRecurringInfo(txn.RecurringInfo),
  };
}

export function validateScheduleChange(input: { end_date?: string; max_occurrences?: number }): ScheduleChange {
  const hasEnd = input.end_date !== undefined && input.end_date !== null && String(input.end_date).trim() !== '';
  const hasMax = input.max_occurrences !== undefined && input.max_occurrences !== null;
  if (hasEnd && hasMax) {
    throw new RecurringRequestError(
      'Pass exactly one of end_date or max_occurrences — QBO ScheduleInfo treats them as alternatives ("EndDate or MaxOccurrences"), not both.',
    );
  }
  if (!hasEnd && !hasMax) {
    throw new RecurringRequestError('Pass exactly one of end_date (YYYY-MM-DD) or max_occurrences (positive integer).');
  }
  if (hasEnd) {
    const end = String(input.end_date).trim();
    if (!ISO_DATE.test(end)) {
      throw new RecurringRequestError(`end_date must be YYYY-MM-DD (got "${end}").`);
    }
    return { end_date: end };
  }
  const max = Number(input.max_occurrences);
  if (!Number.isInteger(max) || max < 1) {
    throw new RecurringRequestError(`max_occurrences must be a positive integer (got "${input.max_occurrences}").`);
  }
  return { max_occurrences: max };
}

/**
 * Deep-clone the fetched wrapper, set only the requested schedule field
 * (and Active=true), and keep every other field — especially Line — intact.
 * sparse is forced false: Intuit does not document a sparse update for
 * RecurringTransaction, and a partial write can drop lines.
 *
 * Setting EndDate removes MaxOccurrences (and vice versa) because the
 * official RecurringTransaction docs list them as alternatives.
 */
export function buildRecurringUpdatePayload(
  unwrapped: UnwrappedRecurring,
  change: ScheduleChange,
): { wrapper: Record<string, any>; before: RecurringScheduleInfo; after: RecurringScheduleInfo } {
  if (!unwrapped.txn?.Id || unwrapped.txn.SyncToken == null || unwrapped.txn.SyncToken === '') {
    throw new RecurringRequestError('Fetched RecurringTransaction is missing Id or SyncToken; cannot update.');
  }
  const txn = structuredClone(unwrapped.txn);
  stripWriteNoise(txn);
  if (!txn.RecurringInfo || typeof txn.RecurringInfo !== 'object') {
    txn.RecurringInfo = {};
  }
  if (!txn.RecurringInfo.ScheduleInfo || typeof txn.RecurringInfo.ScheduleInfo !== 'object') {
    txn.RecurringInfo.ScheduleInfo = {};
  }
  const before = shapeRecurringInfo(unwrapped.txn.RecurringInfo).ScheduleInfo;
  txn.RecurringInfo.Active = true;
  if (change.end_date) {
    txn.RecurringInfo.ScheduleInfo.EndDate = change.end_date;
    delete txn.RecurringInfo.ScheduleInfo.MaxOccurrences;
  } else {
    txn.RecurringInfo.ScheduleInfo.MaxOccurrences = change.max_occurrences;
    delete txn.RecurringInfo.ScheduleInfo.EndDate;
  }
  txn.sparse = false;
  const after = shapeRecurringInfo(txn.RecurringInfo).ScheduleInfo;
  return { wrapper: { [unwrapped.txnType]: txn }, before, after };
}

const NOISE_KEY = /^(domain|CustomExtensions)$|^[A-Z][A-Za-z]*Ex$/;

function stripWriteNoise(value: any): void {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) stripWriteNoise(item);
    return;
  }
  for (const key of Object.keys(value)) {
    if (NOISE_KEY.test(key)) {
      delete value[key];
      continue;
    }
    stripWriteNoise(value[key]);
  }
}

export function scheduleDiff(
  before: RecurringScheduleInfo,
  after: RecurringScheduleInfo,
): Record<string, { from: unknown; to: unknown }> {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const diff: Record<string, { from: unknown; to: unknown }> = {};
  for (const key of keys) {
    const from = before[key];
    const to = after[key];
    if (!Object.is(from, to) && JSON.stringify(from) !== JSON.stringify(to)) {
      diff[key] = { from: from ?? null, to: to ?? null };
    }
  }
  return diff;
}

export function lineFingerprint(txn: any): { line_count: number; line_ids: string[]; amounts: number[]; total_amt: number | null } {
  const lines = Array.isArray(txn?.Line) ? txn.Line : [];
  return {
    line_count: lines.length,
    line_ids: lines.map((l: any) => (l?.Id != null ? String(l.Id) : '')),
    amounts: lines.map((l: any) => Number(l?.Amount ?? 0)),
    total_amt: txn?.TotalAmt != null ? Number(txn.TotalAmt) : null,
  };
}

export function linesUnchanged(beforeTxn: any, afterTxn: any): boolean {
  return JSON.stringify(lineFingerprint(beforeTxn)) === JSON.stringify(lineFingerprint(afterTxn));
}

function qboFaultErrors(err: unknown): Array<{ Message?: string; Detail?: string; code?: string | number }> {
  const raw = (err as QBOError)?.response;
  if (raw == null) return [];
  let body: unknown = raw;
  if (typeof raw === 'string') {
    try { body = JSON.parse(raw); } catch { return []; }
  }
  const errors = (body as { Fault?: { Error?: unknown } })?.Fault?.Error;
  if (Array.isArray(errors)) return errors;
  if (errors && typeof errors === 'object') return [errors as { Message?: string; Detail?: string; code?: string | number }];
  return [];
}

/**
 * Direct GET /recurringtransaction/{id} returns HTTP 404 in some cases, but
 * a lookup by RecurDataRef (or a missing object) often comes back as HTTP 400
 * with Fault code 610 ("Object Not Found"). Treat both — and any other
 * not-found Fault — as a miss so resolve() can fall back to the query list.
 */
export function isNotFoundError(err: unknown): boolean {
  if ((err as QBOError)?.statusCode === 404) return true;
  for (const e of qboFaultErrors(err)) {
    if (String(e?.code ?? '') === '610') return true;
    const text = [e?.Message, e?.Detail].filter(Boolean).join(' ');
    if (/\b(?:object\s+)?not found\b/i.test(text)) return true;
  }
  return false;
}

/**
 * EndDate semantics (from Intuit's RecurringTransaction docs / schema, which
 * do not use the word "inclusive"):
 *
 * ScheduleInfo accepts EndDate *or* MaxOccurrences as the stop condition.
 * EndDate is documented only as "The End Date for the Recurring Schedule."
 * In QBO the end date is the last *scheduled* date (NextDate / DayOfMonth)
 * on which an occurrence is created — a monthly DayOfMonth=1 template with
 * EndDate=2026-12-01 still produces the 12/1/2026 run; 1/1/2027 does not.
 * DaysBefore (e.g. 5) only changes when the transaction is generated (Nov 26
 * for a Dec 1 date); it does not move the scheduled date that EndDate is
 * compared against.
 */
export const END_DATE_SEMANTICS =
  'EndDate is the last scheduled date (NextDate) on which an occurrence is created — treated as inclusive of that date. A monthly day-1 template with EndDate 2026-12-01 still runs on 12/1/2026 and does not run on 1/1/2027. DaysBefore only changes the generate-ahead date, not the scheduled date. Intuit\'s API docs do not use the word "inclusive"; confirm NextDate after a live update.';
