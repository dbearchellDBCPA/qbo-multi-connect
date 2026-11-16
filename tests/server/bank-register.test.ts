import { describe, it, expect } from 'vitest';
import {
  resolveRegisterAccount,
  formatBankRegister,
  filterToUncleared,
  isUnclearedClr,
  findRegisterColumn,
  defaultUnclearedRange,
  BANK_REGISTER_COLUMNS,
} from '../../src/server/bank-register.js';

const CHART = [
  { Id: '55', Name: 'Huntington Checking', AcctNum: '1150040001', AccountType: 'Bank', FullyQualifiedName: 'Huntington Checking' },
  { Id: '12', Name: 'FNB Checking', AcctNum: '104', AccountType: 'Bank', FullyQualifiedName: 'FNB Checking' },
  { Id: '104', Name: 'Office Supplies', AcctNum: '6500', AccountType: 'Expense', FullyQualifiedName: 'Office Supplies' },
  { Id: '90', Name: 'Huntington Money Market', AcctNum: '1150040099', AccountType: 'Bank', FullyQualifiedName: 'Huntington Money Market' },
];

describe('resolveRegisterAccount', () => {
  it('resolves a bank account by AcctNum (the number Frank passed, not the QBO Id)', () => {
    const r = resolveRegisterAccount(CHART, '1150040001');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.account.id).toBe('55');
      expect(r.account.label).toBe('1150040001 Huntington Checking');
    }
  });

  it('resolves FNB by account number 104 even when another account has Id 104, preferring Bank/Credit Card', () => {
    // 104 is FNB's AcctNum AND Office Supplies' QBO Id. A bank-register
    // call should land on the Bank account, not mix or pick the expense.
    const r = resolveRegisterAccount(CHART, '104');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.account.id).toBe('12');
      expect(r.account.label).toBe('104 FNB Checking');
    }
  });

  it('errors when an Id/number collision is between two Bank accounts', () => {
    const r = resolveRegisterAccount(
      [
        { Id: '12', Name: 'FNB Checking', AcctNum: '104', AccountType: 'Bank' },
        { Id: '104', Name: 'Legacy Bank', AcctNum: '9000', AccountType: 'Bank' },
      ],
      '104',
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/more than one account/);
  });

  it('resolves by QBO Account Id when that Id is unambiguous', () => {
    const r = resolveRegisterAccount(CHART, '55');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.account.id).toBe('55');
  });

  it('resolves by exact name', () => {
    const r = resolveRegisterAccount(CHART, 'FNB Checking');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.account.id).toBe('12');
  });

  it('does not fall back to all accounts when the term matches nothing', () => {
    const r = resolveRegisterAccount(CHART, '999999');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/No account matched/);
  });

  it('refuses an ambiguous name substring instead of mixing registers', () => {
    const r = resolveRegisterAccount(CHART, 'Huntington');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/ambiguous/);
  });
});

describe('isUnclearedClr', () => {
  it('treats blank as uncleared and C/R as cleared/reconciled', () => {
    expect(isUnclearedClr('')).toBe(true);
    expect(isUnclearedClr(undefined)).toBe(true);
    expect(isUnclearedClr('C')).toBe(false);
    expect(isUnclearedClr('R')).toBe(false);
    expect(isUnclearedClr('Cleared')).toBe(false);
    expect(isUnclearedClr('Reconciled')).toBe(false);
  });
});

function col(title: string, key: string) {
  return { ColTitle: title, MetaData: [{ Name: 'ColKey', Value: key }] };
}

/** Mock GeneralLedger-shaped register for one account, with is_cleared + running balance. */
function registerReport(accountLabel: string, accountId: string, rows: Array<{ date: string; type: string; num?: string; name?: string; memo?: string; clr: string; amount: string; balance: string }>) {
  return {
    Header: { ReportName: 'GeneralLedger', StartPeriod: '2026-10-01', EndPeriod: '2026-10-31' },
    Columns: {
      Column: [
        col('Date', 'tx_date'),
        col('Transaction Type', 'txn_type'),
        col('Num', 'doc_num'),
        col('Name', 'name'),
        col('Memo/Description', 'memo'),
        col('Split', 'split_acc'),
        col('Clr', 'is_cleared'),
        col('Amount', 'subt_nat_amount'),
        col('Balance', 'rbal_nat_amount'),
      ],
    },
    Rows: {
      Row: [
        {
          type: 'Section',
          Header: { ColData: [{ value: accountLabel, id: accountId }] },
          Rows: {
            Row: rows.map((r) => ({
              type: 'Data',
              ColData: [
                { value: r.date }, { value: r.type }, { value: r.num ?? '' }, { value: r.name ?? '' },
                { value: r.memo ?? '' }, { value: 'Split' }, { value: r.clr }, { value: r.amount }, { value: r.balance },
              ],
            })),
          },
        },
      ],
    },
  };
}

