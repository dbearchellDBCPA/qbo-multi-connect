import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  AttachmentsAPI,
  contentTypeForFile,
  resolveAttachmentPath,
  assertSafeUrl,
  parseContentDispositionFileName,
  sniffContentType,
  resolveAttachmentFileName,
  fetchRemoteFile,
  describeRemoteFetch,
  REMOTE_FETCH_USER_AGENT,
  MAX_FILES_PER_UPLOAD,
} from '../../src/api/attachments.js';
import { QBOClient } from '../../src/api/client.js';
import { QBOManager } from '../../src/index.js';
import { companyRoutes } from '../../src/server/routes/company.js';

// ─── Content-type inference ──────────────────────────────────────────────────

describe('contentTypeForFile', () => {
  it('maps the extensions QBO cares about', () => {
    expect(contentTypeForFile('check-image_combined (1).png')).toBe('image/png');
    expect(contentTypeForFile('scan.PDF')).toBe('application/pdf');
    expect(contentTypeForFile('photo.jpeg')).toBe('image/jpeg');
    expect(contentTypeForFile('photo.jpg')).toBe('image/jpeg');
    expect(contentTypeForFile('export.csv')).toBe('text/csv');
  });

  it('returns null for unknown extensions', () => {
    expect(contentTypeForFile('archive.zip')).toBeNull();
    expect(contentTypeForFile('noextension')).toBeNull();
  });
});

// ─── Staging-path allowlist ──────────────────────────────────────────────────

describe('resolveAttachmentPath', () => {
  const dir = '/data/attachments';

  it('accepts relative paths inside the staging dir', () => {
    expect(resolveAttachmentPath('checks/img1.png', dir)).toBe('/data/attachments/checks/img1.png');
  });

  it('accepts absolute paths inside the staging dir', () => {
    expect(resolveAttachmentPath('/data/attachments/img1.png', dir)).toBe('/data/attachments/img1.png');
  });

  it('rejects traversal and out-of-dir paths (no secrets exfiltration)', () => {
    expect(() => resolveAttachmentPath('../.qbo-secrets.json', dir)).toThrow(/staging directory/);
    expect(() => resolveAttachmentPath('/data/.qbo-secrets.json', dir)).toThrow(/staging directory/);
    expect(() => resolveAttachmentPath('/etc/passwd', dir)).toThrow(/staging directory/);
    expect(() => resolveAttachmentPath('a/../../db.sqlite', dir)).toThrow(/staging directory/);
  });
});

// ─── SSRF guard ──────────────────────────────────────────────────────────────

describe('assertSafeUrl', () => {
  it('accepts public https URLs', () => {
    expect(assertSafeUrl('https://files.example.com/check.png').hostname).toBe('files.example.com');
  });

  it('rejects http and malformed URLs', () => {
    expect(() => assertSafeUrl('http://files.example.com/x.png')).toThrow(/https/);
    expect(() => assertSafeUrl('not a url')).toThrow(/not a valid URL/);
  });

  it('rejects internal hosts', () => {
    for (const bad of [
      'https://localhost/x.png',
      'https://127.0.0.1/x.png',
      'https://10.0.0.5/x.png',
      'https://192.168.1.1/x.png',
      'https://172.20.3.4/x.png',
      'https://169.254.169.254/latest/meta-data',
      'https://metadata.google.internal/computeMetadata',
      'https://railway.internal/x',
    ]) {
      expect(() => assertSafeUrl(bad), bad).toThrow(/not allowed/);
    }
  });
});

// ─── file_url helpers (SPEC §5) ──────────────────────────────────────────────

describe('parseContentDispositionFileName', () => {
  it('reads quoted, bare and RFC 5987 encoded names, basename only', () => {
    expect(parseContentDispositionFileName('attachment; filename="TIM true-up 2025.pdf"')).toBe('TIM true-up 2025.pdf');
    expect(parseContentDispositionFileName('attachment; filename=scan.pdf')).toBe('scan.pdf');
    expect(parseContentDispositionFileName("attachment; filename*=UTF-8''inv%205813.pdf")).toBe('inv 5813.pdf');
    expect(parseContentDispositionFileName('attachment; filename="../../etc/passwd"')).toBe('passwd');
    expect(parseContentDispositionFileName('inline')).toBeNull();
    expect(parseContentDispositionFileName(null)).toBeNull();
  });
});

