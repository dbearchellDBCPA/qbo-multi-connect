// ─── MCP registration: RecurringTransaction create / delete ─────────────────
//
//   create_recurring_transaction   POST /recurringtransaction (type-wrapped)
//   delete_recurring_transaction   POST /recurringtransaction?operation=delete
//                                  (full wrapped object; confirm=true required)

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ScopedQBOManager } from './auth.js';
import {
  RECURRING_TXN_TYPES,
  RecurringRequestError,
  buildRecurringCreatePayload,
  buildRecurringDeletePayload,
  summarizeRecurring,
  unwrapRecurring,
  type RecurringTxnType,
} from './recurring-transaction.js';

const TXN_TYPES = RECURRING_TXN_TYPES as unknown as [RecurringTxnType, ...RecurringTxnType[]];

export function registerRecurringTools(
  server: McpServer,
  qboManager: ScopedQBOManager,
  findRealmId: (clientName: string) => Promise<string | null>,
): void {
  const tool = (server as any).tool.bind(server);
  const notFound = (c: string) => ({ content: [{ type: 'text', text: `Client not found: "${c}". Use list_clients to see available companies.` }] });

  tool(
    'create_recurring_transaction',
    'Create a QBO RecurringTransaction template via POST /v3/company/{realmId}/recurringtransaction. The body is the official type-wrapped object (e.g. { Bill: { …, RecurringInfo } }). Pass txn_type, the inner transaction as template (VendorRef and Line for a Bill, Line for a JournalEntry, etc.), and RecurringInfo/ScheduleInfo fields. EndDate and MaxOccurrences are alternatives — pass at most one. Does not add any worksheet or analysis.',
    {
      client_name: z.string().describe('The name of the client company'),
      txn_type: z.enum(TXN_TYPES).describe('Wrapper type, e.g. Bill or JournalEntry'),
      name: z.string().describe('RecurringInfo.Name'),
      recur_type: z.enum(['Automated', 'Reminder', 'Unscheduled']).describe('RecurringInfo.RecurType'),
      active: z.boolean().optional().describe('RecurringInfo.Active (default true)'),
      interval_type: z.enum(['Daily', 'Weekly', 'Monthly', 'Yearly']).optional().describe('ScheduleInfo.IntervalType'),
      num_interval: z.number().optional().describe('ScheduleInfo.NumInterval'),
      day_of_month: z.number().optional().describe('ScheduleInfo.DayOfMonth'),
      day_of_week: z.string().optional().describe('ScheduleInfo.DayOfWeek'),
      week_of_month: z.number().optional().describe('ScheduleInfo.WeekOfMonth'),
      month_of_year: z.string().optional().describe('ScheduleInfo.MonthOfYear'),
      days_before: z.number().optional().describe('ScheduleInfo.DaysBefore (generate-ahead days)'),
      remind_days: z.number().optional().describe('ScheduleInfo.RemindDays'),
      start_date: z.string().optional().describe('ScheduleInfo.StartDate (YYYY-MM-DD)'),
      end_date: z.string().optional().describe('ScheduleInfo.EndDate (YYYY-MM-DD). Alternative to max_occurrences.'),
      max_occurrences: z.number().optional().describe('ScheduleInfo.MaxOccurrences. Alternative to end_date.'),
      template: z.record(z.string(), z.any()).describe('Inner transaction object (without RecurringInfo), e.g. { VendorRef, Line, TotalAmt } for a Bill.'),
    },
    async (args: Record<string, any>) => {
      const realmId = await findRealmId(args.client_name);
      if (!realmId) return notFound(args.client_name);
      try {
        const schedule: Record<string, unknown> = {};
        if (args.interval_type) schedule.IntervalType = args.interval_type;
        if (args.num_interval !== undefined) schedule.NumInterval = args.num_interval;
        if (args.day_of_month !== undefined) schedule.DayOfMonth = args.day_of_month;
        if (args.day_of_week) schedule.DayOfWeek = args.day_of_week;
        if (args.week_of_month !== undefined) schedule.WeekOfMonth = args.week_of_month;
        if (args.month_of_year) schedule.MonthOfYear = args.month_of_year;
        if (args.days_before !== undefined) schedule.DaysBefore = args.days_before;
        if (args.remind_days !== undefined) schedule.RemindDays = args.remind_days;
        if (args.start_date) schedule.StartDate = args.start_date;
        if (args.end_date) schedule.EndDate = args.end_date;
        if (args.max_occurrences !== undefined) schedule.MaxOccurrences = args.max_occurrences;
        const payload = buildRecurringCreatePayload({
          txnType: args.txn_type,
          template: args.template,
          name: args.name,
          recurType: args.recur_type,
          active: args.active,
          schedule,
        });
        const result = await qboManager.recurring.create(realmId, payload);
        const unwrapped = unwrapRecurring(result);
        return { content: [{ type: 'text', text: JSON.stringify({
          created: true,
          payload_type: args.txn_type,
          result: unwrapped ? summarizeRecurring(unwrapped) : result,
        }, null, 2) }] };
      } catch (err: any) {
        const prefix = err instanceof RecurringRequestError ? '' : 'Error creating recurring transaction: ';
        return { content: [{ type: 'text', text: `${prefix}${err?.message ?? err}` }], isError: true };
      }
    },
  );

  tool(
    'delete_recurring_transaction',
    'Delete a QBO RecurringTransaction template via POST /v3/company/{realmId}/recurringtransaction?operation=delete. Intuit requires the full type-wrapped object (not just Id + SyncToken). Defaults to a dry run that shows the template. A live delete requires confirm=true and is refused otherwise. Looks up by wrapped Id or RecurDataRef (including Fault 610 fallback).',
    {
      client_name: z.string().describe('The name of the client company'),
      recurring_transaction_id: z.string().describe('Wrapped txn Id or RecurDataRef.value'),
      confirm: z.boolean().optional().describe('Must be true to actually delete. Default false = dry run.'),
    },
    async ({ client_name, recurring_transaction_id, confirm }: { client_name: string; recurring_transaction_id: string; confirm?: boolean }) => {
      const realmId = await findRealmId(client_name);
      if (!realmId) return notFound(client_name);
      try {
        const resolved = await qboManager.recurring.resolve(realmId, recurring_transaction_id);
        const preview = summarizeRecurring(resolved.unwrapped);
        const payload = buildRecurringDeletePayload(resolved.unwrapped);
        if (confirm !== true) {
          return { content: [{ type: 'text', text: JSON.stringify({
            dry_run: true,
            deleted: false,
            recurring: preview,
            message: `Dry run — would delete this ${preview.txn_type} RecurringTransaction (Id ${preview.id}). Re-run with confirm=true to delete.`,
          }, null, 2) }] };
        }
        const result = await qboManager.recurring.delete(realmId, payload);
        return { content: [{ type: 'text', text: JSON.stringify({
          dry_run: false,
          deleted: true,
          recurring: preview,
          result,
        }, null, 2) }] };
      } catch (err: any) {
        const prefix = err instanceof RecurringRequestError ? '' : 'Error deleting recurring transaction: ';
        return { content: [{ type: 'text', text: `${prefix}${err?.message ?? err}` }], isError: true };
      }
    },
  );
}
