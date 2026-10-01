import { describe, it, expect } from 'vitest';
import {
  resolveBudget,
  budgetAmountsForRange,
  budgetCoverage,
  extractPnlActuals,
  computeBudgetVsActuals,
  accountLabel,
  budgetEntries,
  unnamedRefIds,
} from '../../src/api/budget-vs-actuals.js';

// Budget metadata as get_budget listed it for Northway Church on 2026-09-30.
const NORTHWAY_BUDGETS = [
  { Id: '1000000041', Name: 'ALL Budgets-2024-2025 (By Class)', StartDate: '2024-07-01', EndDate: '2025-06-30', BudgetEntryType: 'Monthly' },
  { Id: '1000000071', Name: 'WDPS Budget FYE 2025', StartDate: '2024-07-01', EndDate: '2025-06-30', BudgetEntryType: 'Monthly' },
  { Id: '1000000081', Name: 'Operating Budget FYE 2025', StartDate: '2024-07-01', EndDate: '2025-06-30', BudgetEntryType: 'Monthly' },
  { Id: '1000000131', Name: 'FY26 Budget by Class', StartDate: '2025-07-01', EndDate: '2026-06-30', BudgetEntryType: 'Monthly' },
  { Id: '1000000141', Name: 'FY27 Budget by Class', StartDate: '2026-07-01', EndDate: '2027-06-30', BudgetEntryType: 'Monthly' },
];

describe('resolveBudget', () => {
  it('resolves each Northway budget by exact name, case/whitespace-insensitively', () => {
    expect(resolveBudget(NORTHWAY_BUDGETS, { budgetName: 'ALL Budgets-2024-2025 (By Class)' }).budget?.Id).toBe('1000000041');
    expect(resolveBudget(NORTHWAY_BUDGETS, { budgetName: 'fy26 budget  by class' }).budget?.Id).toBe('1000000131');
    expect(resolveBudget(NORTHWAY_BUDGETS, { budgetName: 'FY27 Budget by Class' }).budget?.Id).toBe('1000000141');
  });

  it('resolves by Id, and by a unique substring', () => {
    expect(resolveBudget(NORTHWAY_BUDGETS, { budgetId: '1000000131' }).budget?.Name).toBe('FY26 Budget by Class');
    expect(resolveBudget(NORTHWAY_BUDGETS, { budgetName: 'WDPS' }).budget?.Id).toBe('1000000071');
  });

  it('refuses an ambiguous name and lists the candidates (never guesses)', () => {
    const r = resolveBudget(NORTHWAY_BUDGETS, { budgetName: 'FYE 2025' });
    expect(r.budget).toBeNull();
    expect(r.error).toMatch(/matches 2 budgets/);
    expect(r.error).toMatch(/1000000071/);
    expect(r.error).toMatch(/1000000081/);
  });

  it('rejects unknown ids/names, a missing selector, and an id/name disagreement', () => {
    expect(resolveBudget(NORTHWAY_BUDGETS, { budgetId: '999' }).error).toMatch(/Budget 999 not found.*FY27 Budget by Class/s);
    expect(resolveBudget(NORTHWAY_BUDGETS, { budgetName: 'FY28' }).error).toMatch(/No budget named "FY28"/);
    expect(resolveBudget(NORTHWAY_BUDGETS, {}).error).toMatch(/Pass budget_id or budget_name/);
    expect(resolveBudget(NORTHWAY_BUDGETS, { budgetId: '1000000141', budgetName: 'FY26 Budget by Class' }).error).toMatch(/does not match budget_name/);
    expect(resolveBudget(NORTHWAY_BUDGETS, { budgetId: '1000000131', budgetName: 'FY26 Budget by Class' }).budget?.Id).toBe('1000000131');
  });
});

function monthly(accountId: string, amountPerMonth: number, from: string, months: number, classId?: string) {
  const [y, m] = from.split('-').map(Number);
  return Array.from({ length: months }, (_, i) => {
    const d = new Date(Date.UTC(y, m - 1 + i, 1)).toISOString().slice(0, 10);
    return { BudgetDate: d, Amount: amountPerMonth, AccountRef: { value: accountId }, ...(classId ? { ClassRef: { value: classId, name: `Class ${classId}` } } : {}) };
  });
}

