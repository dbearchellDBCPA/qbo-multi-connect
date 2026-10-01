// ─── Normalized, source-agnostic import schema (zod) ─────────────────────────
//
// The agent transforms any source export (NetSuite first) into these shapes
// before calling the server. Documented with one example per txn_type in
// docs/import-schema.md. Shape errors fail the whole call fast (zod names
// the row and field: transactions[12].lines[0].amount); everything that
// depends on the live company is a per-row status instead.

import { z } from 'zod';

export const TXN_TYPES = [
  'JournalEntry', 'Expense', 'Check', 'CreditCardCharge', 'CreditCardCredit', 'Deposit', 'Transfer',
  'Bill', 'BillPayment', 'VendorCredit', 'Invoice', 'Payment', 'CreditMemo', 'SalesReceipt', 'RefundReceipt',
] as const;
export type TxnType = (typeof TXN_TYPES)[number];

/** Normalized txn_type → QBO entity written for it. */
export const QBO_ENTITY_FOR: Record<TxnType, string> = {
  JournalEntry: 'JournalEntry',
  Expense: 'Purchase',
  Check: 'Purchase',
  CreditCardCharge: 'Purchase',
  CreditCardCredit: 'Purchase',
  Deposit: 'Deposit',
  Transfer: 'Transfer',
  Bill: 'Bill',
  BillPayment: 'BillPayment',
  VendorCredit: 'VendorCredit',
  Invoice: 'Invoice',
  Payment: 'Payment',
  CreditMemo: 'CreditMemo',
  SalesReceipt: 'SalesReceipt',
  RefundReceipt: 'RefundReceipt',
};

/** Every QBO entity the importer writes (and rebuild_import_index scans). */
export const IMPORT_QBO_ENTITIES = [...new Set(Object.values(QBO_ENTITY_FOR))];

/** Types that link to earlier imports and therefore load in the second pass. */
export const PAYMENT_TYPES: ReadonlySet<TxnType> = new Set<TxnType>(['Payment', 'BillPayment']);

export const NAME_TYPES = ['Vendor', 'Customer', 'Employee'] as const;
export type NameType = (typeof NAME_TYPES)[number];

/** source_id goes inside the PrivateNote stamp "[src:<source_id>]", so it cannot contain "]" or line breaks. */
export const sourceIdSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[^\]\r\n]+$/, 'source_id cannot contain "]" or line breaks (it is stamped into PrivateNote as [src:<source_id>])');

export const entityRefSchema = z
  .object({
    name: z.string().min(1).describe('DisplayName of the vendor, customer or employee (as created by batch_create_names)'),
    type: z.enum(NAME_TYPES).optional().describe('Vendor | Customer | Employee. Strongly recommended: a name found only under another type then fails with a message naming that type.'),
  })
  .strict();

export const importLineSchema = z
  .object({
    account_number: z.string().optional().describe('Line account by number (preferred)'),
    account_name: z.string().optional().describe('Line account by name; fully qualified "Parent:Child" allowed'),
    amount: z.number().describe('Positive amount; the side comes from posting_type (JournalEntry) or the transaction type'),
    posting_type: z.enum(['Debit', 'Credit']).optional().describe('JournalEntry lines only (required there)'),
    description: z.string().optional().describe('Line description (max 4000)'),
    entity: entityRefSchema.optional().describe('Line-level name: JournalEntry lines (required on A/R and A/P lines), Deposit "received from", Expense/Bill line customer'),
    class: z.string().optional().describe('Class by name (falls back to the transaction-level class)'),
    item_name: z.string().optional().describe('Invoice / CreditMemo / SalesReceipt / RefundReceipt lines: the Service item. Or omit and give account_number/account_name — the item ensure_items created for that account is used.'),
    quantity: z.number().optional().describe('Sales lines: quantity (default 1); unit price = amount / quantity'),
  })
  .strict();

export const linkedSchema = z
  .object({
    source_id: sourceIdSchema.describe('source_id of a previously imported Invoice/CreditMemo (Payment) or Bill/VendorCredit (BillPayment)'),
    amount: z.number().describe('Amount applied to that transaction'),
  })
  .strict();

