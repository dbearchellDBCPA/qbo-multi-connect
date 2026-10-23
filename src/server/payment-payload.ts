/**
 * create_payment payload builder (customer Receive Payment).
 *
 * QBO represents an applied customer credit (CreditMemo, or a JournalEntry's
 * A/R credit line) as its own Payment Line with a positive Amount and
 * LinkedTxn TxnType CreditMemo / JournalEntry, alongside the Invoice lines.
 * TotalAmt = Σ invoice lines − Σ credit lines, so credits that fully cover the
 * invoices post a $0 Payment. Mirrors the BillPayment VendorCredit/JE handling
 * in import_transactions.
 */

/** Payment.Line LinkedTxn types that are credits (reduce TotalAmt). */
export const PAYMENT_CREDIT_TYPES: ReadonlySet<string> = new Set(['CreditMemo', 'JournalEntry']);

export class PaymentArgsError extends Error {}

export interface CreatePaymentArgs {
  customer_id: string;
  customer_name?: string;
  total_amount: number;
  txn_date?: string;
  payment_method_id?: string;
  deposit_to_account_id?: string;
  private_note?: string;
  department_id?: string;
  invoice_ids?: { invoice_id: string; amount?: number }[];
  credits?: { txn_type: 'CreditMemo' | 'JournalEntry'; txn_id: string; amount: number }[];
}

const toCents = (n: number) => Math.round(n * 100);
const money = (c: number) => (c / 100).toFixed(2);

function checkAmount(v: number | undefined, label: string, allowZero: boolean): void {
  if (v === undefined) return;
  if (!Number.isFinite(v) || v < 0 || (!allowZero && v === 0)) {
    throw new PaymentArgsError(`${label}: must be ${allowZero ? '0 or more' : 'greater than 0'} (got ${v}). Nothing was posted.`);
  }
  if (Math.abs(toCents(v) / 100 - v) > 1e-9) throw new PaymentArgsError(`${label}: ${v} has more than 2 decimal places. Nothing was posted.`);
}

export function buildPaymentCreatePayload(a: CreatePaymentArgs): any {
  const invoices = a.invoice_ids ?? [];
  const credits = a.credits ?? [];
  checkAmount(a.total_amount, 'total_amount', true);
  invoices.forEach((inv, i) => {
    if (!inv.invoice_id?.trim()) throw new PaymentArgsError(`invoice_ids[${i}]: invoice_id is required. Nothing was posted.`);
    checkAmount(inv.amount, `invoice_ids[${i}].amount`, false);
  });
  credits.forEach((c, i) => {
    if (!c.txn_id?.trim()) throw new PaymentArgsError(`credits[${i}]: txn_id (the ${c.txn_type} Id) is required. Nothing was posted.`);
    if (c.amount === undefined) throw new PaymentArgsError(`credits[${i}]: amount is required for ${c.txn_type} ${c.txn_id}. Nothing was posted.`);
    checkAmount(c.amount, `credits[${i}].amount (${c.txn_type} ${c.txn_id})`, false);
  });

  const payload: any = {
    CustomerRef: { value: a.customer_id, name: a.customer_name },
    TotalAmt: a.total_amount,
  };
  if (a.txn_date) payload.TxnDate = a.txn_date;
  if (a.payment_method_id) payload.PaymentMethodRef = { value: a.payment_method_id };
  if (a.deposit_to_account_id) payload.DepositToAccountRef = { value: a.deposit_to_account_id };
  if (a.department_id) payload.DepartmentRef = { value: a.department_id };
  if (a.private_note) payload.PrivateNote = a.private_note;

  if (credits.length > 0) {
    if (invoices.length === 0) throw new PaymentArgsError('credits need at least one invoice in invoice_ids to apply to. Nothing was posted.');
    invoices.forEach((inv, i) => {
      if (inv.amount === undefined) throw new PaymentArgsError(`invoice_ids[${i}].amount is required when credits are applied (no full-balance default). Nothing was posted.`);
    });
    const invCents = invoices.reduce((s, x) => s + toCents(x.amount!), 0);
    const credCents = credits.reduce((s, x) => s + toCents(x.amount), 0);
    const net = invCents - credCents;
    if (net < 0) throw new PaymentArgsError(`credits (${money(credCents)}) exceed the invoice amounts (${money(invCents)}). Nothing was posted.`);
    if (toCents(a.total_amount) !== net) {
      throw new PaymentArgsError(`total_amount ${a.total_amount.toFixed(2)} must equal invoices ${money(invCents)} − credits ${money(credCents)} = ${money(net)}. Nothing was posted.`);
    }
  }

  if (invoices.length > 0) {
    payload.Line = [
      ...invoices.map((inv) => ({ Amount: inv.amount ?? a.total_amount, LinkedTxn: [{ TxnId: inv.invoice_id, TxnType: 'Invoice' }] })),
      ...credits.map((c) => ({ Amount: c.amount, LinkedTxn: [{ TxnId: c.txn_id, TxnType: c.txn_type }] })),
    ];
  }
  return payload;
}
