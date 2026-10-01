#!/usr/bin/env tsx
// ─── Live SANDBOX acceptance run for the bulk-import tools ───────────────────
//
// Runs tests/support/bulk-import-scenario.ts (the spec's Testing steps 1–8)
// against a DEPLOYED qbo-multi-connect SANDBOX server over MCP, then deletes
// every transaction it imported with delete_imported_transactions. Names and
// items it creates are prefixed (QBO cannot delete names; deactivate them in
// the sandbox UI if you want them gone).
//
//   npm run sandbox:import -- --url https://<sandbox-host>/mcp --key <api key> \
//       --client "Sandbox Company_US_1" --accounts accounts.json --confirm
//
// Refuses to run unless the company name contains "sandbox" (override with
// --i-know-this-is-a-sandbox) and --confirm is given. NEVER point it at a
// production server or a real client's company.
//
// accounts.json maps the scenario's account slots to the sandbox chart, by
// number or (fully qualified) name, e.g.
//   { "bank": {"account_name": "Checking"}, "savings": {"account_name": "Savings"},
//     "card": {"account_name": "Mastercard"}, "ar": {"account_name": "Accounts Receivable (A/R)"},
//     "undeposited": {"account_name": "Undeposited Funds"},
//     "income1": {"account_name": "Services"}, "income2": {"account_name": "Sales of Product Income"},
//     "expense1": {"account_name": "Office Expenses"}, "expense2": {"account_name": "Rent or Lease"},
//     "subExpense": {"account_name": "Automobile:Fuel"} }
//
// Other options: --prefix ZZI  --month 2026-08  --closed-date YYYY-MM-DD
//   --vendor "<existing vendor>" --customer "<existing customer>" --class "<class>"
//   --bulk 400  --transcript path

import { readFileSync, writeFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { runBulkImportScenario, type ImportScenarioAccounts } from '../tests/support/bulk-import-scenario.js';

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  return process.argv[i + 1] ?? fallback;
}

async function main(): Promise<void> {
  const url = arg('url', process.env.QBO_SANDBOX_MCP_URL);
  const key = arg('key', process.env.QBO_SANDBOX_API_KEY);
  const client = arg('client', process.env.QBO_SANDBOX_CLIENT_NAME);
  const accountsPath = arg('accounts');
  if (!url || !key || !client || !accountsPath) {
    console.error('Usage: npm run sandbox:import -- --url https://<sandbox-host>/mcp --key <api key> --client "<sandbox company>" --accounts accounts.json --confirm');
    process.exit(2);
  }
  if (!/sandbox/i.test(client) && !process.argv.includes('--i-know-this-is-a-sandbox')) {
    console.error(`Refusing: "${client}" does not look like a sandbox company. Pass --i-know-this-is-a-sandbox if it really is one.`);
    process.exit(2);
  }
  const accounts = JSON.parse(readFileSync(accountsPath, 'utf8')) as ImportScenarioAccounts;
  const prefix = arg('prefix', 'ZZI')!;
  const month = arg('month', new Date().toISOString().slice(0, 7))!;
  console.log(`Target: ${url}\nCompany: ${client}\nPrefix: ${prefix} | month ${month}`);
  if (!process.argv.includes('--confirm')) {
    console.log('\nThis WRITES to the named company: prefixed names and items, then ~420 transactions that it deletes again.');
    console.log('Make sure it is a SANDBOX company on a SANDBOX server, then re-run with --confirm.');
    process.exit(2);
  }

  const mcp = new Client({ name: 'sandbox-import', version: '1.0.0' });
  await mcp.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { authorization: `Bearer ${key}` } } }));
  const call = async (name: string, args: Record<string, unknown>): Promise<string> => {
    const res: any = await mcp.callTool({ name, arguments: args });
    return (res.content ?? []).map((c: any) => c.text ?? '').join('\n');
  };
  const info = await call('get_company_info', { client_name: client });
  console.log(info.split('\n').slice(0, 6).join('\n'));

  const lines: string[] = [];
  const log = (line: string) => {
    lines.push(line);
    console.log(line);
  };
  const result = await runBulkImportScenario(call, {
    client,
    prefix,
    accounts,
    month,
    existingVendor: arg('vendor', 'Hicks Hardware')!,
    existingCustomer: arg('customer', 'Amy\'s Bird Sanctuary')!,
    className: arg('class', 'East')!,
    closedDate: arg('closed-date'),
    bulkCount: Number(arg('bulk', '400')),
    log,
  });
  log(`\n${result.passed.length} passed, ${result.failed.length} failed, ${result.skipped.length} skipped`);
  for (const s of result.skipped) log(`SKIPPED ${s.step}: ${s.reason}`);
  const transcriptPath = arg('transcript');
  if (transcriptPath) writeFileSync(transcriptPath, `${lines.join('\n')}\n`);
  await mcp.close();
  process.exit(result.failed.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
