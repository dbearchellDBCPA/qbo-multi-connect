import { describe, it, expect } from 'vitest';
import {
  formatTrialBalance,
  formatAgingReport,
  headerPeriod,
  periodMismatchNote,
} from '../../src/server/report-shaping.js';

// ─────────────────────────────────────────────────────────────────────────────
// Trial Balance — Bug (2026-08-15): QBO delivers TB account rows as bare
// ColData objects (row `type` is optional) nested under an unnamed wrapper
// Section. The old parser required type === 'Data', dropped every account,
// and then stamped its own empty accumulation "✓ BALANCED".
// ─────────────────────────────────────────────────────────────────────────────

const TB_COLUMNS = {
  Column: [
    { ColTitle: '', ColType: 'Account' },
    { ColTitle: 'Debit', ColType: 'Money' },
    { ColTitle: 'Credit', ColType: 'Money' },
  ],
};

/** The failing production/sandbox shape: typeless leaf rows in a wrapper Section. */
const TB_NESTED_TYPELESS = {
  Header: { ReportName: 'TrialBalance', StartPeriod: '2026-06-01', EndPeriod: '2026-06-30' },
  Columns: TB_COLUMNS,
  Rows: {
    Row: [
      {
        type: 'Section',
        Rows: {
          Row: [
            { ColData: [{ value: 'Checking', id: '35' }, { value: '1200.00' }, { value: '' }] },
            { ColData: [{ value: 'Accounts Receivable', id: '81' }, { value: '7562.91' }, { value: '' }] },
            { ColData: [{ value: 'Loan Payable', id: '44' }, { value: '' }, { value: '8762.91' }] },
          ],
        },
        Summary: { ColData: [{ value: 'TOTAL' }, { value: '8762.91' }, { value: '8762.91' }] },
        group: 'GrandTotal',
      },
    ],
  },
};

/** The canonical shape: typed flat Data rows plus a grand-total Summary. */
const TB_TYPED_FLAT = {
  Header: { ReportName: 'TrialBalance', StartPeriod: '2026-06-01', EndPeriod: '2026-06-30' },
  Columns: TB_COLUMNS,
  Rows: {
    Row: [
      { type: 'Data', ColData: [{ value: 'Checking' }, { value: '100.00' }, { value: '' }] },
      { type: 'Data', ColData: [{ value: 'Opening Balance Equity' }, { value: '' }, { value: '100.00' }] },
      { type: 'Section', group: 'GrandTotal', Summary: { ColData: [{ value: 'TOTAL' }, { value: '100.00' }, { value: '100.00' }] } },
    ],
  },
};

describe('formatTrialBalance — row recovery', () => {
  it('parses typeless rows nested under an unnamed wrapper Section (the 2026-08-15 failure shape)', () => {
    const out = formatTrialBalance(TB_NESTED_TYPELESS, 'Remote Fur Operations', '2026-06-01', '2026-06-30');
    expect(out).toContain('Accounts Receivable');
    expect(out).toContain('$7,562.91');
    expect(out).toContain('Checking');
    expect(out).toContain('Loan Payable');
    // Parsed totals now real, agree with QBO's own summary row:
    expect(out).toContain('$8,762.91');
    expect(out).toContain("✓ BALANCED (parsed rows match QBO's reported total $8,762.91)");
    expect(out).not.toContain('PARSE');
  });

  it('still parses the canonical typed flat shape', () => {
    const out = formatTrialBalance(TB_TYPED_FLAT, 'Acme');
    expect(out).toContain('Checking');
    expect(out).toContain('Opening Balance Equity');
    expect(out).toContain('✓ BALANCED');
  });

  it('never counts the grand-total row as an account (typeless TOTAL row variant)', () => {
    const report = {
      Columns: TB_COLUMNS,
      Rows: {
        Row: [
          { ColData: [{ value: 'Checking' }, { value: '50.00' }, { value: '' }] },
          { ColData: [{ value: 'Equity' }, { value: '' }, { value: '50.00' }] },
          { group: 'GrandTotal', ColData: [{ value: 'TOTAL' }, { value: '50.00' }, { value: '50.00' }] },
        ],
      },
    };
    const out = formatTrialBalance(report, 'Acme');
    // TOTALS reflect the two account rows only — a doubled total would be $100.
    expect(out).toContain(`  ${'TOTALS'.padEnd(45)} ${'$50.00'.padStart(14)} ${'$50.00'.padStart(14)}`);
  });
});

