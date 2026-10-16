/**
 * PrintStatus handling for BillPayment (CheckPayment.PrintStatus) and
 * Purchase (Purchase.PrintStatus).
 *
 * Default rules:
 *  - print_status given → sent as-is (only valid for Check pay/payment type).
 *  - print_status omitted but a DocNumber/check ref is supplied → 'NotSet'
 *    (a referenced payment was already issued; QBO would otherwise default
 *    it to 'NeedToPrint' and it would sit in the "checks to print" queue).
 *  - otherwise: create → nothing sent (QBO default); update → existing value kept.
 */
export const PRINT_STATUS_VALUES = ['NotSet', 'NeedToPrint', 'PrintComplete'] as const;
export type PrintStatus = (typeof PRINT_STATUS_VALUES)[number];

export const PRINT_STATUS_DESCRIPTION =
  "Check print status: 'NotSet' | 'NeedToPrint' | 'PrintComplete'. Only valid for Check payments (rejected for CreditCard/Cash). " +
  "If omitted and a doc_number (check/ref no.) is supplied, 'NotSet' is sent so the payment does not land in QBO's checks-to-print queue; " +
  'otherwise create sends nothing (QBO default) and update preserves the existing value.';

export class PrintStatusError extends Error {}

/** Resolve the PrintStatus to send, or undefined to send/change nothing. */
export function resolvePrintStatus(args: {
  print_status?: PrintStatus;
  doc_number?: string;
  isCheck: boolean;
  label: string;
}): PrintStatus | undefined {
  if (args.print_status !== undefined) {
    if (!args.isCheck) {
      throw new PrintStatusError(
        `print_status only applies to Check ${args.label}s — it cannot be set on a non-Check ${args.label}. Nothing was posted.`
      );
    }
    return args.print_status;
  }
  if (args.isCheck && args.doc_number) return 'NotSet';
  return undefined;
}

export interface CreateBillPaymentArgs {
  vendor_id: string;
  vendor_name?: string;
  total_amount: number;
  txn_date?: string;
  doc_number?: string;
  pay_type: 'Check' | 'CreditCard';
  bank_account_id?: string;
  credit_card_account_id?: string;
  private_note?: string;
  department_id?: string;
  print_status?: PrintStatus;
  bill_ids?: { bill_id: string; amount?: number }[];
}

export function buildBillPaymentCreatePayload(a: CreateBillPaymentArgs): any {
  const isCheck = a.pay_type === 'Check';
  const ps = resolvePrintStatus({ print_status: a.print_status, doc_number: a.doc_number, isCheck, label: 'bill payment' });
  if (isCheck && !a.bank_account_id) {
    // Without this QBO can save a Check BillPayment (notably a $0 one) with no
    // CheckPayment.BankAccountRef at all.
    throw new PrintStatusError('bank_account_id is required for Check bill payments. Nothing was posted.');
  }
  if (!isCheck && !a.credit_card_account_id) {
    throw new PrintStatusError('credit_card_account_id is required for CreditCard bill payments. Nothing was posted.');
  }
  const payload: any = {
    VendorRef: { value: a.vendor_id, name: a.vendor_name },
    TotalAmt: a.total_amount,
    PayType: a.pay_type,
  };
  if (a.txn_date) payload.TxnDate = a.txn_date;
  if (a.doc_number) payload.DocNumber = a.doc_number;
  if (a.department_id) payload.DepartmentRef = { value: a.department_id };
  if (a.private_note) payload.PrivateNote = a.private_note;
  if (isCheck) {
    payload.CheckPayment = { BankAccountRef: { value: a.bank_account_id }, ...(ps ? { PrintStatus: ps } : {}) };
  } else {
    payload.CreditCardPayment = { CCAccountRef: { value: a.credit_card_account_id } };
  }
  if (a.bill_ids && a.bill_ids.length > 0) {
    payload.Line = a.bill_ids.map((b) => ({
      Amount: b.amount ?? a.total_amount,
      LinkedTxn: [{ TxnId: b.bill_id, TxnType: 'Bill' }],
    }));
  }
  return payload;
}

/**
 * Merge pay-account / print-status changes into an existing BillPayment
 * payload (full read-modify-write object). The existing CheckPayment is
 * spread first so BankAccountRef / PrintStatus survive when only one changes.
 */
export function applyBillPaymentPayChanges(
  bp: any,
  payload: any,
  a: { pay_account_id?: string; doc_number?: string; print_status?: PrintStatus }
): void {
  const isCheck = bp.PayType !== 'CreditCard';
  const ps = resolvePrintStatus({ print_status: a.print_status, doc_number: a.doc_number, isCheck, label: 'bill payment' });
  if (!isCheck) {
    if (a.pay_account_id) payload.CreditCardPayment = { ...(bp.CreditCardPayment ?? {}), CCAccountRef: { value: a.pay_account_id } };
    return;
  }
  if (!a.pay_account_id && !ps) return; // untouched — existing CheckPayment carried by the spread
  const cp: any = { ...(bp.CheckPayment ?? {}) };
  if (a.pay_account_id) cp.BankAccountRef = { value: a.pay_account_id };
  if (ps) cp.PrintStatus = ps;
  if (!cp.BankAccountRef?.value) {
    throw new PrintStatusError(
      `Bill Payment ${bp.Id} has no CheckPayment.BankAccountRef — pass pay_account_id (the bank account) with this update so it is not written without one. Nothing was posted.`
    );
  }
  payload.CheckPayment = cp;
}

/** Purchase.PrintStatus on create_expense. Mutates payload. */
export function applyExpenseCreatePrintStatus(payload: any, a: { payment_type: string; doc_number?: string; print_status?: PrintStatus }): void {
  const ps = resolvePrintStatus({ print_status: a.print_status, doc_number: a.doc_number, isCheck: a.payment_type === 'Check', label: 'expense' });
  if (ps) payload.PrintStatus = ps;
}

/** Purchase.PrintStatus on update_expense (payload already spread from existing). */
export function applyExpenseUpdatePrintStatus(existing: any, payload: any, a: { payment_type?: string; doc_number?: string; print_status?: PrintStatus }): void {
  const type = a.payment_type ?? existing?.PaymentType;
  const isCheck = type === 'Check';
  const ps = resolvePrintStatus({ print_status: a.print_status, doc_number: a.doc_number, isCheck, label: 'expense' });
  if (ps) payload.PrintStatus = ps;
  else if (!isCheck && payload.PrintStatus !== undefined) delete payload.PrintStatus; // switched away from Check
}
