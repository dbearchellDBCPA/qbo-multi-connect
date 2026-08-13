import { describe, it, expect } from 'vitest';
import {
  resolveAccountFilterTerms,
  summarizeGeneralLedger,
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