describe('sniffContentType', () => {
  it('recognizes PDFs, images and HTML error pages by their leading bytes', () => {
    expect(sniffContentType(Buffer.from('%PDF-1.7 ...'))).toEqual({ contentType: 'application/pdf', extension: '.pdf' });
    expect(sniffContentType(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]))).toEqual({ contentType: 'image/png', extension: '.png' });
    expect(sniffContentType(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]))).toEqual({ contentType: 'image/jpeg', extension: '.jpg' });
    expect(sniffContentType(Buffer.from('\n  <!DOCTYPE html><html>'))).toEqual({ contentType: 'text/html', extension: '.html' });
    expect(sniffContentType(Buffer.from('<html lang="en">'))).toEqual({ contentType: 'text/html', extension: '.html' });
    expect(sniffContentType(Buffer.from('plain text'))).toBeNull();
  });
});

describe('resolveAttachmentFileName', () => {
  const url = new URL('https://uc123.dl.dropboxusercontent.com/cd/0/get/tok/file?c_luid=1');
  it('prefers file_name, then Content-Disposition, then a URL basename with a known extension, then the bytes', () => {
    expect(resolveAttachmentFileName({ explicit: 'custom.pdf', dispositionFileName: 'disp.pdf', url, bytes: Buffer.from('%PDF') })).toBe('custom.pdf');
    expect(resolveAttachmentFileName({ dispositionFileName: 'disp.pdf', url, bytes: Buffer.from('%PDF') })).toBe('disp.pdf');
    expect(resolveAttachmentFileName({ url: new URL('https://files.example.com/checks/img1.png'), bytes: Buffer.from('%PDF') })).toBe('img1.png');
    expect(resolveAttachmentFileName({ url, bytes: Buffer.from('%PDF-1.4') })).toBe('attachment.pdf');
    expect(resolveAttachmentFileName({ url, bytes: Buffer.from('<html>') })).toBe('file');
    expect(resolveAttachmentFileName({ url: new URL('https://files.example.com/'), bytes: Buffer.from('??') })).toBe('attachment');
  });
});

describe('fetchRemoteFile', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('follows redirects by hand with a browser User-Agent and reports what it fetched', async () => {
    const calls: any[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: any, init: any) => {
      calls.push({ url: String(input), init });
      if (calls.length === 1) return new Response('', { status: 302, headers: { location: '/cd/0/get/tok/file?c_luid=1' } });
      return new Response(Buffer.from('%PDF-1.4 x'), { status: 200, headers: { 'content-type': 'application/pdf', 'content-disposition': 'attachment; filename="a.pdf"' } });
    }));
    const r = await fetchRemoteFile('https://files.example.com/start');
    expect(calls.map((c) => c.url)).toEqual(['https://files.example.com/start', 'https://files.example.com/cd/0/get/tok/file?c_luid=1']);
    for (const c of calls) {
      expect(c.init.redirect).toBe('manual');
      expect(c.init.headers['User-Agent']).toBe(REMOTE_FETCH_USER_AGENT);
    }
    expect(r.status).toBe(200);
    expect(r.redirects).toBe(1);
    expect(r.dispositionFileName).toBe('a.pdf');
    expect(r.finalUrl.pathname).toBe('/cd/0/get/tok/file');
    expect(Buffer.from(r.bytes).toString()).toBe('%PDF-1.4 x');
    expect(describeRemoteFetch(r)).toBe('HTTP 200, 10 bytes, content-type application/pdf, 1 redirect, Content-Disposition name "a.pdf"');
  });

  it('applies the SSRF guard to every hop and caps the redirect chain', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 302, headers: { location: 'https://10.0.0.9/secret' } })));
    await expect(fetchRemoteFile('https://files.example.com/start')).rejects.toThrow(/10\.0\.0\.9.*not allowed/);

    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 302, headers: { location: 'https://files.example.com/again' } })));
    await expect(fetchRemoteFile('https://files.example.com/start', { maxRedirects: 2 })).rejects.toThrow(/more than 2 redirects/);
  });

  it('reports the status and a snippet of the body when the fetch fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html><body>Link expired</body></html>', { status: 403, statusText: 'Forbidden' })));
    await expect(fetchRemoteFile('https://files.example.com/x.pdf')).rejects.toThrow('Failed to fetch file_url (HTTP 403 Forbidden from files.example.com): <html><body>Link expired</body></html>');
  });
});

