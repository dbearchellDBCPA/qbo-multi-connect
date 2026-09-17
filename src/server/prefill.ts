/**
 * Sales-form / purchase-form prefill for the create_* tools.
 *
 * The QBO UI fills a new invoice from the customer you pick (email, addresses,
 * terms), from the company's sales settings (default message, numbering) and
 * from whatever the bookkeeper keys every time (class, cc). The REST API does
 * none of that: POST /invoice stores exactly what it is sent, so an
 * agent-created invoice comes back unnumbered (custom transaction numbers on),
 * unclassed, addressless, without a customer message, and invisible to the
 * Send queue — observed on the Ingram Entities TIM true-up invoices,
 * 2026-09-17 (SPEC-create-invoice-prefill.md §1).
 *
 * This module fills what the caller left blank and reports where every value
 * came from. Per field the order is:
 *
 *   explicit tool argument
 *     > the Customer/Vendor record, for the fields the record owns and the UI
 *       copies from it on every new form (email, addresses, terms)
 *     > the customer's/vendor's most recent transactions (class, cc/bcc,
 *       message, department, print status — things that live only on prior
 *       forms; per field, the most recent of the last PRIOR_TXN_LOOKBACK that
 *       has it, so one bare API-created form does not blank the defaults)
 *     > company Preferences (default customer message, default terms,
 *       numbering and class-tracking rules)
 *     > blank
 *
 * Nothing here ever overrides a value the caller passed. With prefill:false
 * the tools skip this module entirely and the payload reaches QBO untouched.
 */

import { escapeQboString } from './entity-fields.js';

export type SalesFormEntity = 'Invoice' | 'Estimate' | 'CreditMemo' | 'SalesReceipt';
export type PurchaseFormEntity = 'Bill' | 'PurchaseOrder';
export type PrefillEntity = SalesFormEntity | PurchaseFormEntity;

/**
 * Sales forms QBO numbers from ONE shared sequence when CustomTxnNumbers is
 * on, so the "next number" must be the max across all of them.
 */
export const SALES_DOC_SEQUENCE: readonly string[] = ['Invoice', 'SalesReceipt', 'CreditMemo', 'Estimate', 'RefundReceipt'];

/** Prior transactions fetched per customer/vendor (one query) for per-field defaults. */
export const PRIOR_TXN_LOOKBACK = 5;

/** Most recently created rows scanned per entity when computing the next document number. */
export const DOC_NUMBER_SCAN = 100;

/** Retries on QBO 6140 (duplicate document number) before the error is surfaced. */
export const MAX_DOC_NUMBER_RETRIES = 5;

const PREFS_TTL_MS = 60 * 60 * 1000;
const ENTITY_TTL_MS = 5 * 60 * 1000;

export const ENTITY_LABEL: Record<string, string> = {
  Invoice: 'invoice',
  Estimate: 'estimate',
  CreditMemo: 'credit memo',
  SalesReceipt: 'sales receipt',
  RefundReceipt: 'refund receipt',
  Bill: 'bill',
  PurchaseOrder: 'purchase order',
};

/**
 * Which prior transactions each form copies from, in order: the same kind
 * first, then the customer's invoices (a customer with no credit memos still
 * has a class and a cc on their invoices).
 */
const PRIOR_SOURCES: Record<PrefillEntity, readonly string[]> = {
  Invoice: ['Invoice'],
  Estimate: ['Estimate', 'Invoice'],
  CreditMemo: ['CreditMemo', 'Invoice'],
  SalesReceipt: ['SalesReceipt', 'Invoice'],
  Bill: ['Bill'],
  PurchaseOrder: ['PurchaseOrder'],
};

/** The slice of the QBO manager this module needs (satisfied by ScopedQBOManager). */
export interface PrefillClient {
  transactions: {
    rawQuery(realmId: string, query: string): Promise<unknown>;
    getCustomer(realmId: string, customerId: string): Promise<unknown>;
    getVendor(realmId: string, vendorId: string): Promise<unknown>;
  };
  company: {
    getPreferences(realmId: string): Promise<unknown>;
  };
}

// ─── Preferences ─────────────────────────────────────────────────────────────

export interface PrefillPrefs {
  /** SalesFormsPrefs.CustomTxnNumbers — true means QBO does NOT auto-number API-created sales forms. */
  customTxnNumbers: boolean | null;
  /** OtherPrefs "VendorAndPurchasesPrefs.UseCustomTxnNumbers" — the purchase-order equivalent (a separate QBO setting). */
  poCustomTxnNumbers: boolean | null;
  classTrackingPerTxn: boolean | null;
  classTrackingPerTxnLine: boolean | null;
  trackDepartments: boolean | null;
  defaultCustomerMessage: string | null;
  defaultTermsId: string | null;
}

