/**
 * Pure line + payload builders for the line-replacing update tools
 * (update_bill, update_expense, update_invoice, update_sales_receipt; the
 * journal-entry builder lives in line-converters.ts next to its create twin).
 *
 * Unit-tested in tests/server/update-line-ids.test.ts — no QBO calls.
 *
 * Invariants shared by every builder here:
 *  - Read-modify-write: the payload starts from the freshly fetched entity,
 *    so SyncToken, currency, attachments etc. are carried verbatim.
 *  - No `lines` → `Line` is the fetched array by reference (metadata-only
 *    update never rebuilds lines, never loses Ids — PR #6).
 *  - `lines` passed → rebuilt lines carry existing Line.Ids (explicit
 *    `line_id`, else positional — see stampLineIds), non-editable rows are
 *    handled by replaceLinesWithIds, and `sparse = false` so QBO removes
 *    lines that were left out. Without Ids QBO APPENDS instead (PR #5).
 *  - An unknown / duplicate line_id throws LineIdError before any write.
 */

import {
  replaceLinesWithIds,
  expenseLineKind,
  salesLineKind,
} from './line-converters.js';
import { applyDocNumberOnUpdate } from './doc-number.js';

// ── Bill ──────────────────────────────────────────────────────────────────────

export interface BillLineInput {
  line_id?: string;
  description?: string;
  amount: number;
  detail_type?: 'AccountBasedExpenseLineDetail' | 'ItemBasedExpenseLineDetail';
  account_id?: string;
  account_name?: string;
  item_id?: string;
  item_name?: string;
  quantity?: number;
  unit_price?: number;
  class_id?: string;
}

/** QBO Bill Line array (create + update). ClassRef is kept on BOTH line kinds. */
export function buildBillLines(lines: BillLineInput[]): any[] {
  return lines.map((l) => {
    const detailType = l.detail_type ?? 'AccountBasedExpenseLineDetail';
    const line: any = { Amount: l.amount, DetailType: detailType, Description: l.description };
    if (detailType === 'AccountBasedExpenseLineDetail') {
      line.AccountBasedExpenseLineDetail = {};
      if (l.account_id) line.AccountBasedExpenseLineDetail.AccountRef = { value: l.account_id, name: l.account_name };
      if (l.class_id) line.AccountBasedExpenseLineDetail.ClassRef = { value: l.class_id };
    } else {
      line.ItemBasedExpenseLineDetail = { Qty: l.quantity ?? 1, UnitPrice: l.unit_price ?? l.amount };
      if (l.item_id) line.ItemBasedExpenseLineDetail.ItemRef = l.item_name ? { value: l.item_id, name: l.item_name } : { value: l.item_id };
      if (l.class_id) line.ItemBasedExpenseLineDetail.ClassRef = { value: l.class_id };
    }
    return line;
  });
}

export function buildBillUpdatePayload(
  existing: any,
  args: {
    vendor_id?: string;
    txn_date?: string;
    due_date?: string;
    private_note?: string;
    department_id?: string;
    sales_term_id?: string;
    doc_number?: string;
    lines?: BillLineInput[];
  }
): any {
  const payload: any = { ...existing };
  if (args.vendor_id) payload.VendorRef = { value: args.vendor_id };
  if (args.txn_date) payload.TxnDate = args.txn_date;
  if (args.department_id) payload.DepartmentRef = { value: args.department_id };
  if (args.sales_term_id) payload.SalesTermRef = { value: args.sales_term_id };
  if (args.due_date) payload.DueDate = args.due_date;
  if (args.private_note !== undefined) payload.PrivateNote = args.private_note;
  applyDocNumberOnUpdate(payload, args.doc_number);
  if (args.lines) {
    payload.Line = replaceLinesWithIds(existing?.Line, buildBillLines(args.lines), args.lines, expenseLineKind, 'bill');
    payload.sparse = false;
  }
  return payload;
}

// ── Expense (Purchase) ────────────────────────────────────────────────────────

export interface ExpenseLineInput {
  line_id?: string;
  description?: string;
  amount: number;
  detail_type?: 'AccountBasedExpenseLineDetail' | 'ItemBasedExpenseLineDetail';
  expense_account_id?: string;
  expense_account_name?: string;
  item_id?: string;
  item_name?: string;
  quantity?: number;
  unit_price?: number;
  class_id?: string;
}

/** QBO Purchase Line array (create + update). ClassRef is kept on BOTH line kinds. */
export function buildExpenseLines(lines: ExpenseLineInput[]): any[] {
  return lines.map((l) => {
    const detailType = l.detail_type ?? 'AccountBasedExpenseLineDetail';
    const line: any = { Amount: l.amount, DetailType: detailType, Description: l.description };
    if (detailType === 'AccountBasedExpenseLineDetail') {
      line.AccountBasedExpenseLineDetail = {};
      if (l.expense_account_id) line.AccountBasedExpenseLineDetail.AccountRef = { value: l.expense_account_id, name: l.expense_account_name };
      if (l.class_id) line.AccountBasedExpenseLineDetail.ClassRef = { value: l.class_id };
    } else {
      line.ItemBasedExpenseLineDetail = { Qty: l.quantity ?? 1, UnitPrice: l.unit_price ?? l.amount };
      if (l.item_id) line.ItemBasedExpenseLineDetail.ItemRef = l.item_name ? { value: l.item_id, name: l.item_name } : { value: l.item_id };
      if (l.class_id) line.ItemBasedExpenseLineDetail.ClassRef = { value: l.class_id };
    }
    return line;
  });
}

