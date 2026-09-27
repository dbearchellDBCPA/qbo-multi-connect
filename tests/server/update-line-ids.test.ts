import { describe, it, expect } from 'vitest';
import {
  stampLineIds,
  stampDepositLineIds,
  replaceLinesWithIds,
  salesLineKind,
  LineIdError,
  buildJournalEntryUpdatePayload,
  qboJournalLinesToUpdateShape,
  qboBillLinesToUpdateShape,
  qboExpenseLinesToUpdateShape,
  qboSalesLinesToUpdateShape,
} from '../../src/server/line-converters.js';
import {
  buildBillUpdatePayload,
  buildExpenseUpdatePayload,
  buildInvoiceUpdatePayload,
  buildSalesReceiptUpdatePayload,
} from '../../src/server/update-payloads.js';
import { postedLineStats } from '../../src/server/update-verification.js';

// ─────────────────────────────────────────────────────────────────────────────
// P0 follow-up to PR #5: every line-replacing update must carry existing
// Line.Ids, otherwise QBO APPENDS the rebuilt lines (1 → 2 → 3 → 7).
// Pure payload-builder tests — no QBO calls.
// ─────────────────────────────────────────────────────────────────────────────

const clone = <T>(o: T): T => JSON.parse(JSON.stringify(o));
const ids = (lines: any[]) => lines.map((l) => l.Id);

// ── Fixtures ──────────────────────────────────────────────────────────────────

const JE = {
  Id: '901',
  SyncToken: '3',
  TxnDate: '2026-06-30',
  DocNumber: 'JE-1',
  Line: [
    { Id: '0', LineNum: 1, Amount: 250, DetailType: 'JournalEntryLineDetail', Description: 'Dr',
      JournalEntryLineDetail: { PostingType: 'Debit', AccountRef: { value: '64', name: 'Rent' } } },
    { Id: '1', LineNum: 2, Amount: 250, DetailType: 'JournalEntryLineDetail', Description: 'Cr',
      JournalEntryLineDetail: { PostingType: 'Credit', AccountRef: { value: '33', name: 'Accrued' } } },
  ],
};

const BILL = {
  Id: '145',
  SyncToken: '1',
  VendorRef: { value: '56' },
  Line: [
    { Id: '1', LineNum: 1, Amount: 100, DetailType: 'AccountBasedExpenseLineDetail',
      AccountBasedExpenseLineDetail: { AccountRef: { value: '7', name: 'Supplies' }, ClassRef: { value: 'c1' } } },
    { Id: '2', LineNum: 2, Amount: 200, DetailType: 'ItemBasedExpenseLineDetail',
      ItemBasedExpenseLineDetail: { ItemRef: { value: '11', name: 'Widget' }, Qty: 4, UnitPrice: 50, ClassRef: { value: 'c2' } } },
  ],
};

const EXPENSE = {
  Id: '789',
  SyncToken: '2',
  PaymentType: 'Check',
  AccountRef: { value: '35' },
  DocNumber: '1044',
  Line: [
    { Id: '1', Amount: 100, DetailType: 'AccountBasedExpenseLineDetail',
      AccountBasedExpenseLineDetail: { AccountRef: { value: '62', name: 'Supplies' } } },
  ],
};

const INVOICE = {
  Id: '130',
  SyncToken: '4',
  CustomerRef: { value: '1' },
  Line: [
    { Id: '1', LineNum: 1, Amount: 300, DetailType: 'SalesItemLineDetail', Description: 'Consulting',
      SalesItemLineDetail: { ItemRef: { value: '5', name: 'Hours' }, Qty: 3, UnitPrice: 100, ClassRef: { value: 'cl-9' }, TaxCodeRef: { value: 'TAX' } } },
    { Id: '2', LineNum: 2, Amount: 50, DetailType: 'SalesItemLineDetail', Description: 'Travel',
      SalesItemLineDetail: { ItemRef: { value: '6', name: 'Travel' }, Qty: 1, UnitPrice: 50, TaxCodeRef: { value: 'NON' } } },
    { Amount: 350, DetailType: 'SubTotalLineDetail', SubTotalLineDetail: {} },
  ],
};