describe('formatTrialBalance — honest failure modes', () => {
  it('flags a non-empty report whose rows could not be parsed, and never claims BALANCED', () => {
    const report = {
      Header: { StartPeriod: '2026-06-01', EndPeriod: '2026-06-30' },
      Columns: TB_COLUMNS,
      Rows: {
        Row: [
          {
            type: 'Section',
            Rows: { Row: [{ SomethingNew: true }] }, // future structure we cannot parse
            Summary: { ColData: [{ value: 'TOTAL' }, { value: '135398.05' }, { value: '135398.05' }] },
          },
        ],
      },
    };
    const out = formatTrialBalance(report, 'Remote Fur Operations', '2026-06-01', '2026-06-30');
    expect(out).toContain('⚠ PARSE ERROR');
    expect(out).toContain('$135,398.05');
    expect(out).toContain('Raw report JSON follows');
    expect(out).toContain('135398.05'); // raw JSON actually included
    expect(out).not.toContain('✓ BALANCED');
  });

  it('renders an empty period explicitly instead of "BALANCED"', () => {
    const report = {
      Header: { StartPeriod: '2020-01-01', EndPeriod: '2020-12-31' },
      Columns: TB_COLUMNS,
      Rows: {},
    };
    const out = formatTrialBalance(report, 'Acme', '2020-01-01', '2020-12-31');
    expect(out).toContain('the Trial Balance is empty for this period');
    expect(out).not.toContain('✓ BALANCED');
    expect(out).not.toContain('TOTALS');
  });

  it('flags a parsed-vs-QBO total mismatch loudly (missing rows can no longer pass silently)', () => {
    const report = {
      Columns: TB_COLUMNS,
      Rows: {
        Row: [
          { ColData: [{ value: 'Checking' }, { value: '100.00' }, { value: '' }] },
          { ColData: [{ value: 'Equity' }, { value: '' }, { value: '100.00' }] },
          { group: 'GrandTotal', ColData: [{ value: 'TOTAL' }, { value: '135398.05' }, { value: '135398.05' }] },
        ],
      },
    };
    const out = formatTrialBalance(report, 'Acme');
    expect(out).toContain('⚠ PARSE MISMATCH');
    expect(out).toContain('$135,398.05');
    expect(out).not.toContain('✓ BALANCED');
  });

  it('an internally unbalanced parse (debits ≠ credits) reports the difference', () => {
    const report = {
      Columns: TB_COLUMNS,
      Rows: { Row: [{ ColData: [{ value: 'Checking' }, { value: '100.00' }, { value: '' }] }] },
    };
    const out = formatTrialBalance(report, 'Acme');
    expect(out).toContain('⚠ DIFFERENCE: $100.00');
    expect(out).not.toContain('✓ BALANCED');
  });
});

