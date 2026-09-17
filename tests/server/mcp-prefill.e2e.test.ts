import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { QBOManager } from '../../src/index.js';
import { registerMcpRoutes } from '../../src/server/mcp.js';
import { clearPrefillCaches } from '../../src/server/prefill.js';
import { FakeQboForms, ingramLikePreferences } from '../support/fake-qbo-forms.js';

// ─────────────────────────────────────────────────────────────────────────────
// End to end: the real MCP server (registerMcpRoutes → tools → prefill →
// TransactionsAPI → QBOClient → fetch) driven by the real MCP client, with
// Intuit replaced by FakeQboForms seeded to look like Ingram Entities on
// 2026-09-17. The checks are the acceptance test of
// SPEC-create-invoice-prefill.md §7, run against the fake instead of realm
// 9130347766481406; scripts/acceptance-prefill.ts runs the same checks live.
// ─────────────────────────────────────────────────────────────────────────────

const ENCRYPTION_KEY = 'a'.repeat(64);
const MASTER_KEY = 'master-key-for-tests';
const REALM = '9130347766481406';
const CLIENT = 'Ingram Entities';
const CLASS_7000 = { value: '800000000001204542', name: '7000 - DCM Ingram Center' };
const ACH = 'Please Pay Via ACH with payment instructions Below:\n\nPeopleSouth Bank\n1302 Gray Hwy\nMacon, Ga 31211';
const DG_EMAIL = 'kwhitehe@dollargeneral.com, cbane@dollargeneral.com, mmohary@dollargeneral.com';

function salesLine(amount: number, itemId: string, extra: any = {}): any {
  return { Amount: amount, DetailType: 'SalesItemLineDetail', SalesItemLineDetail: { Qty: 1, UnitPrice: amount, ItemRef: { value: itemId }, ...extra } };
}