// ─── Upload multipart structure + response parsing ───────────────────────────

function makeClient(fetchImpl: ReturnType<typeof vi.fn>) {
  const future = new Date(Date.now() + 60 * 60 * 1000);
  const fakeTokenStore = {
    getConnection: async () => ({ status: 'active', tokenExpiry: future, accessToken: 'tok' }),
  };
  vi.stubGlobal('fetch', fetchImpl);
  return new QBOClient(fakeTokenStore as any, { clientId: '', clientSecret: '', redirectUri: '' }, 'sandbox');
}

describe('AttachmentsAPI.upload', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('builds paired metadata/content parts and parses per-item results', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        AttachableResponse: [
          { Attachable: { Id: '9001', FileName: 'check-10259.png', Size: 148213 } },
          { Fault: { Error: [{ Message: 'Invalid Reference Id', Detail: 'Purchase 999 not found' }] } },
        ],
      }),
    });
    const api = new AttachmentsAPI(makeClient(fetchSpy));

    const results = await api.upload('realm-1', [
      {
        fileName: 'check-10259.png',
        contentType: 'image/png',
        bytes: new Uint8Array([1, 2, 3]),
        entityRef: { type: 'Purchase', id: '756' },
        note: 'Front and back scan',
      },
      { fileName: 'check-bad.png', contentType: 'image/png', bytes: new Uint8Array([4]), entityRef: { type: 'Purchase', id: '999' } },
    ]);

    // Request shape: POST .../upload with FormData pairing metadata + content
    const [url, init] = fetchSpy.mock.calls[0];
    expect(String(url)).toContain('/company/realm-1/upload');
    expect(init.body).toBeInstanceOf(FormData);
    const form: FormData = init.body;
    const meta1 = JSON.parse(await (form.get('file_metadata_01') as Blob).text());
    expect(meta1).toEqual({
      FileName: 'check-10259.png',
      ContentType: 'image/png',
      Note: 'Front and back scan',
      AttachableRef: [{ EntityRef: { value: '756', type: 'Purchase' } }],
    });
    const content1 = form.get('file_content_01') as File;
    expect(content1.name).toBe('check-10259.png');
    expect(content1.type).toBe('image/png');
    expect(form.get('file_metadata_02')).toBeTruthy();
    expect(form.get('file_content_02')).toBeTruthy();
    // No Content-Type: application/json header — fetch must set the boundary
    expect(init.headers['Content-Type']).toBeUndefined();

    // Per-item results: one success, one fault
    expect(results[0]).toEqual({ fileName: 'check-10259.png', ok: true, attachable: { Id: '9001', FileName: 'check-10259.png', Size: 148213 } });
    expect(results[1].ok).toBe(false);
    expect(results[1].error).toContain('Invalid Reference Id');
    expect(results[1].error).toContain('Purchase 999 not found');
  });

  it('says what QBO answered when no Attachable comes back, and handles a top-level Fault', async () => {
    const noAttachable = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ AttachableResponse: [{ Warnings: 'x' }] }) });
    const api = new AttachmentsAPI(makeClient(noAttachable));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const [r] = await api.upload('realm-1', [{ fileName: 'a.pdf', contentType: 'application/pdf', bytes: new Uint8Array([1, 2, 3]) }]);
    expect(r.ok).toBe(false);
    expect(r.error).toBe('Upload failed: QBO returned HTTP 2xx but no Attachable for this file (3 bytes as application/pdf). QBO response: {"Warnings":"x"}');
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('[qbo-attachments] no Attachable for "a.pdf"'));

    vi.unstubAllGlobals();
    const topFault = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ Fault: { Error: [{ Message: 'Bad multipart', Detail: 'metadata part missing', code: '2010' }] } }) });
    const api2 = new AttachmentsAPI(makeClient(topFault));
    const [r2] = await api2.upload('realm-1', [{ fileName: 'a.pdf', contentType: 'application/pdf', bytes: new Uint8Array([1]) }]);
    expect(r2.error).toBe('QBO rejected the upload: Bad multipart — metadata part missing (QBO code 2010)');
    errSpy.mockRestore();
  });

  it('enforces the per-request file cap', async () => {
    const api = new AttachmentsAPI(makeClient(vi.fn()));
    const items = Array.from({ length: MAX_FILES_PER_UPLOAD + 1 }, (_, i) => ({
      fileName: `f${i}.png`,
      contentType: 'image/png',
      bytes: new Uint8Array([1]),
    }));
    await expect(api.upload('realm-1', items)).rejects.toThrow(/At most/);
  });
});

