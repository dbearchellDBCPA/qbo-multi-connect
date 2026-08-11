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

// ── Deposit converter ──────────────────────────────────────────────────────────

export interface DepositUpdateShape {
  linked_payment_ids: Array<{ payment_id: string; amount: number }>;
  deposit_lines: Array<{
    amount: number;
    account_id: string;
    description?: string;
    customer_id?: string;
    entity_id?: string;
    entity_type?: 'Vendor' | 'Employee';
  }>;
}

export function qboDepositLinesToUpdateShape(lines: any[]): DepositUpdateShape {
  const linked_payment_ids: DepositUpdateShape['linked_payment_ids'] = [];
  const deposit_lines: DepositUpdateShape['deposit_lines'] = [];

  for (const l of (lines ?? [])) {
    if (l.LinkedTxn?.length && l.LinkedTxn[0].TxnType === 'Payment') {
      linked_payment_ids.push({ payment_id: l.LinkedTxn[0].TxnId, amount: l.Amount ?? 0 });
    } else if (l.DetailType === 'DepositLineDetail' && l.DepositLineDetail) {
      const d = l.DepositLineDetail;
      const dl: any = { amount: l.Amount ?? 0, account_id: d.AccountRef?.value ?? '' };
      if (l.Description) dl.description = l.Description;
      // QBO returns the line entity either nested ({ type, EntityRef: { value } },
      // the shape create_deposit writes) or flat ({ value, name, type: 'VENDOR' }).
      const entityId = d.Entity?.EntityRef?.value ?? d.Entity?.value;
      if (entityId) {
        const rawType = String(d.Entity?.type ?? d.Entity?.Type ?? 'Customer');
        const entityType = rawType.charAt(0).toUpperCase() + rawType.slice(1).toLowerCase();
        if (entityType === 'Vendor' || entityType === 'Employee') {
          dl.entity_id = entityId;
          dl.entity_type = entityType;
        } else {
          dl.customer_id = entityId;
        }
      }
      deposit_lines.push(dl);
    }
  }
  return { linked_payment_ids, deposit_lines };
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