/** Reduce a GET /preferences body to the handful of settings the prefill layer acts on. null = not exposed. */
export function summarizePreferences(raw: any): PrefillPrefs {
  const p = raw?.Preferences ?? raw ?? {};
  const acc = p.AccountingInfoPrefs ?? {};
  const sales = p.SalesFormsPrefs ?? {};
  const other: any[] = Array.isArray(p.OtherPrefs?.NameValue) ? p.OtherPrefs.NameValue : [];
  const otherValue = (name: string): unknown => other.find((nv) => nv?.Name === name)?.Value;
  const bool = (v: unknown): boolean | null => {
    if (typeof v === 'boolean') return v;
    if (typeof v === 'string' && (v === 'true' || v === 'false')) return v === 'true';
    return null;
  };
  const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null);
  return {
    customTxnNumbers: bool(sales.CustomTxnNumbers),
    poCustomTxnNumbers: bool(otherValue('VendorAndPurchasesPrefs.UseCustomTxnNumbers')),
    classTrackingPerTxn: bool(acc.ClassTrackingPerTxn),
    classTrackingPerTxnLine: bool(acc.ClassTrackingPerTxnLine),
    trackDepartments: bool(acc.TrackDepartments),
    defaultCustomerMessage: text(sales.DefaultCustomerMessage) ?? text(otherValue('SalesFormsPrefs.DefaultCustomerMessage')),
    defaultTermsId: sales.DefaultTerms?.value != null && String(sales.DefaultTerms.value) !== '' ? String(sales.DefaultTerms.value) : null,
  };
}

const prefsCache = new Map<string, { at: number; prefs: PrefillPrefs }>();
const entityCache = new Map<string, { at: number; record: any }>();

/** Drop the per-realm Preferences cache and the Customer/Vendor cache (tests; after settings changes). */
export function clearPrefillCaches(): void {
  prefsCache.clear();
  entityCache.clear();
}

async function loadPrefs(qbo: PrefillClient, realmId: string): Promise<PrefillPrefs> {
  const hit = prefsCache.get(realmId);
  if (hit && Date.now() - hit.at < PREFS_TTL_MS) return hit.prefs;
  const prefs = summarizePreferences(await qbo.company.getPreferences(realmId));
  prefsCache.set(realmId, { at: Date.now(), prefs });
  return prefs;
}

async function loadEntity(qbo: PrefillClient, realmId: string, kind: 'Customer' | 'Vendor', id: string): Promise<any | null> {
  const key = `${realmId}:${kind}:${id}`;
  const hit = entityCache.get(key);
  if (hit && Date.now() - hit.at < ENTITY_TTL_MS) return hit.record;
  const raw: any = kind === 'Customer' ? await qbo.transactions.getCustomer(realmId, id) : await qbo.transactions.getVendor(realmId, id);
  const record = raw?.[kind] ?? null;
  entityCache.set(key, { at: Date.now(), record });
  return record;
}

// ─── Prior transactions ──────────────────────────────────────────────────────

export interface PriorTxn {
  entity: string;
  txn: any;
}

/** Most recent first by TxnDate, then by numeric Id — the tie-break for same-day forms. */
export function sortMostRecentFirst(rows: any[]): any[] {
  return [...rows].sort((a, b) => {
    const byDate = String(b?.TxnDate ?? '').localeCompare(String(a?.TxnDate ?? ''));
    if (byDate !== 0) return byDate;
    return (Number(b?.Id) || 0) - (Number(a?.Id) || 0);
  });
}

async function loadPriorTxns(
  qbo: PrefillClient,
  realmId: string,
  entities: readonly string[],
  refField: 'CustomerRef' | 'VendorRef',
  id: string
): Promise<PriorTxn[]> {
  for (const entity of entities) {
    const res: any = await qbo.transactions.rawQuery(
      realmId,
      `SELECT * FROM ${entity} WHERE ${refField} = '${escapeQboString(id)}' ORDERBY TxnDate DESC, Id DESC MAXRESULTS ${PRIOR_TXN_LOOKBACK}`
    );
    const rows: any[] = res?.QueryResponse?.[entity] ?? [];
    if (rows.length > 0) return sortMostRecentFirst(rows).map((txn) => ({ entity, txn }));
  }
  return [];
}

function txnLabel(p: PriorTxn): string {
  const noun = ENTITY_LABEL[p.entity] ?? p.entity.toLowerCase();
  const num = p.txn?.DocNumber;
  return num != null && String(num).trim() !== '' ? `${noun} #${num}` : `${noun} Id ${p.txn?.Id}`;
}

// ─── Document numbers ────────────────────────────────────────────────────────

