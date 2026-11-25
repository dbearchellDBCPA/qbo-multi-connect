import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { QBOManager } from '../../src/index.js';
import { registerMcpRoutes } from '../../src/server/mcp.js';
import { QBOError } from '../../src/api/client.js';

const ENCRYPTION_KEY = 'a'.repeat(64);
const MASTER_KEY = 'master-key-for-document-tests';
const CLIENT = 'United Way of the CSRA';
const REALM = '9341454121860748';
const PDF_BYTES = Buffer.from('%PDF-1.4 mock invoice\n');

describe('MCP transaction PDF and email send (mocked QBO only)', () => {
  let qbo: QBOManager;
  let app: FastifyInstance;
  let baseUrl: string;
  let dataDir: string;
  let getSpy: ReturnType<typeof vi.fn>;
  let getBinarySpy: ReturnType<typeof vi.fn>;
  let postSpy: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'qbo-doc-'));
    qbo = new QBOManager({ dbPath: ':memory:', encryptionKey: ENCRYPTION_KEY });
    const future = new Date(Date.now() + 60 * 60 * 1000);
    const farFuture = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000);
    await (qbo as any).tokenStore.storeConnection({
      clientName: CLIENT,
      realmId: REALM,
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      tokenExpiry: future,
      refreshExpiry: farFuture,
      scopes: ['com.intuit.quickbooks.accounting'],
    });

    getSpy = vi.fn().mockImplementation((_realm: string, path: string) => {
      if (path === 'invoice/20') {
        return Promise.resolve({ Invoice: { Id: '20', DocNumber: '501', BillEmail: { Address: 'ap@example.org' }, SyncToken: '1' } });
      }
      if (path === 'invoice/21') {
        return Promise.resolve({ Invoice: { Id: '21', DocNumber: '502', SyncToken: '1' } });
      }
      return Promise.reject(new QBOError(`unexpected get ${path}`, 404));
    });
    getBinarySpy = vi.fn().mockImplementation((_realm: string, path: string) => {
      if (path === 'invoice/20/pdf' || path === 'invoice/21/pdf') {
        return Promise.resolve({ buffer: PDF_BYTES, contentType: 'application/pdf' });
      }
      return Promise.reject(new QBOError(`unexpected pdf ${path}`, 400));
    });
    postSpy = vi.fn().mockImplementation((_realm: string, path: string) => {
      if (path.startsWith('invoice/20/send')) {
        return Promise.resolve({ Invoice: { Id: '20', EmailStatus: 'EmailSent' } });
      }
      return Promise.reject(new QBOError(`unexpected post ${path}`, 400));
    });
    (qbo as any).client.get = getSpy;
    (qbo as any).client.getBinary = getBinarySpy;
    (qbo as any).client.post = postSpy;

    app = Fastify();
    await registerMcpRoutes(app, qbo, MASTER_KEY, join(dataDir, 'attachments'), { importDataDir: dataDir });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address();
    baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  });

  afterEach(async () => {
    await app.close();
    qbo.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  async function callTool(name: string, args: Record<string, unknown>): Promise<{ texts: string[]; isError: boolean }> {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${MASTER_KEY}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    const chunks = text.trimStart().startsWith('{')
      ? [text]
      : text.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim());
    for (const chunk of chunks) {
      const parsed = JSON.parse(chunk);
      if (parsed?.error) throw new Error(`MCP error: ${parsed.error.message}`);
      if (parsed?.result) {
        return {
          texts: (parsed.result.content ?? []).map((c: any) => String(c.text ?? '')),
          isError: Boolean(parsed.result.isError),
        };
      }
    }
    throw new Error(`No tools/call result in response: ${text.slice(0, 200)}`);
  }

  const lastJson = (texts: string[]) => JSON.parse(texts[texts.length - 1]);

  it('get_transaction_pdf saves the PDF and serves it at the download URL (no API key in the link)', async () => {
    const { texts, isError } = await callTool('get_transaction_pdf', {
      client_name: CLIENT,
      type: 'Invoice',
      id: '20',
    });
    expect(isError).toBe(false);
    const body = lastJson(texts);
    expect(body.file_name).toBe('Invoice_501.pdf');
    expect(body.bytes).toBe(PDF_BYTES.length);
    expect(body.content_type).toBe('application/pdf');
    expect(body.download_url).toMatch(/\/downloads\/pdf\/pdf_[a-f0-9]{48}$/);
    expect(body.download_url).not.toMatch(/key=|api_key|intuit_apikey/i);
    expect(getBinarySpy).toHaveBeenCalledWith(REALM, 'invoice/20/pdf', 'application/pdf');

    const res = await fetch(body.download_url);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/pdf/);
    const bytes = Buffer.from(await res.arrayBuffer());
    expect(bytes.equals(PDF_BYTES)).toBe(true);
  });

  it('send_transaction_email defaults to a dry run that shows the recipient and does not POST /send', async () => {
    const { texts, isError } = await callTool('send_transaction_email', {
      client_name: CLIENT,
      type: 'Invoice',
      id: '20',
    });
    expect(isError).toBe(false);
    const body = lastJson(texts);
    expect(body.dry_run).toBe(true);
    expect(body.sent).toBe(false);
    expect(body.recipient).toBe('ap@example.org');
    expect(body.bill_email).toBe('ap@example.org');
    expect(body.message).toMatch(/confirm_send=true/);
    expect(postSpy).not.toHaveBeenCalled();
  });

  it('send_transaction_email refuses a live send without confirm_send=true', async () => {
    const { texts, isError } = await callTool('send_transaction_email', {
      client_name: CLIENT,
      type: 'Invoice',
      id: '20',
      send_to: 'other@example.org',
      confirm_send: false,
    });
    expect(isError).toBe(false);
    const body = lastJson(texts);
    expect(body.dry_run).toBe(true);
    expect(body.recipient).toBe('other@example.org');
    expect(postSpy).not.toHaveBeenCalled();
  });

  it('send_transaction_email posts /send when confirm_send=true', async () => {
    const { texts, isError } = await callTool('send_transaction_email', {
      client_name: CLIENT,
      type: 'Invoice',
      id: '20',
      send_to: 'other@example.org',
      confirm_send: true,
    });
    expect(isError).toBe(false);
    const body = lastJson(texts);
    expect(body.dry_run).toBe(false);
    expect(body.sent).toBe(true);
    expect(body.recipient).toBe('other@example.org');
    expect(postSpy).toHaveBeenCalledWith(
      REALM,
      'invoice/20/send?sendTo=other%40example.org',
      undefined,
      { headers: { 'Content-Type': 'application/octet-stream' } },
    );
  });

  it('send_transaction_email with confirm_send=true refuses when no BillEmail exists, even with send_to', async () => {
    const { texts, isError } = await callTool('send_transaction_email', {
      client_name: CLIENT,
      type: 'Invoice',
      id: '21',
      send_to: 'other@example.org',
      confirm_send: true,
    });
    expect(isError).toBe(true);
    const body = lastJson(texts);
    expect(body.sent).toBe(false);
    expect(body.bill_email).toBeNull();
    expect(body.send_to).toBe('other@example.org');
    expect(body.message).toBe('Transaction has no BillEmail; set it first with update_invoice bill_email=... then retry');
    expect(postSpy).not.toHaveBeenCalled();
  });

  it('send_transaction_email with confirm_send=true refuses when no recipient and no BillEmail exist', async () => {
    const { texts, isError } = await callTool('send_transaction_email', {
      client_name: CLIENT,
      type: 'Invoice',
      id: '21',
      confirm_send: true,
    });
    expect(isError).toBe(true);
    const body = lastJson(texts);
    expect(body.sent).toBe(false);
    expect(body.message).toBe('Transaction has no BillEmail; set it first with update_invoice bill_email=... then retry');
    expect(postSpy).not.toHaveBeenCalled();
  });

  it('send_transaction_email dry run warns when BillEmail is missing even if send_to is set', async () => {
    const { texts, isError } = await callTool('send_transaction_email', {
      client_name: CLIENT,
      type: 'Invoice',
      id: '21',
      send_to: 'other@example.org',
    });
    expect(isError).toBe(false);
    const body = lastJson(texts);
    expect(body.dry_run).toBe(true);
    expect(body.sent).toBe(false);
    expect(body.message).toMatch(/no BillEmail/);
    expect(body.message).toMatch(/update_invoice bill_email=/);
    expect(postSpy).not.toHaveBeenCalled();
  });
});