const SALES_RECEIPT = {
  Id: '77',
  SyncToken: '0',
  CustomerRef: { value: '3' },
  Line: [
    { Id: '1', LineNum: 1, Amount: 40, DetailType: 'SalesItemLineDetail',
      SalesItemLineDetail: { ItemRef: { value: '8', name: 'Soap' }, Qty: 2, UnitPrice: 20, ClassRef: { value: 'cl-2' }, TaxCodeRef: { value: 'TAX' } } },
    { Amount: 40, DetailType: 'SubTotalLineDetail', SubTotalLineDetail: {} },
  ],
};

// ── stampLineIds (shared helper) ─────────────────────────────────────────────

describe('stampLineIds', () => {
  const existing = [
    { Id: '10', DetailType: 'X', Amount: 1 },
    { Id: '11', DetailType: 'X', Amount: 2 },
  ];

  it('positional: first min(old,new) keep Ids, extra new lines get none', () => {
    const out = stampLineIds(existing, [{ DetailType: 'X' }, { DetailType: 'X' }, { DetailType: 'X' }]);
    expect(ids(out)).toEqual(['10', '11', undefined]);
  });

  it('explicit: uses line_id, unmarked lines are new', () => {
    const out = stampLineIds(existing, [{ DetailType: 'X' }, { DetailType: 'X' }], { explicitIds: ['11', undefined] });
    expect(ids(out)).toEqual(['11', undefined]);
  });

  it('explicit: unknown line_id throws LineIdError', () => {
    expect(() => stampLineIds(existing, [{ DetailType: 'X' }], { explicitIds: ['99'], entityLabel: 'bill' }))
      .toThrow(LineIdError);
    expect(() => stampLineIds(existing, [{ DetailType: 'X' }], { explicitIds: ['99'], entityLabel: 'bill' }))
      .toThrow(/line_id "99".*does not exist on this bill.*10, 11.*Nothing was posted/);
  });

  it('explicit: duplicate line_id throws', () => {
    expect(() => stampLineIds(existing, [{ DetailType: 'X' }, { DetailType: 'X' }], { explicitIds: ['10', '10'] }))
      .toThrow(/more than one line/);
  });

  it('explicit: a SubTotal row Id is not a valid target', () => {
    const lines = [...existing, { Id: '12', DetailType: 'SubTotalLineDetail' }];
    expect(() => stampLineIds(lines, [{ DetailType: 'X' }], { explicitIds: ['12'] })).toThrow(LineIdError);
  });

  it('does not mutate inputs', () => {
    const e = clone(existing);
    const n = [{ DetailType: 'X' }];
    stampLineIds(e, n);
    expect(e).toEqual(existing);
    expect(n).toEqual([{ DetailType: 'X' }]);
  });

  it('replaceLinesWithIds keeps Discount rows verbatim and drops SubTotal', () => {
    const fetched = [
      { Id: '1', DetailType: 'SalesItemLineDetail', Amount: 100, SalesItemLineDetail: {} },
      { Amount: 100, DetailType: 'SubTotalLineDetail', SubTotalLineDetail: {} },
      { Id: '3', DetailType: 'DiscountLineDetail', Amount: 10, DiscountLineDetail: { PercentBased: false } },
    ];
    const out = replaceLinesWithIds(fetched, [{ DetailType: 'SalesItemLineDetail', Amount: 120 }], [{}], salesLineKind, 'invoice');
    expect(out.map((l) => l.DetailType)).toEqual(['SalesItemLineDetail', 'DiscountLineDetail']);
    expect(ids(out)).toEqual(['1', '3']);
  });
});