export interface NextDocNumber {
  /** The number to use. */
  value: string;
  /** The highest numeric DocNumber found. */
  max: string;
  /** Entity the max came from (e.g. "Invoice"). */
  maxEntity: string;
}

/**
 * Next number in a sequence of DocNumbers: max numeric + 1, as a string,
 * keeping the max's zero-padding. Non-numeric numbers ("STMT 05/25/2025",
 * "2025_TIM", "INV-100") are ignored. null when nothing numeric was found.
 */
export function nextDocNumberFrom(rows: Iterable<{ docNumber: unknown; entity?: string }>): NextDocNumber | null {
  let best: { n: number; raw: string; entity: string } | null = null;
  for (const { docNumber, entity } of rows) {
    if (docNumber == null) continue;
    const raw = String(docNumber).trim();
    if (!/^\d+$/.test(raw)) continue;
    const n = Number(raw);
    if (!Number.isSafeInteger(n)) continue;
    if (!best || n > best.n) best = { n, raw, entity: entity ?? '' };
  }
  if (!best) return null;
  return { value: bumpDocNumber(best.raw), max: best.raw, maxEntity: best.entity };
}

/** "5734" → "5735", "0042" → "0043". */
export function bumpDocNumber(current: string): string {
  return String(Number(current) + 1).padStart(current.length, '0');
}

async function loadRecentDocNumbers(
  qbo: PrefillClient,
  realmId: string,
  entities: readonly string[]
): Promise<{ rows: Array<{ docNumber: unknown; entity: string }>; warnings: string[] }> {
  const warnings: string[] = [];
  const perEntity = await Promise.all(
    entities.map(async (entity) => {
      try {
        const res: any = await qbo.transactions.rawQuery(
          realmId,
          `SELECT DocNumber FROM ${entity} ORDERBY MetaData.CreateTime DESC MAXRESULTS ${DOC_NUMBER_SCAN}`
        );
        const rows: any[] = res?.QueryResponse?.[entity] ?? [];
        return rows.map((r) => ({ docNumber: r?.DocNumber, entity }));
      } catch (err: any) {
        warnings.push(`prefill: could not scan ${ENTITY_LABEL[entity] ?? entity} numbers (${errMsg(err)}).`);
        return [];
      }
    })
  );
  return { rows: perEntity.flat(), warnings };
}

/**
 * Next number for a sales form: the highest numeric DocNumber among the most
 * recently created invoices, sales receipts, credit memos, estimates and
 * refund receipts (one shared sequence in QBO), plus one.
 */
export async function nextSalesDocNumber(
  qbo: PrefillClient,
  realmId: string
): Promise<{ next: NextDocNumber | null; warnings: string[] }> {
  const { rows, warnings } = await loadRecentDocNumbers(qbo, realmId, SALES_DOC_SEQUENCE);
  return { next: nextDocNumberFrom(rows), warnings };
}

/** Purchase orders number from their own sequence. */
export async function nextPurchaseOrderDocNumber(
  qbo: PrefillClient,
  realmId: string
): Promise<{ next: NextDocNumber | null; warnings: string[] }> {
  const { rows, warnings } = await loadRecentDocNumbers(qbo, realmId, ['PurchaseOrder']);
  return { next: nextDocNumberFrom(rows), warnings };
}

/** QBO code 6140 — "Duplicate Document Number Error". */
export function isDuplicateDocNumberError(err: unknown): boolean {
  const e = err as any;
  const text = `${e?.message ?? ''} ${typeof e?.response === 'string' ? e.response : ''}`;
  return /\b6140\b/.test(text) || /Duplicate Document Number/i.test(text);
}

// ─── Value helpers ───────────────────────────────────────────────────────────

function present(v: unknown): boolean {
  if (v == null) return false;
  if (typeof v === 'string') return v.trim() !== '';
  if (typeof v === 'object') return Object.keys(v as object).length > 0;
  return true;
}

function refPresent(ref: any): boolean {
  return ref != null && typeof ref === 'object' && ref.value != null && String(ref.value).trim() !== '';
}

function emailPresent(e: any): boolean {
  return typeof e?.Address === 'string' && e.Address.trim() !== '';
}

function memoPresent(m: any): boolean {
  return typeof m?.value === 'string' && m.value.trim() !== '';
}

function copyRef(ref: any): { value: string; name?: string } {
  const out: { value: string; name?: string } = { value: String(ref.value) };
  if (typeof ref.name === 'string' && ref.name !== '') out.name = ref.name;
  return out;
}

/**
 * Copy a PhysicalAddress without its row Id (an address Id belongs to the
 * record it was read from). null when only the Id is there — QBO returns
 * {Id} shells for addresses that were never filled in.
 */
