/**
 * create_bill_payment with vendor credits applied (credits[]) and dry_run.
 *
 * Payload math reuses planBillPayment from the import_transactions BillPayment
 * path: one Line per Bill (LinkedTxn Bill) followed by one Line per credit
 * applied to it (positive Amount, LinkedTxn VendorCredit); TotalAmt = bills −
 * credits, so credits that fully cover the bills post a $0 BillPayment.
 *
 * Validated flow (used whenever credits[] is given or dry_run=true):
 *   1. structural checks (strict amounts, total = bills − credits)
 *   2. fetch every Bill / VendorCredit: exists, same vendor, open Balance covers
 *   3. no reconcile/cleared check: Bills and VendorCredits are A/P documents and
 *      never carry a cleared/reconciled status in QBO (allow_reconciled is a no-op)
 *   4. dry_run → return payload + checks; else post, re-read BillPayment + each
 *      Bill + each VendorCredit, verify balances; on mismatch delete the new
 *      BillPayment (rollback) and report.
 */
import { planBillPayment } from './import-build.js';
import { buildBillPaymentCreatePayload, PrintStatusError, type CreateBillPaymentArgs } from './print-status.js';

export class BillPaymentCreditsError extends Error {}

export interface BillPaymentCreditArg { txn_type: 'VendorCredit'; txn_id: string; amount: number; bill_id?: string }
export interface CreateBillPaymentWithCreditsArgs extends CreateBillPaymentArgs {
  credits?: BillPaymentCreditArg[];
}

const toCents = (n: number) => Math.round(n * 100);
const money = (c: number) => (c / 100).toFixed(2);

function checkAmount(v: number | undefined, label: string, allowZero: boolean): string | null {
  if (v === undefined) return null;
  if (!Number.isFinite(v) || v < 0 || (!allowZero && v === 0)) return `${label}: must be ${allowZero ? '0 or more' : 'greater than 0'} (got ${v}).`;
  if (Math.abs(toCents(v) / 100 - v) > 1e-9) return `${label}: ${v} has more than 2 decimal places.`;
  return null;
}

/** Pure payload builder. Throws BillPaymentCreditsError listing every structural problem. */
export function buildBillPaymentWithCreditsPayload(a: CreateBillPaymentWithCreditsArgs): any {
  const bills = a.bill_ids ?? [];
  const credits = a.credits ?? [];
  const errs: string[] = [];
  const t = checkAmount(a.total_amount, 'total_amount', true); if (t) errs.push(t);
  bills.forEach((b, i) => {
    if (!b.bill_id?.trim()) errs.push(`bill_ids[${i}]: bill_id is required.`);
    const p = checkAmount(b.amount, `bill_ids[${i}].amount (Bill ${b.bill_id})`, false); if (p) errs.push(p);
  });
  if (credits.length === 0) {
    if (errs.length) throw new BillPaymentCreditsError(errs.join('\n') + '\nNothing was posted.');
    return buildBillPaymentCreatePayload(a);
  }
  if (bills.length === 0) errs.push('credits need at least one bill in bill_ids to apply to.');
  bills.forEach((b, i) => { if (b.amount === undefined) errs.push(`bill_ids[${i}].amount is required when credits are applied (no full-balance default) — Bill ${b.bill_id}.`); });
  const billIds = new Set(bills.map((b) => b.bill_id));
  if (billIds.size !== bills.length) errs.push('bill_ids contains the same bill twice.');
  const seenCredit = new Set<string>();
  credits.forEach((c, i) => {
    if (c.txn_type !== 'VendorCredit') errs.push(`credits[${i}]: txn_type must be 'VendorCredit' (got ${c.txn_type}).`);
    if (!c.txn_id?.trim()) errs.push(`credits[${i}]: txn_id (the VendorCredit Id) is required.`);
    if (c.amount === undefined) errs.push(`credits[${i}]: amount is required for VendorCredit ${c.txn_id}.`);
    else { const p = checkAmount(c.amount, `credits[${i}].amount (VendorCredit ${c.txn_id})`, false); if (p) errs.push(p); }
    if (seenCredit.has(c.txn_id)) errs.push(`credits[${i}]: VendorCredit ${c.txn_id} listed twice — combine the amounts.`);
    seenCredit.add(c.txn_id);
    if (c.bill_id !== undefined && !billIds.has(c.bill_id)) errs.push(`credits[${i}]: bill_id ${c.bill_id} is not in bill_ids.`);
    if (c.bill_id === undefined && bills.length > 1) errs.push(`credits[${i}]: bill_id is required when paying more than one bill (which bill does VendorCredit ${c.txn_id} apply to?).`);
  });
  if (errs.length) throw new BillPaymentCreditsError(errs.join('\n') + '\nNothing was posted.');

  // Same ordering/maths as import_transactions: bill, then its credits.
  const entries: Array<{ sourceId: string; kind: 'bill' | 'credit'; cents: number; type: string }> = [];
  for (const b of bills) {
    entries.push({ sourceId: b.bill_id, kind: 'bill', cents: toCents(b.amount!), type: 'Bill' });
    for (const c of credits) if ((c.bill_id ?? bills[0].bill_id) === b.bill_id) entries.push({ sourceId: c.txn_id, kind: 'credit', cents: toCents(c.amount), type: c.txn_type });
  }
  const plan = planBillPayment(entries);
  if (plan.errors.length) throw new BillPaymentCreditsError(plan.errors.join('\n') + '\nNothing was posted.');
  if (toCents(a.total_amount) !== plan.netCents) {
    throw new BillPaymentCreditsError(`total_amount ${a.total_amount.toFixed(2)} must equal bills ${money(plan.billCents)} − credits ${money(plan.creditCents)} = ${money(plan.netCents)}. Nothing was posted.`);
  }
  const payload = buildBillPaymentCreatePayload({ ...a, bill_ids: undefined });
  payload.Line = [];
  for (const g of plan.groups) {
    payload.Line.push({ Amount: g.cents / 100, LinkedTxn: [{ TxnId: g.sourceId, TxnType: 'Bill' }] });
    for (const c of g.credits) payload.Line.push({ Amount: c.cents / 100, LinkedTxn: [{ TxnId: c.sourceId, TxnType: entries[c.index].type }] });
  }
  return payload;
}

