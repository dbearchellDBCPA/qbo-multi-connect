import { describe, it, expect } from 'vitest';
import {
  resolveAccountFilterTerms,
  expandToDescendants,
  parseGeneralLedger,
  summarizeGeneralLedger,
  stripQboNoise,
  filterBudgets,
  budgetToSummary,
} from '../../src/server/report-shaping.js';

// ─────────────────────────────────────────────────────────────────────────────
// Account-filter resolution — the layer behind get_general_ledger's
// accounts / account_filter params. Bug 2 (2026-08-13): a filter that
// resolves to nothing must never silently fall through to the full GL,
// and "4404" must catch the 4404-* sub-accounts a bookkeeper expects.
// ─────────────────────────────────────────────────────────────────────────────

const CHART = [
  { Id: '76', Name: 'Checking', AcctNum: '1000' },
  { Id: '81', Name: 'Accounts Receivable', AcctNum: '1200' },
  { Id: '90', Name: 'Endowment', AcctNum: '4404' },
  { Id: '91', Name: 'Endowment - Scholarships', AcctNum: '4404-1', FullyQualifiedName: 'Endowment:Scholarships' },
  { Id: '92', Name: 'Endowment - Capital', AcctNum: '4404.2', FullyQualifiedName: 'Endowment:Capital' },
  { Id: '93', Name: 'Tuition', AcctNum: '44040' },
  { Id: '94', Name: 'Utilities', AcctNum: '7600' },
  { Id: '95', Name: 'Wages Pastoral', AcctNum: '5012' },
  { Id: '96', Name: 'Wages Admin' }, // no account number
];

describe('resolveAccountFilterTerms — number matching', () => {
  it('matches an exact account number', () => {
    const { ids, unresolved } = resolveAccountFilterTerms(CHART, ['5012']);
    expect(ids).toEqual(['95']);
    expect(unresolved).toEqual([]);
  });

  it('prefix-matches sub-accounts at a separator boundary: "4404" catches 4404, 4404-1, 4404.2 — not 44040', () => {
    const { ids } = resolveAccountFilterTerms(CHART, ['4404']);
    expect(ids.sort()).toEqual(['90', '91', '92']);
    expect(ids).not.toContain('93'); // 44040 is a different account, not a sub-account
  });

  it('does not treat a short number as a prefix of longer numbers without a separator ("76" ≠ 7600)', () => {
    const { ids } = resolveAccountFilterTerms(CHART, ['76']);
    // Only the QBO-ID match (Checking has Id 76) — NOT account 7600.
    expect(ids).toEqual(['76']);
  });

  it('unions QBO-ID and account-number interpretations so a collision never silently picks one', () => {
    // "1200" is account 81's AcctNum; no account has Id 1200 → just 81.
    expect(resolveAccountFilterTerms(CHART, ['1200']).ids).toEqual(['81']);
    // "76" is both an Id (Checking) and — if an AcctNum 76 existed — a number.
    const chart = [...CHART, { Id: '200', Name: 'Misc', AcctNum: '76' }];
    const { ids } = resolveAccountFilterTerms(chart, ['76']);
    expect(ids.sort()).toEqual(['200', '76']);
  });
});

describe('resolveAccountFilterTerms — name matching', () => {
  it('matches an exact name case-insensitively', () => {
    expect(resolveAccountFilterTerms(CHART, ['wages pastoral']).ids).toEqual(['95']);
  });

  it('matches a FullyQualifiedName', () => {
    expect(resolveAccountFilterTerms(CHART, ['Endowment:Scholarships']).ids).toEqual(['91']);
  });

  it('resolves "number name" strings via the number part (including sub-accounts)', () => {
    const { ids } = resolveAccountFilterTerms(CHART, ['4404 Endowment']);
    expect(ids.sort()).toEqual(['90', '91', '92']);
  });

  it('falls back to name substring as a last resort (may match several)', () => {
    const { ids } = resolveAccountFilterTerms(CHART, ['wages']);
    expect(ids.sort()).toEqual(['95', '96']);
  });
});

