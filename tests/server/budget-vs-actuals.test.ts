import { describe, it, expect } from 'vitest';
import {
  filterBudgets,
  precheckBudgetVsActuals,
  explainBudgetVsActualsFailure,
  isIntuitSystemFailure,
  reportPeriodWarning,
} from '../../src/server/report-shaping.js';

// Budget metadata exactly as Intuit returned it for Erick Erickson, LLC on
// 2026-09-05 (SELECT Id, Name, StartDate, EndDate, BudgetType, BudgetEntryType,
// Active FROM Budget).
const BUDGETS = [
  { Name: 'FY2022', StartDate: '2022-01-01', EndDate: '2022-12-31', BudgetType: 'ProfitAndLoss', BudgetEntryType: 'Monthly', Active: true, Id: '2' },
  { Name: 'FY2023', StartDate: '2023-01-01', EndDate: '2023-12-31', BudgetType: 'ProfitAndLoss', BudgetEntryType: 'Monthly', Active: true, Id: '3' },
  { Name: 'FY2024', StartDate: '2024-01-01', EndDate: '2024-12-31', BudgetType: 'ProfitAndLoss', BudgetEntryType: 'Monthly', Active: true, Id: '1000000001' },
  { Name: 'Budget_FY25_P&L', StartDate: '2025-01-01', EndDate: '2025-12-31', BudgetType: 'ProfitAndLoss', BudgetEntryType: 'Monthly', Active: true, Id: '1000000011' },
  { Name: 'Budget_FY26_P&L', StartDate: '2026-01-01', EndDate: '2026-12-31', BudgetType: 'ProfitAndLoss', BudgetEntryType: 'Monthly', Active: true, Id: '1000000021' },
];

const NPE_FAULT = {
  Fault: {
    Error: [{ Message: 'An application error has occurred while processing your request', Detail: 'System Failure Error: java.lang.NullPointerException', code: '10000', element: 'SystemFailureError' }],
    type: 'SystemFault',
  },
};

describe('filterBudgets — fiscal_year', () => {
  it('keeps only budgets overlapping the calendar year (number or string)', () => {
    expect(filterBudgets(BUDGETS, { fiscalYear: 2026 }).map((b) => b.Id)).toEqual(['1000000021']);
    expect(filterBudgets(BUDGETS, { fiscalYear: '2024' }).map((b) => b.Id)).toEqual(['1000000001']);
    expect(filterBudgets(BUDGETS, { fiscalYear: 2019 })).toEqual([]);
  });

  it('matches a non-calendar fiscal year against both years it spans', () => {
    const fy = [{ Id: 'x', Name: 'FY26 (Jul-Jun)', StartDate: '2025-07-01', EndDate: '2026-06-30' }];
    expect(filterBudgets(fy, { fiscalYear: 2025 })).toHaveLength(1);
    expect(filterBudgets(fy, { fiscalYear: 2026 })).toHaveLength(1);
    expect(filterBudgets(fy, { fiscalYear: 2027 })).toHaveLength(0);
  });

  it('combines with name_contains and rejects a malformed year', () => {
    expect(filterBudgets(BUDGETS, { fiscalYear: 2025, nameContains: 'p&l' }).map((b) => b.Id)).toEqual(['1000000011']);
    expect(() => filterBudgets(BUDGETS, { fiscalYear: '26' })).toThrow(/4-digit year/);
  });
});

