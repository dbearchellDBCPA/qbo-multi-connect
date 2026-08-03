import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface ResolvedSecrets {
  apiKey: string;
  encryptionKey: string;
  generatedApiKey: boolean;
  generatedEncryptionKey: boolean;
  /** Where auto-managed secrets are persisted, or null if both came from env. */
  secretsPath: string | null;
}

/** 32 random bytes → 64 hex chars, the format both keys use. */
function generateKey(): string {
  return randomBytes(32).toString('hex');
}

/**
 * Resolve the admin API key and the token-encryption key for a deployment.
 *
 * Precedence per key:
 *   1. Environment variable (QBO_API_KEY / QBO_ENCRYPTION_KEY) — always wins.
 *   2. A persisted secrets file in the data directory (next to the DB).
 *   3. Freshly generated, then persisted to that file.
 *
 * This lets a brand-new instance self-provision: mount a data volume, boot,
 * and the app creates and STORES stable secrets. Stability matters for the
 * encryption key — if it changed between restarts, previously stored QBO
 * tokens would become undecryptable. The persisted file lives on the same
 * volume as the database, so it survives redeploys exactly as the data does.
 */
export function resolveSecrets(dbPath: string): ResolvedSecrets {
  const dataDir = dirname(dbPath) || '.';
  const secretsPath = join(dataDir, '.qbo-secrets.json');

  let stored: { apiKey?: string; encryptionKey?: string } = {};
  if (existsSync(secretsPath)) {
    try {
      stored = JSON.parse(readFileSync(secretsPath, 'utf8'));
    } catch {
      stored = {};
    }
  }

  const envApiKey = process.env.QBO_API_KEY?.trim() || '';
  const envEncKey = process.env.QBO_ENCRYPTION_KEY?.trim() || '';

  let apiKey = envApiKey || stored.apiKey || '';
  let encryptionKey = envEncKey || stored.encryptionKey || '';
  let generatedApiKey = false;
  let generatedEncryptionKey = false;

  if (!apiKey) {
    apiKey = generateKey();
    generatedApiKey = true;
  }
  if (!encryptionKey) {
    encryptionKey = generateKey();
    generatedEncryptionKey = true;
  }

  if (encryptionKey.length !== 64) {
    throw new Error('QBO_ENCRYPTION_KEY must be 64 hex characters (32 bytes)');
  }

  // Persist whichever secrets are NOT supplied by env, so the file stays the
  // stable source of truth for auto-managed keys. Env always overrides at
  // runtime, so a value present in env is never written to disk.
  let persistedTo: string | null = envApiKey && envEncKey ? null : secretsPath;
  if (!envApiKey || !envEncKey) {
    const payload: { apiKey?: string; encryptionKey?: string } = {};
    if (!envApiKey) payload.apiKey = apiKey;
    if (!envEncKey) payload.encryptionKey = encryptionKey;
    try {
      mkdirSync(dataDir, { recursive: true });
      writeFileSync(secretsPath, JSON.stringify(payload, null, 2), { mode: 0o600 });
    } catch (err) {
      // Read-only filesystem or missing volume: we can still run this boot,
      // but auto-generated keys won't survive a restart — warn loudly.
      console.warn(
        `[bootstrap] Could not persist secrets to ${secretsPath}: ${
          err instanceof Error ? err.message : err
        }. ` +
          'Set QBO_API_KEY and QBO_ENCRYPTION_KEY explicitly, or mount a writable data volume.'
      );
      persistedTo = null;
    }
  }

  return { apiKey, encryptionKey, generatedApiKey, generatedEncryptionKey, secretsPath: persistedTo };
}

/**
 * Print a one-time banner when the admin key was freshly generated, so the
 * operator can grab it from the deploy logs. It stays recoverable from the
 * secrets file afterwards (unlike per-member keys, which are hashed).
 */
export function logFreshSecrets(secrets: ResolvedSecrets): void {
  if (!secrets.generatedApiKey && !secrets.generatedEncryptionKey) return;

  const line = '═'.repeat(64);
  console.log(`\n${line}`);
  console.log(' FIRST-RUN SETUP — new secrets generated for this instance');
  if (secrets.generatedApiKey) {
    console.log('\n Admin API key (use this to sign in to the dashboard):');
    console.log(`   ${secrets.apiKey}`);
  }
  if (secrets.generatedEncryptionKey) {
    console.log('\n A token-encryption key was generated and stored.');
  }
  if (secrets.secretsPath) {
    console.log(`\n Stored on the data volume at: ${secrets.secretsPath}`);
    console.log(' Keep that volume — losing it means re-authorizing every company.');
  }
  console.log(`${line}\n`);
}
