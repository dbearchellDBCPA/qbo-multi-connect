import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { QBOManager } from '../../src/index.js';
import { registerMcpRoutes } from '../../src/server/mcp.js';
import { FakeQboForms, ingramLikePreferences } from '../support/fake-qbo-forms.js';

// ─────────────────────────────────────────────────────────────────────────────
// create_attachment(file_url=…) end to end (SPEC §5.4): a public https URL
// that 302-redirects to a Dropbox-style temporary link whose path ends in
// "/file" (no extension) and names the file only in Content-Disposition. The
// MCP tool must follow the redirect, name and type the file correctly, and
// send QBO's /upload a PDF part linked to the invoice — and when things go
// wrong, say what was fetched and what QBO answered.
// ─────────────────────────────────────────────────────────────────────────────

const ENCRYPTION_KEY = 'a'.repeat(64);
const MASTER_KEY = 'master-key-for-tests';
const REALM = '9130347766481406';
const CLIENT = 'Ingram Entities';
const PDF = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n');
const HTML = Buffer.from('<!DOCTYPE html><html><head><title>Link expired</title></head><body>This link has expired.</body></html>');

describe('create_attachment with file_url — end to end over MCP', () => {
  let app: FastifyInstance;
  let qbo: QBOManager;
  let mcp: Client;
  let fake: FakeQboForms;
  const requests: { url: string; headers: Record<string, string>; redirect?: string }[] = [];
  let finalResponse: () => Response;

  const call = async (name: string, args: Record<string, unknown>): Promise<string> => {
    const res: any = await mcp.callTool({ name, arguments: { client_name: CLIENT, ...args } });
    return (res.content ?? []).map((c: any) => c.text ?? '').join('\n');
  };

  beforeAll(async () => {
    fake = new FakeQboForms(REALM, ingramLikePreferences());
    fake.seed('Invoice', { Id: '126405', DocNumber: '5813', TxnDate: '2026-09-17', CustomerRef: { value: '31' }, Line: [], TotalAmt: 1 });
    const realFetch = globalThis.fetch;
    vi.stubGlobal('fetch', (input: any, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.hostname.endsWith('intuit.com')) return fake.fetch(input, init);
      if (url.hostname === 'www.dropbox.example') {
        requests.push({ url: url.toString(), headers: Object.fromEntries(Object.entries((init?.headers as Record<string, string>) ?? {})), redirect: init?.redirect });
        return Promise.resolve(new Response('moved', { status: 302, headers: { location: 'https://uc123.dl.dropboxusercontent.example/cd/0/get/tok/file?c_luid=42' } }));
      }
      if (url.hostname === 'uc123.dl.dropboxusercontent.example') {
        requests.push({ url: url.toString(), headers: Object.fromEntries(Object.entries((init?.headers as Record<string, string>) ?? {})), redirect: init?.redirect });
        return Promise.resolve(finalResponse());
      }
      if (url.hostname === 'bounce.example') {
        return Promise.resolve(new Response('moved', { status: 302, headers: { location: 'https://169.254.169.254/latest/meta-data' } }));
      }
      return realFetch(input, init);
    });

    qbo = new QBOManager({ dbPath: ':memory:', encryptionKey: ENCRYPTION_KEY });
    await (qbo as any).tokenStore.storeConnection({
      clientName: CLIENT,
      realmId: REALM,
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      tokenExpiry: new Date(Date.now() + 60 * 60 * 1000),
      refreshExpiry: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
      scopes: ['com.intuit.quickbooks.accounting'],
    });
    app = Fastify();
    await registerMcpRoutes(app, qbo, MASTER_KEY);
    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address();
    const baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
    mcp = new Client({ name: 'attachment-url-e2e', version: '1.0.0' });
    await mcp.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${MASTER_KEY}` } },
    }));
  }, 60_000);

  afterAll(async () => {
    await mcp?.close().catch(() => {});
    await app?.close();
    qbo?.close();
    vi.unstubAllGlobals();
  });

  beforeEach(() => {
    requests.length = 0;
    fake.uploads.length = 0;
    fake.uploadResponseOverride = null;
    finalResponse = () => new Response(PDF, {
      status: 200,
      headers: { 'content-type': 'application/pdf', 'content-disposition': 'attachment; filename="TIM true-up 2025.pdf"' },
    });
  });

  it('follows the redirect, names the file from file_name, types it as a PDF and links it to the invoice', async () => {
    const text = await call('create_attachment', {
      entity_type: 'Invoice',
      entity_id: '126405',
      file_url: 'https://www.dropbox.example/scl/fi/abc/TIM.pdf?dl=1',
      file_name: 'DG-2025-TIM-true-up.pdf',
      include_on_send: true,
    });
    expect(text).toMatch(/^Attachment uploaded\./);
    expect(text).toContain('Linked to: Invoice 126405');
    expect(text).toContain(`Source: file_url uc123.dl.dropboxusercontent.example: HTTP 200, ${PDF.length} bytes, content-type application/pdf, 1 redirect, Content-Disposition name "TIM true-up 2025.pdf" → uploaded as "DG-2025-TIM-true-up.pdf" (application/pdf)`);

    // Both hops carried a browser-ish User-Agent and were fetched with manual redirects (SSRF check per hop).
    expect(requests).toHaveLength(2);
    for (const r of requests) {
      expect(r.headers['User-Agent']).toMatch(/^Mozilla\/5\.0/);
      expect(r.redirect).toBe('manual');
    }
    expect(requests[1].url).toBe('https://uc123.dl.dropboxusercontent.example/cd/0/get/tok/file?c_luid=42');

    const [part] = fake.uploads[0];
    expect(part.metadata).toEqual({
      FileName: 'DG-2025-TIM-true-up.pdf',
      ContentType: 'application/pdf',
      IncludeOnSend: true,
      AttachableRef: [{ EntityRef: { value: '126405', type: 'Invoice' } }],
    });
    expect(part.fileName).toBe('DG-2025-TIM-true-up.pdf');
    expect(part.contentType).toBe('application/pdf');
    expect(part.size).toBe(PDF.length);
  });

  it('without file_name, takes the name from Content-Disposition (not the "/file" path)', async () => {
    const text = await call('create_attachment', { entity_type: 'Invoice', entity_id: '126405', file_url: 'https://www.dropbox.example/tmp/link' });
    expect(text).toMatch(/^Attachment uploaded\./);
    expect(fake.uploads[0][0].metadata.FileName).toBe('TIM true-up 2025.pdf');
    expect(fake.uploads[0][0].metadata.ContentType).toBe('application/pdf');
  });

  it('with neither name nor extension, types the file from its bytes', async () => {
    finalResponse = () => new Response(PDF, { status: 200, headers: { 'content-type': 'application/octet-stream' } });
    const text = await call('create_attachment', { entity_type: 'Invoice', entity_id: '126405', file_url: 'https://www.dropbox.example/tmp/link' });
    expect(text).toMatch(/^Attachment uploaded\./);
    expect(fake.uploads[0][0].metadata).toMatchObject({ FileName: 'attachment.pdf', ContentType: 'application/pdf' });
  });

  it('refuses to upload an HTML page that came back instead of the file, and says so', async () => {
    finalResponse = () => new Response(HTML, { status: 200, headers: { 'content-type': 'text/html' } });
    const text = await call('create_attachment', { entity_type: 'Invoice', entity_id: '126405', file_url: 'https://www.dropbox.example/tmp/link', file_name: 'x.pdf' });
    expect(text).toMatch(/^Error creating attachment: file_url returned an HTML page, not a file/);
    expect(text).toContain('HTTP 200');
    expect(text).toContain('Link expired');
    expect(fake.uploads).toHaveLength(0);
  });

  it('reports the HTTP status and body of a failed fetch', async () => {
    finalResponse = () => new Response('{"error":"expired_link"}', { status: 410, statusText: 'Gone' });
    const text = await call('create_attachment', { entity_type: 'Invoice', entity_id: '126405', file_url: 'https://www.dropbox.example/tmp/link', file_name: 'x.pdf' });
    expect(text).toContain('Failed to fetch file_url (HTTP 410 Gone from uc123.dl.dropboxusercontent.example after 1 redirect): {"error":"expired_link"}');
  });

  it('surfaces what QBO answered when no Attachable comes back', async () => {
    fake.uploadResponseOverride = { AttachableResponse: [{}] };
    const text = await call('create_attachment', { entity_type: 'Invoice', entity_id: '126405', file_url: 'https://www.dropbox.example/tmp/link', file_name: 'x.pdf' });
    expect(text).toContain(`Attachment upload failed: Upload failed: QBO returned HTTP 2xx but no Attachable for this file (${PDF.length} bytes as application/pdf). QBO response: {}`);
    expect(text).toContain(`Source: file_url uc123.dl.dropboxusercontent.example: HTTP 200, ${PDF.length} bytes`);

    fake.uploadResponseOverride = { Fault: { Error: [{ Message: 'Request has invalid or unsupported property', Detail: 'Property Name:IncludeOnSend specified is unsupported or invalid', code: '2010' }], type: 'ValidationFault' } };
    const text2 = await call('create_attachment', { entity_type: 'Invoice', entity_id: '126405', file_url: 'https://www.dropbox.example/tmp/link', file_name: 'x.pdf' });
    expect(text2).toContain('QBO rejected the upload: Request has invalid or unsupported property — Property Name:IncludeOnSend specified is unsupported or invalid (QBO code 2010)');
  });

  it('re-checks every redirect hop against the SSRF guard', async () => {
    const text = await call('create_attachment', { entity_type: 'Invoice', entity_id: '126405', file_url: 'https://bounce.example/file', file_name: 'x.pdf' });
    expect(text).toContain('file_url host "169.254.169.254" is not allowed');
    expect(fake.uploads).toHaveLength(0);
  });
});