describe('budgetAmountsForRange', () => {
  const budget = {
    Id: '1000000141', Name: 'FY27 Budget by Class', StartDate: '2026-07-01', EndDate: '2027-06-30', BudgetEntryType: 'Monthly',
    BudgetDetail: [...monthly('10', 3000, '2026-07-01', 12, '5'), ...monthly('10', 1500, '2026-07-01', 12, '6'), ...monthly('20', 600, '2026-07-01', 12)],
  };

  it('sums the months inside the range and pro-rates a partial month by days', () => {
    const { lines, periods } = budgetAmountsForRange(budget, '2026-07-01', '2026-09-28');
    // Jul + Aug in full, Sep 28/30
    const a10c5 = lines.find((l) => l.account_id === '10' && l.class_id === '5')!;
    expect(a10c5.amount).toBeCloseTo(3000 * 2 + 3000 * (28 / 30), 6);
    expect(lines.find((l) => l.account_id === '20' && l.class_id === null)!.amount).toBeCloseTo(600 * 2 + 600 * (28 / 30), 6);
    expect(periods.map((p) => [p.period_start, p.factor])).toEqual([['2026-07-01', 1], ['2026-08-01', 1], ['2026-09-01', 0.9333]]);
  });

  it('counts a partial month in full with mode "full", and ignores months outside the range', () => {
    const { lines } = budgetAmountsForRange(budget, '2026-07-01', '2026-09-28', 'full');
    expect(lines.find((l) => l.account_id === '20')!.amount).toBe(1800);
    expect(budgetAmountsForRange(budget, '2025-07-01', '2025-09-30').lines).toEqual([]);
  });

  it('handles quarterly entries', () => {
    const q = { StartDate: '2026-01-01', EndDate: '2026-12-31', BudgetEntryType: 'Quarterly', BudgetDetail: [{ BudgetDate: '2026-01-01', Amount: '900', AccountRef: { value: '1' } }] };
    expect(budgetAmountsForRange(q, '2026-01-01', '2026-01-31').lines[0].amount).toBeCloseTo(900 * (31 / 90), 6);
  });

  it('reports coverage of the requested range', () => {
    expect(budgetCoverage(budget, '2026-07-01', '2026-09-28')).toBe('full');
    expect(budgetCoverage(budget, '2026-06-01', '2026-09-28')).toBe('partial');
    expect(budgetCoverage(NORTHWAY_BUDGETS[0], '2026-07-01', '2026-09-28')).toBe('none');
  });
});

/** A ProfitAndLoss report shaped like QBO's (sections, sub-account, NetIncome). */
function pnl(opts: { start: string; end: string; basis?: string; byClass?: boolean }) {
  const cols = opts.byClass
    ? [
        { ColTitle: '', ColType: 'Account' },
        { ColTitle: 'Worship', ColType: 'Money', MetaData: [{ Name: 'ColKey', Value: '5' }] },
        { ColTitle: 'Youth', ColType: 'Money' },
        { ColTitle: 'Not Specified', ColType: 'Money' },
        { ColTitle: 'Total', ColType: 'Money' },
      ]
    : [{ ColTitle: '', ColType: 'Account' }, { ColTitle: 'Total', ColType: 'Money' }];
  const v = (total: number, split: [number, number, number]) =>
    opts.byClass ? [...split.map((n) => ({ value: n ? n.toFixed(2) : '' })), { value: total.toFixed(2) }] : [{ value: total.toFixed(2) }];
  return {
    Header: { ReportName: 'ProfitAndLoss', StartPeriod: opts.start, EndPeriod: opts.end, ReportBasis: opts.basis ?? 'Cash' },
    Columns: { Column: cols },
    Rows: {
      Row: [
        {
          group: 'Income', type: 'Section',
          Header: { ColData: [{ value: 'Income' }] },
          Rows: { Row: [{ type: 'Data', ColData: [{ value: '4000 Tithes', id: '10' }, ...v(10000, [7000, 2500, 500])] }] },
          Summary: { ColData: [{ value: 'Total Income' }, ...v(10000, [7000, 2500, 500])] },
        },
        {
          group: 'Expenses', type: 'Section',
          Header: { ColData: [{ value: 'Expenses' }] },
          Rows: {
            Row: [
              {
                type: 'Section',
                Header: { ColData: [{ value: '6000 Facilities', id: '19' }] },
                Rows: {
                  Row: [
                    { ColData: [{ value: '6000 Facilities', id: '19' }, ...v(100, [0, 0, 100])] },
                    { ColData: [{ value: '6010 Utilities', id: '20' }, ...v(1500, [1000, 500, 0])] },
                  ],
                },
                Summary: { ColData: [{ value: 'Total 6000 Facilities' }, ...v(1600, [1000, 500, 100])] },
              },
            ],
          },
          Summary: { ColData: [{ value: 'Total Expenses' }, ...v(1600, [1000, 500, 100])] },
        },
        { group: 'NetIncome', type: 'Section', Summary: { ColData: [{ value: 'Net Income' }, ...v(8400, [6000, 2000, 400])] } },
      ],
    },
  };
}

