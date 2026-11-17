// ─── MCP registration: TimeActivity get / create / update / delete ──────────
//
//   get_time_activity       GET /v3/company/{realmId}/timeactivity/{id}
//   create_time_activity    POST /timeactivity
//   update_time_activity    POST /timeactivity (Id + SyncToken)
//   delete_time_activity    POST /timeactivity?operation=delete — requires confirm=true
//
// Docs: https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/timeactivity

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ScopedQBOManager } from './auth.js';

function unwrap(raw: unknown): any | null {
  return (raw as any)?.TimeActivity ?? null;
}

export function shapeTimeActivity(t: any) {
  return {
    id: t?.Id,
    sync_token: t?.SyncToken,
    name_of: t?.NameOf,
    employee_id: t?.EmployeeRef?.value,
    employee_name: t?.EmployeeRef?.name,
    vendor_id: t?.VendorRef?.value,
    vendor_name: t?.VendorRef?.name,
    customer_id: t?.CustomerRef?.value,
    customer_name: t?.CustomerRef?.name,
    item_id: t?.ItemRef?.value,
    class_id: t?.ClassRef?.value,
    department_id: t?.DepartmentRef?.value,
    txn_date: t?.TxnDate,
    hours: t?.Hours,
    minutes: t?.Minutes,
    start_time: t?.StartTime,
    end_time: t?.EndTime,
    description: t?.Description,
    billable_status: t?.BillableStatus,
    hourly_rate: t?.HourlyRate,
    taxable: t?.Taxable,
  };
}

function applyTimeActivityFields(payload: any, args: Record<string, any>): void {
  if (args.name_of) payload.NameOf = args.name_of;
  if (args.employee_id) payload.EmployeeRef = { value: args.employee_id };
  if (args.vendor_id) payload.VendorRef = { value: args.vendor_id };
  if (args.customer_id) payload.CustomerRef = { value: args.customer_id };
  if (args.item_id) payload.ItemRef = { value: args.item_id };
  if (args.class_id) payload.ClassRef = { value: args.class_id };
  if (args.department_id) payload.DepartmentRef = { value: args.department_id };
  if (args.txn_date) payload.TxnDate = args.txn_date;
  if (args.hours !== undefined) payload.Hours = args.hours;
  if (args.minutes !== undefined) payload.Minutes = args.minutes;
  if (args.start_time) payload.StartTime = args.start_time;
  if (args.end_time) payload.EndTime = args.end_time;
  if (args.description !== undefined) payload.Description = args.description;
  if (args.billable_status) payload.BillableStatus = args.billable_status;
  if (args.hourly_rate !== undefined) payload.HourlyRate = args.hourly_rate;
  if (args.taxable !== undefined) payload.Taxable = args.taxable;
}

const fields = {
  name_of: z.enum(['Employee', 'Vendor']).optional().describe('NameOf — Employee or Vendor'),
  employee_id: z.string().optional().describe('EmployeeRef.value (when name_of is Employee)'),
  vendor_id: z.string().optional().describe('VendorRef.value (when name_of is Vendor)'),
  customer_id: z.string().optional().describe('CustomerRef.value (job / customer)'),
  item_id: z.string().optional().describe('ItemRef.value (service item)'),
  class_id: z.string().optional(),
  department_id: z.string().optional(),
  txn_date: z.string().optional().describe('Date (YYYY-MM-DD)'),
  hours: z.number().optional().describe('Whole hours'),
  minutes: z.number().optional().describe('Minutes 0-59'),
  start_time: z.string().optional().describe('StartTime if using a time range instead of hours/minutes'),
  end_time: z.string().optional().describe('EndTime if using a time range'),
  description: z.string().optional(),
  billable_status: z.enum(['Billable', 'NotBillable', 'HasBeenBilled']).optional(),
  hourly_rate: z.number().optional(),
  taxable: z.boolean().optional(),
};

