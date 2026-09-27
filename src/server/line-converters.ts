/**
 * Pure functions that convert QBO native line shapes → update-tool input shapes.
 * Used by get_<entity> tools to produce round-trip-safe output, and by
 * swap_item_or_account to mutate raw lines before re-posting.
 */

// ── Sales entity converters (Invoice, SalesReceipt, CreditMemo, Estimate) ─────

export interface SalesShapeOptions {
  /**
   * Emit each line's QBO Id as `line_id` (default true). update_invoice /
   * update_sales_receipt accept it so a get → update round trip edits the
   * same lines in place. Pass false for tools whose update schema does not
   * (yet) accept line_id.
   */
  includeLineId?: boolean;
  /**
   * Only return caller-editable lines (SalesItemLineDetail + DescriptionOnly).
   * QBO-computed rows (SubTotal) are always excluded; Discount / Group rows
   * are excluded too when this is true, because update_invoice /
   * update_sales_receipt carry them through verbatim instead of rebuilding
   * them (default true). Pass false to keep the legacy mapping.
   */
  editableOnly?: boolean;
}

export function qboSalesLinesToUpdateShape(lines: any[], opts: SalesShapeOptions = {}): any[] {
  const includeLineId = opts.includeLineId ?? true;
  const editableOnly = opts.editableOnly ?? true;
  return (lines ?? [])
    .filter((l: any) => l?.DetailType !== 'SubTotalLineDetail')
    .filter((l: any) => !editableOnly || salesLineKind(l) !== null)
    .map((l: any) => {
      const out: any = {};
      if (includeLineId && l.Id != null) out.line_id = String(l.Id);
      out.amount = l.Amount ?? 0;
      out.description = l.Description;
      if (l.DetailType === 'DescriptionOnly') {
        out.detail_type = 'DescriptionOnly';
      } else {
        out.detail_type = 'SalesItemLineDetail';
        const d = l.SalesItemLineDetail ?? {};
        if (d.ItemRef?.value) out.item_id = d.ItemRef.value;
        if (d.ItemRef?.name) out.item_name = d.ItemRef.name;
        if (d.Qty != null) out.quantity = d.Qty;
        if (d.UnitPrice != null) out.unit_price = d.UnitPrice;
        if (d.ClassRef?.value) out.class_id = d.ClassRef.value;
        if (d.TaxCodeRef?.value) out.tax_code_id = d.TaxCodeRef.value;
      }
      return out;
    });
}

// ── Bill converter ─────────────────────────────────────────────────────────────

export function qboBillLinesToUpdateShape(lines: any[]): any[] {
  return (lines ?? [])
    .filter((l: any) =>
      l.DetailType === 'AccountBasedExpenseLineDetail' ||
      l.DetailType === 'ItemBasedExpenseLineDetail'
    )
    .map((l: any) => {
      const out: any = {};
      if (l.Id != null) out.line_id = String(l.Id);
      out.amount = l.Amount ?? 0;
      out.description = l.Description;
      out.detail_type = l.DetailType as 'AccountBasedExpenseLineDetail' | 'ItemBasedExpenseLineDetail';
      if (l.DetailType === 'AccountBasedExpenseLineDetail') {
        const d = l.AccountBasedExpenseLineDetail ?? {};
        if (d.AccountRef?.value) out.account_id = d.AccountRef.value;
        if (d.AccountRef?.name) out.account_name = d.AccountRef.name;
        if (d.ClassRef?.value) out.class_id = d.ClassRef.value;
      } else {
        const d = l.ItemBasedExpenseLineDetail ?? {};
        if (d.ItemRef?.value) out.item_id = d.ItemRef.value;
        if (d.ItemRef?.name) out.item_name = d.ItemRef.name;
        if (d.Qty != null) out.quantity = d.Qty;
        if (d.UnitPrice != null) out.unit_price = d.UnitPrice;
        if (d.ClassRef?.value) out.class_id = d.ClassRef.value;
      }
      return out;
    });
}

