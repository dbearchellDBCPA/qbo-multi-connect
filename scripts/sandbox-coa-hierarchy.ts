#!/usr/bin/env tsx
// ─── Live sandbox acceptance run for the chart-of-accounts hierarchy tools ────
//
// Runs tests/support/coa-hierarchy-scenario.ts against a DEPLOYED qbo-multi-
// connect server over MCP: loads a prefixed three-level chart into the named
// company, verifies parent links and fully qualified names, re-runs the batch
// to prove idempotency, exercises every QBO rule the loader explains, then
// deactivates everything it created. Point it at a sandbox company only.
//
//   npm run sandbox:coa -- --url https://<host>/mcp --key <api key> --client "Company A" --confirm
//
// Options: --prefix ZZT (name prefix for every account it creates)
//          --num-base 9900 (account numbers used: base .. base+93)
//          --transcript path (also write the full transcript to a file)

import { writeFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { runCoaHierarchyScenario } from '../tests/support/coa-hierarchy-scenario.js';

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  return process.argv[i + 1] ?? fallback;
}

async function main(): Promise<void> {
  const url = arg('url', process.env.QBO_MCP_URL);
  const key = arg('key', process.env.QBO_API_KEY);
  const client = arg('client', process.env.QBO_CLIENT_NAME);
  const prefix = arg('prefix', 'ZZT')!;
  const numBase = Number(arg('num-base', '9900'));
  const transcriptPath = arg('transcript');
  if (!url || !key || !client) {
    console.error('Usage: npm run sandbox:coa -- --url https://<host>/mcp --key <api key> --client "<company>" --confirm');
    process.exit(2);
  }
  console.log(`Target: ${url}\nCompany: ${client}\nPrefix: ${prefix} | numbers ${numBase}..${numBase + 93}`);
  if (!process.argv.includes('--confirm')) {
    console.log('\nThis WRITES to the named company (creates prefixed accounts, classes and locations, then deactivates them).');
    console.log('Make sure it is a sandbox company, then re-run with --confirm.');
    process.exit(2);
  }

  const mcp = new Client({ name: 'sandbox-coa-hierarchy', version: '1.0.0' });
  await mcp.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { authorization: `Bearer ${key}` } } }));
  const call = async (name: string, args: Record<string, unknown>): Promise<string> => {
    const res: any = await mcp.callTool({ name, arguments: args });
    return (res.content ?? []).map((c: any) => c.text ?? '').join('\n');
  };

  const lines: string[] = [];
  const log = (line: string) => {
    lines.push(line);
    console.log(line);
  };
  const result = await runCoaHierarchyScenario(call, { client, prefix, numBase, log });
  if (transcriptPath) writeFileSync(transcriptPath, `${lines.join('\n')}\n`);
  await mcp.close();
  process.exit(result.failed.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
