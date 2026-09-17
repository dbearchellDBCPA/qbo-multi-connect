import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  nextDocNumberFrom,
  bumpDocNumber,
  summarizePreferences,
  sortMostRecentFirst,
  copyAddress,
  describeValue,
  prefillSalesPayload,
  prefillPurchasePayload,
  isDuplicateDocNumberError,
  postWithDocNumberRetry,
  appendPrefillReport,
  emptyOutcome,
  runSalesFormPrefill,
  runPurchaseFormPrefill,
  clearPrefillCaches,
  SALES_DOC_SEQUENCE,
  MAX_DOC_NUMBER_RETRIES,
  type PrefillClient,
  type PriorTxn,
} from '../../src/server/prefill.js';
import { buildSalesTxnLines, buildBillTxnLines, uniformSalesLineClass, hasMixedSalesLineClasses } from '../../src/server/line-converters.js';
import { ingramLikePreferences } from '../support/fake-qbo-forms.js';

// ─────────────────────────────────────────────────────────────────────────────
// Unit tests for the prefill layer (SPEC-create-invoice-prefill.md §2): the
// DocNumber helper, the Preferences summary, and the per-field precedence
// explicit argument > Customer record > prior forms > Preferences > blank.
// Fixtures mirror Ingram Entities customer 31 (Dollar General) as read from
// the live realm on 2026-09-17.
// ─────────────────────────────────────────────────────────────────────────────

const CLASS_7000 = { value: '800000000001204542', name: '7000 - DCM Ingram Center' };
const ACH_MESSAGE = 'Please Pay Via ACH with payment instructions Below:\n\nPeopleSouth Bank\n1302 Gray Hwy\nMacon, Ga 31211';

const customer31 = {
  Id: '31',
  DisplayName: 'Dollar General (C)',
  Taxable: false,
  PrimaryEmailAddr: { Address: 'kwhitehe@dollargeneral.com, cbane@dollargeneral.com, mmohary@dollargeneral.com' },
  BillAddr: { Id: '7', Line1: 'Ingram Center I, Space 8-10', City: 'Forsyth', Country: 'USA', CountrySubDivisionCode: 'GA', PostalCode: '31029' },
  ShipAddr: { Id: '10' }, // QBO's empty-address shell
};

function salesLine(amount: number, itemId = '73', extra: any = {}): any {
  return {
    Amount: amount,
    DetailType: 'SalesItemLineDetail',
    SalesItemLineDetail: { Qty: 1, UnitPrice: amount, ItemRef: { value: itemId }, ...extra },
  };
}

/** The customer's most recent invoice: API-created, then patched up by hand in the UI (no cc, no message). */
const inv126405 = {
  Id: '126405',
  DocNumber: '2025_TIM',
  TxnDate: '2026-09-17',
  CustomerRef: { value: '31', name: 'Dollar General (C)' },
  Line: [salesLine(7015.19, '73', { ClassRef: CLASS_7000, TaxCodeRef: { value: 'NON' } }), { Amount: 7015.19, DetailType: 'SubTotalLineDetail' }],
  BillAddr: { Id: '1282', Line1: 'Dollar General', Line2: 'Ingram Center I, Space 8-10', Line3: 'Forsyth, GA  31029 USA' },
  SalesTermRef: { value: '3', name: 'Net 30' },
  PrintStatus: 'NeedToPrint',
  EmailStatus: 'EmailSent',
  BillEmail: { Address: 'kwhitehe@dollargeneral.com, cbane@dollargeneral.com, mmohary@dollargeneral.com' },
};

/** An older, UI-created monthly rent invoice with everything on it. */
const inv5735 = {
  Id: '126233',
  DocNumber: '5735',
  TxnDate: '2026-09-01',
  CustomerRef: { value: '31', name: 'Dollar General (C)' },
  Line: [salesLine(3200, '70', { ClassRef: CLASS_7000 })],
  DepartmentRef: { value: '1', name: 'Ingram Center' },
  BillAddr: { Id: '1186', Line1: 'Dollar General', Line2: 'Forsyth, GA' },
  ShipAddr: { Id: '1187', Line1: 'Ingram Center I, Space 8-10', City: 'Forsyth' },
  SalesTermRef: { value: '3', name: 'Net 30' },
  PrintStatus: 'NotSet',
  EmailStatus: 'EmailSent',
  BillEmail: { Address: 'old-contact@dollargeneral.com' },
  BillEmailCc: { Address: 'obingram@ingramentities.com' },
  CustomerMemo: { value: ACH_MESSAGE },
};

const priorInvoices: PriorTxn[] = [
  { entity: 'Invoice', txn: inv126405 },
  { entity: 'Invoice', txn: inv5735 },
];

const prefs = summarizePreferences(ingramLikePreferences());
const next5813 = { value: '5813', max: '5812', maxEntity: 'Invoice' };

function invoicePayload(lines: any[] = [salesLine(1)]): any {
  return { CustomerRef: { value: '31', name: 'Dollar General (C)' }, Line: lines };
}

// ── DocNumber helper (§2.3) ──────────────────────────────────────────────────

describe('nextDocNumberFrom — next number in the shared sales sequence', () => {
  it('takes the max numeric DocNumber across entities and adds one', () => {
    const next = nextDocNumberFrom([
      { docNumber: '5812', entity: 'Invoice' },
      { docNumber: '5811', entity: 'Invoice' },
      { docNumber: '2025_TIM', entity: 'Invoice' },
      { docNumber: '4610', entity: 'SalesReceipt' },
      { docNumber: '2611', entity: 'CreditMemo' },
    ]);
    expect(next).toEqual({ value: '5813', max: '5812', maxEntity: 'Invoice' });
  });

  it('lets a higher number on another sales form win (one shared sequence)', () => {
    const next = nextDocNumberFrom([
      { docNumber: '100', entity: 'Invoice' },
      { docNumber: '250', entity: 'Estimate' },
    ]);
    expect(next).toEqual({ value: '251', max: '250', maxEntity: 'Estimate' });
  });

  it('ignores non-numeric numbers and returns null when nothing numeric exists', () => {
    expect(nextDocNumberFrom([
      { docNumber: 'STMT 05/25/2025' },
      { docNumber: '2025_TIM' },
      { docNumber: 'INV-100' },
      { docNumber: '' },
      { docNumber: null },
      { docNumber: undefined },
      { docNumber: '12.5' },
    ])).toBeNull();
  });

  it('keeps zero padding', () => {
    expect(nextDocNumberFrom([{ docNumber: '0042' }, { docNumber: '0007' }])?.value).toBe('0043');
    expect(bumpDocNumber('0099')).toBe('0100');
    expect(bumpDocNumber('5734')).toBe('5735');
  });

  it('scans the five sales-form entities QBO numbers together', () => {
    expect(SALES_DOC_SEQUENCE).toEqual(['Invoice', 'SalesReceipt', 'CreditMemo', 'Estimate', 'RefundReceipt']);
  });
});

