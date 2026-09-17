#!/usr/bin/env tsx
// ─── Live acceptance run for the sales-form prefill (SPEC §7) ────────────────
//
// Runs the §7 acceptance test of SPEC-create-invoice-prefill.md against a
// DEPLOYED qbo-multi-connect server over MCP:
//   1. reads the company's numbering + class settings and the customer record
//   2. create_invoice(customer, one line, 1.00) with prefill on
//   3. checks DocNumber = highest sales DocNumber + 1, line class, BillEmail,
//      BillEmailCc, CustomerMemo, SalesTermRef, EmailStatus, and that every
//      one of them is listed in `prefilled` with its source
//   4. deletes the invoice
//   5. repeats with prefill:false and checks the bare (pre-prefill) behavior,
//      then deletes that one too
//
//   npm run acceptance:prefill -- --url https://<host>/mcp --key <api key> \
//     --client "Ingram Entities" --customer 31 --item 73 --confirm
//
// Options: --amount 1.00            line amount
//          --expect-class <id>      expected line ClassRef (default: whatever the customer's last invoice has)
//          --expect-cc <email>      expected BillEmailCc (default: whatever the customer's recent invoices have)
//          --expect-term <id>       expected SalesTermRef (default: customer record → last invoice → company default)
//          --memo-contains <text>   expected substring of CustomerMemo (default: the company default message)
//          --keep                   do not delete the invoices it creates
//          --transcript <path>      also write the full transcript to a file
//
// It WRITES to the named company (creates two $1 invoices, then deletes them).

import { writeFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { nextDocNumberFrom, SALES_DOC_SEQUENCE } from '../src/server/prefill.js';

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  return process.argv[i + 1] ?? fallback;
}