describe('precheckBudgetVsActuals', () => {
  it('accepts the FY26 budget with dates inside its year', () => {
    const r = precheckBudgetVsActuals({ budgetId: '1000000021', startDate: '2026-01-01', endDate: '2026-12-31' }, BUDGETS);
    expect(r.error).toBeNull();
    expect(r.budget?.Id).toBe('1000000021');
  });

  it('rejects dates outside the budget year and names the budget that covers them', () => {
    const r = precheckBudgetVsActuals({ budgetId: '1000000021', startDate: '2025-01-01', endDate: '2025-12-31' }, BUDGETS);
    expect(r.error).toMatch(/outside budget 1000000021 "Budget_FY26_P&L"/);
    expect(r.error).toMatch(/1000000011 "Budget_FY25_P&L"/);
  });

  it('rejects a range that straddles two budget years', () => {
    const r = precheckBudgetVsActuals({ budgetId: '1000000021', startDate: '2025-08-01', endDate: '2026-08-31' }, BUDGETS);
    expect(r.error).toMatch(/No budget covers 2025-08-01\.\.2026-08-31 in full/);
  });

  it('rejects an unknown budget_id and lists the budgets that exist', () => {
    const r = precheckBudgetVsActuals({ budgetId: '999', startDate: '2026-01-01', endDate: '2026-12-31' }, BUDGETS);
    expect(r.error).toMatch(/Budget 999 not found/);
    expect(r.error).toMatch(/1000000021 "Budget_FY26_P&L" \(ProfitAndLoss, Monthly, 2026-01-01 → 2026-12-31\)/);
  });

  it('requires a period: dates together, or date_macro, never both', () => {
    expect(precheckBudgetVsActuals({ budgetId: '2' }, BUDGETS).error).toMatch(/start_date \+ end_date or date_macro/);
    expect(precheckBudgetVsActuals({ budgetId: '2', startDate: '2022-01-01' }, BUDGETS).error).toMatch(/given together/);
    expect(precheckBudgetVsActuals({ budgetId: '2', startDate: '2022-01-01', endDate: '2022-12-31', dateMacro: 'Last Month' }, BUDGETS).error).toMatch(/not both/);
    expect(precheckBudgetVsActuals({ budgetId: '2', dateMacro: 'This Fiscal Year-to-date' }, BUDGETS).error).toBeNull();
  });

  it('validates date format and order', () => {
    expect(precheckBudgetVsActuals({ startDate: '01/01/2026', endDate: '2026-12-31' }, BUDGETS).error).toMatch(/start_date must be YYYY-MM-DD/);
    expect(precheckBudgetVsActuals({ startDate: '2026-12-31', endDate: '2026-01-01' }, BUDGETS).error).toMatch(/after end_date/);
  });

  it('without budget_id it cannot validate the year but still passes a well-formed request', () => {
    const r = precheckBudgetVsActuals({ startDate: '2026-01-01', endDate: '2026-12-31' }, BUDGETS);
    expect(r.error).toBeNull();
    expect(r.budget).toBeNull();
  });
});

describe('explainBudgetVsActualsFailure', () => {
  const req = { budgetId: '1000000021', startDate: '2026-01-01', endDate: '2026-12-31', summarizeBy: 'Month' };

  it('recognises Intuit\'s code-10000 NullPointerException whether it arrives as a message or a Fault body', () => {
    expect(isIntuitSystemFailure({ message: 'QBO SystemFault: … (SystemFailureError, code 10000)' })).toBe(true);
    expect(isIntuitSystemFailure({ message: 'boom', response: NPE_FAULT })).toBe(true);
    expect(isIntuitSystemFailure({ message: 'QBO API error: Connection is not active' })).toBe(false);
  });

  it('explains the failure with the params sent, the budget hit, and the workarounds', () => {
    const err = { message: 'QBO SystemFault: An application error has occurred while processing your request — System Failure Error: java.lang.NullPointerException (SystemFailureError, code 10000)' };
    const text = explainBudgetVsActualsFailure(err, req, BUDGETS[4]);
    expect(text).toMatch(/Intuit's report engine rejected/);
    expect(text).toMatch(/Sent: budget_id=1000000021, start_date=2026-01-01, end_date=2026-12-31, summarize_column_by=Month/);
    expect(text).toMatch(/Budget: 1000000021 "Budget_FY26_P&L" — ProfitAndLoss, Monthly, 2026-01-01 → 2026-12-31/);
    expect(text).toMatch(/omit summarize_by/);
    expect(text).toMatch(/date_macro/);
    expect(text).toMatch(/get_budget\(budget_id=…\).*get_profit_and_loss\(summarize_by="Month"\)/);
  });

  it('passes other errors through with the params for context', () => {
    const text = explainBudgetVsActualsFailure({ message: 'QBO API error: Connection is not active: expired' }, req, null);
    expect(text).toMatch(/^Error fetching Budget vs Actuals: QBO API error: Connection is not active: expired/);
    expect(text).toMatch(/Sent: budget_id=1000000021/);
    expect(text).not.toMatch(/report engine/);
  });
});

describe('reportPeriodWarning', () => {
  it('warns when the Header carries no period at all (the all-time-actuals case)', () => {
    const w = reportPeriodWarning({ Header: { ReportName: 'BudgetVsActuals', SummarizeColumnsBy: 'Total' } }, { start: '2026-01-01', end: '2026-12-31' }, 'Budget vs Actuals');
    expect(w).toMatch(/without a StartPeriod\/EndPeriod/);
    expect(w).toMatch(/2026-01-01 to 2026-12-31/);
    expect(w).toMatch(/ALL-TIME/);
  });

  it('warns on a mismatched period and is silent when the Header agrees', () => {
    const report = { Header: { StartPeriod: '2026-08-01', EndPeriod: '2026-08-31', DateMacro: 'last month' } };
    expect(reportPeriodWarning(report, { end: '2024-08-31' }, 'Balance Sheet')).toMatch(/end 2026-08-31 \(requested 2024-08-31\)/);
    expect(reportPeriodWarning(report, { start: '2026-08-01', end: '2026-08-31' })).toBeNull();
    expect(reportPeriodWarning(report, {})).toBeNull();
  });
});