export const normalizedTransactionSchema = z
  .object({
    source_id: sourceIdSchema.describe('REQUIRED external key, unique per company, e.g. "netsuite:21500"'),
    txn_type: z.enum(TXN_TYPES),
    txn_date: z.string().describe('YYYY-MM-DD'),
    doc_number: z.string().optional().describe('QBO DocNumber, max 21 characters (longer fails unless truncate_doc_numbers=true)'),
    memo: z.string().optional().describe('Goes to PrivateNote, followed by the [src:<source_id>] stamp (max 4000 together)'),
    entity: entityRefSchema.optional().describe('Transaction-level name: payee / vendor / customer'),
    account_number: z.string().optional().describe('Bank / credit-card / deposit-to / paid-from account (see docs/import-schema.md per type)'),
    account_name: z.string().optional().describe('Same slot as account_number, by (fully qualified) name'),
    class: z.string().optional().describe('Transaction-level class, used for lines that do not carry one'),
    lines: z.array(importLineSchema).max(1000).optional(),
    linked: z.array(linkedSchema).max(500).optional().describe('Payment → Invoices/CreditMemos, BillPayment → Bills/VendorCredits, by source_id'),
    payment_method: z.enum(['Cash', 'Check', 'CreditCard']).optional().describe('Expense: PaymentType (default Cash). BillPayment: Check (default; Cash is treated as Check) or CreditCard'),
    check_number: z.string().optional().describe('Paper check number → DocNumber (Check / Expense paid by check / BillPayment) or PaymentRefNum (Payment)'),
    transfer_to_account_number: z.string().optional().describe('Transfer only: destination account by number'),
    transfer_to_account_name: z.string().optional().describe('Transfer only: destination account by name'),
    amount: z.number().optional().describe('Transfer amount; Payment / BillPayment total when it differs from the sum of linked (unapplied credit). Other types derive the total from lines.'),
    due_date: z.string().optional().describe('Bill / Invoice due date, YYYY-MM-DD'),
    terms: z.string().optional().describe('Bill / Invoice terms by name'),
  })
  .strict();

export type NormalizedLine = z.infer<typeof importLineSchema>;
export type NormalizedTransaction = z.infer<typeof normalizedTransactionSchema>;

export const nameRowSchema = z
  .object({
    display_name: z.string().min(1),
    name_type: z.enum(NAME_TYPES),
    company_name: z.string().optional(),
    given_name: z.string().optional(),
    family_name: z.string().optional(),
    email: z.string().optional(),
    phone: z.string().optional(),
    billing_address: z
      .object({
        street: z.string().optional(),
        city: z.string().optional(),
        state: z.string().optional(),
        postal_code: z.string().optional(),
        country: z.string().optional(),
      })
      .strict()
      .optional(),
    terms: z.string().optional().describe('Payment terms by name (Vendor TermRef / Customer SalesTermRef)'),
    vendor_1099: z.boolean().optional(),
    account_number: z.string().optional().describe('Vendor account number (QBO AcctNum)'),
    notes: z.string().optional(),
    active: z.boolean().optional().describe('Default true'),
    source_id: z.string().optional().describe('External key: stored in Vendor AcctNum (unless account_number is given) or appended to Customer Notes as [src:<id>]; always reported back'),
  })
  .strict();
export type NameRow = z.infer<typeof nameRowSchema>;

export const itemRowSchema = z
  .object({
    account_number: z.string().optional().describe('Income account by number'),
    account_name: z.string().optional().describe('Income account by (fully qualified) name'),
    item_name: z.string().optional().describe('Item name; default from name_pattern'),
    expense_account_number: z.string().optional().describe('Optional expense account (purchase side) by number'),
    expense_account_name: z.string().optional().describe('Optional expense account by name'),
    description: z.string().optional(),
  })
  .strict();
export type ItemRow = z.infer<typeof itemRowSchema>;

export const DEFAULT_ITEM_NAME_PATTERN = 'History - {account_name}';