export function copyAddress(addr: any): Record<string, unknown> | null {
  if (!addr || typeof addr !== 'object') return null;
  const { Id: _id, ...rest } = addr;
  const kept = Object.fromEntries(
    Object.entries(rest).filter(([, v]) => v != null && String(v).trim() !== '')
  );
  return Object.keys(kept).length > 0 ? kept : null;
}

const ADDRESS_KEYS = ['Line1', 'Line2', 'Line3', 'Line4', 'Line5', 'City', 'CountrySubDivisionCode', 'PostalCode', 'Country'];

function truncate(s: string, max = 80): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

/** Human rendering of a prefilled value for the `prefilled` report. */
export function describeValue(value: any): string {
  if (value == null) return '';
  if (typeof value !== 'object') return truncate(String(value));
  if (typeof value.Address === 'string') return truncate(value.Address);
  const addr = ADDRESS_KEYS.map((k) => value[k]).filter((v) => v != null && String(v).trim() !== '');
  if (addr.length > 0) return truncate(addr.join(', '));
  if ('value' in value) return truncate(typeof value.name === 'string' && value.name !== '' ? value.name : String(value.value));
  return truncate(JSON.stringify(value));
}

function errMsg(err: unknown): string {
  return (err as any)?.message ?? String(err);
}

/** The first line of a transaction that carries a class, whatever the line kind. */
export function firstLineClass(txn: any): { value: string; name?: string } | null {
  for (const l of txn?.Line ?? []) {
    const d = l?.SalesItemLineDetail ?? l?.AccountBasedExpenseLineDetail ?? l?.ItemBasedExpenseLineDetail;
    if (refPresent(d?.ClassRef)) return copyRef(d.ClassRef);
  }
  return null;
}

/** The expense account on the first account-based line of a bill. */
export function firstExpenseAccount(txn: any): { value: string; name?: string } | null {
  for (const l of txn?.Line ?? []) {
    const ref = l?.AccountBasedExpenseLineDetail?.AccountRef;
    if (refPresent(ref)) return copyRef(ref);
  }
  return null;
}

function lineDetail(line: any): any | null {
  return line?.SalesItemLineDetail ?? line?.AccountBasedExpenseLineDetail ?? line?.ItemBasedExpenseLineDetail ?? null;
}

// ─── Outcome ─────────────────────────────────────────────────────────────────

export interface PrefillOutcome {
  /** Field → "source → value", e.g. "Line.ClassRef": "from invoice #5096 → 7000 - DCM Ingram Center". */
  prefilled: Record<string, string>;
  warnings: string[];
  /** True when DocNumber was computed here — the only case a duplicate-number retry is allowed. */
  docNumberComputed: boolean;
}

export function emptyOutcome(): PrefillOutcome {
  return { prefilled: {}, warnings: [], docNumberComputed: false };
}

export interface PrefillOptions {
  /** Header-level class_id argument; the tool has already put it on lines that had no line-level class. */
  headerClassId?: string;
}

interface Filler {
  out: PrefillOutcome;
  payload: any;
  priorTxns: PriorTxn[];
  prefs: PrefillPrefs | null;
  noun: string;
  who: 'customer' | 'vendor';
}

function fromPrior<T>(
  f: Filler,
  pick: (txn: any) => T,
  ok: (v: T) => boolean,
  restrictTo?: string
): { value: T; label: string } | null {
  for (const p of f.priorTxns) {
    if (restrictTo && p.entity !== restrictTo) continue;
    const v = pick(p.txn);
    if (ok(v)) return { value: v, label: `from ${txnLabel(p)}` };
  }
  return null;
}

function report(f: Filler, field: string, source: string, value: any): void {
  f.out.prefilled[field] = `${source} → ${describeValue(value)}`;
}

/** Report an explicit argument, or run the fallback chain when the field is absent. */
function argOr(f: Filler, field: string, isPresent: boolean, fill: () => void): void {
  if (isPresent) report(f, field, 'argument', f.payload[field]);
  else fill();
}

function fillRef(f: Filler, field: string, chain: Array<() => { ref: any; source: string } | null>): void {
  argOr(f, field, refPresent(f.payload[field]), () => {
    for (const step of chain) {
      const hit = step();
      if (hit && refPresent(hit.ref)) {
        f.payload[field] = copyRef(hit.ref);
        report(f, field, hit.source, hit.ref);
        return;
      }
    }
  });
}

function fillEmail(f: Filler, field: string, chain: Array<() => { email: any; source: string } | null>): void {
  argOr(f, field, emailPresent(f.payload[field]), () => {
    for (const step of chain) {
      const hit = step();
      if (hit && emailPresent(hit.email)) {
        f.payload[field] = { Address: hit.email.Address };
        report(f, field, hit.source, hit.email);
        return;
      }
    }
  });
}