// ── Journal entry converter ────────────────────────────────────────────────────

export function qboJournalLinesToUpdateShape(lines: any[]): any[] {
  return (lines ?? [])
    .filter((l: any) => l.DetailType === 'JournalEntryLineDetail')
    .map((l: any) => {
      const d = l.JournalEntryLineDetail ?? {};
      const out: any = {};
      if (l.Id != null) out.line_id = String(l.Id);
      out.amount = l.Amount ?? 0;
      out.description = l.Description;
      out.posting_type = d.PostingType as 'Debit' | 'Credit';
      out.account_id = d.AccountRef?.value ?? '';
      if (d.AccountRef?.name) out.account_name = d.AccountRef.name;
      if (d.ClassRef?.value) {
        out.class_id = d.ClassRef.value;
        if (d.ClassRef.name) out.class_name = d.ClassRef.name;
      }
      if (d.DepartmentRef?.value) out.department_id = d.DepartmentRef.value;
      if (d.Entity) {
        out.entity_type = d.Entity.Type as 'Customer' | 'Vendor' | 'Employee';
        out.entity_id = d.Entity.EntityRef?.value;
        if (d.Entity.EntityRef?.name) out.entity_name = d.Entity.EntityRef.name;
      }
      return out;
    });
}

export interface JournalLineInput {
  /** Existing QBO Line.Id to edit in place (update only; ignored on create). */
  line_id?: string;
  posting_type: 'Debit' | 'Credit';
  account_id: string;
  account_name?: string;
  amount: number;
  description?: string;
  entity_type?: 'Customer' | 'Vendor' | 'Employee';
  entity_id?: string;
  entity_name?: string;
  class_id?: string;
  class_name?: string;
  department_id?: string;
}

/**
 * Build a QBO JournalEntry `Line` array from tool input. Shared by
 * create_journal_entry and update_journal_entry. Built lines carry no Id;
 * update_journal_entry stamps existing Ids on afterwards (replaceLinesWithIds)
 * so QBO edits in place instead of appending.
 */
export function buildJournalEntryLines(lines: JournalLineInput[]): any[] {
  return lines.map((l) => {
    const line: any = {
      Amount: l.amount,
      DetailType: 'JournalEntryLineDetail',
      Description: l.description,
      JournalEntryLineDetail: {
        PostingType: l.posting_type,
        AccountRef: { value: l.account_id, name: l.account_name },
      },
    };
    if (l.entity_type && l.entity_id) {
      line.JournalEntryLineDetail.Entity = {
        Type: l.entity_type,
        EntityRef: { value: l.entity_id, name: l.entity_name },
      };
    }
    if (l.class_id) {
      line.JournalEntryLineDetail.ClassRef = { value: l.class_id, name: l.class_name };
    }
    if (l.department_id) {
      line.JournalEntryLineDetail.DepartmentRef = { value: l.department_id };
    }
    return line;
  });
}

/** create_journal_entry payload. DocNumber is omitted unless non-empty. */
export function buildJournalEntryCreatePayload(args: {
  txn_date?: string;
  private_note?: string;
  doc_number?: string;
  lines: JournalLineInput[];
}): any {
  const payload: any = { Line: buildJournalEntryLines(args.lines) };
  if (args.txn_date) payload.TxnDate = args.txn_date;
  if (args.private_note) payload.PrivateNote = args.private_note;
  if (args.doc_number) payload.DocNumber = args.doc_number;
  return payload;
}

