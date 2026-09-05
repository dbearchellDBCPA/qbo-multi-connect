import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ReportsAPI, qboFaultMessage } from '../../src/api/reports.js';

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

  it('generalLedger threads an explicit columns request', async () => {
    await reports.generalLedger('r', {
      startDate: '2026-01-01',
      endDate: '2026-03-31',
      columns: 'tx_date,txn_type,debt_amt,credit_amt',
    });
    expect(client.get).toHaveBeenCalledWith('r', 'reports/GeneralLedger', {
      start_date: '2026-01-01',
      end_date: '2026-03-31',
      columns: 'tx_date,txn_type,debt_amt,credit_amt',
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

  // Regression (2026-08-15): report_date alone is ignored by QBO's Aged*
  // reports — the aging came back as-of "today" for any requested date.
  // aging_method=Report_Date must accompany it.
  it('arAging sends aging_method=Report_Date alongside report_date', async () => {
    await reports.arAging('r', { asOfDate: '2026-06-30' });
    expect(client.get).toHaveBeenCalledWith('r', 'reports/AgedReceivables', {
      report_date: '2026-06-30',
      aging_method: 'Report_Date',
    });
  });

  it('arAging with no as-of date sends neither report_date nor aging_method (QBO defaults to today)', async () => {
    await reports.arAging('r', {});
    expect(client.get).toHaveBeenCalledWith('r', 'reports/AgedReceivables', {});
  });

  it('apAging sends aging_method=Report_Date alongside report_date', async () => {
    await reports.apAging('r', { asOfDate: '2026-06-30', accountingMethod: 'Accrual' });
    expect(client.get).toHaveBeenCalledWith('r', 'reports/AgedPayables', {
      report_date: '2026-06-30',
      accounting_method: 'Accrual',
      aging_method: 'Report_Date',
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

// ─────────────────────────────────────────────────────────────────────────────
// 2026-09-05: get_trial_balance(as_of_date) returned the default-period report
// and get_budget_vs_actuals lacked date_macro; Intuit also answers some report
// failures with an HTTP 200 whose body is a Fault envelope.
// ─────────────────────────────────────────────────────────────────────────────
describe('ReportsAPI — as-of dates, date_macro, and Fault bodies (2026-09-05)', () => {
  let client: any;
  let reports: ReportsAPI;

  beforeEach(() => {
    client = makeClient();
    reports = new ReportsAPI(client);
  });

  it('trialBalance threads asOfDate → end_date (TrialBalance has no as-of param)', async () => {
    await reports.trialBalance('r', { asOfDate: '2024-08-31', accountingMethod: 'Accrual' });
    expect(client.get).toHaveBeenCalledWith('r', 'reports/TrialBalance', {
      end_date: '2024-08-31',
      accounting_method: 'Accrual',
    });
  });

  it('trialBalance prefers an explicit endDate over asOfDate', async () => {
    await reports.trialBalance('r', { startDate: '2025-01-01', endDate: '2025-12-31', asOfDate: '2024-08-31' });
    expect(client.get).toHaveBeenCalledWith('r', 'reports/TrialBalance', {
      start_date: '2025-01-01',
      end_date: '2025-12-31',
    });
  });

  it('trialBalance sends different end_dates for different as-of dates', async () => {
    const seen: string[] = [];
    client.get = vi.fn().mockImplementation((_r: string, _p: string, q: any) => {
      seen.push(q.end_date);
      return Promise.resolve({ Header: { StartPeriod: '2000-01-01', EndPeriod: q.end_date } });
    });
    reports = new ReportsAPI(client);
    const a: any = await reports.trialBalance('r', { asOfDate: '2024-08-31' });
    const b: any = await reports.trialBalance('r', { asOfDate: '2025-12-31' });
    expect(seen).toEqual(['2024-08-31', '2025-12-31']);
    expect(a.Header.EndPeriod).toBe('2024-08-31');
    expect(b.Header.EndPeriod).toBe('2025-12-31');
  });

  it('budgetVsActuals threads dateMacro → date_macro', async () => {
    await reports.budgetVsActuals('r', { dateMacro: 'This Fiscal Year-to-date', budgetId: '1000000021' });
    expect(client.get).toHaveBeenCalledWith('r', 'reports/BudgetVsActuals', {
      date_macro: 'This Fiscal Year-to-date',
      budget_id: '1000000021',
    });
  });

  it('throws a QBOError when Intuit answers 200 with a Fault body', async () => {
    client.get = vi.fn().mockResolvedValue({
      Fault: {
        Error: [
          {
            Message: 'An application error has occurred while processing your request',
            Detail: 'System Failure Error: java.lang.NullPointerException',
            code: '10000',
            element: 'SystemFailureError',
          },
        ],
        type: 'SystemFault',
      },
      time: '2026-09-05T14:59:25.954-07:00',
    });
    reports = new ReportsAPI(client);
    await expect(
      reports.budgetVsActuals('r', { startDate: '2026-01-01', endDate: '2026-12-31', budgetId: '1000000021', summarizeColumnBy: 'Month' })
    ).rejects.toThrow(/SystemFault.*NullPointerException.*SystemFailureError, code 10000/);
  });

  it('qboFaultMessage is null for a normal report body', () => {
    expect(qboFaultMessage({ Header: {}, Rows: {} })).toBeNull();
    expect(qboFaultMessage(null)).toBeNull();
  });
});
