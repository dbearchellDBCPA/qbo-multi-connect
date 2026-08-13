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
 * QBO full updates replace the entire Line array with whatever is posted, so
 * when the caller provides linked_payment_ids and/or deposit_lines the new
 * Line array is built ONLY from those inputs. Concatenating onto the fetched
 * lines here is exactly the bug that made update_deposit append instead of
 * replace (and inflate the deposit total on every call).
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
    payload.Line = buildDepositTxnLines(args.linked_payment_ids ?? [], args.deposit_lines ?? []);
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
