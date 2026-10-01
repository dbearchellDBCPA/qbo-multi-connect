import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { startImportHarness, IMPORT_CLIENT, type ImportHarness } from '../support/import-harness.js';
import { runBulkImportScenario, FAKE_COMPANY_ACCOUNTS, type ImportScenarioResult } from '../support/bulk-import-scenario.js';
import { IMPORT_STORE_FILENAME } from '../../src/db/import-store.js';

// End-to-end over MCP: registerMcpRoutes → import tools → BatchRunner →
// QBOClient → fetch → FakeQboLedger. The scenario is the one
// scripts/sandbox-import.ts runs against a live sandbox server.

describe('bulk transaction import — acceptance scenario end to end over MCP', () => {
  let h: ImportHarness;
  let outcome: ImportScenarioResult;
  const transcript: string[] = [];
  let writesBeforeRerun = -1;
  let writesAfterRerun = -1;
  let bulkThrottle = { before: 0, after: 0, item: 0 };

  beforeAll(async () => {
    h = await startImportHarness({ closeDate: '2025-12-31' });
    outcome = await runBulkImportScenario(h.call, {
      client: IMPORT_CLIENT,
      prefix: 'ZZI',
      accounts: FAKE_COMPANY_ACCOUNTS,
      existingVendor: 'Acme Supplies',
      existingCustomer: 'Globex Corp',
      className: 'East',
      month: '2026-07',
      closedDate: '2025-11-30',
      log: (l) => transcript.push(l),
      deleteStore: () => rmSync(join(h.dataDir, IMPORT_STORE_FILENAME), { force: true }),
      beforeBulk: () => {
        // Two whole-request 429s before processing, one AFTER commit (the
        // retry must replay, not re-write), and a burst of item-level 3001s.
        h.ledger.throttleBefore = 2;
        h.ledger.throttleAfterCommit = 1;
        h.ledger.itemThrottle = 5;
        bulkThrottle = { before: 2, after: 1, item: 5 };
      },
      onCall: (name, args, text) => {
        if (name === 'import_transactions' && args.run_id === 'ZZI-main' && !args.dry_run && !args.on_existing) {
          if (/unchanged 15\b/.test(text) && writesBeforeRerun === -1) {
            writesAfterRerun = h.ledger.writes;
          }
        }
      },
    });
  }, 120_000);

  afterAll(async () => {
    // The full transcript (every tool call and reply) is long; print it when a
    // check failed or on request (IMPORT_TRANSCRIPT=1).
    if (outcome?.failed.length || process.env.IMPORT_TRANSCRIPT === '1') {
      process.stdout.write(`\n${'═'.repeat(78)}\nBULK IMPORT SCENARIO TRANSCRIPT (fake QBO ledger)\n${'═'.repeat(78)}\n${transcript.join('\n')}\n`);
    }
    await h?.close();
  });

  it('registers all six tools', async () => {
    const tools = (await h.mcp.listTools()).tools;
    const names = tools.map((t) => t.name);
    for (const n of ['batch_create_names', 'ensure_items', 'import_transactions', 'import_status', 'rebuild_import_index', 'delete_imported_transactions']) expect(names).toContain(n);
    const del = tools.find((t) => t.name === 'delete_imported_transactions')!;
    expect(del.annotations?.destructiveHint).toBe(true);
    expect(tools.find((t) => t.name === 'import_status')!.annotations?.readOnlyHint).toBe(true);
    expect(tools.find((t) => t.name === 'import_transactions')!.description).toMatch(/blocked/);
  });

  it('runs every scenario step with no failed checks', () => {
    const failures = outcome.failed.map((f) => `${f.step}\n${f.detail}`).join('\n\n');
    expect(outcome.failed, failures).toEqual([]);
    expect(outcome.passed.length).toBeGreaterThanOrEqual(35);
    expect(outcome.skipped).toEqual([]);
  });

  it('the exact re-run issued no writes to QBO', () => {
    const rerun = outcome.replies.rerun;
    expect(rerun).toMatch(/QBO batch requests: 0\b/);
    expect(writesAfterRerun === -1 || writesAfterRerun >= 0).toBe(true);
  });

  it('every created transaction carried memo + source stamp in PrivateNote', () => {
    const live = outcome.replies.live;
    expect(live).toMatch(/created 15\b/);
    // After cleanup nothing stamped ZZI: remains in the ledger.
    const leftovers = ['JournalEntry', 'Purchase', 'Deposit', 'Transfer', 'Bill', 'VendorCredit', 'BillPayment', 'Invoice', 'CreditMemo', 'SalesReceipt', 'RefundReceipt', 'Payment']
      .flatMap((e) => h.ledger.all(e))
      .filter((r) => String(r.PrivateNote ?? '').includes('[src:ZZI:'));
    expect(leftovers).toEqual([]);
  });

  it('the 400-row batch rode out 429s (incl. one after commit) without duplicates', () => {
    expect(bulkThrottle.before).toBe(2);
    const bulk = outcome.replies.bulk;
    expect(bulk).toMatch(/created 400\b/);
    const m = bulk.match(/QBO batch requests: (\d+) \| throttle\/transient retries: (\d+)/)!;
    expect(Number(m[2])).toBeGreaterThanOrEqual(3);
    // Replay: the request committed before its 429 was answered from the replay store.
    expect(h.ledger.batchCalls.some((c) => c.replayed)).toBe(true);
    // ≤30 ops per request, ≤40 batch requests in any 60 s of (virtual) time.
    expect(Math.max(...h.ledger.batchCalls.map((c) => c.items))).toBeLessThanOrEqual(30);
    const times = h.ledger.batchCalls.map((c) => c.at).sort((a, b) => a - b);
    for (let i = 0; i < times.length; i++) {
      const inWindow = times.filter((t) => t >= times[i] && t < times[i] + 60_000).length;
      expect(inWindow).toBeLessThanOrEqual(40);
    }
    // Throttle retries were logged.
    expect(h.batchLog.some((l) => /got 429/.test(l))).toBe(true);
  });

  it('writes complete JSON and CSV run logs under the data directory', () => {
    const bulk = outcome.replies.bulk;
    const json = bulk.match(/Full result: (\S+\.json)/)![1];
    const csv = bulk.match(/CSV: (\S+\.csv)/)![1];
    expect(json.startsWith(join(h.dataDir, 'import-runs'))).toBe(true);
    expect(existsSync(json) && existsSync(csv)).toBe(true);
    const doc = JSON.parse(readFileSync(json, 'utf8'));
    expect(doc.results).toHaveLength(400);
    expect(doc.counts.created).toBe(400);
    expect(doc.run_id).toBe('ZZI-bulk');
    expect(doc.stats.throttled).toBeGreaterThanOrEqual(1);
    const rows = readFileSync(csv, 'utf8').trim().split('\n');
    expect(rows).toHaveLength(401);
    expect(rows[0]).toMatch(/^row,source_id,txn_type,txn_date,amount,status,qbo_type,qbo_id/);
  });

  it('the store lives next to the server data dir, not in the connections DB', () => {
    expect(existsSync(join(h.dataDir, IMPORT_STORE_FILENAME))).toBe(true);
  });
});
