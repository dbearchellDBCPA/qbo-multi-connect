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

  it('balanceSheet threads asOfDate → date and class/department', async () => {
    await reports.balanceSheet('r', { asOfDate: '2026-12-31', classId: '5', accountingMethod: 'Accrual' });
    expect(client.get).toHaveBeenCalledWith('r', 'reports/BalanceSheet', {
      date: '2026-12-31',
      class: '5',
      accounting_method: 'Accrual',
    });
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