function seedIngram(fake: FakeQboForms): void {
  fake.seed('Customer', {
    Id: '31', DisplayName: 'Dollar General (C)', Taxable: false,
    PrimaryEmailAddr: { Address: DG_EMAIL },
    BillAddr: { Id: '7', Line1: 'Ingram Center I, Space 8-10', City: 'Forsyth', Country: 'USA', CountrySubDivisionCode: 'GA', PostalCode: '31029' },
    ShipAddr: { Id: '10' },
  });
  fake.seed('Customer', { Id: '99', DisplayName: 'Brand New Tenant', PrimaryEmailAddr: { Address: 'new@tenant.example' } });
  fake.seed('Vendor', {
    Id: '501', DisplayName: 'Acme Supply', TermRef: { value: '3', name: 'Net 30' },
    BillAddr: { Id: '77', Line1: '9 Vendor Way', City: 'Macon', CountrySubDivisionCode: 'GA', PostalCode: '31201' },
    PrimaryEmailAddr: { Address: 'ar@acme.example' },
  });
  // Dollar General's most recent invoice: created through the API, then fixed by hand in the UI (no cc / message).
  fake.seed('Invoice', {
    Id: '126405', DocNumber: '2025_TIM', TxnDate: '2026-09-17', CustomerRef: { value: '31', name: 'Dollar General (C)' },
    Line: [salesLine(7015.19, '73', { ClassRef: CLASS_7000, TaxCodeRef: { value: 'NON' } }), { Amount: 7015.19, DetailType: 'SubTotalLineDetail' }],
    BillAddr: { Id: '1282', Line1: 'Dollar General', Line2: 'Ingram Center I, Space 8-10' },
    SalesTermRef: { value: '3', name: 'Net 30' }, PrintStatus: 'NeedToPrint', EmailStatus: 'EmailSent', BillEmail: { Address: DG_EMAIL },
    TotalAmt: 7015.19, Balance: 7015.19,
  });
  // The monthly rent invoice before it, UI-created with everything on it.
  fake.seed('Invoice', {
    Id: '126233', DocNumber: '5735', TxnDate: '2026-09-01', CustomerRef: { value: '31', name: 'Dollar General (C)' },
    Line: [salesLine(3200, '70', { ClassRef: CLASS_7000 })],
    DepartmentRef: { value: '1', name: 'Ingram Center' }, SalesTermRef: { value: '3', name: 'Net 30' },
    BillEmail: { Address: DG_EMAIL }, BillEmailCc: { Address: 'obingram@ingramentities.com' }, CustomerMemo: { value: ACH },
    PrintStatus: 'NotSet', EmailStatus: 'EmailSent', TotalAmt: 3200, Balance: 0,
  });
  // The highest sales number in the company belongs to another customer.
  fake.seed('Invoice', { Id: '126386', DocNumber: '5812', TxnDate: '2026-09-10', CustomerRef: { value: '40', name: 'Other Tenant' }, Line: [salesLine(500, '70', { ClassRef: CLASS_7000 })], TotalAmt: 500, Balance: 500 });
  fake.seed('SalesReceipt', { Id: '119725', DocNumber: '4610', TxnDate: '2026-08-20', CustomerRef: { value: '31', name: 'Dollar General (C)' }, Line: [salesLine(50, '70', { ClassRef: CLASS_7000 })], DepositToAccountRef: { value: '35', name: 'Checking' }, PaymentMethodRef: { value: '2', name: 'Check' }, TotalAmt: 50 });
  fake.seed('CreditMemo', { Id: '109692', DocNumber: '2611', TxnDate: '2025-01-05', CustomerRef: { value: '12', name: 'Someone Else' }, Line: [salesLine(10, '70')], TotalAmt: 10 });
  fake.seed('Bill', {
    Id: '12728', DocNumber: 'A-1001', TxnDate: '2026-08-15', VendorRef: { value: '501', name: 'Acme Supply' },
    DepartmentRef: { value: '1', name: 'Ingram Center' }, APAccountRef: { value: '33', name: 'Accounts Payable (A/P)' },
    Line: [{ Amount: 100, DetailType: 'AccountBasedExpenseLineDetail', AccountBasedExpenseLineDetail: { AccountRef: { value: '62', name: 'Supplies' }, ClassRef: { value: 'C1', name: 'Class One' } } }],
    TotalAmt: 100, Balance: 100,
  });
}

/** The tool text is "summary\n\n{json}" — split it. */
function parseReport(text: string): { summary: string; report: any } {
  const at = text.indexOf('\n\n{');
  if (at === -1) return { summary: text, report: null };
  return { summary: text.slice(0, at), report: JSON.parse(text.slice(at + 2)) };
}

