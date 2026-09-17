import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { QBOManager } from '../../src/index.js';
import { registerMcpRoutes } from '../../src/server/mcp.js';
import { FakeIntuit, defaultSeedAccounts } from '../support/fake-intuit.js';
import { runCoaHierarchyScenario, type ScenarioResult } from '../support/coa-hierarchy-scenario.js';

// ─────────────────────────────────────────────────────────────────────────────
// End-to-end: the real MCP server (registerMcpRoutes → tools → AccountsAPI →
// QBOClient → fetch) driven by the real MCP client over streamable HTTP, with
// Intuit's API replaced by FakeIntuit (tests/support/fake-intuit.ts), which
// enforces QBO's documented and sandbox-observed rules and returns QBO's own
// fault bodies. The scenario is the one the sandbox runner executes for real.
// ─────────────────────────────────────────────────────────────────────────────

const ENCRYPTION_KEY = 'a'.repeat(64);
const MASTER_KEY = 'master-key-for-tests';
const REALM = '4620816365208161220';
const CLIENT = 'Sandbox Co';

describe('chart of accounts hierarchy — end to end over MCP', () => {
  let app: FastifyInstance;
  let qbo: QBOManager;
  let mcp: Client;
  let fake: FakeIntuit;
  const transcript: string[] = [];
  let outcome: ScenarioResult;

  beforeAll(async () => {
    fake = new FakeIntuit(REALM, defaultSeedAccounts());
    // Intuit traffic goes to the fake; everything else (the MCP client talking
    // to the local Fastify server) uses the real fetch.
    const realFetch = globalThis.fetch;
    vi.stubGlobal('fetch', (input: any, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      return url.hostname.endsWith('intuit.com') ? fake.fetch(input, init) : realFetch(input, init);
    });

    qbo = new QBOManager({ dbPath: ':memory:', encryptionKey: ENCRYPTION_KEY });
    await (qbo as any).tokenStore.storeConnection({
      clientName: CLIENT,
      realmId: REALM,
      accessToken: 'sandbox-access-token',
      refreshToken: 'sandbox-refresh-token',
      tokenExpiry: new Date(Date.now() + 60 * 60 * 1000),
      refreshExpiry: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
      scopes: ['com.intuit.quickbooks.accounting'],
    });

    app = Fastify();
    await registerMcpRoutes(app, qbo, MASTER_KEY);
    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address();
    const baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;

    mcp = new Client({ name: 'coa-hierarchy-e2e', version: '1.0.0' });
    await mcp.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${MASTER_KEY}` } },
    }));

    const call = async (name: string, args: Record<string, unknown>): Promise<string> => {
      const res: any = await mcp.callTool({ name, arguments: args });
      return (res.content ?? []).map((c: any) => c.text ?? '').join('\n');
    };
    outcome = await runCoaHierarchyScenario(call, { client: CLIENT, prefix: 'ZZT', numBase: 9900, log: (l) => transcript.push(l) });
  }, 120_000);

  afterAll(async () => {
    // The transcript is the "test output" a human reads: every tool call and its reply.
    process.stdout.write(`\n${'═'.repeat(78)}\nCOA HIERARCHY SCENARIO TRANSCRIPT (fake Intuit)\n${'═'.repeat(78)}\n${transcript.join('\n')}\n`);
    await mcp?.close().catch(() => {});
    await app?.close();
    qbo?.close();
    vi.unstubAllGlobals();
  });

  it('registers the new tools alongside the existing ones', async () => {
    const names = (await mcp.listTools()).tools.map((t) => t.name);
    for (const n of ['get_accounts', 'create_account', 'update_account', 'delete_account', 'batch_create_accounts', 'update_class', 'update_department']) {
      expect(names).toContain(n);
    }
  });

  it('runs the full scenario with no failed checks', () => {
    const failures = outcome.failed.map((f) => `${f.step}\n${f.detail}`).join('\n\n');
    expect(outcome.failed, failures).toEqual([]);
    expect(outcome.passed.length).toBeGreaterThan(40);
    expect(outcome.skipped).toEqual([]);
  });

  it('the chart holds the three-level tree with QBO-derived FQNs and parent links', () => {
    const accounts = [...fake.store.Account.values()];
    const veh = accounts.find((a) => a.AcctNum === '9910')!;
    const adVeh = accounts.find((a) => a.AcctNum === '9919')!;
    expect(adVeh.ParentRef).toEqual({ value: veh.Id });
    expect(adVeh.SubAccount).toBe(true);
    expect(adVeh.FullyQualifiedName).toBe('ZZT Fixed Assets (deleted):ZZT Vehicles (deleted):Accumulated Depreciation (deleted)');
    expect(accounts.filter((a) => a.Name.startsWith('Accumulated Depreciation'))).toHaveLength(2);
  });

  it('re-running the batch issued no writes (idempotency at the HTTP level)', () => {
    // Writes appear in the log in call order; find the two consecutive
    // batch loads (8 creates, then the identical re-run) by their query gaps.
    const posts = fake.log.filter((l) => l.method === 'POST' && l.path.startsWith('account'));
    const createdNames = posts.filter((l) => l.body && !l.body.Id).map((l) => l.body.Name);
    // 8 from the load + Trucks + L3/L4/L5 + the QBO-fault probes that reach Intuit (dup number, dup top-level name, top-level accum dep)
    expect(createdNames.filter((n) => n === 'ZZT Fixed Assets')).toHaveLength(1);
    expect(createdNames.filter((n) => n === 'Accumulated Depreciation')).toHaveLength(2);
  });

  it('every account the scenario created is now inactive (cleanup)', () => {
    const prefixed = [...fake.store.Account.values()].filter((a) => String(a.FullyQualifiedName).includes('ZZT'));
    expect(prefixed.length).toBeGreaterThanOrEqual(12);
    expect(prefixed.every((a) => a.Active === false)).toBe(true);
  });
});