const ACCOUNTS = [
  { Id: '10', Name: 'Tithes', AcctNum: '4000', AccountType: 'Income', Classification: 'Revenue' },
  { Id: '19', Name: 'Facilities', AcctNum: '6000', AccountType: 'Expense', Classification: 'Expense' },
  { Id: '20', Name: 'Utilities', FullyQualifiedName: 'Facilities:Utilities', AcctNum: '6010', AccountType: 'Expense', Classification: 'Expense' },
  { Id: '30', Name: 'Missions', AcctNum: '6500', AccountType: 'Expense', Classification: 'Expense' },
];
const CLASSES = [{ Id: '5', Name: 'Worship' }, { Id: '6', Name: 'Youth' }];

describe('extractPnlActuals', () => {
  it('takes leaf data rows (parent own-postings included once) and QBO Net Income', () => {
    const a = extractPnlActuals(pnl({ start: '2026-07-01', end: '2026-09-28' }));
    expect(a.rows.map((r) => [r.account_id, r.total, r.section])).toEqual([['10', 10000, 'Income'], ['19', 100, 'Expenses'], ['20', 1500, 'Expenses']]);
    expect(a.net_income).toBe(8400);
  });

  it('maps class columns by ColKey, then by title, and Not Specified to null', () => {
    const a = extractPnlActuals(pnl({ start: '2026-07-01', end: '2026-09-28', byClass: true }), CLASSES);
    expect(a.columns.map((c) => [c.title, c.class_id, c.is_total])).toEqual([
      ['Worship', '5', false], ['Youth', '6', false], ['Not Specified', null, false], ['Total', undefined, true],
    ]);
    expect(Object.fromEntries(a.rows[0].by_class)).toEqual({ '5': 7000, '6': 2500, '': 500 });
    expect(a.unmatched_class_columns).toEqual([]);
  });
});