describe('formatTrialBalance — period comes from the response Header', () => {
  it('renders QBO\'s applied period and warns when it differs from the request', () => {
    const report = {
      ...TB_NESTED_TYPELESS,
      Header: { StartPeriod: '2026-07-01', EndPeriod: '2026-07-31' },
    };
    const out = formatTrialBalance(report, 'Acme', '2026-06-01', '2026-06-30');
    expect(out).toContain('Period: 2026-07-01 to 2026-07-31'); // what QBO applied
    expect(out).toContain('⚠ QBO applied a different period than requested');
  });

  it('falls back to the requested dates when the Header has no period', () => {
    const report = { ...TB_TYPED_FLAT, Header: {} };
    const out = formatTrialBalance(report, 'Acme', '2026-06-01', '2026-06-30');
    expect(out).toContain('Period: 2026-06-01 to 2026-06-30');
    expect(out).not.toContain('⚠ QBO applied');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AR/AP Aging — same optional-type row bug: plain (un-sectioned) customers
// arrived as bare ColData rows and were dropped, while QBO's own TOTAL row
// showed the full amount ($837 of rows under a $5,281.52 total, 2026-08-15).
// ─────────────────────────────────────────────────────────────────────────────

const AGING_COLUMNS = {
  Column: [
    { ColTitle: '' },
    { ColTitle: 'Current' },
    { ColTitle: '1 - 30' },
    { ColTitle: '31 - 60' },
    { ColTitle: '61 - 90' },
    { ColTitle: '91 and over' },
    { ColTitle: 'Total' },
  ],
};

const AGING_MIXED = {
  Header: { ReportName: 'AgedReceivables', StartPeriod: '2026-08-15', EndPeriod: '2026-08-15' },
  Columns: AGING_COLUMNS,
  Rows: {
    Row: [
      // Plain customer — typeless bare ColData row (previously dropped)
      { ColData: [{ value: "Amy's Bird Sanctuary" }, { value: '4444.52' }, { value: '' }, { value: '' }, { value: '' }, { value: '' }, { value: '4444.52' }] },
      // Customer with sub-customers — typed Section (previously the only thing rendered)
      {
        type: 'Section',
        Header: { ColData: [{ value: 'Freeman Sporting Goods' }] },
        Rows: {
          Row: [
            { ColData: [{ value: '0969 Ocean View Road' }, { value: '' }, { value: '' }, { value: '' }, { value: '' }, { value: '477.50' }, { value: '477.50' }] },
            { ColData: [{ value: '55 Twin Lane' }, { value: '' }, { value: '' }, { value: '' }, { value: '' }, { value: '85.00' }, { value: '85.00' }] },
          ],
        },
        Summary: { ColData: [{ value: 'Total Freeman Sporting Goods' }, { value: '' }, { value: '' }, { value: '' }, { value: '' }, { value: '562.50' }, { value: '562.50' }] },
      },
      { ColData: [{ value: 'Shara Barnett' }, { value: '' }, { value: '' }, { value: '' }, { value: '' }, { value: '274.50' }, { value: '274.50' }] },
      { group: 'GrandTotal', ColData: [{ value: 'TOTAL' }, { value: '4444.52' }, { value: '' }, { value: '' }, { value: '' }, { value: '837.00' }, { value: '5281.52' }] },
    ],
  },
};

describe('formatAgingReport — row recovery and reconciliation', () => {
  it('renders typeless plain-customer rows alongside sectioned customers', () => {
    const out = formatAgingReport(AGING_MIXED, 'Company A', 'AR', '2026-08-15');
    expect(out).toContain("Amy's Bird Sanctuary");
    expect(out).toContain('FREEMAN SPORTING GOODS');
    expect(out).toContain('0969 Ocean View Road');
    expect(out).toContain('Shara Barnett');
    // Computed grand total now includes the recovered rows and matches QBO:
    expect(out).toContain('$5,281.52');
    expect(out).not.toContain('PARSE MISMATCH');
  });

  it('does not accumulate QBO\'s TOTAL row or section subtotals into the computed totals', () => {
    const out = formatAgingReport(AGING_MIXED, 'Company A', 'AR');
    // Computed TOTAL line: current 4444.52, 91+ 837.00, total 5281.52 — not doubled.
    const totalLines = out.split('\n').filter(l => l.startsWith('TOTAL'));
    const computed = totalLines[totalLines.length - 1];
    expect(computed).toContain('$5,281.52');
    expect(computed).not.toContain('$10,563.04');
  });

  it('flags loudly when parsed rows do not add up to QBO\'s own TOTAL row', () => {
    const missingRows = {
      Columns: AGING_COLUMNS,
      Rows: {
        Row: [
          { ColData: [{ value: 'Shara Barnett' }, { value: '' }, { value: '' }, { value: '' }, { value: '' }, { value: '274.50' }, { value: '274.50' }] },
          { group: 'GrandTotal', ColData: [{ value: 'TOTAL' }, { value: '' }, { value: '' }, { value: '' }, { value: '' }, { value: '837.00' }, { value: '5281.52' }] },
        ],
      },
    };
    const out = formatAgingReport(missingRows, 'Company A', 'AR');
    expect(out).toContain('⚠ PARSE MISMATCH');
    expect(out).toContain('$274.50');
    expect(out).toContain('$5,281.52');
  });

  it('renders an explicitly empty aging when there are no rows and no total', () => {
    const out = formatAgingReport({ Columns: AGING_COLUMNS, Rows: {} }, 'Company A', 'AR', '2020-06-30');
    expect(out).toContain('(no open receivables as of this date)');
  });

  it('echoes the as-of date QBO applied and warns on mismatch with the request', () => {
    const report = { ...AGING_MIXED, Header: { EndPeriod: '2026-08-15' } };
    const out = formatAgingReport(report, 'Company A', 'AR', '2024-06-30');
    expect(out).toContain('As of: 2026-08-15'); // what QBO actually applied
    expect(out).toContain('⚠ QBO applied a different period than requested');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Header period helpers
// ─────────────────────────────────────────────────────────────────────────────

describe('headerPeriod / periodMismatchNote', () => {
  it('extracts StartPeriod/EndPeriod and treats blanks as unknown', () => {
    expect(headerPeriod({ Header: { StartPeriod: '2026-01-01', EndPeriod: '2026-06-30' } }))
      .toEqual({ start: '2026-01-01', end: '2026-06-30' });
    expect(headerPeriod({ Header: { StartPeriod: '' } })).toEqual({ start: undefined, end: undefined });
    expect(headerPeriod({})).toEqual({ start: undefined, end: undefined });
  });

  it('is silent when periods agree or either side is unknown', () => {
    expect(periodMismatchNote({ end: '2026-06-30' }, { end: '2026-06-30' })).toBeNull();
    expect(periodMismatchNote({ end: '2026-06-30' }, {})).toBeNull();
    expect(periodMismatchNote({}, { end: '2026-07-31' })).toBeNull();
  });

  it('describes exactly which bound differs', () => {
    const note = periodMismatchNote({ end: '2026-06-30' }, { end: '2026-07-31' });
    expect(note).toContain('end 2026-07-31 (requested 2026-06-30)');
    const both = periodMismatchNote(
      { start: '2026-06-01', end: '2026-06-30' },
      { start: '2026-07-01', end: '2026-07-31' }
    );
    expect(both).toContain('start 2026-07-01');
    expect(both).toContain('end 2026-07-31');
  });
});