export function registerTimeActivityTools(
  server: McpServer,
  qboManager: ScopedQBOManager,
  findRealmId: (clientName: string) => Promise<string | null>,
): void {
  const tool = (server as any).tool.bind(server);
  const notFound = (c: string) => ({ content: [{ type: 'text', text: `Client not found: "${c}". Use list_clients to see available companies.` }] });

  tool(
    'get_time_activity',
    'Fetch a QBO TimeActivity (time entry) by Id. Wraps GET /v3/company/{realmId}/timeactivity/{id}.',
    {
      client_name: z.string().describe('The name of the client company'),
      time_activity_id: z.string().describe('QBO TimeActivity ID'),
    },
    async ({ client_name, time_activity_id }: { client_name: string; time_activity_id: string }) => {
      const realmId = await findRealmId(client_name);
      if (!realmId) return notFound(client_name);
      try {
        const rec = unwrap(await qboManager.timeActivity.get(realmId, time_activity_id));
        if (!rec) return { content: [{ type: 'text', text: `TimeActivity ${time_activity_id} not found.` }] };
        return { content: [{ type: 'text', text: JSON.stringify(shapeTimeActivity(rec), null, 2) }] };
      } catch (err: any) {
        return { content: [{ type: 'text', text: `Error fetching time activity: ${err?.message ?? err}` }], isError: true };
      }
    },
  );

  tool(
    'create_time_activity',
    'Create a QBO TimeActivity (time entry) via POST /v3/company/{realmId}/timeactivity. name_of must be Employee or Vendor, with the matching employee_id or vendor_id. Supply hours/minutes and/or start_time/end_time.',
    {
      client_name: z.string().describe('The name of the client company'),
      name_of: z.enum(['Employee', 'Vendor']).describe('NameOf — Employee or Vendor'),
      employee_id: fields.employee_id,
      vendor_id: fields.vendor_id,
      customer_id: fields.customer_id,
      item_id: fields.item_id,
      class_id: fields.class_id,
      department_id: fields.department_id,
      txn_date: fields.txn_date,
      hours: fields.hours,
      minutes: fields.minutes,
      start_time: fields.start_time,
      end_time: fields.end_time,
      description: fields.description,
      billable_status: fields.billable_status,
      hourly_rate: fields.hourly_rate,
      taxable: fields.taxable,
    },
    async (args: Record<string, any>) => {
      const realmId = await findRealmId(args.client_name);
      if (!realmId) return notFound(args.client_name);
      if (args.name_of === 'Employee' && !args.employee_id) {
        return { content: [{ type: 'text', text: 'employee_id is required when name_of is Employee.' }], isError: true };
      }
      if (args.name_of === 'Vendor' && !args.vendor_id) {
        return { content: [{ type: 'text', text: 'vendor_id is required when name_of is Vendor.' }], isError: true };
      }
      try {
        const payload: Record<string, unknown> = {};
        applyTimeActivityFields(payload, args);
        const result = await qboManager.timeActivity.create(realmId, payload);
        const rec = unwrap(result);
        return { content: [{ type: 'text', text: rec ? JSON.stringify(shapeTimeActivity(rec), null, 2) : JSON.stringify(result, null, 2) }] };
      } catch (err: any) {
        return { content: [{ type: 'text', text: `Error creating time activity: ${err?.message ?? err}` }], isError: true };
      }
    },
  );

  tool(
    'update_time_activity',
    'Update an existing TimeActivity. Fetches the current record and a fresh SyncToken, merges only the fields you pass, and POSTs the full object back.',
    {
      client_name: z.string().describe('The name of the client company'),
      time_activity_id: z.string().describe('QBO TimeActivity ID'),
      ...fields,
    },
    async (args: Record<string, any>) => {
      const realmId = await findRealmId(args.client_name);
      if (!realmId) return notFound(args.client_name);
      try {
        const rec = unwrap(await qboManager.timeActivity.get(realmId, args.time_activity_id));
        if (!rec) return { content: [{ type: 'text', text: `TimeActivity ${args.time_activity_id} not found.` }] };
        const payload = { ...rec };
        applyTimeActivityFields(payload, args);
        const result = await qboManager.timeActivity.update(realmId, payload);
        const updated = unwrap(result);
        return { content: [{ type: 'text', text: updated ? JSON.stringify(shapeTimeActivity(updated), null, 2) : JSON.stringify(result, null, 2) }] };
      } catch (err: any) {
        return { content: [{ type: 'text', text: `Error updating time activity: ${err?.message ?? err}` }], isError: true };
      }
    },
  );

  tool(
    'delete_time_activity',
    'Permanently delete a TimeActivity via POST /v3/company/{realmId}/timeactivity?operation=delete with Id and SyncToken. Defaults to a dry run. A live delete requires confirm=true and is refused otherwise.',
    {
      client_name: z.string().describe('The name of the client company'),
      time_activity_id: z.string().describe('QBO TimeActivity ID'),
      confirm: z.boolean().optional().describe('Must be true to actually delete. Default false = dry run.'),
    },
    async ({ client_name, time_activity_id, confirm }: { client_name: string; time_activity_id: string; confirm?: boolean }) => {
      const realmId = await findRealmId(client_name);
      if (!realmId) return notFound(client_name);
      try {
        const rec = unwrap(await qboManager.timeActivity.get(realmId, time_activity_id));
        if (!rec) return { content: [{ type: 'text', text: `TimeActivity ${time_activity_id} not found.` }] };
        const preview = shapeTimeActivity(rec);
        if (confirm !== true) {
          return { content: [{ type: 'text', text: JSON.stringify({
            dry_run: true,
            deleted: false,
            time_activity: preview,
            message: `Dry run — would delete TimeActivity ${time_activity_id}. Re-run with confirm=true to delete.`,
          }, null, 2) }] };
        }
        const result = await qboManager.timeActivity.delete(realmId, time_activity_id, rec.SyncToken);
        return { content: [{ type: 'text', text: JSON.stringify({ dry_run: false, deleted: true, time_activity_id, time_activity: preview, result }, null, 2) }] };
      } catch (err: any) {
        return { content: [{ type: 'text', text: `Error deleting time activity: ${err?.message ?? err}` }], isError: true };
      }
    },
  );
}