/**
 * update_journal_entry payload (read-modify-write on the freshly fetched JE,
 * so SyncToken and every untouched field — TxnDate, attachments, currency,
 * Line Ids — are carried through verbatim).
 *
 * `Line` is only replaced when the caller passes `lines`. A metadata-only
 * update (doc_number / txn_date / private_note) posts the fetched Line array
 * by reference — never rebuilt, so the Ids are never lost.
 *
 * When `lines` IS passed, existing Line.Ids are carried onto the rebuilt
 * lines (explicit `line_id`, else by position — see stampLineIds) and the
 * update is a full `sparse:false` rewrite so omitted lines are removed.
 * Throws LineIdError (nothing posted) on an unknown / duplicate line_id.
 * doc_number: undefined = untouched, "" = clear, otherwise set.
 */
export function buildJournalEntryUpdatePayload(
  existing: any,
  args: {
    txn_date?: string;
    private_note?: string;
    doc_number?: string;
    lines?: JournalLineInput[];
  }
): any {
  const payload: any = { ...existing };
  if (args.txn_date) payload.TxnDate = args.txn_date;
  if (args.private_note !== undefined) payload.PrivateNote = args.private_note;
  if (args.doc_number !== undefined) payload.DocNumber = args.doc_number;
  if (args.lines) {
    payload.Line = replaceLinesWithIds(
      existing?.Line,
      buildJournalEntryLines(args.lines),
      args.lines,
      journalLineKind,
      'journal entry'
    );
    payload.sparse = false;
  }
  return payload;
}

// ── Expense (Purchase) converter ───────────────────────────────────────────────
// NOTE: uses expense_account_id (matching create_expense schema) not account_id

export function qboExpenseLinesToUpdateShape(lines: any[]): any[] {
  return (lines ?? [])
    .filter((l: any) =>
      l.DetailType === 'AccountBasedExpenseLineDetail' ||
      l.DetailType === 'ItemBasedExpenseLineDetail'
    )
    .map((l: any) => {
      const out: any = {};
      if (l.Id != null) out.line_id = String(l.Id);
      out.amount = l.Amount ?? 0;
      out.description = l.Description;
      out.detail_type = l.DetailType as 'AccountBasedExpenseLineDetail' | 'ItemBasedExpenseLineDetail';
      if (l.DetailType === 'AccountBasedExpenseLineDetail') {
        const d = l.AccountBasedExpenseLineDetail ?? {};
        if (d.AccountRef?.value) out.expense_account_id = d.AccountRef.value;
        if (d.AccountRef?.name) out.expense_account_name = d.AccountRef.name;
        if (d.ClassRef?.value) out.class_id = d.ClassRef.value;
      } else {
        const d = l.ItemBasedExpenseLineDetail ?? {};
        if (d.ItemRef?.value) out.item_id = d.ItemRef.value;
        if (d.ItemRef?.name) out.item_name = d.ItemRef.name;
        if (d.Qty != null) out.quantity = d.Qty;
        if (d.UnitPrice != null) out.unit_price = d.UnitPrice;
        if (d.ClassRef?.value) out.class_id = d.ClassRef.value;
      }
      return out;
    });
}

// ── Purchase Order converter ───────────────────────────────────────────────────

export function qboPoLinesToUpdateShape(lines: any[]): any[] {
  return (lines ?? [])
    .filter((l: any) =>
      l.DetailType === 'ItemBasedExpenseLineDetail' ||
      l.DetailType === 'AccountBasedExpenseLineDetail'
    )
    .map((l: any) => {
      const out: any = { amount: l.Amount ?? 0, description: l.Description };
      if (l.DetailType === 'ItemBasedExpenseLineDetail') {
        const d = l.ItemBasedExpenseLineDetail ?? {};
        if (d.ItemRef?.value) out.item_id = d.ItemRef.value;
        if (d.ItemRef?.name) out.item_name = d.ItemRef.name;
        if (d.Qty != null) out.quantity = d.Qty;
        if (d.UnitPrice != null) out.unit_price = d.UnitPrice;
      } else if (l.AccountBasedExpenseLineDetail?.AccountRef?.value) {
        out.account_id = l.AccountBasedExpenseLineDetail.AccountRef.value;
      }
      return out;
    });
}