// ── Preferences summary (§2.2 C) ─────────────────────────────────────────────

describe('summarizePreferences', () => {
  it('reads the numbering, class-tracking, department and default-message settings', () => {
    expect(prefs).toEqual({
      customTxnNumbers: true,
      poCustomTxnNumbers: false,
      classTrackingPerTxn: false,
      classTrackingPerTxnLine: true,
      trackDepartments: true,
      defaultCustomerMessage: ACH_MESSAGE,
      defaultTermsId: '6',
    });
  });

  it('accepts the raw GET /preferences body or the inner Preferences object', () => {
    expect(summarizePreferences({ Preferences: ingramLikePreferences() })).toEqual(prefs);
  });

  it('reports null for settings the company does not expose', () => {
    expect(summarizePreferences({})).toEqual({
      customTxnNumbers: null,
      poCustomTxnNumbers: null,
      classTrackingPerTxn: null,
      classTrackingPerTxnLine: null,
      trackDepartments: null,
      defaultCustomerMessage: null,
      defaultTermsId: null,
    });
  });

  it('falls back to the OtherPrefs copy of the default customer message and reads the PO numbering flag from OtherPrefs', () => {
    const p = summarizePreferences({
      SalesFormsPrefs: { CustomTxnNumbers: false },
      OtherPrefs: { NameValue: [
        { Name: 'SalesFormsPrefs.DefaultCustomerMessage', Value: 'Thank you' },
        { Name: 'VendorAndPurchasesPrefs.UseCustomTxnNumbers', Value: 'true' },
      ] },
    });
    expect(p.defaultCustomerMessage).toBe('Thank you');
    expect(p.poCustomTxnNumbers).toBe(true);
    expect(p.customTxnNumbers).toBe(false);
  });
});

// ── Small helpers ────────────────────────────────────────────────────────────

describe('helpers', () => {
  it('sortMostRecentFirst orders by TxnDate then numeric Id', () => {
    const rows = [
      { Id: '9', TxnDate: '2026-09-17' },
      { Id: '126405', TxnDate: '2026-09-17' },
      { Id: '126500', TxnDate: '2026-09-01' },
    ];
    expect(sortMostRecentFirst(rows).map((r) => r.Id)).toEqual(['126405', '9', '126500']);
  });

  it('copyAddress drops the row Id and treats an Id-only shell as no address', () => {
    expect(copyAddress(customer31.BillAddr)).toEqual({ Line1: 'Ingram Center I, Space 8-10', City: 'Forsyth', Country: 'USA', CountrySubDivisionCode: 'GA', PostalCode: '31029' });
    expect(copyAddress({ Id: '10' })).toBeNull();
    expect(copyAddress(undefined)).toBeNull();
  });

  it('describeValue renders refs by name, emails by address, addresses as one line, and truncates memos', () => {
    expect(describeValue(CLASS_7000)).toBe('7000 - DCM Ingram Center');
    expect(describeValue({ value: '3' })).toBe('3');
    expect(describeValue({ Address: 'a@b.com' })).toBe('a@b.com');
    expect(describeValue(customer31.BillAddr)).toBe('Ingram Center I, Space 8-10, Forsyth, GA, 31029, USA');
    expect(describeValue({ value: ACH_MESSAGE })).toMatch(/^Please Pay Via ACH.*…$/);
    expect(describeValue({ value: ACH_MESSAGE }).length).toBeLessThanOrEqual(80);
  });

  it('isDuplicateDocNumberError recognizes QBO code 6140 in the message or the raw body', () => {
    expect(isDuplicateDocNumberError(new Error('QBO API error: Duplicate Document Number Error — You must specify a different number. (QBO code 6140)'))).toBe(true);
    expect(isDuplicateDocNumberError(Object.assign(new Error('QBO API error'), { response: '{"Fault":{"Error":[{"code":"6140"}]}}' }))).toBe(true);
    expect(isDuplicateDocNumberError(new Error('QBO API error: Stale Object Error (QBO code 5010)'))).toBe(false);
  });
});

// ── Sales-form precedence (§2, §2.4, §2.5) ───────────────────────────────────

