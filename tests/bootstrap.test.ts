import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveSecrets } from '../src/bootstrap.js';

const HEX64 = /^[0-9a-f]{64}$/;

describe('resolveSecrets', () => {
  let dir: string;
  let dbPath: string;
  const saved = { api: process.env.QBO_API_KEY, enc: process.env.QBO_ENCRYPTION_KEY };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'qbo-boot-'));
    dbPath = join(dir, 'qbo-connections.db');
    delete process.env.QBO_API_KEY;
    delete process.env.QBO_ENCRYPTION_KEY;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    if (saved.api === undefined) delete process.env.QBO_API_KEY;
    else process.env.QBO_API_KEY = saved.api;
    if (saved.enc === undefined) delete process.env.QBO_ENCRYPTION_KEY;
    else process.env.QBO_ENCRYPTION_KEY = saved.enc;
  });

  it('generates and persists both secrets on first run', () => {
    const s = resolveSecrets(dbPath);
    expect(s.generatedApiKey).toBe(true);
    expect(s.generatedEncryptionKey).toBe(true);
    expect(s.apiKey).toMatch(HEX64);
    expect(s.encryptionKey).toMatch(HEX64);
    expect(existsSync(join(dir, '.qbo-secrets.json'))).toBe(true);
  });

  it('is stable across restarts — reuses persisted secrets', () => {
    const first = resolveSecrets(dbPath);
    const second = resolveSecrets(dbPath);
    expect(second.generatedApiKey).toBe(false);
    expect(second.generatedEncryptionKey).toBe(false);
    expect(second.apiKey).toBe(first.apiKey);
    expect(second.encryptionKey).toBe(first.encryptionKey);
  });

  it('lets env vars override and does not persist them', () => {
    process.env.QBO_API_KEY = 'env-admin-key';
    process.env.QBO_ENCRYPTION_KEY = 'b'.repeat(64);
    const s = resolveSecrets(dbPath);
    expect(s.apiKey).toBe('env-admin-key');
    expect(s.encryptionKey).toBe('b'.repeat(64));
    expect(s.generatedApiKey).toBe(false);
    expect(s.generatedEncryptionKey).toBe(false);
    expect(s.secretsPath).toBeNull();
    expect(existsSync(join(dir, '.qbo-secrets.json'))).toBe(false);
  });

  it('mixes env and persisted secrets (env key, generated encryption key)', () => {
    process.env.QBO_API_KEY = 'env-admin-key';
    const s = resolveSecrets(dbPath);
    expect(s.apiKey).toBe('env-admin-key');
    expect(s.generatedEncryptionKey).toBe(true);
    // Only the non-env secret is written to disk
    const file = JSON.parse(readFileSync(join(dir, '.qbo-secrets.json'), 'utf8'));
    expect(file.apiKey).toBeUndefined();
    expect(file.encryptionKey).toMatch(HEX64);
  });

  it('rejects an env encryption key of the wrong length', () => {
    process.env.QBO_ENCRYPTION_KEY = 'too-short';
    expect(() => resolveSecrets(dbPath)).toThrow(/64 hex/);
  });

  it('recovers a stored encryption key even if the file lacks an api key', () => {
    writeFileSync(join(dir, '.qbo-secrets.json'), JSON.stringify({ encryptionKey: 'c'.repeat(64) }));
    const s = resolveSecrets(dbPath);
    expect(s.encryptionKey).toBe('c'.repeat(64));
    expect(s.generatedEncryptionKey).toBe(false);
    expect(s.generatedApiKey).toBe(true); // api key was missing → generated
  });
});