// ── Deposit converters ─────────────────────────────────────────────────────────

export type DepositEntityType = 'Customer' | 'Vendor' | 'Employee';

export interface DepositDirectLineInput {
  amount: number;
  account_id: string;
  description?: string;
  /** Alias for entity_id with entity_type "Customer" (kept for backward compatibility). */
  customer_id?: string;
  /** "Received From" entity — requires entity_type. */
  entity_id?: string;
  entity_type?: DepositEntityType;
  /** QBO Class ID → DepositLineDetail.ClassRef.value (class-tracked companies). */
  class_id?: string;
  /** QBO PaymentMethod ID → DepositLineDetail.PaymentMethodRef.value (e.g. Cash "1", Check "2"). */
  payment_method_id?: string;
}

export interface DepositLinkedPaymentInput {
  payment_id: string;
  amount: number;
}

export interface DepositUpdateShape {
  linked_payment_ids: DepositLinkedPaymentInput[];
  deposit_lines: DepositDirectLineInput[];
}

export function qboDepositLinesToUpdateShape(lines: any[]): DepositUpdateShape {
  const linked_payment_ids: DepositLinkedPaymentInput[] = [];
  const deposit_lines: DepositDirectLineInput[] = [];

  for (const l of (lines ?? [])) {
    if (l.LinkedTxn?.length && l.LinkedTxn[0].TxnType === 'Payment') {
      linked_payment_ids.push({ payment_id: l.LinkedTxn[0].TxnId, amount: l.Amount ?? 0 });
    } else if (l.DetailType === 'DepositLineDetail' && l.DepositLineDetail) {
      const d = l.DepositLineDetail;
      const dl: DepositDirectLineInput = { amount: l.Amount ?? 0, account_id: d.AccountRef?.value ?? '' };
      if (l.Description) dl.description = l.Description;
      // Class + Payment Method are per-LINE on deposits. They must round-trip:
      // buildDepositUpdatePayload preserves an omitted line kind by re-reading
      // it through here and rebuilding it, so dropping these would silently
      // strip Class/Payment Method off every preserved line of a
      // class-tracked deposit.
      if (d.ClassRef?.value) dl.class_id = String(d.ClassRef.value);
      if (d.PaymentMethodRef?.value) dl.payment_method_id = String(d.PaymentMethodRef.value);
      // QBO stores DepositLineDetail.Entity as a FLAT ref {value, name, type}
      // with an UPPERCASE type (CUSTOMER/VENDOR/EMPLOYEE). The nested
      // {Type, EntityRef} shape belongs to JournalEntryLineDetail only —
      // read it as a fallback so old malformed writes still round-trip.
      const entityValue = d.Entity?.value ?? d.Entity?.EntityRef?.value;
      if (entityValue) {
        const rawType = String(d.Entity?.type ?? d.Entity?.Type ?? 'CUSTOMER');
        const entityType = (rawType.charAt(0).toUpperCase() +
          rawType.slice(1).toLowerCase()) as DepositEntityType;
        dl.entity_id = String(entityValue);
        dl.entity_type = entityType;
        if (entityType === 'Customer') dl.customer_id = String(entityValue);
      }
      deposit_lines.push(dl);
    }
  }
  return { linked_payment_ids, deposit_lines };
}

/**
 * Build a QBO Deposit `Line` array from linked payments + direct lines.
 * Shared by create_deposit and update_deposit so both write the same shapes.
 *
 * Callers must validate entity_id/entity_type pairing before calling
 * (see depositLineEntityError); an entity_id without a type is skipped here.
 */