describe('stampDepositLineIds — behaviour unchanged after generalising', () => {
  it('linked payments by TxnId, direct lines by index, extras get no Id', () => {
    const existing = [
      { Id: '1', Amount: 400, LinkedTxn: [{ TxnId: 'pmt-1', TxnType: 'Payment' }] },
      { Id: '2', Amount: 150, DetailType: 'DepositLineDetail', DepositLineDetail: { AccountRef: { value: '79' } } },
    ];
    const out = stampDepositLineIds(existing, [
      { Amount: 150, DetailType: 'DepositLineDetail', DepositLineDetail: { AccountRef: { value: '80' } } },
      { Amount: 400, LinkedTxn: [{ TxnId: 'pmt-1', TxnType: 'Payment' }] },
      { Amount: 5, LinkedTxn: [{ TxnId: 'pmt-X', TxnType: 'Payment' }] },
      { Amount: 9, DetailType: 'DepositLineDetail', DepositLineDetail: { AccountRef: { value: '81' } } },
    ]);
    expect(ids(out)).toEqual(['2', '1', undefined, undefined]);
  });
});

// ── update_journal_entry ─────────────────────────────────────────────────────

describe('update_journal_entry — Line.Ids carried', () => {
  it('debit/credit account swap on 2 lines keeps both Ids, count 2, sparse false', () => {
    const p = buildJournalEntryUpdatePayload(clone(JE), {
      lines: [
        { posting_type: 'Debit', account_id: '70', amount: 250 },
        { posting_type: 'Credit', account_id: '40', amount: 250 },
      ],
    });
    expect(ids(p.Line)).toEqual(['0', '1']);
    expect(p.Line[0].JournalEntryLineDetail.AccountRef.value).toBe('70');
    expect(p.Line[1].JournalEntryLineDetail.AccountRef.value).toBe('40');
    expect(p.sparse).toBe(false);
  });

  it('explicit line_id (reversed order) matches by id, not position', () => {
    const p = buildJournalEntryUpdatePayload(clone(JE), {
      lines: [
        { line_id: '1', posting_type: 'Credit', account_id: '33', amount: 300 },
        { line_id: '0', posting_type: 'Debit', account_id: '64', amount: 300 },
      ],
    });
    expect(ids(p.Line)).toEqual(['1', '0']);
  });

  it('unknown line_id throws (nothing posted)', () => {
    expect(() => buildJournalEntryUpdatePayload(clone(JE), {
      lines: [{ line_id: '42', posting_type: 'Debit', account_id: '64', amount: 1 }, { posting_type: 'Credit', account_id: '33', amount: 1 }],
    })).toThrow(LineIdError);
  });

  it('growing: 3rd line has no Id', () => {
    const p = buildJournalEntryUpdatePayload(clone(JE), {
      lines: [
        { posting_type: 'Debit', account_id: '64', amount: 200 },
        { posting_type: 'Debit', account_id: '65', amount: 50 },
        { posting_type: 'Credit', account_id: '33', amount: 250 },
      ],
    });
    expect(ids(p.Line)).toEqual(['0', '1', undefined]);
  });

  it('get_journal_entry → update round trip is exact (line_id carried)', () => {
    const shape = qboJournalLinesToUpdateShape(JE.Line);
    expect(shape.map((l) => l.line_id)).toEqual(['0', '1']);
    const p = buildJournalEntryUpdatePayload(clone(JE), { lines: shape });
    expect(ids(p.Line)).toEqual(['0', '1']);
    expect(postedLineStats(p.Line)).toEqual(postedLineStats(JE.Line));
  });

  it('metadata-only update posts the fetched Line untouched, no sparse flag', () => {
    const fetched = clone(JE);
    const p = buildJournalEntryUpdatePayload(fetched, { doc_number: 'JE-2' });
    expect(p.Line).toBe(fetched.Line);
    expect('sparse' in p).toBe(false);
  });
});

// ── update_bill ──────────────────────────────────────────────────────────────

