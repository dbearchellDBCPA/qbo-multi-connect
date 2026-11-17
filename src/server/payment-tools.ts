// ─── MCP registration: Payment get / update / void / delete ─────────────────
//
//   get_payment      GET /v3/company/{realmId}/payment/{id}
//   update_payment   POST /payment (full object, fresh SyncToken)
//   void_payment     POST /payment?operation=void  (Id + SyncToken)
//   delete_payment   POST /payment?operation=delete (Id + SyncToken)
//
// Void and delete default to a dry run and require confirm_void / confirm.

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ScopedQBOManager } from './auth.js';
import { formatCurrency } from './report-shaping.js';

export function paymentToUpdateShape(p: any) {
  const lines = Array.isArray(p?.Line)
    ? p.Line.map((l: any) => ({
      amount: l?.Amount,
      txn_id: l?.LinkedTxn?.[0]?.TxnId ?? null,
      txn_type: l?.LinkedTxn?.[0]?.TxnType ?? null,
    }))
    : [];
  return {
    id: p?.Id,
    sync_token: p?.SyncToken,
    doc_number: p?.DocNumber,
    customer_id: p?.CustomerRef?.value,
    customer_name: p?.CustomerRef?.name,
    txn_date: p?.TxnDate,
    total_amt: p?.TotalAmt,
    unapplied_amt: p?.UnappliedAmt,
    private_note: p?.PrivateNote,
    department_id: p?.DepartmentRef?.value,
    payment_method_id: p?.PaymentMethodRef?.value,
    deposit_to_account_id: p?.DepositToAccountRef?.value,
    lines,
  };
}

function unwrapPayment(raw: unknown): any | null {
  return (raw as any)?.Payment ?? null;
}

