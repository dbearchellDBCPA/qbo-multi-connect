import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PdfDownloadStore, isPdfToken, pdfDownloadPath, PDF_TTL_MS } from '../../src/server/pdf-store.js';
import { billEmailAddress, documentFileName, documentPath } from '../../src/api/documents.js';

describe('document helpers', () => {
  it('builds the official PDF and send paths', () => {
    expect(documentPath('Invoice', '20', 'pdf')).toBe('invoice/20/pdf');
    expect(documentPath('CreditMemo', '9', 'send')).toBe('creditmemo/9/send');
    expect(documentPath('PurchaseOrder', 'a/b', 'pdf')).toBe('purchaseorder/a%2Fb/pdf');
  });

  it('reads BillEmail.Address off the wrapped entity', () => {
    expect(billEmailAddress('Invoice', { Invoice: { BillEmail: { Address: 'ap@example.org' } } })).toBe('ap@example.org');
    expect(billEmailAddress('Invoice', { Invoice: { Id: '1' } })).toBeNull();
  });

  it('names the file from DocNumber when present', () => {
    expect(documentFileName('Invoice', '20', { Invoice: { DocNumber: '501' } })).toBe('Invoice_501.pdf');
    expect(documentFileName('Payment', '55', { Payment: {} })).toBe('Payment_55.pdf');
    expect(documentFileName('Invoice', '20', { Invoice: { DocNumber: 'A / B' } })).toBe('Invoice_A_B.pdf');
  });
});

describe('PdfDownloadStore', () => {
  let dir: string;
  let store: PdfDownloadStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'qbo-pdf-'));
    store = new PdfDownloadStore(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('saves a PDF and reads it back by token', () => {
    const buffer = Buffer.from('%PDF-1.4 test');
    const meta = store.save({
      buffer,
      fileName: 'Invoice_501.pdf',
      contentType: 'application/pdf',
      realmId: '9341454121860748',
      entityType: 'Invoice',
      entityId: '20',
    });
    expect(isPdfToken(meta.token)).toBe(true);
    expect(pdfDownloadPath(meta.token)).toBe(`/downloads/pdf/${meta.token}`);
    expect(meta.bytes).toBe(buffer.length);
    const found = store.read(meta.token);
    expect(found?.buffer.equals(buffer)).toBe(true);
    expect(found?.meta.fileName).toBe('Invoice_501.pdf');
  });

  it('returns null for an expired or unknown token and deletes expired files', () => {
    const buffer = Buffer.from('%PDF-1.4 x');
    const now = new Date('2026-11-17T12:00:00Z');
    const meta = store.save({
      buffer,
      fileName: 'Invoice_501.pdf',
      contentType: 'application/pdf',
      realmId: 'r',
      entityType: 'Invoice',
      entityId: '20',
      now,
      ttlMs: PDF_TTL_MS,
    });
    expect(store.read(meta.token, new Date(now.getTime() + PDF_TTL_MS + 1))).toBeNull();
    expect(store.read('pdf_' + 'ab'.repeat(24))).toBeNull();
    expect(store.read('not-a-token')).toBeNull();
    expect(existsSync(join(dir, `${meta.token}.pdf`))).toBe(false);
  });
});
