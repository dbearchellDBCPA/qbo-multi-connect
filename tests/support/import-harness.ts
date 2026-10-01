// Spins up the real MCP server (registerMcpRoutes) against FakeQboLedger and
// returns a call(tool, args) → text helper. The batch runner gets a virtual
// clock: sleeps advance it instantly, so throttling/backoff paths run in ms
// while the per-minute window is still enforced on virtual time.

import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { QBOManager } from '../../src/index.js';
import { registerMcpRoutes } from '../../src/server/mcp.js';
import { FakeQboLedger, LEDGER_REALM, seedImportCompany, type FakeLedgerOptions } from './fake-qbo-ledger.js';

export const IMPORT_CLIENT = 'Import Test Co';
const MASTER_KEY = 'master-key-for-import-tests';

export interface ImportHarness {
  app: FastifyInstance;
  qbo: QBOManager;
  mcp: Client;
  ledger: FakeQboLedger;
  dataDir: string;
  clock: { now: number; slept: number[] };
  batchLog: string[];
  call: (name: string, args: Record<string, unknown>) => Promise<string>;
  close: () => Promise<void>;
}

export async function startImportHarness(opts: FakeLedgerOptions = {}): Promise<ImportHarness> {
  const clock = { now: Date.UTC(2026, 8, 30, 12, 0, 0), slept: [] as number[] };
  const ledger = seedImportCompany(new FakeQboLedger(LEDGER_REALM, { clock: () => clock.now, ...opts }));
  const realFetch = globalThis.fetch;
  vi.stubGlobal('fetch', (input: any, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    return url.hostname.endsWith('intuit.com') ? ledger.fetch(input, init) : realFetch(input, init);
  });
  const dataDir = mkdtempSync(join(tmpdir(), 'qbo-import-test-'));
  const qbo = new QBOManager({ dbPath: ':memory:', encryptionKey: 'b'.repeat(64) });
  await (qbo as any).tokenStore.storeConnection({
    clientName: IMPORT_CLIENT,
    realmId: LEDGER_REALM,
    accessToken: 'test-access-token',
    refreshToken: 'test-refresh-token',
    tokenExpiry: new Date(Date.now() + 60 * 60 * 1000),
    refreshExpiry: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
    scopes: ['com.intuit.quickbooks.accounting'],
  });
  const batchLog: string[] = [];
  const app = Fastify();
  await registerMcpRoutes(app, qbo, MASTER_KEY, undefined, {
    importDataDir: dataDir,
    importRunnerOptions: {
      now: () => clock.now,
      sleep: async (ms) => {
        clock.slept.push(ms);
        clock.now += ms;
      },
      log: (line) => batchLog.push(line),
    },
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  const baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  const mcp = new Client({ name: 'bulk-import-e2e', version: '1.0.0' });
  await mcp.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${MASTER_KEY}` } },
  }));
  const call = async (name: string, args: Record<string, unknown>): Promise<string> => {
    const res: any = await mcp.callTool({ name, arguments: args });
    const t = (res.content ?? []).map((c: any) => c.text ?? '').join('\n');
    // Advance the virtual clock between calls like real time would.
    clock.now += 1000;
    return t;
  };
  return {
    app, qbo, mcp, ledger, dataDir, clock, batchLog, call,
    close: async () => {
      await mcp.close().catch(() => {});
      await app.close();
      qbo.close();
      vi.unstubAllGlobals();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

const STATUS_RE = /\b(would create|would update|would delete|not found|created|updated|unchanged|skipped|blocked|failed|deleted|refused)\b/;

/** The status of a row (by source id or display name) in one of the tools' tables. */
export function rowStatus(text: string, key: string): string | undefined {
  for (const line of text.split('\n')) {
    const at = line.indexOf(`  ${key}  `);
    if (at < 0) continue;
    const m = line.slice(at + key.length + 2).match(STATUS_RE);
    if (m) return m[1];
  }
  return undefined;
}

/** Load the JSON run log a tool reply points at ("Full result: <path>"). */
export function runLog(text: string): any {
  const m = text.match(/Full result: (\S+\.json)/);
  if (!m) throw new Error(`no run log path in:\n${text}`);
  return JSON.parse(readFileSync(m[1], 'utf8'));
}

export function csvPath(text: string): string {
  const m = text.match(/CSV: (\S+\.csv)/);
  if (!m) throw new Error(`no CSV path in:\n${text}`);
  return m[1];
}