describe('sales-form prefill — end to end over MCP', () => {
  let app: FastifyInstance;
  let qbo: QBOManager;
  let mcp: Client;
  let fake: FakeQboForms;

  const call = async (name: string, args: Record<string, unknown>): Promise<string> => {
    const res: any = await mcp.callTool({ name, arguments: { client_name: CLIENT, ...args } });
    return (res.content ?? []).map((c: any) => c.text ?? '').join('\n');
  };
  const lastPost = (path: string) => {
    const posts = fake.posts.filter((p) => p.path === path);
    return posts[posts.length - 1]?.body;
  };

  beforeAll(async () => {
    fake = new FakeQboForms(REALM, ingramLikePreferences());
    seedIngram(fake);
    const realFetch = globalThis.fetch;
    vi.stubGlobal('fetch', (input: any, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      return url.hostname.endsWith('intuit.com') ? fake.fetch(input, init) : realFetch(input, init);
    });

    qbo = new QBOManager({ dbPath: ':memory:', encryptionKey: ENCRYPTION_KEY });
    await (qbo as any).tokenStore.storeConnection({
      clientName: CLIENT,
      realmId: REALM,
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      tokenExpiry: new Date(Date.now() + 60 * 60 * 1000),
      refreshExpiry: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
      scopes: ['com.intuit.quickbooks.accounting'],
    });

    app = Fastify();
    await registerMcpRoutes(app, qbo, MASTER_KEY);
    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address();
    const baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
    mcp = new Client({ name: 'prefill-e2e', version: '1.0.0' });
    await mcp.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${MASTER_KEY}` } },
    }));
  }, 60_000);

  afterAll(async () => {
    await mcp?.close().catch(() => {});
    await app?.close();
    qbo?.close();
    vi.unstubAllGlobals();
  });

  beforeEach(() => clearPrefillCaches());

  it('lists the new parameters on every create tool and class on update lines (schemas regenerate from zod)', async () => {
    const tools = (await mcp.listTools()).tools;
    const schema = (name: string): any => tools.find((t) => t.name === name)!.inputSchema;
    for (const name of ['create_invoice', 'create_estimate', 'create_credit_memo', 'create_sales_receipt']) {
      const props = schema(name).properties;
      for (const p of ['prefill', 'doc_number', 'class_id', 'bill_email', 'bill_email_cc', 'bill_email_bcc', 'customer_memo', 'email_status', 'bill_addr', 'ship_addr']) {
        expect(Object.keys(props), `${name}.${p}`).toContain(p);
      }
      expect(props.prefill.default).toBe(true);
      expect(props.email_status.enum).toEqual(['NotSet', 'NeedToSend', 'EmailSent']);
      expect(Object.keys(props.lines.items.properties)).toEqual(expect.arrayContaining(['class_id', 'tax_code_id']));
    }
    for (const name of ['create_bill', 'create_purchase_order']) {
      const props = schema(name).properties;
      expect(Object.keys(props)).toEqual(expect.arrayContaining(['prefill', 'doc_number', 'class_id']));
      expect(Object.keys(props.lines.items.properties)).toContain('class_id');
    }
    expect(Object.keys(schema('create_purchase_order').properties)).toEqual(expect.arrayContaining(['email_status', 'po_email']));
    expect(Object.keys(schema('create_bill').properties)).not.toContain('email_status');
    const upd = schema('update_invoice').properties;
    expect(Object.keys(upd)).toEqual(expect.arrayContaining(['class_id', 'doc_number', 'bill_email', 'bill_email_cc', 'customer_memo', 'email_status']));
    expect(Object.keys(upd.lines.items.properties)).toEqual(expect.arrayContaining(['class_id', 'tax_code_id']));
    for (const name of ['update_estimate', 'update_credit_memo', 'update_sales_receipt']) {
      expect(Object.keys(schema(name).properties.lines.items.properties), name).toContain('class_id');
    }
  });

  it('§7: create_invoice(customer 31, item 73, 1.00) with defaults comes out like a UI-created invoice', async () => {
    const text = await call('create_invoice', { customer_id: '31', lines: [{ item_id: '73', amount: 1.0 }] });
    const { summary, report } = parseReport(text);
    expect(summary).toMatch(/^Invoice #5813 created successfully\.\nID: \d+ \| SyncToken: 0 \| Customer: Dollar General \(C\) \| Total: \$1\.00 \| Balance: \$1\.00$/);

    const body = lastPost('invoice');
    expect(body.DocNumber).toBe('5813'); // max(5812 invoice, 4610 SR, 2611 CM) + 1
    expect(body.Line).toHaveLength(1);
    expect(body.Line[0].SalesItemLineDetail.ClassRef).toEqual(CLASS_7000);
    expect(body.ClassRef).toBeUndefined(); // per-line company: no header ClassRef
    expect(body.BillEmail).toEqual({ Address: DG_EMAIL });
    expect(body.BillEmailCc).toEqual({ Address: 'obingram@ingramentities.com' });
    expect(body.CustomerMemo).toEqual({ value: ACH });
    expect(body.SalesTermRef).toEqual({ value: '3', name: 'Net 30' });
    expect(body.EmailStatus).toBe('NeedToSend');
    expect(body.PrintStatus).toBe('NeedToPrint');
    expect(body.DepartmentRef).toEqual({ value: '1', name: 'Ingram Center' });
    expect(body.BillAddr).toEqual({ Line1: 'Ingram Center I, Space 8-10', City: 'Forsyth', Country: 'USA', CountrySubDivisionCode: 'GA', PostalCode: '31029' });
    expect(body.ShipAddr).toBeUndefined(); // customer's is an {Id} shell and no prior invoice carries one
    expect(body.Id).toBeUndefined();
    expect(body.TxnDate).toBeUndefined();

    expect(report).toMatchObject({
      id: expect.any(String),
      doc_number: '5813',
      total: 1,
      balance: 1,
      customer: 'Dollar General (C)',
      prefilled: {
        DocNumber: 'computed (CustomTxnNumbers on): 5812 → 5813',
        'Line.ClassRef': 'from invoice #2025_TIM → 7000 - DCM Ingram Center',
        BillEmail: `from customer → ${DG_EMAIL}`,
        BillEmailCc: 'from invoice #5735 → obingram@ingramentities.com',
        CustomerMemo: expect.stringMatching(/^from invoice #5735 → Please Pay Via ACH/),
        SalesTermRef: 'from invoice #2025_TIM → Net 30',
        EmailStatus: 'default → NeedToSend',
      },
      warnings: [],
    });
  });

  it('the next invoice continues the sequence (the scan sees the one just created)', async () => {
    await call('create_invoice', { customer_id: '31', lines: [{ item_id: '73', amount: 2.0 }] });
    expect(lastPost('invoice').DocNumber).toBe('5814');
  });

  it('retries a computed number that QBO reports as taken (6140)', async () => {
    fake.rejectDocNumberOnce.add('5815');
    const before = fake.posts.filter((p) => p.path === 'invoice').length;
    const { summary, report } = parseReport(await call('create_invoice', { customer_id: '31', lines: [{ item_id: '73', amount: 3.0 }] }));
    expect(summary).toMatch(/^Invoice #5816 created successfully/);
    expect(fake.posts.filter((p) => p.path === 'invoice').length - before).toBe(2);
    expect(report.prefilled.DocNumber).toBe('computed (CustomTxnNumbers on): 5814 → 5815; 5815 was already taken → retried with 5816');
  });

  it('§7: prefill=false sends exactly the bare payload of before', async () => {
    const text = await call('create_invoice', { customer_id: '31', prefill: false, lines: [{ item_id: '73', amount: 1.0 }] });
    expect(text).toMatch(/^Invoice #\d+ created successfully\.\nID: \d+ \| SyncToken: 0 \| Customer: Dollar General \(C\) \| Total: \$1\.00 \| Balance: \$1\.00$/);
    expect(text).not.toContain('prefilled');
    expect(lastPost('invoice')).toEqual({
      CustomerRef: { value: '31' },
      Line: [{ Amount: 1, DetailType: 'SalesItemLineDetail', SalesItemLineDetail: { Qty: 1, UnitPrice: 1, ItemRef: { value: '73' } } }],
    });
    // with custom numbers on, QBO leaves it unnumbered — today's behavior
    expect(text).toMatch(/^Invoice #2\d{5} created/);
  });

  it('explicit arguments win and are reported as such; class_id lands on lines only', async () => {
    const { report } = parseReport(await call('create_invoice', {
      customer_id: '31',
      txn_date: '2020-01-01', // back-dated so later tests still see the classed rent invoices as "most recent"
      doc_number: 'TIM-2026',
      class_id: 'C-explicit',
      bill_email: 'ap@dollargeneral.com',
      bill_email_cc: 'cc@dollargeneral.com',
      customer_memo: 'Thank you',
      email_status: 'NotSet',
      sales_term_id: '6',
      lines: [{ item_id: '73', amount: 1.0 }, { item_id: '74', amount: 2.0, class_id: 'C-line' }],
    }));
    const body = lastPost('invoice');
    expect(body.DocNumber).toBe('TIM-2026');
    expect(body.Line[0].SalesItemLineDetail.ClassRef).toEqual({ value: 'C-explicit' });
    expect(body.Line[1].SalesItemLineDetail.ClassRef).toEqual({ value: 'C-line' });
    expect(body.ClassRef).toBeUndefined();
    expect(body.BillEmail).toEqual({ Address: 'ap@dollargeneral.com' });
    expect(body.BillEmailCc).toEqual({ Address: 'cc@dollargeneral.com' });
    expect(body.CustomerMemo).toEqual({ value: 'Thank you' });
    expect(body.EmailStatus).toBe('NotSet');
    expect(body.SalesTermRef).toEqual({ value: '6' });
    expect(report.prefilled.DocNumber).toBe('argument → TIM-2026');
    expect(report.prefilled['Line.ClassRef']).toBe('argument → C-explicit');
    expect(report.prefilled.EmailStatus).toBe('argument → NotSet');
    expect(report.prefilled.SalesTermRef).toBe('argument → 6');
  });

  it('warns about a missing class for a customer with no prior invoice in a class-tracked company', async () => {
    const { report } = parseReport(await call('create_invoice', { customer_id: '99', lines: [{ item_id: '73', amount: 1.0 }] }));
    expect(lastPost('invoice').Line[0].SalesItemLineDetail.ClassRef).toBeUndefined();
    expect(report.warnings).toContainEqual(expect.stringMatching(/^no class set — company uses class tracking and there is no prior invoice for this customer/));
    expect(report.prefilled.BillEmail).toBe('from customer → new@tenant.example');
    expect(report.prefilled.CustomerMemo).toMatch(/^from Preferences \(DefaultCustomerMessage\)/);
    expect(report.prefilled.SalesTermRef).toBe('from Preferences (DefaultTerms) → 6');
  });

  it('create_estimate shares the sales sequence and falls back to the customer\'s invoices', async () => {
    const { summary, report } = parseReport(await call('create_estimate', { customer_id: '31', lines: [{ item_id: '73', amount: 10 }] }));
    expect(summary).toMatch(/^Estimate #\d{4} created\./);
    const body = lastPost('estimate');
    expect(Number(body.DocNumber)).toBeGreaterThan(5816);
    expect(body.Line[0].SalesItemLineDetail.ClassRef).toEqual(CLASS_7000);
    expect(body.BillEmailCc).toEqual({ Address: 'obingram@ingramentities.com' });
    expect(body.EmailStatus).toBe('NeedToSend');
    expect(report.prefilled['Line.ClassRef']).toMatch(/^from invoice #/);
  });

  it('create_credit_memo shares the sales sequence too', async () => {
    const { summary } = parseReport(await call('create_credit_memo', { customer_id: '31', lines: [{ item_id: '73', amount: 5 }] }));
    expect(summary).toMatch(/^Credit Memo #\d{4} created\./);
    const body = lastPost('creditmemo');
    expect(body.Line[0].SalesItemLineDetail.ClassRef).toEqual(CLASS_7000);
    expect(body.CustomerMemo).toEqual({ value: ACH });
  });

  it('create_sales_receipt copies deposit account and payment method from the last sales receipt', async () => {
    const { report } = parseReport(await call('create_sales_receipt', { customer_id: '31', lines: [{ item_id: '73', amount: 5 }] }));
    const body = lastPost('salesreceipt');
    expect(body.DepositToAccountRef).toEqual({ value: '35', name: 'Checking' });
    expect(body.PaymentMethodRef).toEqual({ value: '2', name: 'Check' });
    expect(body.Line[0].SalesItemLineDetail.ClassRef).toEqual(CLASS_7000);
    expect(report.prefilled.DepositToAccountRef).toBe('from sales receipt #4610 → Checking');
    // The customer has a prior sales receipt, so that is the source — invoices are the fallback only when there is none.
    expect(report.prefilled['Line.ClassRef']).toBe('from sales receipt #4610 → 7000 - DCM Ingram Center');
    expect(report.prefilled.BillEmailCc).toBeUndefined();
  });

  it('create_bill fills the vendor\'s terms, AP account, class and expense account, and never numbers the bill', async () => {
    const { summary, report } = parseReport(await call('create_bill', { vendor_id: '501', lines: [{ amount: 42 }] }));
    expect(summary).toMatch(/^Bill #\d+ created successfully\./);
    const body = lastPost('bill');
    expect(body.DocNumber).toBeUndefined();
    expect(body.EmailStatus).toBeUndefined();
    expect(body.SalesTermRef).toEqual({ value: '3', name: 'Net 30' });
    expect(body.APAccountRef).toEqual({ value: '33', name: 'Accounts Payable (A/P)' });
    expect(body.DepartmentRef).toEqual({ value: '1', name: 'Ingram Center' });
    expect(body.VendorAddr).toEqual({ Line1: '9 Vendor Way', City: 'Macon', CountrySubDivisionCode: 'GA', PostalCode: '31201' });
    expect(body.Line[0].AccountBasedExpenseLineDetail.AccountRef).toEqual({ value: '62', name: 'Supplies' });
    expect(body.Line[0].AccountBasedExpenseLineDetail.ClassRef).toEqual({ value: 'C1', name: 'Class One' });
    expect(report.prefilled).toMatchObject({
      SalesTermRef: 'from vendor → Net 30',
      'Line.AccountRef': 'from bill #A-1001 → Supplies',
      'Line.ClassRef': 'from bill #A-1001 → Class One',
    });
    expect(report.prefilled.DocNumber).toBeUndefined();
    expect(report.warnings).toEqual([]);
  });

  it('create_purchase_order leaves numbering to QBO when custom PO numbers are off', async () => {
    const { report } = parseReport(await call('create_purchase_order', { vendor_id: '501', lines: [{ account_id: '62', amount: 42 }] }));
    const body = lastPost('purchaseorder');
    expect(body.DocNumber).toBeUndefined();
    expect(body.POEmail).toEqual({ Address: 'ar@acme.example' });
    expect(body.EmailStatus).toBe('NeedToSend');
    expect(body.SalesTermRef).toEqual({ value: '3', name: 'Net 30' });
    expect(report.prefilled.DocNumber).toMatch(/^omitted \(purchase-order custom numbers off/);
    expect(report.prefilled.POEmail).toBe('from vendor → ar@acme.example');
  });

  it('update_invoice with only lines keeps header fields and the class the lines shared', async () => {
    const text = await call('update_invoice', { invoice_id: '126233', lines: [{ item_id: '70', amount: 3300, description: 'October rent' }] });
    expect(text).toMatch(/^Invoice #5735 updated\./);
    expect(text).toContain('Line class carried over from the existing lines: 7000 - DCM Ingram Center.');
    const body = lastPost('invoice');
    expect(body.Id).toBe('126233');
    expect(body.Line).toEqual([{ Amount: 3300, DetailType: 'SalesItemLineDetail', Description: 'October rent', SalesItemLineDetail: { Qty: 1, UnitPrice: 3300, ItemRef: { value: '70' }, ClassRef: { value: CLASS_7000.value } } }]);
    expect(body.BillEmailCc).toEqual({ Address: 'obingram@ingramentities.com' });
    expect(body.CustomerMemo).toEqual({ value: ACH });
    expect(body.DocNumber).toBe('5735');
    expect(body.EmailStatus).toBe('EmailSent');
  });

  it('update_invoice with class_id alone re-classes the existing lines in place and can set the header fields', async () => {
    const text = await call('update_invoice', { invoice_id: '126405', class_id: 'C-new', bill_email_cc: 'obingram@ingramentities.com', customer_memo: ACH, email_status: 'NeedToSend' });
    expect(text).toContain('Class C-new applied to 1 existing line(s).');
    const body = lastPost('invoice');
    expect(body.Line[0].Id).toBe('1');
    expect(body.Line[0].SalesItemLineDetail.ClassRef).toEqual({ value: 'C-new' });
    expect(body.Line[1].DetailType).toBe('SubTotalLineDetail');
    expect(body.Line[1].Id).toBe('2');
    expect(body.BillEmailCc).toEqual({ Address: 'obingram@ingramentities.com' });
    expect(body.CustomerMemo).toEqual({ value: ACH });
    expect(body.EmailStatus).toBe('NeedToSend');
    expect(body.BillEmail).toEqual({ Address: DG_EMAIL }); // untouched
  });

  it('get_invoice → update_invoice round-trips class, tax code and the header fields', async () => {
    const got = JSON.parse(await call('get_invoice', { invoice_id: '126405' }));
    expect(got).toMatchObject({ doc_number: '2025_TIM', bill_email: DG_EMAIL, bill_email_cc: 'obingram@ingramentities.com', email_status: 'NeedToSend' });
    expect(got.lines[0]).toMatchObject({ item_id: '73', class_id: 'C-new', tax_code_id: 'NON' });
    got.lines[0].amount = 7100;
    await call('update_invoice', { invoice_id: '126405', lines: got.lines });
    const body = lastPost('invoice');
    expect(body.Line[0].SalesItemLineDetail.ClassRef).toEqual({ value: 'C-new' });
    expect(body.Line[0].SalesItemLineDetail.TaxCodeRef).toEqual({ value: 'NON' });
    expect(body.Line[0].Amount).toBe(7100);
  });

  it('update_estimate / update_credit_memo / update_sales_receipt accept line class_id', async () => {
    const est = fake.seed('Estimate', { Id: '9001', DocNumber: '5900', TxnDate: '2026-09-01', CustomerRef: { value: '31' }, Line: [salesLine(10, '70', { ClassRef: CLASS_7000 })], TotalAmt: 10 });
    await call('update_estimate', { estimate_id: est.Id, lines: [{ item_id: '70', amount: 12, class_id: 'C-est' }] });
    expect(lastPost('estimate').Line[0].SalesItemLineDetail.ClassRef).toEqual({ value: 'C-est' });

    const cm = fake.seed('CreditMemo', { Id: '9002', DocNumber: '5901', TxnDate: '2026-09-01', CustomerRef: { value: '31' }, Line: [salesLine(10, '70', { ClassRef: CLASS_7000 })], TotalAmt: 10 });
    const cmText = await call('update_credit_memo', { credit_memo_id: cm.Id, lines: [{ item_id: '70', amount: 12 }] });
    expect(cmText).toContain('Line class carried over');
    expect(lastPost('creditmemo').Line[0].SalesItemLineDetail.ClassRef).toEqual({ value: CLASS_7000.value });

    await call('update_sales_receipt', { sales_receipt_id: '119725', class_id: 'C-sr', lines: [{ item_id: '70', amount: 12 }] });
    expect(lastPost('salesreceipt').Line[0].SalesItemLineDetail.ClassRef).toEqual({ value: 'C-sr' });
  });

  it('§7 cleanup: delete_invoice removes the test invoices', async () => {
    expect(fake.posts.filter((p) => p.path === 'invoice' && !p.body.Id).length).toBeGreaterThan(0);
    const created = [...fake.store.Invoice.values()].filter((i) => Number(i.Id) >= 200000);
    for (const inv of created) {
      const text = await call('delete_invoice', { invoice_id: inv.Id });
      expect(text).toMatch(/deleted successfully/);
    }
    expect([...fake.store.Invoice.values()].filter((i) => Number(i.Id) >= 200000)).toEqual([]);
  });
});
