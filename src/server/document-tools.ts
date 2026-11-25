// ─── MCP registration: transaction PDF + email send ─────────────────────────
//
//   get_transaction_pdf       GET /{entity}/{id}/pdf, save, return download URL
//   send_transaction_email    POST /{entity}/{id}/send — dry-run unless confirm_send=true
//
// Supported types (wherever Intuit documents PDF and/or send):
// Invoice, Estimate, CreditMemo, SalesReceipt, Payment, PurchaseOrder, RefundReceipt.

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ScopedQBOManager } from './auth.js';
import {
  DOCUMENT_TYPES,
  billEmailAddress,
  documentFileName,
  type DocumentType,
} from '../api/documents.js';
import { pdfDownloadPath, type PdfDownloadStore } from './pdf-store.js';

export interface DocumentToolOptions {
  pdfStore: PdfDownloadStore;
  publicBaseUrl: string | null;
}

export function registerDocumentTools(
  server: McpServer,
  qboManager: ScopedQBOManager,
  findRealmId: (clientName: string) => Promise<string | null>,
  options: DocumentToolOptions,
): void {
  const tool = (server as any).tool.bind(server);
  const types = DOCUMENT_TYPES as unknown as [DocumentType, ...DocumentType[]];

  tool(
    'get_transaction_pdf',
    'Download a QBO transaction PDF (GET /v3/company/{realmId}/{type}/{id}/pdf), save it on this server, and return a short-lived download URL. The URL is a capability token in the path — it does not contain the Multi-Connect API key or Intuit credentials (those would be redacted from tool output). Supported types: Invoice, Estimate, CreditMemo, SalesReceipt, Payment, PurchaseOrder, RefundReceipt, wherever Intuit supports a PDF for that type. The link expires in one hour.',
    {
      client_name: z.string().describe('The name of the client company'),
      type: z.enum(types).describe('QBO transaction type'),
      id: z.string().min(1).describe('QBO transaction Id'),
    },
    async ({ client_name, type, id }: { client_name: string; type: DocumentType; id: string }) => {
      const realmId = await findRealmId(client_name);
      if (!realmId) {
        return { content: [{ type: 'text', text: `Client not found: "${client_name}". Use list_clients to see available companies.` }] };
      }
      try {
        let raw: unknown = null;
        try {
          raw = await qboManager.documents.getEntity(realmId, type, id);
        } catch {
          raw = null;
        }
        const pdf = await qboManager.documents.getPdf(realmId, type, id);
        const fileName = documentFileName(type, id, raw);
        const meta = options.pdfStore.save({
          buffer: pdf.buffer,
          fileName,
          contentType: pdf.contentType || 'application/pdf',
          realmId,
          entityType: type,
          entityId: id,
        });
        const path = pdfDownloadPath(meta.token);
        const download_url = options.publicBaseUrl ? `${options.publicBaseUrl}${path}` : path;
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              entity_type: type,
              id,
              file_name: meta.fileName,
              bytes: meta.bytes,
              content_type: meta.contentType,
              download_url,
              expires_at: meta.expiresAt,
            }, null, 2),
          }],
        };
      } catch (err: any) {
        return { content: [{ type: 'text', text: `Error fetching transaction PDF: ${err?.message ?? err}` }], isError: true };
      }
    },
  );

  tool(
    'send_transaction_email',
    'Email a QBO transaction PDF to the customer (or send_to) via POST /v3/company/{realmId}/{type}/{id}/send. Defaults to a dry run that shows the recipient and does not send. A live send requires confirm_send=true; the tool refuses otherwise. The transaction must already have BillEmail.Address — this tool will not set it. For invoices, call update_invoice with bill_email first, then retry. Supported types: Invoice, Estimate, CreditMemo, SalesReceipt, Payment, PurchaseOrder, RefundReceipt, wherever Intuit supports send for that type.',
    {
      client_name: z.string().describe('The name of the client company'),
      type: z.enum(types).describe('QBO transaction type'),
      id: z.string().min(1).describe('QBO transaction Id'),
      send_to: z.string().email().optional().describe('Override recipient. If omitted, QBO uses BillEmail.Address on the transaction.'),
      confirm_send: z.boolean().optional().describe('Must be true to actually send. Default false = dry run that shows the recipient.'),
    },
    async ({ client_name, type, id, send_to, confirm_send }: {
      client_name: string;
      type: DocumentType;
      id: string;
      send_to?: string;
      confirm_send?: boolean;
    }) => {
      const realmId = await findRealmId(client_name);
      if (!realmId) {
        return { content: [{ type: 'text', text: `Client not found: "${client_name}". Use list_clients to see available companies.` }] };
      }
      try {
        const raw = await qboManager.documents.getEntity(realmId, type, id);
        const onFile = billEmailAddress(type, raw);
        const recipient = send_to ?? onFile;
        const missingBillEmailMessage =
          'Transaction has no BillEmail; set it first with update_invoice bill_email=... then retry';
        const preview = {
          dry_run: confirm_send !== true,
          entity_type: type,
          id,
          send_to: send_to ?? null,
          bill_email: onFile,
          recipient: recipient ?? null,
        };

        if (confirm_send !== true) {
          let message: string;
          if (!onFile) {
            message = send_to
              ? `Dry run — this ${type} has no BillEmail.Address. A live send will be refused even with send_to (QBO /send can NullPointerException when BillEmail is missing). ${missingBillEmailMessage}`
              : `Dry run — no send_to and no BillEmail.Address on this ${type}. ${missingBillEmailMessage}`;
          } else {
            message = `Dry run — would email this ${type} to ${recipient}. Re-run with confirm_send=true to send.`;
          }
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                ...preview,
                sent: false,
                message,
              }, null, 2),
            }],
          };
        }

        // Do not silently write BillEmail before /send — Multi-Connect is a
        // native API wrapper. QBO's /send can NPE when BillEmail is missing,
        // even if sendTo is provided, so refuse with an actionable error.
        if (!onFile) {
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                ...preview,
                sent: false,
                message: missingBillEmailMessage,
              }, null, 2),
            }],
            isError: true,
          };
        }

        const result = await qboManager.documents.sendEmail(realmId, type, id, send_to);
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              dry_run: false,
              sent: true,
              entity_type: type,
              id,
              recipient,
              result,
            }, null, 2),
          }],
        };
      } catch (err: any) {
        return { content: [{ type: 'text', text: `Error sending transaction email: ${err?.message ?? err}` }], isError: true };
      }
    },
  );
}