describe('resolveAccountFilterTerms — dashed sub-account numbers', () => {
  // 2026-08-24: "1700-00" (and "1700-00 Partnerships Owned") failed to
  // resolve and was silently dropped from a GL pull.
  const chart = [
    { Id: '34', Name: 'Partnerships Owned', AcctNum: '1700-00' },
    { Id: '35', Name: 'Eastside Fund III', AcctNum: '1700-01' },
  ];

  it('resolves a dashed account number exactly, without bleeding into siblings', () => {
    const { ids, unresolved } = resolveAccountFilterTerms(chart, ['1700-00']);
    expect(ids).toEqual(['34']);
    expect(unresolved).toEqual([]);
  });

  it('resolves "dashed-number name" strings via the number token', () => {
    const { ids } = resolveAccountFilterTerms(chart, ['1700-00 Partnerships Owned']);
    expect(ids).toEqual(['34']);
  });

  it('resolves the number even when the account has no AcctNum but embeds it in the Name', () => {
    const numless = [{ Id: '34', Name: '1700-00 Partnerships Owned' }];
    const { ids } = resolveAccountFilterTerms(numless, ['1700-00']);
    expect(ids).toEqual(['34']); // name-substring fallback
  });
});

describe('expandToDescendants', () => {
  const chart = [
    { Id: '34', Name: 'Partnerships Owned', AcctNum: '1700-00' },
    { Id: '35', Name: 'Eastside Fund III', AcctNum: '1700-01', ParentRef: { value: '34' } },
    { Id: '36', Name: 'Westside Fund', AcctNum: '1700-02', ParentRef: { value: '34' } },
    { Id: '37', Name: 'Westside Fund B', AcctNum: '1700-02-1', ParentRef: { value: '36' } },
    { Id: '99', Name: 'Unrelated' },
  ];

  it('expands a parent to itself plus all descendants (grandchildren included)', () => {
    expect(expandToDescendants(chart, ['34']).sort()).toEqual(['34', '35', '36', '37']);
  });

  it('leaves leaf accounts alone and never adds unrelated accounts', () => {
    expect(expandToDescendants(chart, ['35'])).toEqual(['35']);
  });
});

