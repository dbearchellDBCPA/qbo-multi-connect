/**
 * Pure functions that convert QBO native line shapes → update-tool input shapes.
 * Used by get_<entity> tools to produce round-trip-safe output, and by
 * swap_item_or_account to mutate raw lines before re-posting.
 */

// ── Sales entity converters (Invoice, SalesReceipt, CreditMemo, Estimate) ─────

export function qboSalesLinesToUpdateShape(lines: any[]): any[] {
  return (lines ?? [])
    .filter((l: any) => l.DetailType !== 'SubTotalLineDetail')
    .map((l: any) => {
      const out: any = {
        amount: l.Amount ?? 0,
        description: l.Description,
      };
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

// ── Shared line BUILDERS (tool input shape → QBO Line) ─────────────────────────
// One builder per form family so create_* and update_* write identical line
// shapes, and so header-level class_id lands on every line that has no
// line-level class of its own.

export interface SalesLineInput {
  description?: string;
  amount: number;
  detail_type?: 'SalesItemLineDetail' | 'DescriptionOnly';
  item_id?: string;
  item_name?: string;
  quantity?: number;
  unit_price?: number;
  /** Line ClassRef (SalesItemLineDetail.ClassRef). */
  class_id?: string;
  /** Line TaxCodeRef, e.g. "TAX" / "NON" (SalesItemLineDetail.TaxCodeRef). */
  tax_code_id?: string;
}

/**
 * Build sales-form lines (Invoice, Estimate, CreditMemo, SalesReceipt).
 * `headerClassId` fills the class of every SalesItemLineDetail line that has
 * no class_id of its own; a line's own class_id always wins.
 */
export function buildSalesTxnLines(lines: SalesLineInput[], headerClassId?: string): any[] {
  return (lines ?? []).map((l) => {
    const detailType = l.detail_type ?? 'SalesItemLineDetail';
    const line: any = { Amount: l.amount, DetailType: detailType, Description: l.description };
    if (detailType === 'SalesItemLineDetail') {
      line.SalesItemLineDetail = { Qty: l.quantity ?? 1, UnitPrice: l.unit_price ?? l.amount };
      if (l.item_id) line.SalesItemLineDetail.ItemRef = { value: l.item_id, name: l.item_name };
      const classId = l.class_id ?? headerClassId;
      if (classId) line.SalesItemLineDetail.ClassRef = { value: classId };
      if (l.tax_code_id) line.SalesItemLineDetail.TaxCodeRef = { value: l.tax_code_id };
    }
    return line;
  });
}

export interface BillLineInput {
  description?: string;
  amount: number;
  detail_type?: 'AccountBasedExpenseLineDetail' | 'ItemBasedExpenseLineDetail';
  account_id?: string;
  account_name?: string;
  item_id?: string;
  quantity?: number;
  unit_price?: number;
  class_id?: string;
}

/** Build Bill lines. Header class_id fills lines without a class of their own. */
export function buildBillTxnLines(lines: BillLineInput[], headerClassId?: string): any[] {
  return (lines ?? []).map((l) => {
    const detailType = l.detail_type ?? 'AccountBasedExpenseLineDetail';
    const line: any = { Amount: l.amount, DetailType: detailType, Description: l.description };
    const classId = l.class_id ?? headerClassId;
    if (detailType === 'AccountBasedExpenseLineDetail') {
      line.AccountBasedExpenseLineDetail = {};
      if (l.account_id) line.AccountBasedExpenseLineDetail.AccountRef = { value: l.account_id, name: l.account_name };
      if (classId) line.AccountBasedExpenseLineDetail.ClassRef = { value: classId };
    } else {
      line.ItemBasedExpenseLineDetail = { Qty: l.quantity ?? 1, UnitPrice: l.unit_price ?? l.amount };
      if (l.item_id) line.ItemBasedExpenseLineDetail.ItemRef = { value: l.item_id };
      if (classId) line.ItemBasedExpenseLineDetail.ClassRef = { value: classId };
    }
    return line;
  });
}

export interface PoLineInput {
  description?: string;
  amount: number;
  item_id?: string;
  item_name?: string;
  quantity?: number;
  unit_price?: number;
  account_id?: string;
  class_id?: string;
}

/** Build PurchaseOrder lines: item-based when item_id is given, else account-based. */
export function buildPoTxnLines(lines: PoLineInput[], headerClassId?: string): any[] {
  return (lines ?? []).map((l) => {
    const line: any = { Amount: l.amount, Description: l.description };
    const classId = l.class_id ?? headerClassId;
    if (l.item_id) {
      line.DetailType = 'ItemBasedExpenseLineDetail';
      line.ItemBasedExpenseLineDetail = { Qty: l.quantity ?? 1, UnitPrice: l.unit_price ?? l.amount, ItemRef: { value: l.item_id, name: l.item_name } };
      if (classId) line.ItemBasedExpenseLineDetail.ClassRef = { value: classId };
    } else {
      line.DetailType = 'AccountBasedExpenseLineDetail';
      line.AccountBasedExpenseLineDetail = {};
      if (l.account_id) line.AccountBasedExpenseLineDetail.AccountRef = { value: l.account_id };
      if (classId) line.AccountBasedExpenseLineDetail.ClassRef = { value: classId };
    }
    return line;
  });
}

/**
 * The one class shared by every sales line of a stored form, or null when
 * the lines are unclassed or carry different classes. update_* tools use it
 * so replacement lines that say nothing about class keep the class the form
 * already had instead of silently stripping it.
 */
export function uniformSalesLineClass(lines: any[] | undefined | null): { value: string; name?: string } | null {
  let found: { value: string; name?: string } | null = null;
  for (const l of lines ?? []) {
    if (l?.DetailType !== 'SalesItemLineDetail') continue;
    const ref = l.SalesItemLineDetail?.ClassRef;
    if (!ref?.value) return null;
    if (found && found.value !== String(ref.value)) return null;
    if (!found) found = { value: String(ref.value), ...(ref.name ? { name: ref.name } : {}) };
  }
  return found;
}

/** True when a stored form has sales lines carrying more than one class. */
export function hasMixedSalesLineClasses(lines: any[] | undefined | null): boolean {
  const seen = new Set<string>();
  for (const l of lines ?? []) {
    if (l?.DetailType !== 'SalesItemLineDetail') continue;
    const v = l.SalesItemLineDetail?.ClassRef?.value;
    if (v) seen.add(String(v));
  }
  return seen.size > 1;
}

// ── Bill converter ─────────────────────────────────────────────────────────────

export function qboBillLinesToUpdateShape(lines: any[]): any[] {
  return (lines ?? [])
    .filter((l: any) =>
      l.DetailType === 'AccountBasedExpenseLineDetail' ||
      l.DetailType === 'ItemBasedExpenseLineDetail'
    )
    .map((l: any) => {
      const out: any = {
        amount: l.Amount ?? 0,
        description: l.Description,
        detail_type: l.DetailType as 'AccountBasedExpenseLineDetail' | 'ItemBasedExpenseLineDetail',
      };
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
      const out: any = {
        amount: l.Amount ?? 0,
        description: l.Description,
        posting_type: d.PostingType as 'Debit' | 'Credit',
        account_id: d.AccountRef?.value ?? '',
      };
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

// ── Expense (Purchase) converter ───────────────────────────────────────────────
// NOTE: uses expense_account_id (matching create_expense schema) not account_id

export function qboExpenseLinesToUpdateShape(lines: any[]): any[] {
  return (lines ?? [])
    .filter((l: any) =>
      l.DetailType === 'AccountBasedExpenseLineDetail' ||
      l.DetailType === 'ItemBasedExpenseLineDetail'
    )
    .map((l: any) => {
      const out: any = {
        amount: l.Amount ?? 0,
        description: l.Description,
        detail_type: l.DetailType as 'AccountBasedExpenseLineDetail' | 'ItemBasedExpenseLineDetail',
      };
      if (l.DetailType === 'AccountBasedExpenseLineDetail') {
        const d = l.AccountBasedExpenseLineDetail ?? {};
        if (d.AccountRef?.value) out.expense_account_id = d.AccountRef.value;
        if (d.AccountRef?.name) out.expense_account_name = d.AccountRef.name;
        if (d.ClassRef?.value) out.class_id = d.ClassRef.value;
      } else {
        const d = l.ItemBasedExpenseLineDetail ?? {};
        if (d.ItemRef?.value) out.item_id = d.ItemRef.value;
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

/**
 * Build the full-update payload for a Deposit (read-modify-write).
 *
 * QBO full updates replace the entire Line array with whatever is posted
 * (lines with an Id update in place, lines without an Id are ADDED, omitted
 * lines are removed), so the outgoing Line array is rebuilt from scratch —
 * never the fetched line objects with their Ids, and never a concatenation
 * onto them. Carrying the fetched lines into the body is exactly the bug
 * that made update_deposit append instead of replace.
 *
 * Per-kind semantics (each array independently):
 *  - provided (even []) → that kind is REPLACED with exactly what was passed;
 *    linked_payment_ids: [] explicitly returns those payments to
 *    Undeposited Funds.
 *  - omitted (undefined) → that kind is PRESERVED, rebuilt cleanly (without
 *    Id/LineNum) from the fetched deposit — so re-coding a direct line can
 *    never silently unlink payments.
 *  - both omitted → Line is left untouched entirely (scalar-only update).
 */
export function buildDepositUpdatePayload(
  existing: any,
  args: {
    deposit_account_id?: string;
    txn_date?: string;
    private_note?: string;
    linked_payment_ids?: DepositLinkedPaymentInput[];
    deposit_lines?: DepositDirectLineInput[];
  }
): any {
  const payload: any = { ...existing };
  if (args.deposit_account_id) payload.DepositToAccountRef = { value: args.deposit_account_id };
  if (args.txn_date) payload.TxnDate = args.txn_date;
  if (args.private_note !== undefined) payload.PrivateNote = args.private_note;
  if (args.linked_payment_ids || args.deposit_lines) {
    const current = qboDepositLinesToUpdateShape(existing?.Line ?? []);
    const linked = args.linked_payment_ids ?? current.linked_payment_ids;
    const direct = args.deposit_lines ?? current.deposit_lines;
    payload.Line = buildDepositTxnLines(linked, direct);
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