export function buildDepositTxnLines(
  linkedPayments: DepositLinkedPaymentInput[] = [],
  depositLines: DepositDirectLineInput[] = []
): any[] {
  const lines: any[] = [];
  for (const lp of linkedPayments) {
    lines.push({
      Amount: lp.amount,
      LinkedTxn: [{ TxnId: lp.payment_id, TxnType: 'Payment' }],
    });
  }
  for (const dl of depositLines) {
    const line: any = {
      Amount: dl.amount,
      Description: dl.description,
      DetailType: 'DepositLineDetail',
      DepositLineDetail: { AccountRef: { value: dl.account_id } },
    };
    if (dl.class_id) line.DepositLineDetail.ClassRef = { value: dl.class_id };
    if (dl.payment_method_id) line.DepositLineDetail.PaymentMethodRef = { value: dl.payment_method_id };
    const entityId = dl.entity_id ?? dl.customer_id;
    if (entityId) {
      const type = dl.entity_id ? dl.entity_type : 'Customer';
      if (type) {
        // Flat ref + UPPERCASE type — QBO silently drops any other shape.
        line.DepositLineDetail.Entity = { value: entityId, type: type.toUpperCase() };
      }
    }
    lines.push(line);
  }
  return lines;
}

/** Returns an error string if any deposit line has entity_id without entity_type. */
export function depositLineEntityError(depositLines: DepositDirectLineInput[] = []): string | null {
  const bad = depositLines.find((dl) => dl.entity_id && !dl.entity_type);
  if (!bad) return null;
  return `Deposit line for account ${bad.account_id} has entity_id ${bad.entity_id} without entity_type. Pass entity_type (Vendor | Customer | Employee) so the "Received From" attribution is explicit — nothing was posted.`;
}

// ── Line.Id stamping (shared by every line-replacing update) ─────────────────

/**
 * Thrown when a caller-supplied line_id cannot be honoured. Raised BEFORE
 * anything is posted, so handlers can surface the message verbatim.
 */
export class LineIdError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LineIdError';
  }
}

/**
 * Classifies a QBO line for Id matching. Returns a bucket key for a real,
 * caller-editable line (lines are matched by position WITHIN a bucket), or
 * null for QBO-injected / non-editable rows (SubTotal, Discount, Group, …),
 * which never take part in matching.
 */
export type LineKindFn = (line: any) => string | null;

export interface StampLineIdsOptions {
  /** Bucket classifier; default treats every non-SubTotal line as 'monetary'. */
  lineKind?: LineKindFn;
  /**
   * Optional exact-match key (e.g. Deposit linked payments by TxnId). A new
   * line with a key only ever takes the Id of the existing line with the same
   * key and never consumes a positional slot.
   */
  matchKey?: (line: any) => string | null | undefined;
  /**
   * Caller-supplied line_id per new line (same index as newLines). If ANY is
   * set, explicit mode applies: set ids must exist on an editable existing
   * line (else LineIdError), and lines without one are new (no Id).
   */
  explicitIds?: Array<string | null | undefined>;
  /** Lower-case label for error messages, e.g. 'invoice'. */
  entityLabel?: string;
}

const defaultLineKind: LineKindFn = (l) =>
  l?.DetailType === 'SubTotalLineDetail' ? null : 'monetary';

/**
 * Carry existing QBO Line.Ids onto a rebuilt Line array so QBO edits those
 * lines in place.
 *
 * QBO line semantics (confirmed production 2026-09-25 on Deposit, same
 * write model for every transaction): a posted line WITH an Id updates that
 * line; a line WITHOUT an Id is ADDED; existing lines missing from the
 * payload are only removed on a full (sparse:false) update. Rebuilding lines
 * without Ids therefore APPENDS (1 line → 2 → 3 → 7, PR #5).
 *
 * Modes:
 *  - explicit (any explicitIds set): each set id must match an editable
 *    existing line (unknown or duplicated → LineIdError, nothing posted);
 *    unset entries are new lines with no Id.
 *  - positional (no explicitIds set): keyed lines match by key; the rest are
 *    matched by index within their lineKind bucket, so the first
 *    min(old, new) lines of each bucket keep their Ids and any extra new
 *    lines get none (true add). Unused existing Ids are simply omitted —
 *    callers set sparse:false so QBO removes those lines.
 *
 * Never mutates its inputs.
 */
