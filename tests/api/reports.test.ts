import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ReportsAPI } from '../../src/api/reports.js';

function makeClient() {
  return { get: vi.fn().mockResolvedValue({ ok: true }) } as any;
}

describe('ReportsAPI param threading', () => {
  let client: any;
  let reports: ReportsAPI;

  beforeEach(() => {
    client = makeClient();
    reports = new ReportsAPI(client);
  });

  it('profitAndLoss threads summarizeColumnBy → summarize_column_by', async () => {
    await reports.profitAndLoss('r', { startDate: '2026-01-01', endDate: '2026-12-31', summarizeColumnBy: 'Month' });
    expect(client.get).toHaveBeenCalledWith('r', 'reports/ProfitAndLoss', {
      start_date: '2026-01-01',
      end_date: '2026-12-31',
      summarize_column_by: 'Month',
    });
  });

  it('profitAndLoss threads accountingMethod and class/department/customer/vendor filters', async () => {
    await reports.profitAndLoss('r', {
      startDate: '2026-01-01',
      endDate: '2026-12-31',
      accountingMethod: 'Accrual',
      classId: '5',
      departmentId: '7',
      customerId: '9',
      vendorId: '11',
    });
    expect(client.get).toHaveBeenCalledWith('r', 'reports/ProfitAndLoss', {
      start_date: '2026-01-01',
      end_date: '2026-12-31',
      accounting_method: 'Accrual',
      class: '5',
      department: '7',
      customer: '9',
      vendor: '11',
    });
  });

  it('generalLedger threads account (IDs) and class/department', async () => {
    await reports.generalLedger('r', {
      startDate: '2026-01-01',
      endDate: '2026-03-31',
      accountIds: '100,101,102',
      classId: '5',
      departmentId: '7',
      accountingMethod: 'Cash',
    });
    expect(client.get).toHaveBeenCalledWith('r', 'reports/GeneralLedger', {
      start_date: '2026-01-01',
      end_date: '2026-03-31',
      accounting_method: 'Cash',
      class: '5',
      department: '7',
      account: '100,101,102',
    });
  });

  // Regression (2026-08-13): asOfDate used to be sent as `date`, which the
  // BalanceSheet report does not accept — QBO silently ignored it and returned
  // TODAY'S balance sheet for every requested date. The as-of date must go out
  // as `end_date`, and no `date` param may ever be sent.
  it('balanceSheet threads asOfDate → end_date (never `date`) and class/department', async () => {
    await reports.balanceSheet('r', { asOfDate: '2026-12-31', classId: '5', accountingMethod: 'Accrual' });
    expect(client.get).toHaveBeenCalledWith('r', 'reports/BalanceSheet', {
      end_date: '2026-12-31',
      class: '5',
      accounting_method: 'Accrual',
    });
    const query = client.get.mock.calls[0][2];
    expect(query).not.toHaveProperty('date');
  });

  it('balanceSheet threads startDate for summarize_column_by series', async () => {
    await reports.balanceSheet('r', {
      asOfDate: '2026-06-30',
      startDate: '2026-01-01',
      summarizeColumnBy: 'Month',
    });
    expect(client.get).toHaveBeenCalledWith('r', 'reports/BalanceSheet', {
      start_date: '2026-01-01',
      end_date: '2026-06-30',
      summarize_column_by: 'Month',
    });
  });

  it('balanceSheet returns different data for different as-of dates (date drives the request)', async () => {
    // The bug this guards against: three different as_of_dates all returned
    // identical current-day figures because the date never reached QBO.
    const byEndDate: Record<string, any> = {
      '2025-06-30': { Rows: { Row: [] }, cash: 12_000, investments: 1_079_000 },
      '2026-08-13': { Rows: { Row: [] }, cash: 245_796, investments: 0 },
    };
    client.get = vi.fn().mockImplementation((_realm: string, _path: string, query: any) =>
      Promise.resolve(byEndDate[query.end_date] ?? { error: `unexpected end_date ${query.end_date}` })
    );
    reports = new ReportsAPI(client);

    const yearEnd: any = await reports.balanceSheet('r', { asOfDate: '2025-06-30' });
    const today: any = await reports.balanceSheet('r', { asOfDate: '2026-08-13' });

    expect(yearEnd.cash).toBe(12_000);
    expect(today.cash).toBe(245_796);
    expect(yearEnd).not.toEqual(today);
  });

  it('budgetVsActuals threads budgetId', async () => {
    await reports.budgetVsActuals('r', {
      startDate: '2026-01-01',
      endDate: '2026-12-31',
      budgetId: '42',
      summarizeColumnBy: 'Month',
      accountingMethod: 'Accrual',
    });
    expect(client.get).toHaveBeenCalledWith('r', 'reports/BudgetVsActuals', {
      start_date: '2026-01-01',
      end_date: '2026-12-31',
      accounting_method: 'Accrual',
      summarize_column_by: 'Month',
      budget_id: '42',
    });
  });

  it('omits undefined / empty options entirely', async () => {
    await reports.profitAndLoss('r', { startDate: '2026-01-01', endDate: '2026-12-31' });
    expect(client.get).toHaveBeenCalledWith('r', 'reports/ProfitAndLoss', {
      start_date: '2026-01-01',
      end_date: '2026-12-31',
    });
  });

  it('does not include unsupported params on a report that does not accept them', async () => {
    // trialBalance does not support class/department/account
    await reports.trialBalance('r', {
      startDate: '2026-01-01',
      endDate: '2026-03-31',
      classId: 'should-be-ignored',
      accountIds: 'should-be-ignored',
    });
    expect(client.get).toHaveBeenCalledWith('r', 'reports/TrialBalance', {
      start_date: '2026-01-01',
      end_date: '2026-03-31',
    });
  });
});