// ── Validated create flow ────────────────────────────────────────────────────

/** allow_reconciled is accepted for schema compatibility; it is a no-op (no reconcile check on A/P documents). */
export interface FlowOpts { dry_run: boolean; allow_reconciled: boolean }

interface Check { item: string; ok: boolean; message: string; [k: string]: unknown }

export async function createBillPaymentValidated(q: any, realmId: string, a: CreateBillPaymentWithCreditsArgs, o: FlowOpts): Promise<{ ok: boolean; text: string }> {
  let payload: any;
  try {
    payload = buildBillPaymentWithCreditsPayload(a);
  } catch (e: any) {
    if (e instanceof BillPaymentCreditsError || e instanceof PrintStatusError) return { ok: false, text: e.message };
    throw e;
  }
  const bills = a.bill_ids ?? [];
  const credits = a.credits ?? [];
  const checks: Check[] = [];
  const before: Record<string, { type: string; id: string; balance: number; apply: number }> = {};

  // Total amount applied per bill (gross: cash + credits) comes from the payload lines.
  const items: Array<{ type: 'Bill' | 'VendorCredit'; id: string; apply: number }> = [
    ...bills.map((b) => ({ type: 'Bill' as const, id: b.bill_id, apply: b.amount ?? a.total_amount })),
    ...credits.map((c) => ({ type: 'VendorCredit' as const, id: c.txn_id, apply: c.amount })),
  ];
  for (const it of items) {
    const label = `${it.type} ${it.id}`;
    const problems: string[] = [];
    let txn: any;
    try {
      const raw: any = it.type === 'Bill' ? await q.transactions.getBill(realmId, it.id) : await q.transactions.getVendorCredit(realmId, it.id);
      txn = raw?.[it.type];
    } catch (e: any) {
      checks.push({ item: label, ok: false, message: `${label}: could not be read (${e?.message ?? e}).` });
      continue;
    }
    if (!txn) { checks.push({ item: label, ok: false, message: `${label}: not found.` }); continue; }
    if (String(txn.VendorRef?.value) !== String(a.vendor_id)) problems.push(`${label} belongs to vendor ${txn.VendorRef?.value}${txn.VendorRef?.name ? ` (${txn.VendorRef.name})` : ''}, not vendor ${a.vendor_id}.`);
    const bal = Number(txn.Balance);
    if (!Number.isFinite(bal)) problems.push(`${label}: open balance unreadable.`);
    else if (toCents(bal) < toCents(it.apply)) problems.push(it.type === 'Bill'
      ? `${label}: open balance ${bal.toFixed(2)} is less than the ${it.apply.toFixed(2)} to apply.`
      : `${label}: unapplied balance ${bal.toFixed(2)} is less than the ${it.apply.toFixed(2)} to apply.`);
    before[label] = { type: it.type, id: it.id, balance: bal, apply: it.apply };
    checks.push({ item: label, ok: problems.length === 0, message: problems.length ? problems.join(' ') : `${label}: ok (vendor ${a.vendor_id}, balance ${bal.toFixed(2)}, applying ${it.apply.toFixed(2)}).`, date: txn.TxnDate, balance: bal, reconcile_status: 'not_applicable' });
  }
  checks.push({ item: 'reconcile_status', ok: true, message: 'Reconcile status: not applicable to A/P documents (Bills and VendorCredits never carry a cleared/reconciled status in QBO); not checked. allow_reconciled is accepted but has no effect here.' });
  const valid = checks.every((c) => c.ok);
  const report = { dry_run: o.dry_run, valid, payload, checks };
  if (o.dry_run) return { ok: valid, text: `DRY RUN — nothing was posted. ${valid ? 'All checks passed.' : 'Checks FAILED; a live run would be refused.'}\n${JSON.stringify(report, null, 2)}` };
  if (!valid) return { ok: false, text: `Refused — nothing was posted.\n${checks.filter((c) => !c.ok).map((c) => `• ${c.message}`).join('\n')}\n${JSON.stringify(report, null, 2)}` };

  const created: any = ((await q.transactions.createBillPayment(realmId, payload)) as any)?.BillPayment;
  if (!created?.Id) return { ok: false, text: `QBO returned no BillPayment Id — check QBO before retrying.\n${JSON.stringify(created ?? null)}` };

  // Read back.
  const mismatches: string[] = [];
  const after: any[] = [];
  let bp: any;
  try { bp = ((await q.transactions.getBillPayment(realmId, created.Id)) as any)?.BillPayment; } catch (e: any) { mismatches.push(`BillPayment ${created.Id} re-read failed: ${e?.message ?? e}`); }
  if (bp) {
    if (toCents(Number(bp.TotalAmt)) !== toCents(payload.TotalAmt)) mismatches.push(`BillPayment TotalAmt ${bp.TotalAmt} ≠ ${payload.TotalAmt}`);
    for (const l of payload.Line) {
      const lt = l.LinkedTxn[0];
      const got = (bp.Line ?? []).find((x: any) => (x.LinkedTxn ?? []).some((k: any) => String(k.TxnId) === String(lt.TxnId) && k.TxnType === lt.TxnType));
      if (!got) mismatches.push(`BillPayment has no line linked to ${lt.TxnType} ${lt.TxnId}`);
      else if (toCents(Number(got.Amount)) !== toCents(l.Amount)) mismatches.push(`BillPayment line for ${lt.TxnType} ${lt.TxnId} is ${got.Amount} ≠ ${l.Amount}`);
    }
    after.push({ item: `BillPayment ${bp.Id}`, total_amt: bp.TotalAmt, balance: bp.Balance ?? null });
  }
  for (const [label, b] of Object.entries(before)) {
    try {
      const raw: any = b.type === 'Bill' ? await q.transactions.getBill(realmId, b.id) : await q.transactions.getVendorCredit(realmId, b.id);
      const bal = Number(raw?.[b.type]?.Balance);
      const expected = (toCents(b.balance) - toCents(b.apply)) / 100;
      after.push({ item: label, balance_before: b.balance, applied: b.apply, balance_after: bal, expected_balance: expected });
      if (toCents(bal) !== toCents(expected)) mismatches.push(`${label} balance ${bal} ≠ expected ${expected.toFixed(2)}`);
    } catch (e: any) {
      mismatches.push(`${label} re-read failed: ${e?.message ?? e}`);
    }
  }
  if (mismatches.length === 0) {
    return { ok: true, text: `Bill Payment ${created.Id} recorded and verified: ${(payload.TotalAmt as number).toFixed(2)} to vendor ${a.vendor_id}${created.SyncToken !== undefined ? ` (SyncToken ${created.SyncToken})` : ''}.\n${JSON.stringify({ bill_payment_id: created.Id, payload, checks, read_back: after }, null, 2)}` };
  }
  // Rollback: delete the BillPayment we just created.
  let rollback: string;
  try {
    const tok = bp?.SyncToken ?? created.SyncToken;
    await q.transactions.deleteBillPayment(realmId, created.Id, tok);
    rollback = `ROLLED BACK: BillPayment ${created.Id} was deleted; bills and credits should be back to their prior balances — re-check them.`;
  } catch (e: any) {
    rollback = `ROLLBACK FAILED: BillPayment ${created.Id} is still in QBO (${e?.message ?? e}) — review/delete it manually.`;
  }
  return { ok: false, text: `VERIFICATION FAILED after posting BillPayment ${created.Id}:\n${mismatches.map((m) => `• ${m}`).join('\n')}\n${rollback}\n${JSON.stringify({ payload, checks, read_back: after }, null, 2)}` };
}