function fillAddress(f: Filler, field: string, chain: Array<() => { addr: any; source: string } | null>): void {
  argOr(f, field, copyAddress(f.payload[field]) != null, () => {
    for (const step of chain) {
      const hit = step();
      const copied = hit ? copyAddress(hit.addr) : null;
      if (copied) {
        f.payload[field] = copied;
        report(f, field, hit!.source, copied);
        return;
      }
    }
  });
}

function priorRef(f: Filler, field: string, restrictTo?: string): () => { ref: any; source: string } | null {
  return () => {
    const p = fromPrior(f, (t) => t?.[field], refPresent, restrictTo);
    return p ? { ref: p.value, source: p.label } : null;
  };
}

function priorEmail(f: Filler, field: string): () => { email: any; source: string } | null {
  return () => {
    const p = fromPrior(f, (t) => t?.[field], emailPresent);
    return p ? { email: p.value, source: p.label } : null;
  };
}

function priorAddress(f: Filler, field: string): () => { addr: any; source: string } | null {
  return () => {
    const p = fromPrior(f, (t) => copyAddress(t?.[field]), (v) => v != null);
    return p ? { addr: p.value, source: p.label } : null;
  };
}

/**
 * Class goes on every line that has none. Precedence: line-level class_id
 * (already on the line) > header class_id > the class on the most recent
 * prior form's first classed line. A header ClassRef is written only when
 * the company tracks class per transaction — QBO rejects it on per-line
 * companies (Ingram is per-line).
 */
function applyClass(f: Filler, opts: PrefillOptions, headerAllowed: boolean): void {
  const details = (f.payload.Line ?? []).map(lineDetail).filter(Boolean);
  if (details.length === 0) return;
  const prefs = f.prefs;
  const tracking = prefs ? prefs.classTrackingPerTxn === true || prefs.classTrackingPerTxnLine === true : null;

  let ref: { value: string; name?: string } | null = null;
  let source = '';
  if (details.every((d: any) => refPresent(d.ClassRef))) {
    ref = copyRef(details[0].ClassRef);
    source = 'argument';
  } else if (opts.headerClassId) {
    ref = { value: opts.headerClassId };
    source = 'argument';
  } else {
    const p = fromPrior(f, (t) => firstLineClass(t), (v) => v != null);
    if (p) {
      ref = p.value!;
      source = p.label;
    }
  }

  if (!ref) {
    if (tracking === true) {
      const why = f.priorTxns.length > 0
        ? `prior ${f.noun}s for this ${f.who} are unclassed too`
        : `there is no prior ${f.noun} for this ${f.who} to copy one from`;
      f.out.warnings.push(`no class set — company uses class tracking and ${why}; pass class_id (use get_classes to find IDs).`);
    }
    return;
  }
  if (source !== 'argument' && tracking === false) return; // company does not track classes: nothing copied

  for (const d of details) {
    if (!refPresent(d.ClassRef)) d.ClassRef = { ...ref };
  }
  f.out.prefilled['Line.ClassRef'] = `${source} → ${describeValue(ref)}`;
  if (headerAllowed && prefs?.classTrackingPerTxn === true && !refPresent(f.payload.ClassRef)) {
    f.payload.ClassRef = { ...ref };
    f.out.prefilled.ClassRef = `${source} → ${describeValue(ref)}`;
  }
}

function applySalesDocNumber(f: Filler, next: NextDocNumber | null): void {
  const { payload, prefs, out } = f;
  if (present(payload.DocNumber)) {
    report(f, 'DocNumber', 'argument', payload.DocNumber);
    return;
  }
  if (!prefs) {
    out.warnings.push(`DocNumber left blank: company Preferences could not be read, so whether QBO auto-numbers ${f.noun}s is unknown — pass doc_number if it comes back unnumbered.`);
    return;
  }
  if (prefs.customTxnNumbers === false) {
    out.prefilled.DocNumber = 'omitted (CustomTxnNumbers off — QBO assigns the next number)';
    return;
  }
  if (prefs.customTxnNumbers !== true) {
    out.warnings.push('DocNumber left blank: SalesFormsPrefs.CustomTxnNumbers is not exposed by this company — pass doc_number if it comes back unnumbered.');
    return;
  }
  if (!next) {
    out.warnings.push('DocNumber left blank: CustomTxnNumbers is on but no numeric DocNumber was found on recent sales forms to continue from — pass doc_number.');
    return;
  }
  payload.DocNumber = next.value;
  out.docNumberComputed = true;
  out.prefilled.DocNumber = `computed (CustomTxnNumbers on): ${next.max} → ${next.value}`;
}

// ─── Sales forms (Invoice, Estimate, CreditMemo, SalesReceipt) ───────────────

