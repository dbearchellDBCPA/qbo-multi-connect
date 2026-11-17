import { QBOClient } from './client.js';

/**
 * Transaction types Intuit documents for PDF retrieve and/or email send
 * on the Accounting API:
 *   GET  /v3/company/{realmId}/{entity}/{id}/pdf
 *   POST /v3/company/{realmId}/{entity}/{id}/send[?sendTo=]
 *
 * Docs: https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/invoice
 */
export const DOCUMENT_TYPES = [
  'Invoice',
  'Estimate',
  'CreditMemo',
  'SalesReceipt',
  'Payment',
  'PurchaseOrder',
  'RefundReceipt',
] as const;

export type DocumentType = (typeof DOCUMENT_TYPES)[number];

export const DOCUMENT_PATH: Record<DocumentType, string> = {
  Invoice: 'invoice',
  Estimate: 'estimate',
  CreditMemo: 'creditmemo',
  SalesReceipt: 'salesreceipt',
  Payment: 'payment',
  PurchaseOrder: 'purchaseorder',
  RefundReceipt: 'refundreceipt',
};

export function isDocumentType(value: string): value is DocumentType {
  return (DOCUMENT_TYPES as readonly string[]).includes(value);
}

export function documentPath(type: DocumentType, id: string, suffix: 'pdf' | 'send'): string {
  return `${DOCUMENT_PATH[type]}/${encodeURIComponent(id)}/${suffix}`;
}

/** BillEmail.Address on the wrapped entity, if any. */
export function billEmailAddress(entityType: DocumentType, raw: unknown): string | null {
  const obj = (raw as any)?.[entityType] ?? raw;
  const addr = obj?.BillEmail?.Address ?? (typeof obj?.BillEmail === 'string' ? obj.BillEmail : null);
  if (typeof addr === 'string' && addr.trim()) return addr.trim();
  return null;
}

export function documentFileName(entityType: DocumentType, id: string, raw: unknown): string {
  const obj = (raw as any)?.[entityType] ?? raw;
  const doc = obj?.DocNumber != null && String(obj.DocNumber).trim() ? String(obj.DocNumber).trim() : id;
  const safe = doc.replace(/[^A-Za-z0-9._-]+/g, '_');
  return `${entityType}_${safe}.pdf`;
}

export class DocumentsAPI {
  constructor(private client: QBOClient) {}

  async getEntity(realmId: string, type: DocumentType, id: string): Promise<unknown> {
    return this.client.get(realmId, `${DOCUMENT_PATH[type]}/${encodeURIComponent(id)}`, {});
  }

  async getPdf(realmId: string, type: DocumentType, id: string): Promise<{ buffer: Buffer; contentType: string }> {
    return this.client.getBinary(realmId, documentPath(type, id, 'pdf'), 'application/pdf');
  }

  async sendEmail(realmId: string, type: DocumentType, id: string, sendTo?: string): Promise<unknown> {
    const path = documentPath(type, id, 'send');
    const endpoint = sendTo ? `${path}?sendTo=${encodeURIComponent(sendTo)}` : path;
    return this.client.post(realmId, endpoint, undefined);
  }
}