// ─── REST upload endpoint ────────────────────────────────────────────────────

const ENCRYPTION_KEY = 'a'.repeat(64);
const MASTER_KEY = 'master-key-for-tests';

function multipartBody(
  boundary: string,
  parts: Array<{ name: string; value?: string; fileName?: string; contentType?: string; bytes?: Buffer }>
): Buffer {
  const chunks: Buffer[] = [];
  for (const p of parts) {
    chunks.push(Buffer.from(`--${boundary}\r\n`));
    if (p.fileName !== undefined) {
      chunks.push(
        Buffer.from(
          `Content-Disposition: form-data; name="${p.name}"; filename="${p.fileName}"\r\nContent-Type: ${p.contentType ?? 'application/octet-stream'}\r\n\r\n`
        )
      );
      chunks.push(p.bytes ?? Buffer.alloc(0));
    } else {
      chunks.push(Buffer.from(`Content-Disposition: form-data; name="${p.name}"\r\n\r\n${p.value ?? ''}`));
    }
    chunks.push(Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return Buffer.concat(chunks);
}

describe('POST /api/company/:realmId/attachments', () => {
  let qbo: QBOManager;
  let app: FastifyInstance;

  beforeEach(async () => {
    qbo = new QBOManager({ dbPath: ':memory:', encryptionKey: ENCRYPTION_KEY });
    const future = new Date(Date.now() + 60 * 60 * 1000);
    const far = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000);
    await (qbo as any).tokenStore.storeConnection({
      clientName: 'The Meadows',
      realmId: 'realm-1',
      accessToken: 'at',
      refreshToken: 'rt',
      tokenExpiry: future,
      refreshExpiry: far,
      scopes: ['x'],
    });
    app = Fastify({ logger: false });
    await companyRoutes(app, qbo, MASTER_KEY);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    await qbo.close?.();
    vi.unstubAllGlobals();
  });

  function inject(parts: Parameters<typeof multipartBody>[1], headers: Record<string, string> = {}) {
    const boundary = 'testboundary123';
    return app.inject({
      method: 'POST',
      url: '/api/company/realm-1/attachments',
      headers: {
        authorization: `Bearer ${MASTER_KEY}`,
        'content-type': `multipart/form-data; boundary=${boundary}`,
        ...headers,
      },
      payload: multipartBody(boundary, parts),
    });
  }

  it('uploads a file and returns the Attachable identity', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          AttachableResponse: [{ Attachable: { Id: '9001', FileName: 'check.png', Size: 3 } }],
        }),
      })
    );

    const res = await inject([
      { name: 'file', fileName: 'check.png', contentType: 'image/png', bytes: Buffer.from([1, 2, 3]) },
      { name: 'entity_type', value: 'Purchase' },
      { name: 'entity_id', value: '756' },
    ]);

    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({
      attachableId: '9001',
      fileName: 'check.png',
      size: 3,
      contentType: 'image/png',
      entity: { type: 'Purchase', id: '756' },
    });
  });

  it('rejects entity_type without entity_id (no silent orphans)', async () => {
    const res = await inject([
      { name: 'file', fileName: 'check.png', contentType: 'image/png', bytes: Buffer.from([1]) },
      { name: 'entity_type', value: 'Purchase' },
    ]);
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain('together');
  });

  it('rejects requests without a file part', async () => {
    const res = await inject([{ name: 'entity_type', value: 'Purchase' }, { name: 'entity_id', value: '1' }]);
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain('file');
  });

  it('requires auth and an assigned company', async () => {
    const noAuth = await app.inject({ method: 'POST', url: '/api/company/realm-1/attachments' });
    expect(noAuth.statusCode).toBe(401);

    const { apiKey } = await qbo.users.create({ name: 'Scoped', realmIds: [] }); // no companies
    const boundary = 'b2';
    const denied = await app.inject({
      method: 'POST',
      url: '/api/company/realm-1/attachments',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
      payload: multipartBody(boundary, [
        { name: 'file', fileName: 'x.png', contentType: 'image/png', bytes: Buffer.from([1]) },
      ]),
    });
    expect(denied.statusCode).toBe(404); // unassigned looks like nonexistent
  });

  it('rejects read-only keys', async () => {
    const { apiKey } = await qbo.users.create({ name: 'Reader', accessLevel: 'read', realmIds: ['realm-1'] });
    const boundary = 'b3';
    const res = await app.inject({
      method: 'POST',
      url: '/api/company/realm-1/attachments',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
      payload: multipartBody(boundary, [
        { name: 'file', fileName: 'x.png', contentType: 'image/png', bytes: Buffer.from([1]) },
      ]),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().message).toContain('read-only');
  });

  it('accepts a realm-bound upload token minted by the token service', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ AttachableResponse: [{ Attachable: { Id: '7001', FileName: 'x.png', Size: 1 } }] }),
      })
    );
    const { token } = await qbo.uploadTokens.issue('realm-1', 'test');

    const boundary = 'b4';
    const res = await app.inject({
      method: 'POST',
      url: '/api/company/realm-1/attachments',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
      payload: multipartBody(boundary, [
        { name: 'file', fileName: 'x.png', contentType: 'image/png', bytes: Buffer.from([1]) },
      ]),
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().attachableId).toBe('7001');
  });

  it('rejects upload tokens for a different realm and garbage tokens', async () => {
    const { token } = await qbo.uploadTokens.issue('realm-OTHER', 'test');
    const boundary = 'b5';
    for (const bad of [token, 'uplt_deadbeef']) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/company/realm-1/attachments',
        headers: {
          authorization: `Bearer ${bad}`,
          'content-type': `multipart/form-data; boundary=${boundary}`,
        },
        payload: multipartBody(boundary, [
          { name: 'file', fileName: 'x.png', contentType: 'image/png', bytes: Buffer.from([1]) },
        ]),
      });
      expect(res.statusCode, bad).toBe(401);
      expect(res.json().message).toContain('create_upload_session');
    }
  });
});