function parseReport(text: string): any | null {
  const at = text.indexOf('\n\n{');
  if (at === -1) return null;
  try {
    return JSON.parse(text.slice(at + 2));
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const url = arg('url', process.env.QBO_MCP_URL);
  const key = arg('key', process.env.QBO_API_KEY);
  const client = arg('client', process.env.QBO_CLIENT_NAME);
  const customerId = arg('customer', '31')!;
  const itemId = arg('item', '73')!;
  const amount = Number(arg('amount', '1.00'));
  const keep = process.argv.includes('--keep');
  const transcriptPath = arg('transcript');
  if (!url || !key || !client) {
    console.error('Usage: npm run acceptance:prefill -- --url https://<host>/mcp --key <api key> --client "<company>" --customer 31 --item 73 --confirm');
    process.exit(2);
  }
  console.log(`Target: ${url}\nCompany: ${client}\nCustomer: ${customerId} | Item: ${itemId} | Amount: ${amount.toFixed(2)}`);
  if (!process.argv.includes('--confirm')) {
    console.log('\nThis WRITES to the named company (creates two invoices, then deletes them). Re-run with --confirm.');
    process.exit(2);
  }

  const lines: string[] = [];
  const log = (line: string) => {
    lines.push(line);
    console.log(line);
  };
  const passed: string[] = [];
  const failed: { step: string; detail: string }[] = [];
  const check = (step: string, ok: boolean, detail: string) => {
    if (ok) passed.push(step);
    else failed.push({ step, detail });
    log(`${ok ? 'PASS' : 'FAIL'}  ${step}${ok ? '' : `\n      ${detail.split('\n').join('\n      ')}`}`);
  };

  const mcp = new Client({ name: 'acceptance-prefill', version: '1.0.0' });
  await mcp.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { authorization: `Bearer ${key}` } } }));
  const call = async (name: string, args: Record<string, unknown>): Promise<string> => {
    const res: any = await mcp.callTool({ name, arguments: { client_name: client, ...args } });
    const text = (res.content ?? []).map((c: any) => c.text ?? '').join('\n');
    log(`\n▶ ${name} ${JSON.stringify(args)}\n${text.split('\n').map((l: string) => `  ${l}`).join('\n')}\n`);
    return text;
  };
  const query = async (q: string): Promise<any> => {
    const text = await call('query_transactions', { query: q });
    try {
      return JSON.parse(text)?.QueryResponse ?? {};
    } catch {
      return {};
    }
  };

  // ── 1. Settings and baseline ──────────────────────────────────────────────
  const prefs = (await query('SELECT * FROM Preferences')).Preferences?.[0] ?? {};
  const customTxnNumbers = prefs.SalesFormsPrefs?.CustomTxnNumbers === true;
  const perLine = prefs.AccountingInfoPrefs?.ClassTrackingPerTxnLine === true;
  const defaultMessage: string = prefs.SalesFormsPrefs?.DefaultCustomerMessage ?? '';
  log(`Settings: CustomTxnNumbers=${customTxnNumbers} ClassTrackingPerTxnLine=${perLine} DefaultTerms=${prefs.SalesFormsPrefs?.DefaultTerms?.value ?? 'none'}`);

  const customer = (await query(`SELECT * FROM Customer WHERE Id = '${customerId}'`)).Customer?.[0];
  check('customer exists', Boolean(customer), `no customer ${customerId}`);
  const customerEmail: string | undefined = customer?.PrimaryEmailAddr?.Address;

  const recent = (await query(`SELECT * FROM Invoice WHERE CustomerRef = '${customerId}' ORDERBY TxnDate DESC, Id DESC MAXRESULTS 5`)).Invoice ?? [];
  const firstClass = (inv: any) => inv?.Line?.find((l: any) => l?.SalesItemLineDetail?.ClassRef?.value)?.SalesItemLineDetail.ClassRef;
  const priorClass = recent.map(firstClass).find(Boolean);
  const priorCc = recent.map((i: any) => i?.BillEmailCc?.Address).find(Boolean);
  const priorTerm = recent.map((i: any) => i?.SalesTermRef?.value).find(Boolean);
  const expectClass = arg('expect-class', priorClass?.value);
  const expectCc = arg('expect-cc', priorCc);
  const expectTerm = arg('expect-term', customer?.SalesTermRef?.value ?? priorTerm ?? prefs.SalesFormsPrefs?.DefaultTerms?.value);
  const memoContains = arg('memo-contains', defaultMessage.split('\n')[0] || undefined);

  const docRows: { docNumber: unknown; entity: string }[] = [];
  for (const entity of SALES_DOC_SEQUENCE) {
    const rows = (await query(`SELECT DocNumber FROM ${entity} ORDERBY MetaData.CreateTime DESC MAXRESULTS 100`))[entity] ?? [];
    for (const r of rows) docRows.push({ docNumber: r.DocNumber, entity });
  }
  const expectedNext = nextDocNumberFrom(docRows);
  log(`Expected next DocNumber: ${expectedNext ? `${expectedNext.max} (${expectedNext.maxEntity}) → ${expectedNext.value}` : 'n/a'}`);

  const created: string[] = [];
  try {
    // ── 2–3. create_invoice with prefill on ───────────────────────────────
    const text = await call('create_invoice', { customer_id: customerId, lines: [{ item_id: itemId, amount }] });
    const report = parseReport(text);
    check('create_invoice succeeded', /created successfully/.test(text), text);
    check('response carries the prefilled report', Boolean(report?.prefilled), text);
    const id = report?.id ?? text.match(/\bID: (\d+)/)?.[1];
    if (id) created.push(id);

    const inv = id ? JSON.parse(await call('get_invoice', { invoice_id: id })) : null;
    if (customTxnNumbers) {
      check('DocNumber = highest existing sales DocNumber + 1', Boolean(expectedNext) && inv?.doc_number === expectedNext!.value, `expected ${expectedNext?.value}, got ${inv?.doc_number}`);
      check('prefilled lists DocNumber as computed', /^computed/.test(report?.prefilled?.DocNumber ?? ''), JSON.stringify(report?.prefilled?.DocNumber));
    } else {
      check('DocNumber assigned by QBO (CustomTxnNumbers off)', Boolean(inv?.doc_number), `got ${inv?.doc_number}`);
    }
    if (expectClass) {
      check(`line ClassRef = ${expectClass}`, inv?.lines?.[0]?.class_id === expectClass, `got ${inv?.lines?.[0]?.class_id}`);
      check('prefilled lists Line.ClassRef with its source', /→/.test(report?.prefilled?.['Line.ClassRef'] ?? ''), JSON.stringify(report?.prefilled?.['Line.ClassRef']));
    }
    if (customerEmail) {
      check("BillEmail = customer's email", inv?.bill_email === customerEmail, `expected ${customerEmail}, got ${inv?.bill_email}`);
      check('prefilled lists BillEmail', Boolean(report?.prefilled?.BillEmail), JSON.stringify(report?.prefilled));
    }
    if (expectCc) {
      check(`BillEmailCc = ${expectCc}`, inv?.bill_email_cc === expectCc, `got ${inv?.bill_email_cc}`);
      check('prefilled lists BillEmailCc', Boolean(report?.prefilled?.BillEmailCc), JSON.stringify(report?.prefilled));
    }
    if (memoContains) {
      check(`CustomerMemo contains "${memoContains}"`, String(inv?.customer_memo ?? '').includes(memoContains), `got ${JSON.stringify(inv?.customer_memo)}`);
      check('prefilled lists CustomerMemo', Boolean(report?.prefilled?.CustomerMemo), JSON.stringify(report?.prefilled));
    }
    if (expectTerm) {
      check(`SalesTermRef = ${expectTerm}`, inv?.sales_term_id === expectTerm, `got ${inv?.sales_term_id}`);
      check('prefilled lists SalesTermRef', Boolean(report?.prefilled?.SalesTermRef), JSON.stringify(report?.prefilled));
    }
    check('EmailStatus = NeedToSend', inv?.email_status === 'NeedToSend', `got ${inv?.email_status}`);
    check('prefilled lists EmailStatus', /NeedToSend/.test(report?.prefilled?.EmailStatus ?? ''), JSON.stringify(report?.prefilled?.EmailStatus));
    check('no warnings', Array.isArray(report?.warnings) && report.warnings.length === 0, JSON.stringify(report?.warnings));

    // ── 5. prefill:false ──────────────────────────────────────────────────
    const bareText = await call('create_invoice', { customer_id: customerId, prefill: false, lines: [{ item_id: itemId, amount }] });
    check('bare create_invoice succeeded', /created successfully/.test(bareText), bareText);
    check('bare response has no prefilled report', parseReport(bareText) === null, bareText);
    const bareId = bareText.match(/\bID: (\d+)/)?.[1];
    if (bareId) created.push(bareId);
    const bare = bareId ? JSON.parse(await call('get_invoice', { invoice_id: bareId })) : null;
    if (customTxnNumbers) check('bare invoice is unnumbered (today\'s behavior)', !bare?.doc_number, `got ${bare?.doc_number}`);
    check('bare invoice has no line class', !bare?.lines?.[0]?.class_id, `got ${bare?.lines?.[0]?.class_id}`);
    check('bare invoice has no BillEmail', !bare?.bill_email, `got ${bare?.bill_email}`);
    check('bare invoice has no CustomerMemo', !bare?.customer_memo, `got ${bare?.customer_memo}`);
    check('bare invoice EmailStatus is not NeedToSend', bare?.email_status !== 'NeedToSend', `got ${bare?.email_status}`);
  } finally {
    // ── 4. cleanup ────────────────────────────────────────────────────────
    if (!keep) {
      for (const id of created) {
        const t = await call('delete_invoice', { invoice_id: id });
        check(`deleted test invoice ${id}`, /deleted successfully/.test(t), t);
      }
    } else if (created.length) {
      log(`--keep: leaving invoices ${created.join(', ')} in place`);
    }
  }

  log(`\nRESULT: ${passed.length} passed, ${failed.length} failed`);
  if (transcriptPath) writeFileSync(transcriptPath, `${lines.join('\n')}\n`);
  await mcp.close();
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