export function stampLineIds(
  existingLines: any[] | undefined | null,
  newLines: any[],
  opts: StampLineIdsOptions = {}
): any[] {
  const kindOf = opts.lineKind ?? defaultLineKind;
  const keyOf = opts.matchKey ?? (() => null);
  const label = opts.entityLabel ?? 'transaction';
  const editable = (existingLines ?? []).filter((l: any) => l != null && kindOf(l) !== null);
  const incoming = newLines ?? [];

  const explicit = opts.explicitIds ?? [];
  const hasExplicit = explicit.some((id) => id != null && String(id) !== '');
  if (hasExplicit) {
    const byId = new Map<string, any>();
    for (const l of editable) if (l.Id != null) byId.set(String(l.Id), l);
    const known = [...byId.keys()];
    const seen = new Set<string>();
    return incoming.map((line: any, i: number) => {
      const out = { ...line };
      delete out.Id;
      const raw = explicit[i];
      if (raw == null || String(raw) === '') return out;
      const id = String(raw);
      if (!byId.has(id)) {
        throw new LineIdError(
          `line_id "${id}" (line ${i + 1}) does not exist on this ${label}. ` +
          `Existing line_ids: ${known.length ? known.join(', ') : '(none)'}. ` +
          `Use the matching get_* tool to read the current line_ids, or omit line_id to add a new line. Nothing was posted.`
        );
      }
      if (seen.has(id)) {
        throw new LineIdError(
          `line_id "${id}" is used on more than one line (line ${i + 1} repeats it). ` +
          `Each existing line can only be edited once — omit line_id on the extra line to add it as a new line. Nothing was posted.`
        );
      }
      seen.add(id);
      out.Id = byId.get(id).Id;
      return out;
    });
  }

  const keyed = new Map<string, any>();
  const buckets = new Map<string, any[]>();
  for (const l of editable) {
    const key = keyOf(l);
    if (key != null) {
      keyed.set(key, l);
      continue;
    }
    const kind = kindOf(l) as string;
    if (!buckets.has(kind)) buckets.set(kind, []);
    buckets.get(kind)!.push(l);
  }
  const cursors = new Map<string, number>();
  return incoming.map((line: any) => {
    const out = { ...line };
    const key = keyOf(out);
    if (key != null) {
      const match = keyed.get(key);
      if (match?.Id != null) out.Id = match.Id;
      return out;
    }
    const kind = kindOf(out);
    if (kind === null) return out;
    const idx = cursors.get(kind) ?? 0;
    cursors.set(kind, idx + 1);
    const match = buckets.get(kind)?.[idx];
    if (match?.Id != null) out.Id = match.Id;
    return out;
  });
}

/**
 * Replace an entity's editable lines with `builtLines`, carrying Ids via
 * stampLineIds (explicit `line_id` on the inputs, else positional).
 *
 * Fetched rows that are NOT caller-editable (lineKind null) are handled as:
 *  - SubTotalLineDetail → dropped (QBO recomputes it; never re-posted);
 *  - anything else (Discount, Group, …) → carried through verbatim WITH its
 *    Id, after the rebuilt lines, so a line edit never silently deletes a
 *    discount the caller could not see in the get_* shape.
 * Editable fetched lines not carried into the result are dropped; callers
 * MUST set payload.sparse = false so QBO actually removes them.
 */
export function replaceLinesWithIds(
  existingLines: any[] | undefined | null,
  builtLines: any[],
  inputs: Array<{ line_id?: string | null }>,
  lineKind: LineKindFn,
  entityLabel: string
): any[] {
  const stamped = stampLineIds(existingLines, builtLines, {
    lineKind,
    explicitIds: (inputs ?? []).map((l) => l?.line_id),
    entityLabel,
  });
  const preserved = (existingLines ?? []).filter(
    (l: any) => l != null && lineKind(l) === null && l.DetailType !== 'SubTotalLineDetail'
  );
  return [...stamped, ...preserved];
}