describe('UploadTokenService', () => {
  let qbo: QBOManager;

  beforeEach(() => {
    qbo = new QBOManager({ dbPath: ':memory:', encryptionKey: ENCRYPTION_KEY });
  });

  afterEach(async () => {
    await qbo.close?.();
  });

  it('issues uplt_-prefixed tokens valid for their realm only', async () => {
    const { token, expiresAt } = await qbo.uploadTokens.issue('realm-1', 'David');
    expect(token).toMatch(/^uplt_[0-9a-f]{48}$/);
    expect(expiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(await qbo.uploadTokens.validate('realm-1', token)).toBe(true);
    expect(await qbo.uploadTokens.validate('realm-2', token)).toBe(false);
  });

  it('rejects expired tokens', async () => {
    const { token } = await qbo.uploadTokens.issue('realm-1', 'David');
    // Force-expire the row
    (qbo as any).db['db']
      .prepare("UPDATE upload_tokens SET expires_at = datetime('now', '-1 minute')")
      .run();
    expect(await qbo.uploadTokens.validate('realm-1', token)).toBe(false);
  });

  it('rejects non-upload-token shapes without touching the DB', async () => {
    expect(await qbo.uploadTokens.validate('realm-1', 'qbo_notanuploadtoken')).toBe(false);
  });
});