describe('computeBudgetVsActuals', () => {
  const fy27 = {
    Id: '1000000141', Name: 'FY27 Budget by Class', StartDate: '2026-07-01', EndDate: '2027-06-30', BudgetEntryType: 'Monthly',
    BudgetDetail: [...monthly('10', 3000, '2026-07-01', 12, '5'), ...monthly('10', 1000, '2026-07-01', 12, '6'), ...monthly('20', 500, '2026-07-01', 12, '5'), ...monthly('30', 200, '2026-07-01', 12)],
  };
  const base = { clientName: 'Northway Church', budget: fy27, startDate: '2026-07-01', endDate: '2026-09-30', accountingMethod: 'Cash' as const, accounts: ACCOUNTS, classes: CLASSES };

  it('joins budget and actuals per account with variance, sections and net income', () => {
    const out = computeBudgetVsActuals({ ...base, pnl: pnl({ start: '2026-07-01', end: '2026-09-30' }) });
    expect(out.budget).toMatchObject({ budget_id: '1000000141', name: 'FY27 Budget by Class', coverage_of_period: 'full' });
    expect(out.period).toEqual({ start: '2026-07-01', end: '2026-09-30' });
    expect(out.accounting_method).toBe('Cash');
    const income = out.sections.find((s: any) => s.section === 'Income');
    expect(income.accounts).toEqual([
      { account_id: '10', account_number: '4000', account_name: '4000 Tithes', actual: 10000, budget: 12000, over_budget: -2000, pct_of_budget: 83.33 },
    ]);
    const exp = out.sections.find((s: any) => s.section === 'Expenses');
    // Missions has budget but no actuals; it still appears.
    expect(exp.accounts.map((a: any) => [a.account_id, a.actual, a.budget])).toEqual([['19', 100, 0], ['20', 1500, 1500], ['30', 0, 600]]);
    expect(exp.accounts[0].pct_of_budget).toBeNull();
    expect(out.net_income).toMatchObject({ actual: 8400, budget: 12000 - 2100, qbo_pnl_net_income: 8400 });
    expect(out.warnings).toEqual([]);
  });

  it('adds a by_class split that ties to the account totals', () => {
    const out = computeBudgetVsActuals({ ...base, pnl: pnl({ start: '2026-07-01', end: '2026-09-30', byClass: true }), splitByClass: true });
    const tithes = out.sections[0].accounts[0];
    expect(tithes.by_class).toEqual([
      { class_id: null, class_name: 'Not Specified', actual: 500, budget: 0, over_budget: 500, pct_of_budget: null },
      { class_id: '5', class_name: 'Worship', actual: 7000, budget: 9000, over_budget: -2000, pct_of_budget: 77.78 },
      { class_id: '6', class_name: 'Youth', actual: 2500, budget: 3000, over_budget: -500, pct_of_budget: 83.33 },
    ]);
    const sum = tithes.by_class.reduce((s: number, c: any) => s + c.actual, 0);
    expect(sum).toBe(tithes.actual);
  });

  it('class_id limits the budget to that class', () => {
    const out = computeBudgetVsActuals({ ...base, pnl: pnl({ start: '2026-07-01', end: '2026-09-30' }), classId: '6' });
    expect(out.sections[0].accounts[0].budget).toBe(3000);
    expect(out.class_filter).toEqual({ class_id: '6', class_name: 'Youth' });
  });

  it('warns (does not silently zero) when the budget does not cover the dates, and when QBO changed the period or basis', () => {
    const fy25 = { ...fy27, Id: '1000000041', Name: 'ALL Budgets-2024-2025 (By Class)', StartDate: '2024-07-01', EndDate: '2025-06-30', BudgetDetail: monthly('10', 3000, '2024-07-01', 12) };
    const out = computeBudgetVsActuals({ ...base, budget: fy25, pnl: { ...pnl({ start: '2026-07-01', end: '2026-08-31', basis: 'Accrual' }) } });
    expect(out.budget.coverage_of_period).toBe('none');
    expect(out.warnings.join('\n')).toMatch(/does not cover any of 2026-07-01\.\.2026-09-30/);
    expect(out.warnings.join('\n')).toMatch(/QBO applied 2026-07-01\.\.2026-08-31/);
    expect(out.warnings.join('\n')).toMatch(/Accrual basis \(requested Cash\)/);
  });

  it('flags a partial month pro-ration and a reconciliation mismatch', () => {
    const report = pnl({ start: '2026-07-01', end: '2026-09-28' });
    (report.Rows.Row[2] as any).Summary.ColData[1].value = '9999.00';
    const out = computeBudgetVsActuals({ ...base, endDate: '2026-09-28', pnl: report });
    expect(out.warnings.join('\n')).toMatch(/2026-09-01\.\.2026-09-30 × 0\.9333/);
    expect(out.warnings.join('\n')).toMatch(/Reconciliation/);
  });
});

// ─── 2026-09-30 polish: one label per account, budget-line dimensions ─────────