export interface SalesPrefillSources {
  /** Most recent first. */
  priorTxns: PriorTxn[];
  customer: any | null;
  prefs: PrefillPrefs | null;
  /** Computed by the loader when CustomTxnNumbers is on and no doc_number was passed. */
  nextDocNumber: NextDocNumber | null;
}

/**
 * Fill the blanks of a sales-form payload in place and report what was
 * filled. Pure: every source is passed in.
 */
export function prefillSalesPayload(
  entity: SalesFormEntity,
  payload: any,
  sources: SalesPrefillSources,
  opts: PrefillOptions = {}
): PrefillOutcome {
  const out = emptyOutcome();
  const { customer, prefs } = sources;
  const f: Filler = { out, payload, priorTxns: sources.priorTxns, prefs, noun: ENTITY_LABEL[entity], who: 'customer' };

  applySalesDocNumber(f, sources.nextDocNumber);

  fillRef(f, 'DepartmentRef', [
    () => (prefs?.trackDepartments === false ? null : priorRef(f, 'DepartmentRef')()),
  ]);
  fillRef(f, 'SalesTermRef', [
    () => ({ ref: customer?.SalesTermRef, source: 'from customer' }),
    priorRef(f, 'SalesTermRef'),
    () => (prefs?.defaultTermsId ? { ref: { value: prefs.defaultTermsId }, source: 'from Preferences (DefaultTerms)' } : null),
  ]);
  fillEmail(f, 'BillEmail', [
    () => ({ email: customer?.PrimaryEmailAddr, source: 'from customer' }),
    priorEmail(f, 'BillEmail'),
  ]);
  fillEmail(f, 'BillEmailCc', [priorEmail(f, 'BillEmailCc')]);
  fillEmail(f, 'BillEmailBcc', [priorEmail(f, 'BillEmailBcc')]);
  fillAddress(f, 'BillAddr', [
    () => ({ addr: customer?.BillAddr, source: 'from customer' }),
    priorAddress(f, 'BillAddr'),
  ]);
  fillAddress(f, 'ShipAddr', [
    () => ({ addr: customer?.ShipAddr, source: 'from customer' }),
    priorAddress(f, 'ShipAddr'),
  ]);
  argOr(f, 'CustomerMemo', memoPresent(payload.CustomerMemo), () => {
    const p = fromPrior(f, (t) => t?.CustomerMemo, memoPresent);
    if (p) {
      payload.CustomerMemo = { value: p.value.value };
      report(f, 'CustomerMemo', p.label, p.value);
    } else if (prefs?.defaultCustomerMessage) {
      payload.CustomerMemo = { value: prefs.defaultCustomerMessage };
      report(f, 'CustomerMemo', 'from Preferences (DefaultCustomerMessage)', payload.CustomerMemo);
    }
  });
  if (!present(payload.PrintStatus)) {
    const p = fromPrior(f, (t) => t?.PrintStatus, (v) => typeof v === 'string' && v !== '');
    if (p) {
      payload.PrintStatus = p.value;
      report(f, 'PrintStatus', p.label, p.value);
    }
  }
  argOr(f, 'EmailStatus', present(payload.EmailStatus), () => {
    payload.EmailStatus = 'NeedToSend';
    report(f, 'EmailStatus', 'default', 'NeedToSend');
  });
  if (payload.EmailStatus === 'NeedToSend' && !emailPresent(payload.BillEmail)) {
    out.warnings.push(`EmailStatus is NeedToSend but no BillEmail could be found (the customer record and prior ${f.noun}s have none) — QBO's Send queue will have no address; pass bill_email.`);
  }
  if (entity === 'SalesReceipt') {
    fillRef(f, 'DepositToAccountRef', [priorRef(f, 'DepositToAccountRef', 'SalesReceipt')]);
    fillRef(f, 'PaymentMethodRef', [priorRef(f, 'PaymentMethodRef', 'SalesReceipt')]);
  }

  applyClass(f, opts, true);

  if (refPresent(customer?.DefaultTaxCodeRef)) {
    const untaxed = (payload.Line ?? []).filter((l: any) => l?.SalesItemLineDetail && !refPresent(l.SalesItemLineDetail.TaxCodeRef));
    if (untaxed.length > 0) {
      for (const l of untaxed) l.SalesItemLineDetail.TaxCodeRef = { value: String(customer.DefaultTaxCodeRef.value) };
      report(f, 'Line.TaxCodeRef', 'from customer (DefaultTaxCodeRef)', customer.DefaultTaxCodeRef);
    }
  }
  return out;
}

/**
 * Load every source for a sales form and apply the prefill to `payload`.
 * A source that cannot be read becomes a warning, never a failed create.
 */
