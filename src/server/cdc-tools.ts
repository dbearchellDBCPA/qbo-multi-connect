// ─── MCP registration: Change Data Capture ──────────────────────────────────
//
//   get_changed_entities    GET /v3/company/{realmId}/cdc
//
// Thin wrapper around the Accounting API CDC endpoint. Intuit limits
// changedSince to the last 30 days; objects deleted since then come back
// with status "Deleted" and an Id only.

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ScopedQBOManager } from './auth.js';
import { CdcRequestError } from '../api/cdc.js';

const CDC_ENTITY_EXAMPLES = 'Account, Bill, BillPayment, Budget, Class, CreditMemo, Customer, Department, Deposit, Employee, Estimate, Invoice, Item, JournalEntry, Payment, PaymentMethod, Purchase, PurchaseOrder, RefundReceipt, SalesReceipt, TaxAgency, TaxCode, TaxRate, Term, TimeActivity, Transfer, Vendor, VendorCredit';

export function registerCdcTools(
  server: McpServer,
  qboManager: ScopedQBOManager,
  findRealmId: (clientName: string) => Promise<string | null>,
): void {
  const tool = (server as any).tool.bind(server);

  tool(
    'get_changed_entities',
    `Change Data Capture for a QBO company: entities created, updated, or deleted since changed_since. Wraps GET /v3/company/{realmId}/cdc. Intuit limits lookback to the last 30 days — a later timestamp is required. Deleted objects are returned with status "Deleted" and an Id only. Common entity names: ${CDC_ENTITY_EXAMPLES}.`,
    {
      client_name: z.string().describe('The name of the client company'),
      entities: z.array(z.string().min(1)).min(1).describe('QBO entity names to include, e.g. ["Invoice","Payment","Customer"]'),
      changed_since: z.string().describe('ISO datetime or YYYY-MM-DD. Must be within Intuit\'s 30-day CDC lookback. Date-only values are sent as that date at 00:00:00Z.'),
    },
    async ({ client_name, entities, changed_since }: { client_name: string; entities: string[]; changed_since: string }) => {
      const realmId = await findRealmId(client_name);
      if (!realmId) {
        return { content: [{ type: 'text', text: `Client not found: "${client_name}". Use list_clients to see available companies.` }] };
      }
      try {
        const result = await qboManager.cdc.getChanged(realmId, entities, changed_since);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (err: any) {
        const prefix = err instanceof CdcRequestError ? '' : 'Error fetching changed entities: ';
        return { content: [{ type: 'text', text: `${prefix}${err?.message ?? err}` }], isError: true };
      }
    },
  );
}