describe('accountLabel — one consistent "NNNN Name" label from the Account entity', () => {
  it('uses AcctNum + Name, never the FullyQualifiedName path or report/budget text', () => {
    expect(accountLabel({ Id: '181', Name: 'Anniversary', FullyQualifiedName: 'PERSONNEL:Anniversary', AcctNum: '5047' }, 'PERSONNEL:Anniversary')).toBe('5047 Anniversary');
    expect(accountLabel({ Id: '160', Name: 'WDPS, Registration Fees', AcctNum: '4610' }, 'WDPS, Registration Fees')).toBe('4610 WDPS, Registration Fees');
    expect(accountLabel({ Id: '9', Name: 'Ask My Accountant' }, '9999 Something')).toBe('Ask My Accountant');
    expect(accountLabel(undefined, '4100 Contributions')).toBe('4100 Contributions');
  });

  it('computed Budget vs Actuals labels budget-only and actual rows the same way', () => {
    const accounts = [
      { Id: '150', Name: 'Contributions', FullyQualifiedName: 'REVENUE:Contributions', AcctNum: '4100', AccountType: 'Income' },
      { Id: '160', Name: 'WDPS, Registration Fees', FullyQualifiedName: 'REVENUE:WDPS, Registration Fees', AcctNum: '4610', AccountType: 'Income' },
      { Id: '181', Name: 'Anniversary', FullyQualifiedName: 'PERSONNEL:Anniversary', AcctNum: '5047', AccountType: 'Expense' },
      { Id: '305', Name: 'CathCoffee, Marketing Exp.', FullyQualifiedName: 'OPERATIONS:CathCoffee, Expenses:Cathedral Coffee Marketing:CathCoffee, Marketing Exp.', AcctNum: '7732', AccountType: 'Expense' },
    ];
    const budget = {
      Id: '1000000141', Name: 'FY27 Budget by Class', StartDate: '2026-07-01', EndDate: '2027-06-30', BudgetEntryType: 'Monthly',
      BudgetDetail: [
        { BudgetDate: '2026-07-01', Amount: 1000, AccountRef: { value: '150', name: 'REVENUE:Contributions' } },
        { BudgetDate: '2026-07-01', Amount: 500, AccountRef: { value: '160', name: 'WDPS, Registration Fees' } },
        { BudgetDate: '2026-07-01', Amount: 50, AccountRef: { value: '181', name: 'PERSONNEL:Anniversary' } },
        { BudgetDate: '2026-07-01', Amount: 70, AccountRef: { value: '305', name: 'OPERATIONS:CathCoffee, Expenses:Cathedral Coffee Marketing:CathCoffee, Marketing Exp.' } },
      ],
    };
    const report = {
      Header: { StartPeriod: '2026-07-01', EndPeriod: '2026-07-31', ReportBasis: 'Cash' },
      Columns: { Column: [{ ColTitle: '', ColType: 'Account' }, { ColTitle: 'Total', ColType: 'Money' }] },
      Rows: { Row: [{ group: 'Income', Rows: { Row: [{ ColData: [{ value: '4100 Contributions (report text)', id: '150' }, { value: '900.00' }] }] }, Summary: { ColData: [{ value: 'Total Income' }, { value: '900.00' }] } }] },
    };
    const out = computeBudgetVsActuals({ clientName: 'Northway Church', budget, startDate: '2026-07-01', endDate: '2026-07-31', accountingMethod: 'Cash', pnl: report, accounts });
    const labels = out.sections.flatMap((s: any) => s.accounts.map((a: any) => a.account_name));
    expect(labels).toEqual(['4100 Contributions', '4610 WDPS, Registration Fees', '5047 Anniversary', '7732 CathCoffee, Marketing Exp.']);
    for (const l of labels) expect(l).toMatch(/^\d{4} [^:]+$/);
  });
});

describe('budgetEntries — get_budget lines carry class / department / customer', () => {
  const budget = {
    Id: '1000000131', Name: 'FY26 Budget by Class', StartDate: '2025-07-01', EndDate: '2026-06-30',
    BudgetDetail: [
      { BudgetDate: '2025-07-01', Amount: 5833.33, AccountRef: { value: '325', name: 'OPERATIONS:Facilities:Repair & Maintenance' }, ClassRef: { value: '1900000000000747661', name: 'Unrestricted' } },
      { BudgetDate: '2025-07-01', Amount: '100', AccountRef: { value: '325' }, ClassRef: { value: '1900000000000747662' }, DepartmentRef: { value: '3', name: 'Main Campus' }, CustomerRef: { value: '77' } },
      { BudgetDate: '2025-08-01', Amount: 1, AccountRef: { value: '999', name: 'Old account' } },
    ],
  };
  const accounts = [{ Id: '325', Name: 'Repair & Maintenance', FullyQualifiedName: 'OPERATIONS:Facilities:Repair & Maintenance', AcctNum: '7365' }];

  it('adds {id, name} refs from the line, falling back to lookups; null when absent', () => {
    const e = budgetEntries(budget, {
      accounts,
      classes: [{ Id: '1900000000000747662', Name: 'WDPS', FullyQualifiedName: 'WDPS' }],
      customers: [{ Id: '77', DisplayName: 'Smith Family' }],
    });
    expect(e[0]).toEqual({
      account_id: '325', account_number: '7365', account_name: '7365 Repair & Maintenance',
      period: { start: '2025-07-01', end: null }, amount: 5833.33,
      class: { id: '1900000000000747661', name: 'Unrestricted' }, department: null, customer: null,
    });
    expect(e[1]).toMatchObject({ amount: 100, class: { id: '1900000000000747662', name: 'WDPS' }, department: { id: '3', name: 'Main Campus' }, customer: { id: '77', name: 'Smith Family' } });
    expect(e[2]).toMatchObject({ account_id: '999', account_number: null, account_name: 'Old account', class: null });
  });

  it('unnamedRefIds lists only refs that arrive without a name', () => {
    expect(unnamedRefIds([budget], 'ClassRef')).toEqual(['1900000000000747662']);
    expect(unnamedRefIds([budget], 'DepartmentRef')).toEqual([]);
    expect(unnamedRefIds([budget], 'CustomerRef')).toEqual(['77']);
  });
});
