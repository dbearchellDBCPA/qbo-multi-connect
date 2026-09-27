import { describe, it, expect } from 'vitest';
import {
  DOC_NUMBER_MAX_LENGTH,
  docNumberError,
  applyDocNumberOnCreate,
  applyDocNumberOnUpdate,
  docNumberSummary,
} from '../../src/server/doc-number.js';
import {
  buildJournalEntryCreatePayload,
  buildJournalEntryUpdatePayload,
  buildDepositUpdatePayload,
  qboJournalLinesToUpdateShape,
} from '../../src/server/line-converters.js';

// ─────────────────────────────────────────────────────────────────────────────
// doc_number (QBO DocNumber — "Journal no." / "Ref no.") support.
//
// Hard requirement: a doc_number-only (metadata-only) update must post the
// fetched Line array EXACTLY as QBO returned it — same Ids, same count — plus
// TxnDate, attachments and everything else. Rebuilding lines without Ids is
// what made update_deposit APPEND in production (PR #5).
// ─────────────────────────────────────────────────────────────────────────────

const deepClone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

const existingJE = {
  Id: '901',
  SyncToken: '3',
  DocNumber: 'JE-OLD',
  TxnDate: '2026-06-30',
  PrivateNote: 'Q2 accrual',
  TotalAmt: 1250,
  CurrencyRef: { value: 'USD', name: 'United States Dollar' },
  MetaData: { CreateTime: '2026-07-01T10:00:00-07:00' },
  Line: [
    {
      Id: '0',
      LineNum: 1,
      Amount: 1250,
      Description: 'accrue rent',
      DetailType: 'JournalEntryLineDetail',
      JournalEntryLineDetail: {
        PostingType: 'Debit',
        AccountRef: { value: '64', name: 'Rent' },
        ClassRef: { value: '5', name: 'East' },
        DepartmentRef: { value: '2' },
      },
    },
    {
      Id: '1',
      LineNum: 2,
      Amount: 1250,
      Description: 'accrue rent',
      DetailType: 'JournalEntryLineDetail',
      JournalEntryLineDetail: {
        PostingType: 'Credit',
        AccountRef: { value: '33', name: 'Accrued liabilities' },
        Entity: { Type: 'Vendor', EntityRef: { value: '41', name: 'Landlord LLC' } },
      },
    },
  ],
};

describe('docNumberError — 21-character QBO limit', () => {
  it('accepts undefined, empty, and exactly-21-character values', () => {
    expect(docNumberError(undefined)).toBeNull();
    expect(docNumberError('')).toBeNull();
    expect(docNumberError('A'.repeat(DOC_NUMBER_MAX_LENGTH))).toBeNull();
    expect(DOC_NUMBER_MAX_LENGTH).toBe(21);
  });

  it('rejects 22+ characters with a clear, nothing-posted message', () => {
    const err = docNumberError('B'.repeat(22));
    expect(err).not.toBeNull();
    expect(err).toContain('22 characters');
    expect(err).toContain('at most 21');
    expect(err).toContain('Nothing was posted');
  });
});

describe('create payloads set DocNumber', () => {
  it('create_journal_entry sets DocNumber alongside the built lines', () => {
    const payload = buildJournalEntryCreatePayload({
      txn_date: '2026-09-27',
      doc_number: 'ADJ-2026-09',
      lines: [
        { posting_type: 'Debit', account_id: '64', amount: 100 },
        { posting_type: 'Credit', account_id: '33', amount: 100 },
      ],
    });
    expect(payload.DocNumber).toBe('ADJ-2026-09');
    expect(payload.TxnDate).toBe('2026-09-27');
    expect(payload.Line).toHaveLength(2);
    expect(payload.Line[0].JournalEntryLineDetail.PostingType).toBe('Debit');
  });

  it('create_journal_entry omits DocNumber when not supplied or empty', () => {
    const lines = [
      { posting_type: 'Debit' as const, account_id: '64', amount: 1 },
      { posting_type: 'Credit' as const, account_id: '33', amount: 1 },
    ];
    expect('DocNumber' in buildJournalEntryCreatePayload({ lines })).toBe(false);
    expect('DocNumber' in buildJournalEntryCreatePayload({ lines, doc_number: '' })).toBe(false);
  });

  it('applyDocNumberOnCreate (invoice / bill / sales receipt / deposit) sets only when non-empty', () => {
    expect(applyDocNumberOnCreate({ Line: [] } as any, 'INV-1001').DocNumber).toBe('INV-1001');
    expect('DocNumber' in applyDocNumberOnCreate({ Line: [] } as any, undefined)).toBe(false);
    expect('DocNumber' in applyDocNumberOnCreate({ Line: [] } as any, '')).toBe(false);
  });
});

