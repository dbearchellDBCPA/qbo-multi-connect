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

function glRow(date: string, type: string, amount: string, balance: string, memo = ''): any {
  return { ColData: [
    { value: date }, { value: type }, { value: '' }, { value: '' },
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