describe('resolveAccountFilterTerms — never silent', () => {
  it('reports unmatched terms instead of dropping them', () => {
    const { ids, unresolved } = resolveAccountFilterTerms(CHART, ['9999', 'Checking']);
    expect(ids).toEqual(['76']);
    expect(unresolved).toEqual(['9999']);
  });

  it('returns no ids at all when nothing matches (caller must error, not run unfiltered)', () => {
    const { ids, unresolved } = resolveAccountFilterTerms(CHART, ['zzz']);
    expect(ids).toEqual([]);
    expect(unresolved).toEqual(['zzz']);
  });

  it('ignores empty/whitespace terms', () => {
    const { ids, unresolved } = resolveAccountFilterTerms(CHART, ['  ', '5012']);
    expect(ids).toEqual(['95']);
    expect(unresolved).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GL summary mode (Bug 5 hardening)
// ─────────────────────────────────────────────────────────────────────────────

describe('summarizeGeneralLedger', () => {
  it('drops transaction rows but keeps per-account totals and a count', () => {
    const parsed = {
      client: 'Acme',
      period: { start: '2026-07-01', end: '2026-07-31' },
      accounts: [
        {
          number: '4404',
          name: 'Endowment',
          transactions: [{ amount: 1 }, { amount: 2 }],
          total_debits: 3,
          total_credits: 0,
          opening_balance: 0,
          ending_balance: 3,
        },
      ],
      total_accounts: 1,
      total_transactions: 2,
    };
    const summary = summarizeGeneralLedger(parsed);
    expect(summary.detail_level).toBe('summary');
    expect(summary.accounts[0]).toEqual({
      number: '4404',
      name: 'Endowment',
      transaction_count: 2,
      total_debits: 3,
      total_credits: 0,
      opening_balance: 0,
      ending_balance: 3,
    });
    expect(summary.accounts[0]).not.toHaveProperty('transactions');
    expect(summary.total_transactions).toBe(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GL debit/credit attribution (P1, 2026-08-24): QBO's signed amount column is
// positive in the account's NORMAL-BALANCE direction — "positive = debit" is
// only true for debit-normal accounts. Liability/equity/income came out
// swapped (liability deposits reported as debits, income all-debit).
// ─────────────────────────────────────────────────────────────────────────────

const GL_DEFAULT_COLUMNS = {
  Column: [
    { ColTitle: 'Date' }, { ColTitle: 'Transaction Type' }, { ColTitle: 'Num' },
    { ColTitle: 'Name' }, { ColTitle: 'Memo/Description' }, { ColTitle: 'Split' },
    { ColTitle: 'Amount' }, { ColTitle: 'Balance' },
  ],
};

function glRow(date: string, type: string, amount: string, balance: string, memo = '', num = ''): any {
  return { ColData: [
    { value: date }, { value: type }, { value: num }, { value: '' },
    { value: memo }, { value: 'Truist x2631' }, { value: amount }, { value: balance },
  ] };
}

const CHART_FOR_GL = [
  { Id: '88', Name: 'Advance From H2 Energy', AcctNum: '2400-01', Classification: 'Liability' },
  { Id: '90', Name: 'Interest – Notes', AcctNum: '3130-00', Classification: 'Revenue' },
  { Id: '91', Name: 'Directors Fees', AcctNum: '5090-00', Classification: 'Expense' },
  { Id: '92', Name: 'H3K, LLLP', AcctNum: '1700-01', Classification: 'Asset' },
];

describe('parseGeneralLedger — classification-based debit/credit (no explicit columns)', () => {
  const report = {
    Columns: GL_DEFAULT_COLUMNS,
    Rows: { Row: [
      {
        Header: { ColData: [{ value: '2400-01 Advance From H2 Energy', id: '88' }] },
        Rows: { Row: [
          glRow('2026-03-24', 'Deposit', '13100.00', '13100.00'),
          glRow('2026-04-16', 'Deposit', '35000.00', '48100.00'),
          glRow('2026-04-30', 'Journal Entry', '-6666.67', '41433.33', 'mgmt fee'),
        ] },
        Summary: { ColData: [{ value: 'Total for 2400-01' }, { value: '' }, { value: '' }, { value: '' }, { value: '' }, { value: '' }, { value: '' }, { value: '41433.33' }] },
      },
      {
        Header: { ColData: [{ value: '5090-00 Directors Fees', id: '91' }] },
        Rows: { Row: [glRow('2026-05-01', 'Bill', '20000.00', '20000.00')] },
      },
      {
        Header: { ColData: [{ value: '1700-01 H3K, LLLP', id: '92' }] },
        Rows: { Row: [glRow('2026-06-01', 'Journal Entry', '-190000.00', '-190000.00')] },
      },
    ] },
  };
  const parsed = parseGeneralLedger(report, 'H2 Capital', '2026-01-01', '2026-12-31', CHART_FOR_GL);

  it('liability: positive amounts are CREDITS (increase the liability), negative are debits', () => {
    const liab = parsed.accounts.find((a: any) => a.number === '2400-01');
    expect(liab.total_credits).toBe(48100);
    expect(liab.total_debits).toBe(6666.67);
    expect(liab.transactions[0]).toMatchObject({ amount: 13100, debit: 0, credit: 13100 });
    expect(liab.transactions[2]).toMatchObject({ amount: -6666.67, debit: 6666.67, credit: 0 });
    expect(liab.classification).toBe('Liability');
  });

  it('expense: positive amounts stay DEBITS (unchanged behavior for debit-normal accounts)', () => {
    const exp = parsed.accounts.find((a: any) => a.number === '5090-00');
    expect(exp.total_debits).toBe(20000);
    expect(exp.total_credits).toBe(0);
  });

  it('asset: negative amounts stay CREDITS (unchanged behavior)', () => {
    const asset = parsed.accounts.find((a: any) => a.number === '1700-01');
    expect(asset.total_credits).toBe(190000);
    expect(asset.total_debits).toBe(0);
  });

  it('reports the attribution source and populates number from the header', () => {
    expect(parsed.debit_credit_source).toBe('amount_sign_by_classification');
    expect(parsed.accounts.map((a: any) => a.number).sort()).toEqual(['1700-01', '2400-01', '5090-00']);
  });

  it('falls back to debit-normal when the account is unknown (no chart provided)', () => {
    const noChart = parseGeneralLedger(report, 'H2 Capital', '2026-01-01', '2026-12-31');
    const liab = noChart.accounts.find((a: any) => a.number === '2400-01');
    expect(liab.total_debits).toBe(48100); // old behavior — only without classification data
  });
});

describe('parseGeneralLedger — explicit Debit/Credit report columns win', () => {
  const report = {
    Columns: { Column: [
      { ColTitle: 'Date' }, { ColTitle: 'Transaction Type' }, { ColTitle: 'Num' },
      { ColTitle: 'Name' }, { ColTitle: 'Memo/Description' }, { ColTitle: 'Split' },
      { ColTitle: 'Debit' }, { ColTitle: 'Credit' }, { ColTitle: 'Amount' }, { ColTitle: 'Balance' },
    ] },
    Rows: { Row: [
      {
        Header: { ColData: [{ value: '3130-00 Interest – Notes', id: '90' }] },
        Rows: { Row: [
          { ColData: [
            { value: '2026-02-01' }, { value: 'Deposit' }, { value: '' }, { value: '' },
            { value: '' }, { value: 'Truist' }, { value: '' }, { value: '6807.10' }, { value: '6807.10' }, { value: '6807.10' },
          ] },
        ] },
      },
    ] },
  };

  it('uses the report columns directly and tags the source', () => {
    const parsed = parseGeneralLedger(report, 'H2 Capital', '2026-01-01', '2026-12-31', CHART_FOR_GL);
    expect(parsed.debit_credit_source).toBe('report_columns');
    const income = parsed.accounts[0];
    expect(income.transactions[0]).toMatchObject({ debit: 0, credit: 6807.1 });
    expect(income.total_credits).toBe(6807.1);
    expect(income.total_debits).toBe(0);
  });
});

describe('parseGeneralLedger — dashed account numbers and AcctNum backfill', () => {
  it('extracts dashed numbers from the header and prefers the chart\'s AcctNum', () => {
    const report = {
      Columns: GL_DEFAULT_COLUMNS,
      Rows: { Row: [
        {
          // header without id and with a name-only label — number comes from
          // the chart lookup by name
          Header: { ColData: [{ value: 'Advance From H2 Energy' }] },
          Rows: { Row: [glRow('2026-03-24', 'Deposit', '100.00', '100.00')] },
        },
      ] },
    };
    const parsed = parseGeneralLedger(report, 'H2 Capital', '2026-01-01', '2026-12-31', CHART_FOR_GL);
    expect(parsed.accounts[0].number).toBe('2400-01'); // backfilled from AcctNum
    expect(parsed.accounts[0].classification).toBe('Liability');
    expect(parsed.accounts[0].total_credits).toBe(100);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GL ending_balance (2026-08-25): the tracker skipped any row whose running
// balance was exactly 0.00 (`if (balance !== 0)` — written to ignore BLANK
// balance cells, which also parse to 0), so an account whose final credit
// netted it to exactly zero reported the SECOND-TO-LAST row's balance
// (50.75 instead of 0.00 on Samuel Bauer acct 114). The same guard threw
// away QBO's own Summary-row balance of 0.00. Invariants held below:
//   1. ending_balance == transactions[-1].balance            (non-empty)
//   2. ending_balance == opening_balance + net activity in the account's
//      normal-balance direction (debits-credits, or credits-debits)
//   3. ending_balance == opening_balance + Σ transaction amounts (natural sign)
//   4. empty transactions → ending_balance == opening_balance
// ─────────────────────────────────────────────────────────────────────────────

const CHART_SB = [
  { Id: '114', Name: 'Inventory (Temporary)', AcctNum: '114', Classification: 'Asset' },
  { Id: '510', Name: 'Freight & Delivery', AcctNum: '510', Classification: 'Expense' },
  { Id: '400', Name: 'Sales', AcctNum: '400', Classification: 'Revenue' },
];

function glBeginningBalanceRow(balance: string): any {
  return { ColData: [
    { value: 'Beginning Balance' }, { value: '' }, { value: '' }, { value: '' },
    { value: '' }, { value: '' }, { value: '' }, { value: balance },
  ] };
}

function glSummary(label: string, balance: string): any {
  return { ColData: [
    { value: label }, { value: '' }, { value: '' }, { value: '' },
    { value: '' }, { value: '' }, { value: '' }, { value: balance },
  ] };
}

function glSection(header: string, id: string, rows: any[], summary?: any): any {
  const section: any = {
    Header: { ColData: [{ value: header, id }] },
    Rows: { Row: rows },
  };
  if (summary) section.Summary = summary;
  return section;
}

/** Invariants 1–3 (4 for the empty case), from the account's own fields. */
function expectGlInvariants(a: any): void {
  const sumAmount = a.transactions.reduce((s: number, t: any) => s + t.amount, 0);
  expect(a.ending_balance).toBeCloseTo(a.opening_balance + sumAmount, 2);
  const creditNormal = ['Liability', 'Equity', 'Revenue'].includes(a.classification);
  const net = creditNormal ? a.total_credits - a.total_debits : a.total_debits - a.total_credits;
  expect(a.ending_balance).toBeCloseTo(a.opening_balance + net, 2);
  if (a.transactions.length > 0) {
    expect(a.ending_balance).toBeCloseTo(a.transactions[a.transactions.length - 1].balance, 2);
  } else {
    expect(a.ending_balance).toBe(a.opening_balance);
  }
}

// The Samuel Bauer acct-114 repro: the final Bill credit lands the running
// balance on exactly 0.00, and the last two rows share doc_number 260711.
const INVENTORY_ROWS = [
  glRow('2026-07-30', 'Bill', '9058.53', '9058.53', '', 'CINV105699001'),
  glRow('2026-07-31', 'Journal Entry', '-10265.08', '-1206.55'),
  glRow('2026-07-31', 'Bill', '778.80', '-427.75', '', 'CINV105703702'),
  glRow('2026-07-31', 'Bill', '478.50', '50.75', '', '260711'),
  glRow('2026-07-31', 'Bill', '-50.75', '0.00', '', '260711'),
];

describe('parseGeneralLedger — ending_balance when the final row nets to zero', () => {
  it('reports 0.00 (not the second-to-last balance) when the final credit lands the balance on exactly zero', () => {
    const report = {
      Columns: GL_DEFAULT_COLUMNS,
      Rows: { Row: [
        glSection('114 Inventory (Temporary)', '114', INVENTORY_ROWS,
          glSummary('Total for 114 Inventory (Temporary)', '0.00')),
      ] },
    };
    const parsed = parseGeneralLedger(report, 'Samuel Bauer', '2026-01-01', '2026-07-31', CHART_SB);
    const a = parsed.accounts[0];
    expect(a.ending_balance).toBe(0); // was 50.75 — the second-to-last row's balance
    expect(a.opening_balance).toBe(0);
    expect(a.total_debits).toBeCloseTo(10315.83, 2);
    expect(a.total_credits).toBeCloseTo(10315.83, 2);
    // Both same-date, same-doc_number 260711 rows stay in the array AND in the balance math.
    expect(a.transactions).toHaveLength(5);
    expect(a.transactions.filter((t: any) => t.doc_number === '260711')).toHaveLength(2);
    expectGlInvariants(a);
    expect(parsed.warnings).toBeUndefined(); // internally consistent — no mismatch warning
  });

  it('reports 0.00 from the last row even when the Summary row carries no balance', () => {
    const report = {
      Columns: GL_DEFAULT_COLUMNS,
      Rows: { Row: [
        glSection('114 Inventory (Temporary)', '114', INVENTORY_ROWS,
          glSummary('Total for 114 Inventory (Temporary)', '')), // blank balance cell ≠ zero
      ] },
    };
    const a = parseGeneralLedger(report, 'Samuel Bauer', '2026-01-01', '2026-07-31', CHART_SB).accounts[0];
    expect(a.ending_balance).toBe(0);
    expectGlInvariants(a);
  });

  it('honors an explicit Summary balance of 0.00 and warns when it contradicts the parsed rows', () => {
    const report = {
      Columns: GL_DEFAULT_COLUMNS,
      Rows: { Row: [
        // Final credit row missing → rows end at 50.75, but QBO's own total says 0.00.
        glSection('114 Inventory (Temporary)', '114', INVENTORY_ROWS.slice(0, 4),
          glSummary('Total for 114 Inventory (Temporary)', '0.00')),
      ] },
    };
    const parsed = parseGeneralLedger(report, 'Samuel Bauer', '2026-01-01', '2026-07-31', CHART_SB);
    expect(parsed.accounts[0].ending_balance).toBe(0); // QBO's stated total wins
    expect(parsed.warnings).toHaveLength(1);
    expect(parsed.warnings[0]).toContain('114 Inventory (Temporary)');
    expect(parsed.warnings[0]).toContain('disagrees');
  });

  it('nets an opening balance to zero when the only transaction is the offsetting credit', () => {
    const report = {
      Columns: GL_DEFAULT_COLUMNS,
      Rows: { Row: [
        glSection('114 Inventory (Temporary)', '114', [
          glBeginningBalanceRow('100.00'),
          glRow('2026-07-31', 'Journal Entry', '-100.00', '0.00'),
        ]),
      ] },
    };
    const a = parseGeneralLedger(report, 'Samuel Bauer', '2026-01-01', '2026-07-31', CHART_SB).accounts[0];
    expect(a.opening_balance).toBe(100);
    expect(a.ending_balance).toBe(0); // was 100 — the beginning balance never overwritten
    expect(a.transactions).toHaveLength(1); // the Beginning Balance row is not a transaction
    expectGlInvariants(a);
  });
});

describe('parseGeneralLedger — ending_balance across row and account shapes', () => {
  it('final row is a debit: ending_balance is that row\'s running balance', () => {
    const report = {
      Columns: GL_DEFAULT_COLUMNS,
      Rows: { Row: [
        glSection('114 Inventory (Temporary)', '114', [
          glRow('2026-03-01', 'Journal Entry', '-100.00', '-100.00'),
          glRow('2026-03-15', 'Bill', '250.00', '150.00'),
        ]),
      ] },
    };
    const a = parseGeneralLedger(report, 'Samuel Bauer', '2026-01-01', '2026-07-31', CHART_SB).accounts[0];
    expect(a.ending_balance).toBe(150);
    expect(a.total_debits).toBe(250);
    expect(a.total_credits).toBe(100);
    expectGlInvariants(a);
  });

  it('all-credit account (credit-normal): ending_balance follows the natural-signed running balance', () => {
    const report = {
      Columns: GL_DEFAULT_COLUMNS,
      Rows: { Row: [
        glSection('400 Sales', '400', [
          glRow('2026-02-01', 'Invoice', '100.00', '100.00'),
          glRow('2026-02-15', 'Invoice', '250.50', '350.50'),
          glRow('2026-02-28', 'Sales Receipt', '400.00', '750.50'),
        ]),
      ] },
    };
    const a = parseGeneralLedger(report, 'Samuel Bauer', '2026-01-01', '2026-07-31', CHART_SB).accounts[0];
    expect(a.classification).toBe('Revenue');
    expect(a.total_credits).toBeCloseTo(750.5, 2);
    expect(a.total_debits).toBe(0);
    expect(a.ending_balance).toBeCloseTo(750.5, 2);
    expectGlInvariants(a);
  });

  it('empty period: no transactions → ending_balance == opening_balance (and survives summary mode)', () => {
    const report = {
      Columns: GL_DEFAULT_COLUMNS,
      Rows: { Row: [
        glSection('114 Inventory (Temporary)', '114', [glBeginningBalanceRow('1250.00')],
          glSummary('Total for 114 Inventory (Temporary)', '1250.00')),
      ] },
    };
    const parsed = parseGeneralLedger(report, 'Samuel Bauer', '2026-01-01', '2026-07-31', CHART_SB);
    const a = parsed.accounts[0];
    expect(a.transactions).toEqual([]);
    expect(a.opening_balance).toBe(1250);
    expect(a.ending_balance).toBe(1250);
    expectGlInvariants(a);
    const summary = summarizeGeneralLedger(parsed);
    expect(summary.accounts[0]).toMatchObject({ transaction_count: 0, opening_balance: 1250, ending_balance: 1250 });
  });

  it('multi-account pull: each account\'s ending_balance is computed independently', () => {
    const report = {
      Columns: GL_DEFAULT_COLUMNS,
      Rows: { Row: [
        glSection('114 Inventory (Temporary)', '114', INVENTORY_ROWS,
          glSummary('Total for 114 Inventory (Temporary)', '0.00')),
        glSection('510 Freight & Delivery', '510', [
          glRow('2026-04-02', 'Bill', '125.00', '125.00'),
          glRow('2026-05-11', 'Expense', '75.10', '200.10'),
        ], glSummary('Total for 510 Freight & Delivery', '200.10')),
      ] },
    };
    const parsed = parseGeneralLedger(report, 'Samuel Bauer', '2026-01-01', '2026-07-31', CHART_SB);
    expect(parsed.total_accounts).toBe(2);
    const inv = parsed.accounts.find((a: any) => a.number === '114');
    const freight = parsed.accounts.find((a: any) => a.number === '510');
    expect(inv.ending_balance).toBe(0); // the zero does not bleed into 510…
    expect(freight.ending_balance).toBeCloseTo(200.1, 2); // …and 510's balance does not bleed into 114
    expect(freight.total_debits).toBeCloseTo(200.1, 2);
    expectGlInvariants(inv);
    expectGlInvariants(freight);
    expect(parsed.warnings).toBeUndefined();
  });

  it('no Balance column at all: ending_balance is derived from opening + activity, not silently 0', () => {
    const report = {
      Columns: { Column: [
        { ColTitle: 'Date' }, { ColTitle: 'Transaction Type' }, { ColTitle: 'Num' },
        { ColTitle: 'Name' }, { ColTitle: 'Memo/Description' }, { ColTitle: 'Split' },
        { ColTitle: 'Amount' },
      ] },
      Rows: { Row: [
        glSection('114 Inventory (Temporary)', '114', [
          glRow('2026-03-01', 'Bill', '100.00', ''),
          glRow('2026-03-20', 'Journal Entry', '-25.50', ''),
        ]),
      ] },
    };
    const parsed = parseGeneralLedger(report, 'Samuel Bauer', '2026-01-01', '2026-07-31', CHART_SB);
    expect(parsed.accounts[0].ending_balance).toBeCloseTo(74.5, 2);
    expect(parsed.warnings).toBeUndefined();
  });

  it('a blank balance cell never clobbers the tracker, and the row/balance mismatch warns loudly', () => {
    const report = {
      Columns: GL_DEFAULT_COLUMNS,
      Rows: { Row: [
        glSection('114 Inventory (Temporary)', '114', [
          glRow('2026-03-01', 'Bill', '100.00', '100.00'),
          glRow('2026-03-20', 'Bill', '50.00', ''), // balance withheld by the report
        ]),
      ] },
    };
    const parsed = parseGeneralLedger(report, 'Samuel Bauer', '2026-01-01', '2026-07-31', CHART_SB);
    expect(parsed.accounts[0].ending_balance).toBe(100); // last balance the report actually stated
    expect(parsed.warnings).toHaveLength(1); // …but the disagreement with activity (150) is loud
    expect(parsed.warnings[0]).toContain('disagrees');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// query_transactions noise stripping (P3)
// ─────────────────────────────────────────────────────────────────────────────

describe('stripQboNoise', () => {
  it('removes PurchaseEx/CustomExtensions/domain/sparse recursively but keeps MetaData', () => {
    const noisy = {
      QueryResponse: {
        Purchase: [
          {
            Id: '54',
            domain: 'QBO',
            sparse: false,
            TotalAmt: 100,
            MetaData: { CreateTime: '2026-08-11T10:00:00-07:00', LastUpdatedTime: '2026-08-11T10:05:00-07:00' },
            PurchaseEx: { any: [{ name: '{http://schema.intuit.com/finance/v3}NameValue', declaredType: 'x' }] },
            Line: [
              { Id: '1', Amount: 100, CustomExtensions: [], AccountBasedExpenseLineDetail: { AccountRef: { value: '62' } } },
            ],
          },
        ],
        maxResults: 1,
      },
      time: '2026-08-24T12:00:00-07:00',
    };
    const clean: any = stripQboNoise(noisy);
    const purchase = clean.QueryResponse.Purchase[0];
    expect(purchase.PurchaseEx).toBeUndefined();
    expect(purchase.domain).toBeUndefined();
    expect(purchase.sparse).toBeUndefined();
    expect(purchase.Line[0].CustomExtensions).toBeUndefined();
    expect(purchase.MetaData.CreateTime).toBe('2026-08-11T10:00:00-07:00');
    expect(purchase.TotalAmt).toBe(100);
    expect(purchase.Line[0].AccountBasedExpenseLineDetail.AccountRef.value).toBe('62');
    expect(clean.time).toBe('2026-08-24T12:00:00-07:00');
  });

  it('strips other *Ex JAXB extension blobs too, without touching normal fields', () => {
    const clean: any = stripQboNoise({ InvoiceEx: { x: 1 }, DepositEx: { y: 2 }, Description: 'keep', TaxCodeRef: { value: 'NON' } });
    expect(clean.InvoiceEx).toBeUndefined();
    expect(clean.DepositEx).toBeUndefined();
    expect(clean.Description).toBe('keep');
    expect(clean.TaxCodeRef).toEqual({ value: 'NON' });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Budget filters + summary shape (Bug 3)
// ─────────────────────────────────────────────────────────────────────────────

const BUDGETS = [
  { Id: '1', Name: 'FY25 Operating', StartDate: '2024-07-01', EndDate: '2025-06-30', BudgetType: 'ProfitAndLoss', BudgetEntryType: 'Monthly', Active: true, BudgetDetail: [{}, {}, {}] },
  { Id: '2', Name: 'FY26 Operating', StartDate: '2025-07-01', EndDate: '2026-06-30', BudgetType: 'ProfitAndLoss', BudgetEntryType: 'Monthly', Active: true, BudgetDetail: [{}] },
  { Id: '3', Name: 'Capital Campaign', StartDate: '2025-01-01', EndDate: '2026-12-31', BudgetType: 'ProfitAndLoss', BudgetEntryType: 'Yearly', Active: false, BudgetDetail: [] },
];

describe('filterBudgets', () => {
  it('filters by case-insensitive name substring', () => {
    expect(filterBudgets(BUDGETS, { nameContains: 'fy26' }).map(b => b.Id)).toEqual(['2']);
  });

  it('filters by active_on date covered by the budget range (inclusive)', () => {
    expect(filterBudgets(BUDGETS, { activeOn: '2025-06-30' }).map(b => b.Id)).toEqual(['1', '3']);
    expect(filterBudgets(BUDGETS, { activeOn: '2025-07-01' }).map(b => b.Id)).toEqual(['2', '3']);
  });

  it('combines both filters', () => {
    expect(filterBudgets(BUDGETS, { nameContains: 'operating', activeOn: '2026-01-15' }).map(b => b.Id)).toEqual(['2']);
  });

  it('passes everything through with no filters', () => {
    expect(filterBudgets(BUDGETS, {})).toHaveLength(3);
  });
});

describe('budgetToSummary', () => {
  it('returns metadata with entry_count and no entries', () => {
    const s = budgetToSummary(BUDGETS[0]);
    expect(s).toEqual({
      budget_id: '1',
      name: 'FY25 Operating',
      budget_type: 'ProfitAndLoss',
      budget_entry_type: 'Monthly',
      start_date: '2024-07-01',
      end_date: '2025-06-30',
      active: true,
      entry_count: 3,
    });
    expect(s).not.toHaveProperty('entries');
  });

  it('marks Active: false budgets inactive', () => {
    expect(budgetToSummary(BUDGETS[2]).active).toBe(false);
  });
});
