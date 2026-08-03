import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  AttachmentsAPI,
  contentTypeForFile,
  resolveAttachmentPath,
  assertSafeUrl,
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