describe('update_journal_entry — doc_number-only update never touches lines', () => {
  it('preserves the original Line array identically (same Ids, same count) and TxnDate', () => {
    const fetched = deepClone(existingJE);
    const payload = buildJournalEntryUpdatePayload(fetched, { doc_number: 'JE-2026-001' });

    expect(payload.DocNumber).toBe('JE-2026-001');
    // Line posted by reference — never rebuilt.
    expect(payload.Line).toBe(fetched.Line);
    expect(payload.Line).toEqual(existingJE.Line);
    expect(payload.Line).toHaveLength(2);
    expect(payload.Line.map((l: any) => l.Id)).toEqual(['0', '1']);
    // Everything else carried through verbatim.
    expect(payload.TxnDate).toBe('2026-06-30');
    expect(payload.SyncToken).toBe('3');
    expect(payload.PrivateNote).toBe('Q2 accrual');
    expect(payload.CurrencyRef).toEqual(existingJE.CurrencyRef);
    expect(payload.Id).toBe('901');
    // Fetched object not mutated.
    expect(fetched.DocNumber).toBe('JE-OLD');
  });

  it('omitting doc_number leaves the existing DocNumber alone', () => {
    const payload = buildJournalEntryUpdatePayload(deepClone(existingJE), { private_note: 'memo only' });
    expect(payload.DocNumber).toBe('JE-OLD');
    expect(payload.Line.map((l: any) => l.Id)).toEqual(['0', '1']);
  });

  it('doc_number "" clears the number (still without touching lines)', () => {
    const payload = buildJournalEntryUpdatePayload(deepClone(existingJE), { doc_number: '' });
    expect(payload.DocNumber).toBe('');
    expect(payload.Line).toEqual(existingJE.Line);
  });

  it('replacement lines are still built from the caller input when passed (semantics unchanged)', () => {
    const payload = buildJournalEntryUpdatePayload(deepClone(existingJE), {
      doc_number: 'JE-2',
      lines: [
        { posting_type: 'Debit', account_id: '64', amount: 50 },
        { posting_type: 'Credit', account_id: '33', amount: 50 },
      ],
    });
    expect(payload.DocNumber).toBe('JE-2');
    expect(payload.Line).toHaveLength(2);
    expect(payload.Line[0].Amount).toBe(50);
  });

  it('get_journal_entry shape round-trips: lines from get → update rebuild the same line content', () => {
    const shape = qboJournalLinesToUpdateShape(existingJE.Line);
    const payload = buildJournalEntryUpdatePayload(deepClone(existingJE), { lines: shape });
    expect(payload.Line).toHaveLength(existingJE.Line.length);
    expect(payload.Line[1].JournalEntryLineDetail.Entity).toEqual(existingJE.Line[1].JournalEntryLineDetail.Entity);
  });
});