describe('update_bill — Line.Ids carried', () => {
  it('1-line account change keeps Id and count 1 (P0 repro)', () => {
    const one = { ...clone(BILL), Line: [clone(BILL.Line[0])] };
    const p = buildBillUpdatePayload(one, { lines: [{ amount: 100, account_id: '9' }] });
    expect(p.Line).toHaveLength(1);
    expect(p.Line[0].Id).toBe('1');
    expect(p.Line[0].AccountBasedExpenseLineDetail.AccountRef.value).toBe('9');
    expect(p.sparse).toBe(false);
  });

  it('explicit line_id', () => {
    const p = buildBillUpdatePayload(clone(BILL), {
      lines: [{ line_id: '2', amount: 200, detail_type: 'ItemBasedExpenseLineDetail', item_id: '11' }],
    });
    expect(ids(p.Line)).toEqual(['2']);
  });

  it('unknown line_id errors', () => {
    expect(() => buildBillUpdatePayload(clone(BILL), { lines: [{ line_id: 'nope', amount: 1, account_id: '9' }] }))
      .toThrow(/line_id "nope".*bill/);
  });

  it('growing: extra line has no Id', () => {
    const p = buildBillUpdatePayload(clone(BILL), {
      lines: [
        { amount: 100, account_id: '7' },
        { amount: 200, detail_type: 'ItemBasedExpenseLineDetail', item_id: '11' },
        { amount: 5, account_id: '8' },
      ],
    });
    expect(ids(p.Line)).toEqual(['1', '2', undefined]);
  });

  it('shrinking: dropped line absent, sparse false', () => {
    const p = buildBillUpdatePayload(clone(BILL), { lines: [{ amount: 300, account_id: '7' }] });
    expect(ids(p.Line)).toEqual(['1']);
    expect(p.Line).toHaveLength(1);
    expect(p.sparse).toBe(false);
  });

  it('class_id round-trips on item-based lines (was dropped before)', () => {
    const shape = qboBillLinesToUpdateShape(BILL.Line);
    expect(shape.map((l) => l.line_id)).toEqual(['1', '2']);
    const p = buildBillUpdatePayload(clone(BILL), { lines: shape });
    expect(p.Line[1].ItemBasedExpenseLineDetail.ClassRef).toEqual({ value: 'c2' });
    expect(p.Line[1].ItemBasedExpenseLineDetail.ItemRef).toEqual({ value: '11', name: 'Widget' });
    expect(p.Line[0].AccountBasedExpenseLineDetail.ClassRef).toEqual({ value: 'c1' });
    expect(ids(p.Line)).toEqual(['1', '2']);
  });

  it('metadata-only update posts the fetched Line untouched', () => {
    const fetched = clone(BILL);
    const p = buildBillUpdatePayload(fetched, { doc_number: 'B-9', private_note: 'x' });
    expect(p.Line).toBe(fetched.Line);
    expect(p.DocNumber).toBe('B-9');
    expect('sparse' in p).toBe(false);
  });
});

// ── update_expense ───────────────────────────────────────────────────────────