/** Invoice / SalesReceipt: SalesItem lines and DescriptionOnly rows are editable (separate buckets). */
export const salesLineKind: LineKindFn = (l) => {
  if (l?.DetailType === 'SalesItemLineDetail') return 'monetary';
  if (l?.DetailType === 'DescriptionOnly') return 'description';
  return null;
};

/** Bill / Purchase (expense): account- and item-based lines share one positional bucket. */
export const expenseLineKind: LineKindFn = (l) =>
  l?.DetailType === 'AccountBasedExpenseLineDetail' || l?.DetailType === 'ItemBasedExpenseLineDetail'
    ? 'monetary'
    : null;

/** JournalEntry: every JournalEntryLineDetail line (debits and credits) in one bucket, by position. */
export const journalLineKind: LineKindFn = (l) =>
  l?.DetailType === 'JournalEntryLineDetail' ? 'monetary' : null;

function isDepositLinkedPayment(l: any): boolean {
  return l?.LinkedTxn?.[0]?.TxnId != null && l?.LinkedTxn?.[0]?.TxnType === 'Payment';
}

/**
 * Stamp existing Deposit Line.Ids onto a rebuilt Line array so QBO updates
 * those lines in place. Thin wrapper over stampLineIds (behaviour unchanged
 * from PR #5).
 *
 * Production (2026-09-25, HIL Deposit 48 / HK Deposit 64): for Deposit,
 * lines WITHOUT an Id are ADDED and omitted lines are NOT removed. The
 * Aug "strip Ids = replace" assumption is exactly wrong for Deposit —
 * changing account on one line must keep that line's Id.
 *
 * Matching:
 *  - Linked Payment lines → by LinkedTxn[0].TxnId
 *  - DepositLineDetail lines → by index among direct lines (so re-coding
 *    account keeps the same Id)
 * Extra new lines beyond the existing count get no Id (true add). Shrinking
 * omits unused Ids; with sparse:false QBO should drop them (verification
 * catches failure).
 */
export function stampDepositLineIds(existingLines: any[] | undefined | null, newLines: any[]): any[] {
  return stampLineIds(existingLines, newLines, {
    entityLabel: 'deposit',
    lineKind: (l) =>
      isDepositLinkedPayment(l) ? 'linked' : l?.DetailType === 'DepositLineDetail' ? 'direct' : null,
    matchKey: (l) => (isDepositLinkedPayment(l) ? `txn:${String(l.LinkedTxn[0].TxnId)}` : null),
  });
}

/**
 * Build the full-update payload for a Deposit (read-modify-write).
 *
 * Deposit line semantics (confirmed production 2026-09-25): lines WITH an Id
 * update in place; lines WITHOUT an Id are ADDED; omitted Ids are dropped
 * only on a full (sparse:false) update. So the outgoing Line array is rebuilt
 * from scratch (never a concatenation onto fetched lines — that appends),
 * then existing Ids are stamped back onto matching rebuilt lines via
 * stampDepositLineIds. Carrying no Ids is exactly the bug that made
 * update_deposit append instead of replace when re-coding an account.
 *
 * Per-kind semantics (each array independently):
 *  - provided (even []) → that kind is REPLACED with exactly what was passed;
 *    linked_payment_ids: [] explicitly returns those payments to
 *    Undeposited Funds.
 *  - omitted (undefined) → that kind is PRESERVED, rebuilt from the fetched
 *    deposit with Ids stamped so re-coding a direct line never silently
 *    unlinks payments and never appends a duplicate.
 *  - both omitted → Line is left untouched entirely (scalar-only update).
 */