describe('prefillSalesPayload — the Ingram acceptance case (§7)', () => {
  let payload: any;
  let outcome: ReturnType<typeof prefillSalesPayload>;

  beforeEach(() => {
    payload = invoicePayload();
    outcome = prefillSalesPayload('Invoice', payload, { priorTxns: priorInvoices, customer: customer31, prefs, nextDocNumber: next5813 });
  });

  it('numbers the invoice from the shared sequence when CustomTxnNumbers is on', () => {
    expect(payload.DocNumber).toBe('5813');
    expect(outcome.docNumberComputed).toBe(true);
    expect(outcome.prefilled.DocNumber).toBe('computed (CustomTxnNumbers on): 5812 → 5813');
  });

  it('puts the prior invoice\'s class on every line, and no header ClassRef on a per-line company', () => {
    expect(payload.Line[0].SalesItemLineDetail.ClassRef).toEqual(CLASS_7000);
    expect(payload.ClassRef).toBeUndefined();
    expect(outcome.prefilled['Line.ClassRef']).toBe('from invoice #2025_TIM → 7000 - DCM Ingram Center');
  });

  it('takes email, billing address and terms the way the UI does', () => {
    expect(payload.BillEmail).toEqual(customer31.PrimaryEmailAddr);
    expect(outcome.prefilled.BillEmail).toMatch(/^from customer → kwhitehe@dollargeneral.com/);
    expect(payload.BillAddr).toEqual(copyAddress(customer31.BillAddr));
    expect(payload.BillAddr.Id).toBeUndefined();
    expect(outcome.prefilled.BillAddr).toMatch(/^from customer → Ingram Center I/);
    // customer has no terms → most recent invoice's Net 30 (not the company default of 6)
    expect(payload.SalesTermRef).toEqual({ value: '3', name: 'Net 30' });
    expect(outcome.prefilled.SalesTermRef).toBe('from invoice #2025_TIM → Net 30');
  });

  it('looks back past a bare form for cc, message, department and ship address', () => {
    expect(payload.BillEmailCc).toEqual({ Address: 'obingram@ingramentities.com' });
    expect(outcome.prefilled.BillEmailCc).toBe('from invoice #5735 → obingram@ingramentities.com');
    expect(payload.CustomerMemo).toEqual({ value: ACH_MESSAGE });
    expect(outcome.prefilled.CustomerMemo).toMatch(/^from invoice #5735 → Please Pay Via ACH/);
    expect(payload.DepartmentRef).toEqual({ value: '1', name: 'Ingram Center' });
    expect(outcome.prefilled.DepartmentRef).toBe('from invoice #5735 → Ingram Center');
    // the customer's ShipAddr is an {Id} shell → the older invoice's, without its Id
    expect(payload.ShipAddr).toEqual({ Line1: 'Ingram Center I, Space 8-10', City: 'Forsyth' });
    expect(outcome.prefilled.ShipAddr).toBe('from invoice #5735 → Ingram Center I, Space 8-10, Forsyth');
  });

  it('copies PrintStatus and defaults EmailStatus to NeedToSend', () => {
    expect(payload.PrintStatus).toBe('NeedToPrint');
    expect(payload.EmailStatus).toBe('NeedToSend');
    expect(outcome.prefilled.EmailStatus).toBe('default → NeedToSend');
    expect(outcome.prefilled.PrintStatus).toBe('from invoice #2025_TIM → NeedToPrint');
  });

  it('reports every field of the acceptance test with its source and no warnings', () => {
    expect(Object.keys(outcome.prefilled).sort()).toEqual([
      'BillAddr', 'BillEmail', 'BillEmailCc', 'CustomerMemo', 'DepartmentRef', 'DocNumber', 'EmailStatus', 'Line.ClassRef', 'PrintStatus', 'SalesTermRef', 'ShipAddr',
    ]);
    expect(outcome.warnings).toEqual([]);
  });

  it('never copies lines, amounts, dates, Ids or the prior DocNumber', () => {
    expect(payload.Line).toHaveLength(1);
    expect(payload.Line[0].Amount).toBe(1);
    expect(payload.TxnDate).toBeUndefined();
    expect(payload.DueDate).toBeUndefined();
    expect(payload.Id).toBeUndefined();
    expect(payload.DocNumber).not.toBe('2025_TIM');
  });
});

describe('prefillSalesPayload — precedence and edge cases', () => {
  it('explicit arguments win over every source and are reported as "argument"', () => {
    const payload = {
      ...invoicePayload([salesLine(1, '73', { ClassRef: { value: 'C-explicit' } })]),
      DocNumber: 'ABC-1',
      DepartmentRef: { value: '9' },
      SalesTermRef: { value: '6' },
      BillEmail: { Address: 'me@example.com' },
      BillEmailCc: { Address: 'cc@example.com' },
      BillAddr: { Line1: '1 Main St' },
      CustomerMemo: { value: 'Custom note' },
      EmailStatus: 'NotSet',
    };
    const out = prefillSalesPayload('Invoice', payload, { priorTxns: priorInvoices, customer: customer31, prefs, nextDocNumber: next5813 });
    expect(payload.DocNumber).toBe('ABC-1');
    expect(out.docNumberComputed).toBe(false);
    expect(payload.SalesTermRef).toEqual({ value: '6' });
    expect(payload.BillEmail).toEqual({ Address: 'me@example.com' });
    expect(payload.BillEmailCc).toEqual({ Address: 'cc@example.com' });
    expect(payload.BillAddr).toEqual({ Line1: '1 Main St' });
    expect(payload.CustomerMemo).toEqual({ value: 'Custom note' });
    expect(payload.EmailStatus).toBe('NotSet');
    expect(payload.Line[0].SalesItemLineDetail.ClassRef).toEqual({ value: 'C-explicit' });
    for (const field of ['DocNumber', 'DepartmentRef', 'SalesTermRef', 'BillEmail', 'BillEmailCc', 'BillAddr', 'CustomerMemo', 'EmailStatus', 'Line.ClassRef']) {
      expect(out.prefilled[field], field).toMatch(/^argument → /);
    }
  });

  it('a header class_id fills only the lines that have no class of their own', () => {
    const payload = invoicePayload([salesLine(1), salesLine(2, '74', { ClassRef: { value: 'C-line' } })]);
    const out = prefillSalesPayload('Invoice', payload, { priorTxns: priorInvoices, customer: customer31, prefs, nextDocNumber: null }, { headerClassId: 'C-header' });
    expect(payload.Line[0].SalesItemLineDetail.ClassRef).toEqual({ value: 'C-header' });
    expect(payload.Line[1].SalesItemLineDetail.ClassRef).toEqual({ value: 'C-line' });
    expect(out.prefilled['Line.ClassRef']).toBe('argument → C-header');
  });

  it('writes a header ClassRef too when the company tracks class per transaction', () => {
    const perTxn = summarizePreferences(ingramLikePreferences({ AccountingInfoPrefs: { ClassTrackingPerTxn: true, ClassTrackingPerTxnLine: false } }));
    const payload = invoicePayload();
    const out = prefillSalesPayload('Invoice', payload, { priorTxns: priorInvoices, customer: customer31, prefs: perTxn, nextDocNumber: null });
    expect(payload.ClassRef).toEqual(CLASS_7000);
    expect(payload.Line[0].SalesItemLineDetail.ClassRef).toEqual(CLASS_7000);
    expect(out.prefilled.ClassRef).toBe('from invoice #2025_TIM → 7000 - DCM Ingram Center');
  });

  it('copies nothing about class when the company does not track classes', () => {
    const off = summarizePreferences(ingramLikePreferences({ AccountingInfoPrefs: { ClassTrackingPerTxn: false, ClassTrackingPerTxnLine: false } }));
    const payload = invoicePayload();
    const out = prefillSalesPayload('Invoice', payload, { priorTxns: priorInvoices, customer: customer31, prefs: off, nextDocNumber: null });
    expect(payload.Line[0].SalesItemLineDetail.ClassRef).toBeUndefined();
    expect(out.prefilled['Line.ClassRef']).toBeUndefined();
    expect(out.warnings.filter((w) => /class/.test(w))).toEqual([]);
  });

  it('warns when the company tracks classes and no class could be found', () => {
    const noPrior = prefillSalesPayload('Invoice', invoicePayload(), { priorTxns: [], customer: customer31, prefs, nextDocNumber: null });
    expect(noPrior.warnings).toContainEqual(expect.stringMatching(/^no class set — company uses class tracking and there is no prior invoice for this customer/));

    const unclassed: PriorTxn[] = [{ entity: 'Invoice', txn: { ...inv5735, Line: [salesLine(3200, '70')] } }];
    const priorUnclassed = prefillSalesPayload('Invoice', invoicePayload(), { priorTxns: unclassed, customer: customer31, prefs, nextDocNumber: null });
    expect(priorUnclassed.warnings).toContainEqual(expect.stringMatching(/prior invoices for this customer are unclassed too/));
  });

  it('skips DescriptionOnly lines when classing', () => {
    const payload = invoicePayload([{ Amount: 0, DetailType: 'DescriptionOnly', Description: 'Heading' }, salesLine(5)]);
    prefillSalesPayload('Invoice', payload, { priorTxns: priorInvoices, customer: customer31, prefs, nextDocNumber: null });
    expect(payload.Line[0].SalesItemLineDetail).toBeUndefined();
    expect(payload.Line[1].SalesItemLineDetail.ClassRef).toEqual(CLASS_7000);
  });

  it('omits DocNumber when CustomTxnNumbers is off (QBO numbers the form itself)', () => {
    const off = summarizePreferences(ingramLikePreferences({ SalesFormsPrefs: { CustomTxnNumbers: false } }));
    const payload = invoicePayload();
    const out = prefillSalesPayload('Invoice', payload, { priorTxns: priorInvoices, customer: customer31, prefs: off, nextDocNumber: next5813 });
    expect(payload.DocNumber).toBeUndefined();
    expect(out.docNumberComputed).toBe(false);
    expect(out.prefilled.DocNumber).toMatch(/^omitted \(CustomTxnNumbers off/);
  });

  it('warns instead of guessing when CustomTxnNumbers is on but no numeric number exists', () => {
    const payload = invoicePayload();
    const out = prefillSalesPayload('Invoice', payload, { priorTxns: priorInvoices, customer: customer31, prefs, nextDocNumber: null });
    expect(payload.DocNumber).toBeUndefined();
    expect(out.warnings).toContainEqual(expect.stringMatching(/DocNumber left blank: CustomTxnNumbers is on but no numeric DocNumber/));
  });

  it('still fills from the customer and prior forms when Preferences could not be read', () => {
    const payload = invoicePayload();
    const out = prefillSalesPayload('Invoice', payload, { priorTxns: priorInvoices, customer: customer31, prefs: null, nextDocNumber: null });
    expect(payload.BillEmail).toEqual(customer31.PrimaryEmailAddr);
    expect(payload.Line[0].SalesItemLineDetail.ClassRef).toEqual(CLASS_7000);
    expect(payload.CustomerMemo).toEqual({ value: ACH_MESSAGE });
    expect(out.warnings).toContainEqual(expect.stringMatching(/Preferences could not be read/));
  });

  it('falls back to the prior form\'s BillEmail when the customer record has none, and warns when nobody has one', () => {
    const noEmail = { ...customer31, PrimaryEmailAddr: undefined };
    const p1 = invoicePayload();
    const o1 = prefillSalesPayload('Invoice', p1, { priorTxns: priorInvoices, customer: noEmail, prefs, nextDocNumber: null });
    expect(p1.BillEmail).toEqual(inv126405.BillEmail);
    expect(o1.prefilled.BillEmail).toMatch(/^from invoice #2025_TIM/);

    const bare: PriorTxn[] = [{ entity: 'Invoice', txn: { ...inv5735, BillEmail: undefined } }];
    const p2 = invoicePayload();
    const o2 = prefillSalesPayload('Invoice', p2, { priorTxns: bare, customer: noEmail, prefs, nextDocNumber: null });
    expect(p2.BillEmail).toBeUndefined();
    expect(p2.EmailStatus).toBe('NeedToSend');
    expect(o2.warnings).toContainEqual(expect.stringMatching(/NeedToSend but no BillEmail/));
  });

  it('uses the company default message and default terms when neither customer nor prior forms have them', () => {
    const noTerms = { ...customer31 };
    const bare: PriorTxn[] = [{ entity: 'Invoice', txn: { ...inv126405, SalesTermRef: undefined } }];
    const payload = invoicePayload();
    const out = prefillSalesPayload('Invoice', payload, { priorTxns: bare, customer: noTerms, prefs, nextDocNumber: null });
    expect(payload.CustomerMemo).toEqual({ value: ACH_MESSAGE });
    expect(out.prefilled.CustomerMemo).toMatch(/^from Preferences \(DefaultCustomerMessage\)/);
    expect(payload.SalesTermRef).toEqual({ value: '6' });
    expect(out.prefilled.SalesTermRef).toBe('from Preferences (DefaultTerms) → 6');
  });

  it('prefers the customer record\'s own terms over the prior form (what the UI does)', () => {
    const withTerms = { ...customer31, SalesTermRef: { value: '5', name: 'Net 15' } };
    const payload = invoicePayload();
    const out = prefillSalesPayload('Invoice', payload, { priorTxns: priorInvoices, customer: withTerms, prefs, nextDocNumber: null });
    expect(payload.SalesTermRef).toEqual({ value: '5', name: 'Net 15' });
    expect(out.prefilled.SalesTermRef).toBe('from customer → Net 15');
  });

  it('leaves the department alone when the company does not track locations', () => {
    const noDept = summarizePreferences(ingramLikePreferences({ AccountingInfoPrefs: { TrackDepartments: false } }));
    const payload = invoicePayload();
    prefillSalesPayload('Invoice', payload, { priorTxns: priorInvoices, customer: customer31, prefs: noDept, nextDocNumber: null });
    expect(payload.DepartmentRef).toBeUndefined();
  });

  it('applies the customer\'s DefaultTaxCodeRef to lines without a tax code', () => {
    const taxable = { ...customer31, DefaultTaxCodeRef: { value: '2', name: 'TAX' } };
    const payload = invoicePayload([salesLine(1), salesLine(2, '74', { TaxCodeRef: { value: 'NON' } })]);
    const out = prefillSalesPayload('Invoice', payload, { priorTxns: priorInvoices, customer: taxable, prefs, nextDocNumber: null });
    expect(payload.Line[0].SalesItemLineDetail.TaxCodeRef).toEqual({ value: '2' });
    expect(payload.Line[1].SalesItemLineDetail.TaxCodeRef).toEqual({ value: 'NON' });
    expect(out.prefilled['Line.TaxCodeRef']).toBe('from customer (DefaultTaxCodeRef) → TAX');
  });

  it('sales receipts copy deposit account and payment method only from prior sales receipts', () => {
    const priorSr: PriorTxn[] = [
      { entity: 'SalesReceipt', txn: { Id: '119725', DocNumber: '4610', TxnDate: '2026-08-01', Line: [salesLine(50)], DepositToAccountRef: { value: '35', name: 'Checking' }, PaymentMethodRef: { value: '2', name: 'Check' } } },
    ];
    const p1: any = invoicePayload();
    const o1 = prefillSalesPayload('SalesReceipt', p1, { priorTxns: priorSr, customer: customer31, prefs, nextDocNumber: null });
    expect(p1.DepositToAccountRef).toEqual({ value: '35', name: 'Checking' });
    expect(p1.PaymentMethodRef).toEqual({ value: '2', name: 'Check' });
    expect(o1.prefilled.DepositToAccountRef).toBe('from sales receipt #4610 → Checking');

    // An invoice used as the fallback source never supplies deposit/payment-method refs.
    const p2: any = invoicePayload();
    prefillSalesPayload('SalesReceipt', p2, { priorTxns: [{ entity: 'Invoice', txn: { ...inv5735, DepositToAccountRef: { value: '35' } } }], customer: customer31, prefs, nextDocNumber: null });
    expect(p2.DepositToAccountRef).toBeUndefined();
  });

  it('labels a prior form without a DocNumber by its Id', () => {
    const noNumber: PriorTxn[] = [{ entity: 'CreditMemo', txn: { ...inv5735, DocNumber: undefined, Id: '777' } }];
    const payload = invoicePayload();
    const out = prefillSalesPayload('CreditMemo', payload, { priorTxns: noNumber, customer: customer31, prefs, nextDocNumber: null });
    expect(out.prefilled['Line.ClassRef']).toBe('from credit memo Id 777 → 7000 - DCM Ingram Center');
  });
});

// ── Purchase forms (§3) ──────────────────────────────────────────────────────

const vendor1 = {
  Id: 'v-1',
  DisplayName: 'Acme Supply',
  TermRef: { value: '3', name: 'Net 30' },
  BillAddr: { Id: '77', Line1: '9 Vendor Way', City: 'Macon', CountrySubDivisionCode: 'GA', PostalCode: '31201' },
  PrimaryEmailAddr: { Address: 'ar@acme.example' },
};

const priorBill = {
  Id: '12728',
  DocNumber: 'A-1001',
  TxnDate: '2026-08-15',
  VendorRef: { value: 'v-1' },
  DepartmentRef: { value: '1', name: 'Ingram Center' },
  APAccountRef: { value: '33', name: 'Accounts Payable (A/P)' },
  VendorAddr: { Id: '900', Line1: 'old address' },
  Line: [
    { Amount: 100, DetailType: 'AccountBasedExpenseLineDetail', AccountBasedExpenseLineDetail: { AccountRef: { value: '62', name: 'Supplies' }, ClassRef: { value: 'C1', name: 'Class One' } } },
  ],
};

describe('prefillPurchasePayload — bills', () => {
  it('fills terms from the vendor, AP account / department / class / expense account from the last bill, and never numbers a bill', () => {
    const payload: any = { VendorRef: { value: 'v-1' }, Line: buildBillTxnLines([{ amount: 25 }, { amount: 30, account_id: '70', class_id: 'C2' }]) };
    const out = prefillPurchasePayload('Bill', payload, { priorTxns: [{ entity: 'Bill', txn: priorBill }], vendor: vendor1, prefs, nextDocNumber: null });
    expect(payload.DocNumber).toBeUndefined();
    expect(out.prefilled.DocNumber).toBeUndefined();
    expect(out.docNumberComputed).toBe(false);
    expect(payload.EmailStatus).toBeUndefined();
    expect(payload.SalesTermRef).toEqual({ value: '3', name: 'Net 30' });
    expect(out.prefilled.SalesTermRef).toBe('from vendor → Net 30');
    expect(payload.APAccountRef).toEqual({ value: '33', name: 'Accounts Payable (A/P)' });
    expect(payload.DepartmentRef).toEqual({ value: '1', name: 'Ingram Center' });
    expect(payload.VendorAddr).toEqual({ Line1: '9 Vendor Way', City: 'Macon', CountrySubDivisionCode: 'GA', PostalCode: '31201' });
    expect(payload.Line[0].AccountBasedExpenseLineDetail.AccountRef).toEqual({ value: '62', name: 'Supplies' });
    expect(payload.Line[0].AccountBasedExpenseLineDetail.ClassRef).toEqual({ value: 'C1', name: 'Class One' });
    expect(payload.Line[1].AccountBasedExpenseLineDetail.AccountRef).toEqual({ value: '70', name: undefined });
    expect(payload.Line[1].AccountBasedExpenseLineDetail.ClassRef).toEqual({ value: 'C2' });
    expect(out.prefilled['Line.AccountRef']).toBe('from bill #A-1001 → Supplies');
    expect(out.prefilled['Line.ClassRef']).toBe('from bill #A-1001 → Class One');
    expect(out.warnings).toEqual([]);
  });

  it('warns when a line has no account and there is no prior bill to copy one from', () => {
    const payload: any = { VendorRef: { value: 'v-1' }, Line: buildBillTxnLines([{ amount: 25 }]) };
    const out = prefillPurchasePayload('Bill', payload, { priorTxns: [], vendor: vendor1, prefs, nextDocNumber: null });
    expect(payload.Line[0].AccountBasedExpenseLineDetail.AccountRef).toBeUndefined();
    expect(out.warnings).toContainEqual(expect.stringMatching(/1 bill line\(s\) have no account_id/));
  });
});

describe('prefillPurchasePayload — purchase orders', () => {
  const priorPo = {
    Id: '500', DocNumber: '1042', TxnDate: '2026-08-01', VendorRef: { value: 'v-1' },
    ShipAddr: { Id: '5', Line1: 'PO Box 1037', City: 'Forsyth' }, Memo: 'Deliver to rear dock', POEmail: { Address: 'old@acme.example' },
    Line: [{ Amount: 10, DetailType: 'ItemBasedExpenseLineDetail', ItemBasedExpenseLineDetail: { ItemRef: { value: '9' }, ClassRef: { value: 'C1', name: 'Class One' } } }],
  };

  it('numbers from the PO sequence only when the company has custom PO numbers on', () => {
    const on = summarizePreferences(ingramLikePreferences({ poCustomTxnNumbers: 'true' }));
    const p1: any = { VendorRef: { value: 'v-1' }, Line: [{ Amount: 10, DetailType: 'ItemBasedExpenseLineDetail', ItemBasedExpenseLineDetail: { ItemRef: { value: '9' } } }] };
    const o1 = prefillPurchasePayload('PurchaseOrder', p1, { priorTxns: [{ entity: 'PurchaseOrder', txn: priorPo }], vendor: vendor1, prefs: on, nextDocNumber: { value: '1043', max: '1042', maxEntity: 'PurchaseOrder' } });
    expect(p1.DocNumber).toBe('1043');
    expect(o1.docNumberComputed).toBe(true);
    expect(o1.prefilled.DocNumber).toBe('computed (PO custom numbers on): 1042 → 1043');

    const p2: any = { VendorRef: { value: 'v-1' }, Line: [] };
    const o2 = prefillPurchasePayload('PurchaseOrder', p2, { priorTxns: [], vendor: vendor1, prefs, nextDocNumber: { value: '1043', max: '1042', maxEntity: 'PurchaseOrder' } });
    expect(p2.DocNumber).toBeUndefined();
    expect(o2.prefilled.DocNumber).toMatch(/^omitted \(purchase-order custom numbers off/);

    const unknown = summarizePreferences({ SalesFormsPrefs: { CustomTxnNumbers: true } });
    const p3: any = { VendorRef: { value: 'v-1' }, Line: [] };
    const o3 = prefillPurchasePayload('PurchaseOrder', p3, { priorTxns: [], vendor: vendor1, prefs: unknown, nextDocNumber: null });
    expect(p3.DocNumber).toBeUndefined();
    expect(o3.prefilled.DocNumber).toMatch(/does not expose its purchase-order numbering preference/);
  });

  it('fills vendor email, ship-to, vendor message, class and EmailStatus', () => {
    const payload: any = { VendorRef: { value: 'v-1' }, Line: [{ Amount: 10, DetailType: 'ItemBasedExpenseLineDetail', ItemBasedExpenseLineDetail: { ItemRef: { value: '9' } } }] };
    const out = prefillPurchasePayload('PurchaseOrder', payload, { priorTxns: [{ entity: 'PurchaseOrder', txn: priorPo }], vendor: vendor1, prefs, nextDocNumber: null });
    expect(payload.POEmail).toEqual({ Address: 'ar@acme.example' });
    expect(out.prefilled.POEmail).toBe('from vendor → ar@acme.example');
    expect(payload.ShipAddr).toEqual({ Line1: 'PO Box 1037', City: 'Forsyth' });
    expect(payload.Memo).toBe('Deliver to rear dock');
    expect(payload.EmailStatus).toBe('NeedToSend');
    expect(payload.Line[0].ItemBasedExpenseLineDetail.ClassRef).toEqual({ value: 'C1', name: 'Class One' });
    expect(payload.ClassRef).toBeUndefined();
    expect(payload.VendorAddr).toEqual({ Line1: '9 Vendor Way', City: 'Macon', CountrySubDivisionCode: 'GA', PostalCode: '31201' });
  });
});

// ── Posting with duplicate-number retry ──────────────────────────────────────

describe('postWithDocNumberRetry', () => {
  const dup = () => new Error('QBO API error: Duplicate Document Number Error — You must specify a different number. This number has already been used. (QBO code 6140)');

  it('bumps a computed number on 6140 and reports the retry', async () => {
    const outcome = { ...emptyOutcome(), docNumberComputed: true, prefilled: { DocNumber: 'computed (CustomTxnNumbers on): 5812 → 5813' } };
    const payload: any = { DocNumber: '5813' };
    const post = vi.fn().mockRejectedValueOnce(dup()).mockRejectedValueOnce(dup()).mockResolvedValue({ Invoice: { Id: '1' } });
    const res = await postWithDocNumberRetry(post, payload, outcome);
    expect(res).toEqual({ Invoice: { Id: '1' } });
    expect(payload.DocNumber).toBe('5815');
    expect(post).toHaveBeenCalledTimes(3);
    expect(outcome.prefilled.DocNumber).toBe('computed (CustomTxnNumbers on): 5812 → 5813; 5813 was already taken → retried with 5814; 5814 was already taken → retried with 5815');
  });

  it('never bumps an explicit number', async () => {
    const outcome = emptyOutcome();
    const payload: any = { DocNumber: '5813' };
    const post = vi.fn().mockRejectedValue(dup());
    await expect(postWithDocNumberRetry(post, payload, outcome)).rejects.toThrow(/6140/);
    expect(payload.DocNumber).toBe('5813');
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('gives up after the retry limit and surfaces other errors untouched', async () => {
    const outcome = { ...emptyOutcome(), docNumberComputed: true };
    const post = vi.fn().mockRejectedValue(dup());
    await expect(postWithDocNumberRetry(post, { DocNumber: '1' }, outcome)).rejects.toThrow(/6140/);
    expect(post).toHaveBeenCalledTimes(MAX_DOC_NUMBER_RETRIES + 1);

    const other = vi.fn().mockRejectedValue(new Error('QBO API error: Stale Object Error (QBO code 5010)'));
    await expect(postWithDocNumberRetry(other, { DocNumber: '1' }, { ...emptyOutcome(), docNumberComputed: true })).rejects.toThrow(/5010/);
    expect(other).toHaveBeenCalledTimes(1);
  });
});

describe('appendPrefillReport', () => {
  it('keeps the one-line summary and appends the §2.5 JSON block', () => {
    const outcome = { ...emptyOutcome(), prefilled: { DocNumber: 'computed (CustomTxnNumbers on): 5734 → 5735' }, warnings: ['w'] };
    const text = appendPrefillReport('Invoice #5735 created successfully.\nID: 126405', { id: '126405', doc_number: '5735', total: 1 }, outcome);
    expect(text.startsWith('Invoice #5735 created successfully.\nID: 126405\n\n')).toBe(true);
    const json = JSON.parse(text.slice(text.indexOf('\n\n') + 2));
    expect(json).toEqual({ id: '126405', doc_number: '5735', total: 1, prefilled: { DocNumber: 'computed (CustomTxnNumbers on): 5734 → 5735' }, warnings: ['w'] });
  });
});

// ── Source loading (queries issued, caching, failure tolerance) ──────────────

function stubClient(overrides: Partial<{ query: (q: string) => any; customer: any; vendor: any; prefs: any }> = {}) {
  const calls: string[] = [];
  const client: PrefillClient = {
    transactions: {
      rawQuery: vi.fn(async (_realm: string, q: string) => {
        calls.push(`Q ${q}`);
        return overrides.query ? overrides.query(q) : { QueryResponse: {} };
      }),
      getCustomer: vi.fn(async (_realm: string, id: string) => {
        calls.push(`GET customer/${id}`);
        return { Customer: overrides.customer ?? customer31 };
      }),
      getVendor: vi.fn(async (_realm: string, id: string) => {
        calls.push(`GET vendor/${id}`);
        return { Vendor: overrides.vendor ?? vendor1 };
      }),
    },
    company: {
      getPreferences: vi.fn(async () => {
        calls.push('GET preferences');
        if (overrides.prefs instanceof Error) throw overrides.prefs;
        return { Preferences: overrides.prefs ?? ingramLikePreferences() };
      }),
    },
  };
  return { client, calls };
}

describe('runSalesFormPrefill — what it asks QBO', () => {
  beforeEach(() => clearPrefillCaches());

  it('issues the prior-form query, the customer read, Preferences, and the five doc-number scans', async () => {
    const { client, calls } = stubClient({
      query: (q) => {
        if (q.startsWith('SELECT * FROM Invoice')) return { QueryResponse: { Invoice: [inv5735, inv126405] } };
        if (q.startsWith('SELECT DocNumber FROM Invoice')) return { QueryResponse: { Invoice: [{ Id: '1', DocNumber: '5812' }, { Id: '2', DocNumber: '2025_TIM' }] } };
        if (q.startsWith('SELECT DocNumber FROM SalesReceipt')) return { QueryResponse: { SalesReceipt: [{ Id: '3', DocNumber: '4610' }] } };
        return { QueryResponse: {} };
      },
    });
    const payload = invoicePayload();
    const out = await runSalesFormPrefill(client, 'realm-1', 'Invoice', "O'Brien", payload);
    expect(calls).toContain("Q SELECT * FROM Invoice WHERE CustomerRef = 'O\\'Brien' ORDERBY TxnDate DESC, Id DESC MAXRESULTS 5");
    expect(calls).toContain("GET customer/O'Brien");
    expect(calls).toContain('GET preferences');
    for (const entity of SALES_DOC_SEQUENCE) {
      expect(calls).toContain(`Q SELECT DocNumber FROM ${entity} ORDERBY MetaData.CreateTime DESC MAXRESULTS 100`);
    }
    expect(payload.DocNumber).toBe('5813');
    // rows come back in query order; the loader re-sorts most recent first
    expect(out.prefilled['Line.ClassRef']).toBe('from invoice #2025_TIM → 7000 - DCM Ingram Center');
    expect(out.warnings).toEqual([]);
  });

  it('skips the doc-number scans when CustomTxnNumbers is off or doc_number was passed', async () => {
    const off = stubClient({ prefs: ingramLikePreferences({ SalesFormsPrefs: { CustomTxnNumbers: false } }) });
    await runSalesFormPrefill(off.client, 'realm-1', 'Invoice', '31', invoicePayload());
    expect(off.calls.filter((c) => c.includes('SELECT DocNumber'))).toEqual([]);

    clearPrefillCaches();
    const explicit = stubClient();
    await runSalesFormPrefill(explicit.client, 'realm-1', 'Invoice', '31', { ...invoicePayload(), DocNumber: 'X' });
    expect(explicit.calls.filter((c) => c.includes('SELECT DocNumber'))).toEqual([]);
  });

  it('falls back from the same-kind query to invoices for estimates, credit memos and sales receipts', async () => {
    const { client, calls } = stubClient({
      query: (q) => (q.startsWith('SELECT * FROM Invoice') ? { QueryResponse: { Invoice: [inv126405] } } : { QueryResponse: {} }),
      prefs: ingramLikePreferences({ SalesFormsPrefs: { CustomTxnNumbers: false } }),
    });
    const payload = invoicePayload();
    const out = await runSalesFormPrefill(client, 'realm-1', 'Estimate', '31', payload);
    expect(calls.filter((c) => c.startsWith('Q SELECT * FROM'))).toEqual([
      "Q SELECT * FROM Estimate WHERE CustomerRef = '31' ORDERBY TxnDate DESC, Id DESC MAXRESULTS 5",
      "Q SELECT * FROM Invoice WHERE CustomerRef = '31' ORDERBY TxnDate DESC, Id DESC MAXRESULTS 5",
    ]);
    expect(out.prefilled['Line.ClassRef']).toBe('from invoice #2025_TIM → 7000 - DCM Ingram Center');
  });

  it('caches Preferences per realm and the customer record between calls', async () => {
    const { client, calls } = stubClient({ prefs: ingramLikePreferences({ SalesFormsPrefs: { CustomTxnNumbers: false } }) });
    await runSalesFormPrefill(client, 'realm-1', 'Invoice', '31', invoicePayload());
    await runSalesFormPrefill(client, 'realm-1', 'Invoice', '31', invoicePayload());
    expect(calls.filter((c) => c === 'GET preferences')).toHaveLength(1);
    expect(calls.filter((c) => c === 'GET customer/31')).toHaveLength(1);
    expect(calls.filter((c) => c.startsWith('Q SELECT * FROM Invoice'))).toHaveLength(2); // prior forms are always fresh
  });

  it('turns an unreadable source into a warning instead of failing the create', async () => {
    const { client } = stubClient({ prefs: new Error('QBO API error: 503') });
    const payload = invoicePayload();
    const out = await runSalesFormPrefill(client, 'realm-1', 'Invoice', '31', payload);
    expect(out.warnings[0]).toMatch(/^prefill: Preferences unavailable \(QBO API error: 503\)/);
    expect(payload.BillEmail).toEqual(customer31.PrimaryEmailAddr); // the rest still ran
  });
});

describe('runPurchaseFormPrefill — what it asks QBO', () => {
  beforeEach(() => clearPrefillCaches());

  it('reads prior bills by VendorRef and the vendor record, and never scans numbers for a bill', async () => {
    const { client, calls } = stubClient({
      query: (q) => (q.startsWith('SELECT * FROM Bill') ? { QueryResponse: { Bill: [priorBill] } } : { QueryResponse: {} }),
    });
    const payload: any = { VendorRef: { value: 'v-1' }, Line: buildBillTxnLines([{ amount: 5 }]) };
    const out = await runPurchaseFormPrefill(client, 'realm-1', 'Bill', 'v-1', payload);
    expect(calls).toContain("Q SELECT * FROM Bill WHERE VendorRef = 'v-1' ORDERBY TxnDate DESC, Id DESC MAXRESULTS 5");
    expect(calls).toContain('GET vendor/v-1');
    expect(calls.filter((c) => c.includes('SELECT DocNumber'))).toEqual([]);
    expect(payload.Line[0].AccountBasedExpenseLineDetail.AccountRef).toEqual({ value: '62', name: 'Supplies' });
    expect(out.prefilled.SalesTermRef).toBe('from vendor → Net 30');
  });

  it('scans purchase-order numbers only when the company has custom PO numbers on', async () => {
    const { client, calls } = stubClient({
      prefs: ingramLikePreferences({ poCustomTxnNumbers: 'true' }),
      query: (q) => (q.startsWith('SELECT DocNumber FROM PurchaseOrder') ? { QueryResponse: { PurchaseOrder: [{ Id: '1', DocNumber: '1042' }] } } : { QueryResponse: {} }),
    });
    const payload: any = { VendorRef: { value: 'v-1' }, Line: [] };
    await runPurchaseFormPrefill(client, 'realm-1', 'PurchaseOrder', 'v-1', payload);
    expect(calls).toContain('Q SELECT DocNumber FROM PurchaseOrder ORDERBY MetaData.CreateTime DESC MAXRESULTS 100');
    expect(calls.filter((c) => c.includes('SELECT DocNumber'))).toHaveLength(1);
    expect(payload.DocNumber).toBe('1043');
  });
});

// ── Shared line builders / update-tool class inheritance (§4) ────────────────

describe('buildSalesTxnLines', () => {
  it('produces exactly the pre-prefill shape when no class or tax code is given', () => {
    expect(buildSalesTxnLines([{ amount: 1, item_id: '73', item_name: 'TIM', quantity: 2, unit_price: 0.5, description: 'x' }])).toEqual([
      { Amount: 1, DetailType: 'SalesItemLineDetail', Description: 'x', SalesItemLineDetail: { Qty: 2, UnitPrice: 0.5, ItemRef: { value: '73', name: 'TIM' } } },
    ]);
    expect(buildSalesTxnLines([{ amount: 0, detail_type: 'DescriptionOnly', description: 'Heading' }])).toEqual([
      { Amount: 0, DetailType: 'DescriptionOnly', Description: 'Heading' },
    ]);
  });

  it('puts the header class on lines without their own, and tax codes where given', () => {
    const lines = buildSalesTxnLines([{ amount: 1, item_id: '73' }, { amount: 2, item_id: '74', class_id: 'L', tax_code_id: 'NON' }], 'H');
    expect(lines[0].SalesItemLineDetail.ClassRef).toEqual({ value: 'H' });
    expect(lines[1].SalesItemLineDetail.ClassRef).toEqual({ value: 'L' });
    expect(lines[1].SalesItemLineDetail.TaxCodeRef).toEqual({ value: 'NON' });
    expect(lines[0].SalesItemLineDetail.TaxCodeRef).toBeUndefined();
  });
});

describe('uniformSalesLineClass / hasMixedSalesLineClasses', () => {
  const classed = (v: string) => salesLine(1, '73', { ClassRef: { value: v, name: `Class ${v}` } });

  it('returns the one class every sales line shares', () => {
    expect(uniformSalesLineClass([classed('A'), classed('A'), { Amount: 2, DetailType: 'SubTotalLineDetail' }])).toEqual({ value: 'A', name: 'Class A' });
  });

  it('returns null when lines are unclassed or mixed', () => {
    expect(uniformSalesLineClass([salesLine(1)])).toBeNull();
    expect(uniformSalesLineClass([classed('A'), salesLine(1)])).toBeNull();
    expect(uniformSalesLineClass([classed('A'), classed('B')])).toBeNull();
    expect(uniformSalesLineClass([])).toBeNull();
    expect(hasMixedSalesLineClasses([classed('A'), classed('B')])).toBe(true);
    expect(hasMixedSalesLineClasses([classed('A'), salesLine(1)])).toBe(false);
  });
});