describe('update_expense — Line.Ids carried', () => {
  it('1-line account change keeps Id and count 1', () => {
    const p = buildExpenseUpdatePayload(clone(EXPENSE), { lines: [{ amount: 100, expense_account_id: '63' }] });
    expect(p.Line).toHaveLength(1);
    expect(p.Line[0].Id).toBe('1');
    expect(p.Line[0].AccountBasedExpenseLineDetail.AccountRef.value).toBe('63');
    expect(p.sparse).toBe(false);
  });

  it('explicit line_id + a new line', () => {
    const p = buildExpenseUpdatePayload(clone(EXPENSE), {
      lines: [{ amount: 5, expense_account_id: '64' }, { line_id: '1', amount: 95, expense_account_id: '62' }],
    });
    expect(ids(p.Line)).toEqual([undefined, '1']);
  });

  it('unknown line_id errors', () => {
    expect(() => buildExpenseUpdatePayload(clone(EXPENSE), { lines: [{ line_id: '7', amount: 1 }] })).toThrow(LineIdError);
  });

  it('growing / shrinking', () => {
    const grown = buildExpenseUpdatePayload(clone(EXPENSE), { lines: [{ amount: 60, expense_account_id: '62' }, { amount: 40, expense_account_id: '64' }] });
    expect(ids(grown.Line)).toEqual(['1', undefined]);
    const two = { ...clone(EXPENSE), Line: [clone(EXPENSE.Line[0]), { ...clone(EXPENSE.Line[0]), Id: '2' }] };
    const shrunk = buildExpenseUpdatePayload(two, { lines: [{ amount: 100, expense_account_id: '62' }] });
    expect(ids(shrunk.Line)).toEqual(['1']);
    expect(shrunk.sparse).toBe(false);
  });

  it('get_expense round trip carries line_id and class on item lines', () => {
    const fetched = {
      ...clone(EXPENSE),
      Line: [{ Id: '4', Amount: 30, DetailType: 'ItemBasedExpenseLineDetail',
        ItemBasedExpenseLineDetail: { ItemRef: { value: '2', name: 'Bolt' }, Qty: 3, UnitPrice: 10, ClassRef: { value: 'k' } } }],
    };
    const shape = qboExpenseLinesToUpdateShape(fetched.Line);
    const p = buildExpenseUpdatePayload(clone(fetched), { lines: shape });
    expect(p.Line[0].Id).toBe('4');
    expect(p.Line[0].ItemBasedExpenseLineDetail.ClassRef).toEqual({ value: 'k' });
  });

  it('metadata-only update posts the fetched Line untouched', () => {
    const fetched = clone(EXPENSE);
    const p = buildExpenseUpdatePayload(fetched, { private_note: 'n', entity_ref: { value: 'v9' } });
    expect(p.Line).toBe(fetched.Line);
    expect(p.EntityRef).toEqual({ value: 'v9', type: 'Vendor' });
    expect(p.DocNumber).toBe('1044');
  });
});

// ── update_invoice ───────────────────────────────────────────────────────────

describe('update_invoice — Line.Ids carried', () => {
  it('1-line item change keeps Id, count 1, SubTotal not re-posted', () => {
    const one = { ...clone(INVOICE), Line: [clone(INVOICE.Line[0]), clone(INVOICE.Line[2])] };
    const p = buildInvoiceUpdatePayload(one, { lines: [{ amount: 300, item_id: '99', quantity: 3, unit_price: 100 }] });
    expect(p.Line).toHaveLength(1);
    expect(p.Line[0].Id).toBe('1');
    expect(p.Line[0].SalesItemLineDetail.ItemRef.value).toBe('99');
    expect(p.Line.some((l: any) => l.DetailType === 'SubTotalLineDetail')).toBe(false);
    expect(p.sparse).toBe(false);
  });

  it('SubTotal row is excluded from positional matching and from get_invoice lines', () => {
    const shape = qboSalesLinesToUpdateShape(INVOICE.Line);
    expect(shape).toHaveLength(2);
    expect(shape.map((l) => l.line_id)).toEqual(['1', '2']);
    const p = buildInvoiceUpdatePayload(clone(INVOICE), {
      lines: [{ amount: 1 }, { amount: 2 }, { amount: 3 }],
    });
    expect(ids(p.Line)).toEqual(['1', '2', undefined]);
  });

  it('explicit line_id / unknown line_id', () => {
    const p = buildInvoiceUpdatePayload(clone(INVOICE), { lines: [{ line_id: '2', amount: 50 }] });
    expect(ids(p.Line)).toEqual(['2']);
    expect(() => buildInvoiceUpdatePayload(clone(INVOICE), { lines: [{ line_id: '3', amount: 50 }] })).toThrow(/invoice/);
  });

  it('shrinking: dropped line absent, sparse false', () => {
    const p = buildInvoiceUpdatePayload(clone(INVOICE), { lines: [{ amount: 300, item_id: '5' }] });
    expect(ids(p.Line)).toEqual(['1']);
    expect(p.sparse).toBe(false);
  });

  it('class_id / tax_code_id round-trip (get_invoice → update_invoice)', () => {
    const shape = qboSalesLinesToUpdateShape(INVOICE.Line);
    const p = buildInvoiceUpdatePayload(clone(INVOICE), { lines: shape });
    expect(p.Line[0].SalesItemLineDetail.ClassRef).toEqual({ value: 'cl-9' });
    expect(p.Line[0].SalesItemLineDetail.TaxCodeRef).toEqual({ value: 'TAX' });
    expect(p.Line[1].SalesItemLineDetail.TaxCodeRef).toEqual({ value: 'NON' });
    expect(ids(p.Line)).toEqual(['1', '2']);
    expect(postedLineStats(p.Line)).toEqual(postedLineStats(INVOICE.Line));
  });

  it('DescriptionOnly rows match their own bucket', () => {
    const fetched = { ...clone(INVOICE), Line: [clone(INVOICE.Line[0]), { Id: '5', DetailType: 'DescriptionOnly', Amount: 0, Description: 'Hdr' }] };
    const p = buildInvoiceUpdatePayload(fetched, {
      lines: [{ amount: 0, detail_type: 'DescriptionOnly', description: 'New hdr' }, { amount: 310, item_id: '5' }],
    });
    expect(ids(p.Line)).toEqual(['5', '1']);
  });

  it('metadata-only update posts the fetched Line untouched (incl. SubTotal)', () => {
    const fetched = clone(INVOICE);
    const p = buildInvoiceUpdatePayload(fetched, { doc_number: 'INV-7', due_date: '2026-10-31' });
    expect(p.Line).toBe(fetched.Line);
    expect('sparse' in p).toBe(false);
  });
});