export function buildDepositUpdatePayload(
  existing: any,
  args: {
    deposit_account_id?: string;
    txn_date?: string;
    private_note?: string;
    /** undefined = untouched, "" = clear, otherwise set. Never touches Line. */
    doc_number?: string;
    linked_payment_ids?: DepositLinkedPaymentInput[];
    deposit_lines?: DepositDirectLineInput[];
  }
): any {
  const payload: any = { ...existing };
  if (args.deposit_account_id) payload.DepositToAccountRef = { value: args.deposit_account_id };
  if (args.txn_date) payload.TxnDate = args.txn_date;
  if (args.private_note !== undefined) payload.PrivateNote = args.private_note;
  if (args.doc_number !== undefined) payload.DocNumber = args.doc_number;
  if (args.linked_payment_ids || args.deposit_lines) {
    const current = qboDepositLinesToUpdateShape(existing?.Line ?? []);
    const linked = args.linked_payment_ids ?? current.linked_payment_ids;
    const direct = args.deposit_lines ?? current.deposit_lines;
    payload.Line = stampDepositLineIds(existing?.Line, buildDepositTxnLines(linked, direct));
    // Full update so omitted line Ids are dropped rather than left hanging.
    payload.sparse = false;
  }
  return payload;
}

// ── Swap helpers for swap_item_or_account ─────────────────────────────────────

export interface SwapResult {
  updatedLines: any[];
  linesChanged: number;
}

export function swapItemInLines(lines: any[], oldId: string, newId: string): SwapResult {
  let linesChanged = 0;
  const updatedLines = (lines ?? []).map((line: any) => {
    const l = { ...line };
    if (l.DetailType === 'SalesItemLineDetail' && l.SalesItemLineDetail?.ItemRef?.value === oldId) {
      l.SalesItemLineDetail = {
        ...l.SalesItemLineDetail,
        ItemRef: { ...l.SalesItemLineDetail.ItemRef, value: newId },
      };
      linesChanged++;
    } else if (
      l.DetailType === 'ItemBasedExpenseLineDetail' &&
      l.ItemBasedExpenseLineDetail?.ItemRef?.value === oldId
    ) {
      l.ItemBasedExpenseLineDetail = {
        ...l.ItemBasedExpenseLineDetail,
        ItemRef: { ...l.ItemBasedExpenseLineDetail.ItemRef, value: newId },
      };
      linesChanged++;
    }
    return l;
  });
  return { updatedLines, linesChanged };
}

export function swapAccountInLines(lines: any[], oldId: string, newId: string): SwapResult {
  let linesChanged = 0;
  const updatedLines = (lines ?? []).map((line: any) => {
    const l = { ...line };
    if (
      l.DetailType === 'AccountBasedExpenseLineDetail' &&
      l.AccountBasedExpenseLineDetail?.AccountRef?.value === oldId
    ) {
      l.AccountBasedExpenseLineDetail = {
        ...l.AccountBasedExpenseLineDetail,
        AccountRef: { ...l.AccountBasedExpenseLineDetail.AccountRef, value: newId },
      };
      linesChanged++;
    } else if (
      l.DetailType === 'JournalEntryLineDetail' &&
      l.JournalEntryLineDetail?.AccountRef?.value === oldId
    ) {
      l.JournalEntryLineDetail = {
        ...l.JournalEntryLineDetail,
        AccountRef: { ...l.JournalEntryLineDetail.AccountRef, value: newId },
      };
      linesChanged++;
    } else if (
      l.DetailType === 'DepositLineDetail' &&
      l.DepositLineDetail?.AccountRef?.value === oldId
    ) {
      l.DepositLineDetail = {
        ...l.DepositLineDetail,
        AccountRef: { ...l.DepositLineDetail.AccountRef, value: newId },
      };
      linesChanged++;
    }
    return l;
  });
  return { updatedLines, linesChanged };
}