export function registerPaymentTools(
  server: McpServer,
  qboManager: ScopedQBOManager,
  findRealmId: (clientName: string) => Promise<string | null>,
): void {
  const tool = (server as any).tool.bind(server);
  const notFound = (c: string) => ({ content: [{ type: 'text', text: `Client not found: "${c}". Use list_clients to see available companies.` }] });

  tool(
    'get_payment',
    'Fetch a customer payment (Receive Payment) in update-ready shape: header fields plus application lines (invoice / credit LinkedTxn). Use the returned values with update_payment, void_payment, or delete_payment.',
    {
      client_name: z.string().describe('The name of the client company'),
      payment_id: z.string().describe('QBO Payment ID'),
    },
    async ({ client_name, payment_id }: { client_name: string; payment_id: string }) => {
      const realmId = await findRealmId(client_name);
      if (!realmId) return notFound(client_name);
      try {
        const pmt = unwrapPayment(await qboManager.transactions.getPayment(realmId, payment_id));
        if (!pmt) return { content: [{ type: 'text', text: `Payment ${payment_id} not found.` }] };
        return { content: [{ type: 'text', text: JSON.stringify(paymentToUpdateShape(pmt), null, 2) }] };
      } catch (err: any) {
        return { content: [{ type: 'text', text: `Error fetching payment: ${err?.message ?? err}` }], isError: true };
      }
    },
  );

  tool(
    'update_payment',
    'Update an existing customer payment in place. Fetches the current Payment and a fresh SyncToken, merges only the fields you pass, and POSTs the full object back. Untouched fields and existing application lines are preserved unless you pass lines or, when there is exactly one invoice line, total_amt (that line amount is synced to the new total).',
    {
      client_name: z.string().describe('The name of the client company'),
      payment_id: z.string().describe('QBO Payment ID'),
      total_amt: z.number().optional().describe('New TotalAmt. If the payment has exactly one invoice line and lines is omitted, that line amount is updated to match.'),
      txn_date: z.string().optional().describe('New payment date (YYYY-MM-DD)'),
      doc_number: z.string().optional().describe('New reference number'),
      private_note: z.string().optional().describe('New private memo'),
      payment_method_id: z.string().optional().describe('PaymentMethodRef.value'),
      deposit_to_account_id: z.string().optional().describe('DepositToAccountRef.value'),
      department_id: z.string().optional().describe('DepartmentRef.value'),
      lines: z.array(z.object({
        txn_id: z.string().describe('Linked transaction Id'),
        txn_type: z.enum(['Invoice', 'CreditMemo', 'JournalEntry']).describe('LinkedTxn type'),
        amount: z.number().describe('Amount applied on this line'),
      })).optional().describe('Replacement application lines (replaces ALL existing lines if provided).'),
    },
    async (args: Record<string, any>) => {
      const realmId = await findRealmId(args.client_name);
      if (!realmId) return notFound(args.client_name);
      try {
        const pmt = unwrapPayment(await qboManager.transactions.getPayment(realmId, args.payment_id));
        if (!pmt) return { content: [{ type: 'text', text: `Payment ${args.payment_id} not found.` }] };
        const payload: any = { ...pmt };
        if (args.txn_date) payload.TxnDate = args.txn_date;
        if (args.doc_number !== undefined) payload.DocNumber = args.doc_number;
        if (args.private_note !== undefined) payload.PrivateNote = args.private_note;
        if (args.payment_method_id) payload.PaymentMethodRef = { value: args.payment_method_id };
        if (args.deposit_to_account_id) payload.DepositToAccountRef = { value: args.deposit_to_account_id };
        if (args.department_id) payload.DepartmentRef = { value: args.department_id };
        if (args.lines) {
          payload.Line = args.lines.map((l: any) => ({
            Amount: l.amount,
            LinkedTxn: [{ TxnId: l.txn_id, TxnType: l.txn_type }],
          }));
        } else if (args.total_amt !== undefined) {
          const existingLines: any[] = pmt.Line ?? [];
          if (existingLines.length === 1) {
            payload.Line = [{ ...existingLines[0], Amount: args.total_amt }];
          } else if (existingLines.length > 1) {
            return { content: [{ type: 'text', text: `Payment ${args.payment_id} has ${existingLines.length} application lines — pass lines explicitly so the new split is deliberate. Nothing was posted.` }] };
          }
        }
        if (args.total_amt !== undefined) payload.TotalAmt = args.total_amt;
        const result = await qboManager.transactions.updatePayment(realmId, payload);
        const updated = unwrapPayment(result);
        return { content: [{ type: 'text', text: updated ? JSON.stringify(paymentToUpdateShape(updated), null, 2) : JSON.stringify(result, null, 2) }] };
      } catch (err: any) {
        return { content: [{ type: 'text', text: `Error updating payment: ${err?.message ?? err}` }], isError: true };
      }
    },
  );

  tool(
    'void_payment',
    'Void a customer payment via POST /v3/company/{realmId}/payment?operation=void with Id and SyncToken. Defaults to a dry run that shows the payment and does not void. A live void requires confirm_void=true and is refused otherwise.',
    {
      client_name: z.string().describe('The name of the client company'),
      payment_id: z.string().describe('QBO Payment ID'),
      confirm_void: z.boolean().optional().describe('Must be true to actually void. Default false = dry run.'),
    },
    async ({ client_name, payment_id, confirm_void }: { client_name: string; payment_id: string; confirm_void?: boolean }) => {
      const realmId = await findRealmId(client_name);
      if (!realmId) return notFound(client_name);
      try {
        const pmt = unwrapPayment(await qboManager.transactions.getPayment(realmId, payment_id));
        if (!pmt) return { content: [{ type: 'text', text: `Payment ${payment_id} not found.` }] };
        const preview = paymentToUpdateShape(pmt);
        if (confirm_void !== true) {
          return { content: [{ type: 'text', text: JSON.stringify({
            dry_run: true,
            voided: false,
            payment: preview,
            message: `Dry run — would void Payment ${payment_id} (${formatCurrency(pmt.TotalAmt)} from ${pmt.CustomerRef?.name ?? pmt.CustomerRef?.value ?? 'customer'}). Re-run with confirm_void=true to void.`,
          }, null, 2) }] };
        }
        const result = await qboManager.transactions.voidPayment(realmId, payment_id, pmt.SyncToken);
        return { content: [{ type: 'text', text: JSON.stringify({
          dry_run: false,
          voided: true,
          payment_id,
          result,
        }, null, 2) }] };
      } catch (err: any) {
        return { content: [{ type: 'text', text: `Error voiding payment: ${err?.message ?? err}` }], isError: true };
      }
    },
  );

  tool(
    'delete_payment',
    'Permanently delete a customer payment via POST /v3/company/{realmId}/payment?operation=delete with Id and SyncToken (Intuit documents delete on Payment). This is a QBO hard delete — recoverable only via the Audit Log — and applied invoice balances reopen. Defaults to a dry run. A live delete requires confirm=true and is refused otherwise.',
    {
      client_name: z.string().describe('The name of the client company'),
      payment_id: z.string().describe('QBO Payment ID'),
      confirm: z.boolean().optional().describe('Must be true to actually delete. Default false = dry run.'),
    },
    async ({ client_name, payment_id, confirm }: { client_name: string; payment_id: string; confirm?: boolean }) => {
      const realmId = await findRealmId(client_name);
      if (!realmId) return notFound(client_name);
      try {
        const pmt = unwrapPayment(await qboManager.transactions.getPayment(realmId, payment_id));
        if (!pmt) return { content: [{ type: 'text', text: `Payment ${payment_id} not found.` }] };
        const preview = paymentToUpdateShape(pmt);
        if (confirm !== true) {
          return { content: [{ type: 'text', text: JSON.stringify({
            dry_run: true,
            deleted: false,
            payment: preview,
            message: `Dry run — would hard-delete Payment ${payment_id} (${formatCurrency(pmt.TotalAmt)} from ${pmt.CustomerRef?.name ?? pmt.CustomerRef?.value ?? 'customer'}). Re-run with confirm=true to delete.`,
          }, null, 2) }] };
        }
        const result = await qboManager.transactions.deletePayment(realmId, payment_id, pmt.SyncToken);
        return { content: [{ type: 'text', text: JSON.stringify({
          dry_run: false,
          deleted: true,
          payment_id,
          payment: preview,
          result,
        }, null, 2) }] };
      } catch (err: any) {
        return { content: [{ type: 'text', text: `Error deleting payment: ${err?.message ?? err}` }], isError: true };
      }
    },
  );
}