// ── update_sales_receipt ─────────────────────────────────────────────────────

describe('update_sales_receipt — Line.Ids carried', () => {
  it('1-line change keeps Id, count 1, SubTotal excluded', () => {
    const p = buildSalesReceiptUpdatePayload(clone(SALES_RECEIPT), { lines: [{ amount: 45, item_id: '8', quantity: 3, unit_price: 15 }] });
    expect(p.Line).toHaveLength(1);
    expect(p.Line[0].Id).toBe('1');
    expect(p.sparse).toBe(false);
  });

  it('explicit / unknown line_id, growing', () => {
    expect(ids(buildSalesReceiptUpdatePayload(clone(SALES_RECEIPT), { lines: [{ amount: 1 }, { line_id: '1', amount: 2 }] }).Line))
      .toEqual([undefined, '1']);
    expect(() => buildSalesReceiptUpdatePayload(clone(SALES_RECEIPT), { lines: [{ line_id: 'x', amount: 1 }] })).toThrow(/sales receipt/);
    expect(ids(buildSalesReceiptUpdatePayload(clone(SALES_RECEIPT), { lines: [{ amount: 1 }, { amount: 2 }] }).Line))
      .toEqual(['1', undefined]);
  });

  it('class_id / tax_code_id round-trip', () => {
    const shape = qboSalesLinesToUpdateShape(SALES_RECEIPT.Line);
    const p = buildSalesReceiptUpdatePayload(clone(SALES_RECEIPT), { lines: shape });
    expect(p.Line).toHaveLength(1);
    expect(p.Line[0].Id).toBe('1');
    expect(p.Line[0].SalesItemLineDetail.ClassRef).toEqual({ value: 'cl-2' });
    expect(p.Line[0].SalesItemLineDetail.TaxCodeRef).toEqual({ value: 'TAX' });
  });

  it('metadata-only update posts the fetched Line untouched', () => {
    const fetched = clone(SALES_RECEIPT);
    const p = buildSalesReceiptUpdatePayload(fetched, { private_note: 'memo' });
    expect(p.Line).toBe(fetched.Line);
    expect('sparse' in p).toBe(false);
  });
});

describe('get_credit_memo / get_estimate keep the legacy sales shape', () => {
  it('no line_id and Discount rows still mapped when opted out', () => {
    const lines = [{ Id: '1', DetailType: 'SalesItemLineDetail', Amount: 5, SalesItemLineDetail: {} }];
    expect(qboSalesLinesToUpdateShape(lines, { includeLineId: false, editableOnly: false })[0].line_id).toBeUndefined();
  });
});
