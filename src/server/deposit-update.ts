/**
 * Pure helpers for create_deposit / update_deposit: QBO line building,
 * read-modify-write payload assembly, and post-write verification.
 *
 * Imported by both the MCP tool handlers and the tests, so the logic under
 * test is the exact logic that ships — no mirrored copies that can drift.
 *
 * THE REPLACE-ALL CONTRACT (update_deposit): when linked_payment_ids and/or
 * deposit_lines is provided, the two arrays together become the ENTIRE Line
 * array. The fetched deposit's lines are discarded, never concatenated —
 * appending would silently inflate a posted transaction's dollar amount, and
 * QBO offers no API to remove a deposit line afterwards. When neither array
 * is provided, the fetched lines pass through untouched.
 */

export interface LinkedPaymentInput {
  payment_id: string;
  amount: number;
}

export interface DepositLineInput {
  amount: number;
  account_id: string;
  description?: string;
  customer_id?: string;
  entity_id?: string;
  entity_type?: 'Customer' | 'Vendor' | 'Employee';
}

export interface DepositUpdateArgs {
  deposit_account_id?: string;
  txn_date?: string;
  private_note?: string;
  department_id?: string;
  linked_payment_ids?: LinkedPaymentInput[];
  deposit_lines?: DepositLineInput[];
}

// Builds the QBO Line array for a deposit from the tool-input arrays. Order
// matches create_deposit: linked payments first, then direct lines.
export function buildDepositQboLines(
  linkedPayments: LinkedPaymentInput[] | undefined,
  depositLines: DepositLineInput[] | undefined
): any[] {
  const lines: any[] = [];
  for (const lp of linkedPayments ?? []) {
    lines.push({
      Amount: lp.amount,
      LinkedTxn: [{ TxnId: lp.payment_id, TxnType: 'Payment' }],
    });
  }
  for (const dl of depositLines ?? []) {
    const entityId = dl.entity_id ?? dl.customer_id;
    const entityType = dl.entity_id ? (dl.entity_type ?? 'Customer') : 'Customer';
    lines.push({
      Amount: dl.amount,
      Description: dl.description,
      DetailType: 'DepositLineDetail',
      DepositLineDetail: {
        AccountRef: { value: dl.account_id },
        ...(entityId ? { Entity: { type: entityType, EntityRef: { value: entityId } } } : {}),
      },
    });
  }
  return lines;
}

export function buildDepositUpdatePayload(
  existing: any,
  args: DepositUpdateArgs
): { payload: any; linesReplaced: boolean } {
  const payload: any = { ...existing };
  if (args.deposit_account_id) payload.DepositToAccountRef = { value: args.deposit_account_id };
  if (args.txn_date) payload.TxnDate = args.txn_date;
  if (args.department_id) payload.DepartmentRef = { value: args.department_id };
  if (args.private_note !== undefined) payload.PrivateNote = args.private_note;

  const linesReplaced = args.linked_payment_ids !== undefined || args.deposit_lines !== undefined;
  if (linesReplaced) {
    // Exactly the submitted lines. Assign, never concatenate with existing.Line.
    payload.Line = buildDepositQboLines(args.linked_payment_ids, args.deposit_lines);
  }
  return { payload, linesReplaced };
}

// ── Post-write verification ───────────────────────────────────────────────────

export interface DepositWriteVerification {
  ok: boolean;
  expected_line_count: number;
  actual_line_count: number;
  expected_total: number;
  actual_total: number;
  looks_appended: boolean;
}

const AMOUNT_TOLERANCE = 0.01;

function depositLineTotal(dep: any): number {
  return ((dep?.Line ?? []) as any[]).reduce(
    (sum, l) => sum + (parseFloat(l?.Amount ?? '0') || 0),
    0
  );
}

/**
 * Compare what was submitted against what QBO reports back after the write.
 * Checks line count and the sum of line amounts (line sums rather than
 * TotalAmt, so CashBack can't skew the comparison), and fingerprints the
 * classic append failure: actual == original + submitted.
 */
export function verifyDepositWrite(
  submitted: any,
  original: any,
  written: any
): DepositWriteVerification {
  const expected_line_count = (submitted?.Line ?? []).length;
  const actual_line_count = (written?.Line ?? []).length;
  const expected_total = depositLineTotal(submitted);
  const actual_total = depositLineTotal(written);
  const ok =
    actual_line_count === expected_line_count &&
    Math.abs(actual_total - expected_total) <= AMOUNT_TOLERANCE;

  const originalCount = (original?.Line ?? []).length;
  const originalTotal = depositLineTotal(original);
  const looks_appended =
    !ok &&
    actual_line_count === originalCount + expected_line_count &&
    Math.abs(actual_total - (originalTotal + expected_total)) <= AMOUNT_TOLERANCE;

  return { ok, expected_line_count, actual_line_count, expected_total, actual_total, looks_appended };
}

export type DepositRollbackOutcome =
  | { status: 'restored' }
  | { status: 'mismatched' }
  | { status: 'failed'; error: string };

function usd(n: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);
}

export function formatDepositVerificationFailure(
  v: DepositWriteVerification,
  rollback: DepositRollbackOutcome
): string {
  const parts: string[] = [
    `VERIFICATION FAILED — the write went through but the deposit does not match what was submitted. ` +
      `Expected ${v.expected_line_count} line(s) totaling ${usd(v.expected_total)}; ` +
      `QBO now shows ${v.actual_line_count} line(s) totaling ${usd(v.actual_total)}.`,
  ];
  if (v.looks_appended) {
    parts.push('The submitted lines were APPENDED to the existing lines, not replaced.');
  }
  parts.push(
    'DO NOT RETRY this update — retrying a failed-verification write can append the same lines again and inflate the deposit further.'
  );
  switch (rollback.status) {
    case 'restored':
      parts.push('Automatic rollback succeeded: the deposit was restored to its pre-update state and re-verified.');
      break;
    case 'mismatched':
      parts.push('Automatic rollback was attempted but the deposit still does not match its pre-update state — inspect it manually.');
      break;
    case 'failed':
      parts.push(`Automatic rollback FAILED (${rollback.error}) — the deposit is still in the mismatched state described above.`);
      break;
  }
  parts.push('Run get_deposit to inspect the current state before making any further changes.');
  return parts.join('\n');
}