export async function runSalesFormPrefill(
  qbo: PrefillClient,
  realmId: string,
  entity: SalesFormEntity,
  customerId: string,
  payload: any,
  opts: PrefillOptions = {}
): Promise<PrefillOutcome> {
  const warnings: string[] = [];
  const noun = ENTITY_LABEL[entity];
  const [prefs, priorTxns, customer] = await Promise.all([
    loadPrefs(qbo, realmId).catch((err) => {
      warnings.push(`prefill: Preferences unavailable (${errMsg(err)}) — numbering and class-tracking rules could not be checked.`);
      return null;
    }),
    loadPriorTxns(qbo, realmId, PRIOR_SOURCES[entity], 'CustomerRef', customerId).catch((err) => {
      warnings.push(`prefill: could not read prior ${noun}s for customer ${customerId} (${errMsg(err)}).`);
      return [] as PriorTxn[];
    }),
    loadEntity(qbo, realmId, 'Customer', customerId).catch((err) => {
      warnings.push(`prefill: could not read customer ${customerId} (${errMsg(err)}).`);
      return null;
    }),
  ]);
  let nextDocNumber: NextDocNumber | null = null;
  if (!present(payload.DocNumber) && prefs?.customTxnNumbers === true) {
    const r = await nextSalesDocNumber(qbo, realmId);
    nextDocNumber = r.next;
    warnings.push(...r.warnings);
  }
  const outcome = prefillSalesPayload(entity, payload, { priorTxns, customer, prefs, nextDocNumber }, opts);
  outcome.warnings.unshift(...warnings);
  return outcome;
}

// ─── Purchase forms (Bill, PurchaseOrder) ────────────────────────────────────

export interface PurchasePrefillSources {
  priorTxns: PriorTxn[];
  vendor: any | null;
  prefs: PrefillPrefs | null;
  nextDocNumber: NextDocNumber | null;
}

/**
 * Fill the blanks of a bill / purchase-order payload in place. A bill's
 * DocNumber is the vendor's own invoice number and is never generated;
 * purchase orders number from their own sequence when the company has
 * custom PO numbers on.
 */
export function prefillPurchasePayload(
  entity: PurchaseFormEntity,
  payload: any,
  sources: PurchasePrefillSources,
  opts: PrefillOptions = {}
): PrefillOutcome {
  const out = emptyOutcome();
  const { vendor, prefs } = sources;
  const f: Filler = { out, payload, priorTxns: sources.priorTxns, prefs, noun: ENTITY_LABEL[entity], who: 'vendor' };

  if (present(payload.DocNumber)) {
    report(f, 'DocNumber', 'argument', payload.DocNumber);
  } else if (entity === 'PurchaseOrder') {
    if (!prefs) {
      out.warnings.push('DocNumber left blank: company Preferences could not be read, so whether QBO auto-numbers purchase orders is unknown — pass doc_number if it comes back unnumbered.');
    } else if (prefs.poCustomTxnNumbers === false) {
      out.prefilled.DocNumber = 'omitted (purchase-order custom numbers off — QBO assigns the next number)';
    } else if (prefs.poCustomTxnNumbers === true) {
      if (sources.nextDocNumber) {
        payload.DocNumber = sources.nextDocNumber.value;
        out.docNumberComputed = true;
        out.prefilled.DocNumber = `computed (PO custom numbers on): ${sources.nextDocNumber.max} → ${sources.nextDocNumber.value}`;
      } else {
        out.warnings.push('DocNumber left blank: purchase-order custom numbers are on but no numeric PO number was found to continue from — pass doc_number.');
      }
    } else {
      out.prefilled.DocNumber = 'omitted (this company does not expose its purchase-order numbering preference — pass doc_number if the PO comes back unnumbered)';
    }
  }

  fillRef(f, 'DepartmentRef', [
    () => (prefs?.trackDepartments === false ? null : priorRef(f, 'DepartmentRef')()),
  ]);
  fillRef(f, 'SalesTermRef', [
    () => ({ ref: vendor?.TermRef, source: 'from vendor' }),
    priorRef(f, 'SalesTermRef'),
  ]);
  fillRef(f, 'APAccountRef', [
    priorRef(f, 'APAccountRef'),
    () => ({ ref: vendor?.APAccountRef, source: 'from vendor' }),
  ]);
  fillAddress(f, 'VendorAddr', [
    () => ({ addr: vendor?.BillAddr, source: 'from vendor' }),
    priorAddress(f, 'VendorAddr'),
  ]);

  if (entity === 'PurchaseOrder') {
    fillAddress(f, 'ShipAddr', [priorAddress(f, 'ShipAddr')]);
    fillEmail(f, 'POEmail', [
      () => ({ email: vendor?.PrimaryEmailAddr, source: 'from vendor' }),
      priorEmail(f, 'POEmail'),
    ]);
    argOr(f, 'Memo', present(payload.Memo), () => {
      const p = fromPrior(f, (t) => t?.Memo, (v) => typeof v === 'string' && v.trim() !== '');
      if (p) {
        payload.Memo = p.value;
        report(f, 'Memo', p.label, p.value);
      }
    });
    argOr(f, 'EmailStatus', present(payload.EmailStatus), () => {
      payload.EmailStatus = 'NeedToSend';
      report(f, 'EmailStatus', 'default', 'NeedToSend');
    });
    if (payload.EmailStatus === 'NeedToSend' && !emailPresent(payload.POEmail)) {
      out.warnings.push('EmailStatus is NeedToSend but no POEmail could be found (the vendor record and prior purchase orders have none) — pass po_email.');
    }
  }

  applyClass(f, opts, entity === 'PurchaseOrder');

  if (entity === 'Bill') {
    const needing = (payload.Line ?? []).filter(
      (l: any) => l?.DetailType === 'AccountBasedExpenseLineDetail' && l.AccountBasedExpenseLineDetail && !refPresent(l.AccountBasedExpenseLineDetail.AccountRef)
    );
    if (needing.length > 0) {
      const p = fromPrior(f, (t) => firstExpenseAccount(t), (v) => v != null);
      if (p) {
        for (const l of needing) l.AccountBasedExpenseLineDetail.AccountRef = copyRef(p.value);
        report(f, 'Line.AccountRef', p.label, p.value);
      } else {
        out.warnings.push(`${needing.length} bill line(s) have no account_id and there is no prior bill for this vendor to copy an expense account from — QBO will reject them.`);
      }
    }
  }
  return out;
}