describe('update_deposit — doc_number-only update keeps lines untouched', () => {
  const existingDeposit = {
    Id: '48',
    SyncToken: '5',
    TxnDate: '2026-09-10',
    DepositToAccountRef: { value: '35' },
    Line: [
      { Id: '1', LineNum: 1, Amount: 400, LinkedTxn: [{ TxnId: 'pmt-1', TxnType: 'Payment' }] },
      {
        Id: '2',
        LineNum: 2,
        Amount: 80,
        DetailType: 'DepositLineDetail',
        DepositLineDetail: { AccountRef: { value: '182' }, ClassRef: { value: '7' } },
      },
    ],
  };

  it('sets DocNumber and posts the fetched Line array by reference, no sparse flip', () => {
    const fetched = deepClone(existingDeposit);
    const payload = buildDepositUpdatePayload(fetched, { doc_number: 'DEP-0910' });
    expect(payload.DocNumber).toBe('DEP-0910');
    expect(payload.Line).toBe(fetched.Line);
    expect(payload.Line.map((l: any) => l.Id)).toEqual(['1', '2']);
    expect(payload.TxnDate).toBe('2026-09-10');
    expect(payload.sparse).toBeUndefined();
  });

  it('omitting doc_number leaves DocNumber absent/unchanged', () => {
    const payload = buildDepositUpdatePayload({ ...deepClone(existingDeposit), DocNumber: 'KEEP' }, { private_note: 'x' });
    expect(payload.DocNumber).toBe('KEEP');
  });
});

describe('applyDocNumberOnUpdate (invoice / bill / sales receipt handlers)', () => {
  const fixtures: Record<string, any> = {
    Invoice: {
      Id: '130', SyncToken: '1', DocNumber: '1037', TxnDate: '2026-08-01',
      Line: [
        { Id: '1', LineNum: 1, Amount: 300, DetailType: 'SalesItemLineDetail', SalesItemLineDetail: { ItemRef: { value: '9' }, Qty: 3, UnitPrice: 100 } },
        { Amount: 300, DetailType: 'SubTotalLineDetail', SubTotalLineDetail: {} },
      ],
    },
    Bill: {
      Id: '77', SyncToken: '0', TxnDate: '2026-08-02',
      Line: [
        { Id: '1', LineNum: 1, Amount: 55, DetailType: 'AccountBasedExpenseLineDetail', AccountBasedExpenseLineDetail: { AccountRef: { value: '60' } } },
        { Id: '2', LineNum: 2, Amount: 45, DetailType: 'ItemBasedExpenseLineDetail', ItemBasedExpenseLineDetail: { ItemRef: { value: '3' }, Qty: 1, UnitPrice: 45 } },
      ],
    },
    SalesReceipt: {
      Id: '12', SyncToken: '4', TxnDate: '2026-08-03',
      Line: [
        { Id: '1', LineNum: 1, Amount: 20, DetailType: 'SalesItemLineDetail', SalesItemLineDetail: { ItemRef: { value: '1' } } },
      ],
    },
  };

  for (const [entity, fixture] of Object.entries(fixtures)) {
    it(`${entity}: sets DocNumber and leaves Line (Ids + count) and TxnDate identical`, () => {
      const fetched = deepClone(fixture);
      const payload = applyDocNumberOnUpdate({ ...fetched }, 'REF-42');
      expect(payload.DocNumber).toBe('REF-42');
      expect(payload.Line).toBe(fetched.Line);
      expect(payload.Line).toEqual(fixture.Line);
      expect(payload.Line).toHaveLength(fixture.Line.length);
      expect(payload.TxnDate).toBe(fixture.TxnDate);
      expect(payload.SyncToken).toBe(fixture.SyncToken);
    });
  }

  it('undefined leaves DocNumber untouched; "" clears it', () => {
    expect(applyDocNumberOnUpdate({ DocNumber: '1037' } as any, undefined).DocNumber).toBe('1037');
    expect(applyDocNumberOnUpdate({ DocNumber: '1037' } as any, '').DocNumber).toBe('');
  });
});

describe('docNumberSummary', () => {
  it('renders a labelled suffix only when a DocNumber exists', () => {
    expect(docNumberSummary({ DocNumber: 'JE-1' }, 'Journal No')).toBe(' | Journal No: JE-1');
    expect(docNumberSummary({ DocNumber: 'R-9' })).toBe(' | Ref No: R-9');
    expect(docNumberSummary({})).toBe('');
    expect(docNumberSummary({ DocNumber: '' })).toBe('');
    expect(docNumberSummary(undefined)).toBe('');
  });
});