const HUNTINGTON_ROWS = [
  { date: '2026-10-02', type: 'Deposit', name: 'United Way', memo: 'lockbox', clr: 'R', amount: '1000.00', balance: '1000.00' },
  { date: '2026-10-15', type: 'Check', num: '101', name: 'Vendor A', memo: 'supplies', clr: '', amount: '-50.00', balance: '950.00' },
  { date: '2026-10-20', type: 'Expense', name: 'Vendor B', memo: 'pending', clr: 'C', amount: '-25.00', balance: '925.00' },
];

const FNB_ROWS = [
  { date: '2026-10-05', type: 'Deposit', name: 'Grant', memo: 'FNB only', clr: '', amount: '5000.00', balance: '5000.00' },
];

describe('formatBankRegister', () => {
  it('maps Clr and running balance by ColKey, not just ColTitle', () => {
    // Titles that the old formatter missed ('Reconcile?' instead of 'Clr'/'Balance').
    const report = registerReport('1150040001 Huntington Checking', '55', HUNTINGTON_ROWS);
    report.Columns.Column[6].ColTitle = '';
    report.Columns.Column[8].ColTitle = '';
    const out = formatBankRegister(report, 'GSC', '1150040001 Huntington Checking', 'BANK REGISTER', { start: '2026-10-01', end: '2026-10-31' });
    expect(out).toMatch(/BANK REGISTER — GSC/);
    expect(out).toMatch(/Account: 1150040001 Huntington Checking/);
    expect(out).toMatch(/Period: 2026-10-01 to 2026-10-31/);
    expect(out).toMatch(/Transactions: 3/);
    expect(out).toMatch(/R\s+.+\$1,000\.00\s+\$1,000\.00/);
    expect(out).toMatch(/-\$50\.00\s+\$950\.00/);
    expect(out).toMatch(/C\s+.+-\$25\.00\s+\$925\.00/);
    expect(out).not.toMatch(/QBO did not return/);
  });

  it('warns when Clr/Balance columns are absent (the pre-fix TransactionList shape)', () => {
    const report = {
      Header: { StartPeriod: '2026-10-01', EndPeriod: '2026-10-31' },
      Columns: {
        Column: [
          { ColTitle: 'Date' }, { ColTitle: 'Transaction Type' }, { ColTitle: 'Num' },
          { ColTitle: 'Name' }, { ColTitle: 'Memo/Description' }, { ColTitle: 'Account' },
          { ColTitle: 'Amount' },
        ],
      },
      Rows: { Row: [{ type: 'Data', ColData: [
        { value: '2026-10-02' }, { value: 'Deposit' }, { value: '' }, { value: 'X' },
        { value: '' }, { value: 'Huntington' }, { value: '100.00' },
      ] }] },
    };
    const out = formatBankRegister(report, 'GSC', 'mixed');
    expect(out).toMatch(/QBO did not return Clr \(is_cleared\) or Balance \(rbal_nat_amount\)/);
  });
});

describe('filterToUncleared', () => {
  it('keeps blank Clr rows and drops C/R', () => {
    const report = registerReport('1150040001 Huntington Checking', '55', HUNTINGTON_ROWS);
    const filtered = filterToUncleared(report);
    const out = formatBankRegister(filtered, 'GSC', '1150040001 Huntington Checking', 'UNCLEARED TRANSACTIONS');
    expect(out).toMatch(/Transactions: 1/);
    expect(out).toMatch(/Vendor A/);
    expect(out).not.toMatch(/United Way/);
    expect(out).not.toMatch(/Vendor B/);
  });
});

describe('findRegisterColumn / default range', () => {
  it('prefers ColKey over a misleading title', () => {
    const cols = [
      { ColTitle: 'Balance', MetaData: [{ Name: 'ColKey', Value: 'subt_nat_amount' }] },
      { ColTitle: 'Running', MetaData: [{ Name: 'ColKey', Value: 'rbal_nat_amount' }] },
    ];
    expect(findRegisterColumn(cols, ['rbal_nat_amount'], ['balance'])).toBe(1);
    expect(findRegisterColumn(cols, ['subt_nat_amount'], ['amount'])).toBe(0);
  });

  it('defaults uncleared dates to a 10-year window ending today', () => {
    const r = defaultUnclearedRange(new Date(2026, 10, 16)); // Nov 16, 2026 local
    expect(r).toEqual({ start: '2016-11-16', end: '2026-11-16' });
  });

  it('exports the GL column set used by the tools', () => {
    expect(BANK_REGISTER_COLUMNS).toMatch(/is_cleared/);
    expect(BANK_REGISTER_COLUMNS).toMatch(/rbal_nat_amount/);
  });
});

export { registerReport, HUNTINGTON_ROWS, FNB_ROWS, CHART };