export async function runPurchaseFormPrefill(
  qbo: PrefillClient,
  realmId: string,
  entity: PurchaseFormEntity,
  vendorId: string,
  payload: any,
  opts: PrefillOptions = {}
): Promise<PrefillOutcome> {
  const warnings: string[] = [];
  const noun = ENTITY_LABEL[entity];
  const [prefs, priorTxns, vendor] = await Promise.all([
    loadPrefs(qbo, realmId).catch((err) => {
      warnings.push(`prefill: Preferences unavailable (${errMsg(err)}) — numbering and class-tracking rules could not be checked.`);
      return null;
    }),
    loadPriorTxns(qbo, realmId, PRIOR_SOURCES[entity], 'VendorRef', vendorId).catch((err) => {
      warnings.push(`prefill: could not read prior ${noun}s for vendor ${vendorId} (${errMsg(err)}).`);
      return [] as PriorTxn[];
    }),
    loadEntity(qbo, realmId, 'Vendor', vendorId).catch((err) => {
      warnings.push(`prefill: could not read vendor ${vendorId} (${errMsg(err)}).`);
      return null;
    }),
  ]);
  let nextDocNumber: NextDocNumber | null = null;
  if (entity === 'PurchaseOrder' && !present(payload.DocNumber) && prefs?.poCustomTxnNumbers === true) {
    const r = await nextPurchaseOrderDocNumber(qbo, realmId);
    nextDocNumber = r.next;
    warnings.push(...r.warnings);
  }
  const outcome = prefillPurchasePayload(entity, payload, { priorTxns, vendor, prefs, nextDocNumber }, opts);
  outcome.warnings.unshift(...warnings);
  return outcome;
}

// ─── Posting ─────────────────────────────────────────────────────────────────

/**
 * Post a create, and when the DocNumber was computed here and QBO answers
 * 6140 (someone took the number in between), bump it and try again — up to
 * MAX_DOC_NUMBER_RETRIES times. An explicit doc_number is never bumped.
 */
export async function postWithDocNumberRetry<T>(
  post: (payload: any) => Promise<T>,
  payload: any,
  outcome: PrefillOutcome
): Promise<T> {
  let retries = 0;
  for (;;) {
    try {
      return await post(payload);
    } catch (err) {
      if (!outcome.docNumberComputed || !isDuplicateDocNumberError(err) || retries >= MAX_DOC_NUMBER_RETRIES) throw err;
      retries++;
      const taken = String(payload.DocNumber);
      payload.DocNumber = bumpDocNumber(taken);
      outcome.prefilled.DocNumber = `${outcome.prefilled.DocNumber ?? 'computed'}; ${taken} was already taken → retried with ${payload.DocNumber}`;
    }
  }
}

/**
 * The tool response: the existing one-line summary (unchanged for callers
 * that parse it) followed by the JSON block of §2.5 — identity, totals,
 * the `prefilled` map and `warnings`.
 */
export function appendPrefillReport(summary: string, created: Record<string, unknown>, outcome: PrefillOutcome): string {
  return `${summary}\n\n${JSON.stringify({ ...created, prefilled: outcome.prefilled, warnings: outcome.warnings }, null, 2)}`;
}