export function buildExpenseUpdatePayload(
  existing: any,
  args: {
    payment_type?: string;
    account_id?: string;
    account_name?: string;
    txn_date?: string;
    /** Only set when non-empty (update_expense never clears an existing number). */
    doc_number?: string;
    /** Already-resolved payee (vendor_id, or vendor_name resolved by the handler). */
    entity_ref?: { value: string; name?: string } | null;
    private_note?: string;
    department_id?: string;
    lines?: ExpenseLineInput[];
  }
): any {
  const payload: any = { ...existing };
  if (args.payment_type) payload.PaymentType = args.payment_type;
  if (args.account_id) payload.AccountRef = { value: args.account_id, name: args.account_name };
  if (args.txn_date) payload.TxnDate = args.txn_date;
  if (args.doc_number) payload.DocNumber = args.doc_number;
  if (args.entity_ref) payload.EntityRef = { ...args.entity_ref, type: 'Vendor' };
  if (args.department_id) payload.DepartmentRef = { value: args.department_id };
  if (args.private_note !== undefined) payload.PrivateNote = args.private_note;
  if (args.lines) {
    payload.Line = replaceLinesWithIds(existing?.Line, buildExpenseLines(args.lines), args.lines, expenseLineKind, 'expense');
    payload.sparse = false;
  }
  return payload;
}

// ── Sales lines (Invoice, SalesReceipt) ───────────────────────────────────────

export interface SalesLineInput {
  line_id?: string;
  description?: string;
  amount: number;
  detail_type?: 'SalesItemLineDetail' | 'DescriptionOnly';
  item_id?: string;
  item_name?: string;
  quantity?: number;
  unit_price?: number;
  class_id?: string;
  tax_code_id?: string;
}

/** QBO sales Line array. Class + tax code are per-line (SalesItemLineDetail). */
export function buildSalesLines(lines: SalesLineInput[]): any[] {
  return lines.map((l) => {
    const detailType = l.detail_type ?? 'SalesItemLineDetail';
    const line: any = { Amount: l.amount, DetailType: detailType, Description: l.description };
    if (detailType === 'SalesItemLineDetail') {
      line.SalesItemLineDetail = { Qty: l.quantity ?? 1, UnitPrice: l.unit_price ?? l.amount };
      if (l.item_id) line.SalesItemLineDetail.ItemRef = { value: l.item_id, name: l.item_name };
      if (l.class_id) line.SalesItemLineDetail.ClassRef = { value: l.class_id };
      if (l.tax_code_id) line.SalesItemLineDetail.TaxCodeRef = { value: l.tax_code_id };
    }
    return line;
  });
}

export function buildInvoiceUpdatePayload(
  existing: any,
  args: {
    customer_id?: string;
    txn_date?: string;
    due_date?: string;
    private_note?: string;
    department_id?: string;
    sales_term_id?: string;
    doc_number?: string;
    lines?: SalesLineInput[];
  }
): any {
  const payload: any = { ...existing };
  if (args.customer_id) payload.CustomerRef = { value: args.customer_id };
  if (args.txn_date) payload.TxnDate = args.txn_date;
  if (args.department_id) payload.DepartmentRef = { value: args.department_id };
  if (args.sales_term_id) payload.SalesTermRef = { value: args.sales_term_id };
  if (args.due_date) payload.DueDate = args.due_date;
  if (args.private_note !== undefined) payload.PrivateNote = args.private_note;
  applyDocNumberOnUpdate(payload, args.doc_number);
  if (args.lines) {
    payload.Line = replaceLinesWithIds(existing?.Line, buildSalesLines(args.lines), args.lines, salesLineKind, 'invoice');
    payload.sparse = false;
  }
  return payload;
}

export function buildSalesReceiptUpdatePayload(
  existing: any,
  args: {
    txn_date?: string;
    private_note?: string;
    department_id?: string;
    doc_number?: string;
    lines?: SalesLineInput[];
  }
): any {
  const payload: any = { ...existing };
  if (args.txn_date) payload.TxnDate = args.txn_date;
  if (args.department_id) payload.DepartmentRef = { value: args.department_id };
  if (args.private_note !== undefined) payload.PrivateNote = args.private_note;
  applyDocNumberOnUpdate(payload, args.doc_number);
  if (args.lines) {
    payload.Line = replaceLinesWithIds(existing?.Line, buildSalesLines(args.lines), args.lines, salesLineKind, 'sales receipt');
    payload.sparse = false;
  }
  return payload;
}

// ── Tool-description text ─────────────────────────────────────────────────────

export const LINE_ID_PARAM_DESCRIPTION =
  'Existing QBO line Id to edit in place (returned as line_id by the matching get_* tool). ' +
  'Omit on a line to add it as a NEW line. If ANY line has line_id, only lines with a line_id keep an existing Id; ' +
  'an unknown line_id is rejected and nothing is posted.';

export const REPLACEMENT_LINES_BEHAVIOUR =
  'If `lines` is passed it is the COMPLETE new line set: existing lines you leave out are REMOVED. ' +
  'Existing QBO line Ids are carried so QBO edits lines in place (never appends duplicates): pass each line\'s line_id ' +
  '(from the get_* tool) for an exact match; if no line has line_id, Ids are matched BY POSITION — the 1st line you pass ' +
  'edits the 1st existing line, and so on; extra lines are added as new lines. The write is verified and rolled back ' +
  'automatically if QBO stores something different. Omit `lines` to change only header fields (lines untouched).';
