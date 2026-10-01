import { describe, it, expect, vi } from 'vitest';
import { parseGeneralLedger, fiscalYearStart } from '../../src/server/report-shaping.js';
import { AttachmentsAPI } from '../../src/api/attachments.js';

// ─────────────────────────────────────────────────────────────────────────────
// 2026-09-27 (UWGA, account 1650 Prepaid expenses): the GL parser kept the
// last NON-ZERO running balance, so an account that netted to 0.00 reported
// the previous row's 77.75 as its ending_balance.
// ─────────────────────────────────────────────────────────────────────────────

const GL_COLUMNS = {
  Column: [
    { ColTitle: 'Date' }, { ColTitle: 'Transaction Type' }, { ColTitle: 'Num' },
    { ColTitle: 'Name' }, { ColTitle: 'Memo/Description' }, { ColTitle: 'Split' },
    { ColTitle: 'Amount' }, { ColTitle: 'Balance' },
  ],
};

function row(date: string, amount: string, balance: string) {
  return { ColData: [{ value: date }, { value: 'Journal Entry' }, { value: '' }, { value: '' }, { value: '' }, { value: '' }, { value: amount }, { value: balance }] };
}

function gl(rows: any[], summaryBalance = '') {
  return {
    Columns: GL_COLUMNS,
    Rows: {
      Row: [
        {
          Header: { ColData: [{ value: '1650 Prepaid expenses', id: '90' }] },
          Rows: { Row: rows },
          Summary: { ColData: [{ value: 'Total for 1650 Prepaid expenses' }, { value: '' }, { value: '' }, { value: '' }, { value: '' }, { value: '' }, { value: '0.00' }, { value: summaryBalance }] },
        },
      ],
    },
  };
}

const CHART = [{ Id: '90', Name: 'Prepaid expenses', AcctNum: '1650', Classification: 'Asset' }];

describe('parseGeneralLedger — ending_balance', () => {
  it('reports 0.00 when the running balance ends at zero (not the prior non-zero row)', () => {
    const out = parseGeneralLedger(gl([row('2026-07-01', '155.50', '155.50'), row('2026-07-15', '-77.75', '77.75'), row('2026-07-31', '-77.75', '0.00')]), 'UWGA', '2026-07-01', '2027-07-31', CHART);
    expect(out.accounts[0].ending_balance).toBe(0);
  });

  it('uses the last row with a printed balance and ignores blank-balance rows', () => {
    const out = parseGeneralLedger(gl([row('2026-07-01', '100.00', '100.00'), row('2026-07-02', '', '')]), 'UWGA', '2026-07-01', '2026-07-31', CHART);
    expect(out.accounts[0].ending_balance).toBe(100);
  });

  it('honors a printed Summary balance, including zero', () => {
    const out = parseGeneralLedger(gl([row('2026-07-01', '50.00', '50.00')], '0.00'), 'UWGA', '2026-07-01', '2026-07-31', CHART);
    expect(out.accounts[0].ending_balance).toBe(0);
  });
});

describe('fiscalYearStart', () => {
  it('uses the calendar year when the fiscal year starts in January or is unknown', () => {
    expect(fiscalYearStart('2026-07-31', 'January')).toBe('2026-01-01');
    expect(fiscalYearStart('2026-07-31', undefined)).toBe('2026-01-01');
  });
  it('rolls back a year when the end date is before the fiscal start month', () => {
    expect(fiscalYearStart('2026-03-31', 'July')).toBe('2025-07-01');
    expect(fiscalYearStart('2026-07-31', 'July')).toBe('2026-07-01');
    expect(fiscalYearStart('2026-08-31', 'july')).toBe('2026-07-01');
  });
});

describe('AttachmentsAPI.link', () => {
  const existing = {
    Id: '5000000000001',
    SyncToken: '2',
    FileName: 'support.pdf',
    AttachableRef: [{ EntityRef: { type: 'JournalEntry', value: '37072' }, IncludeOnSend: false }],
  };

  it('keeps existing links and appends the new one in a sparse update', async () => {
    const post = vi.fn().mockResolvedValue({ Attachable: { ...existing, AttachableRef: [...existing.AttachableRef, { EntityRef: { type: 'Bill', value: '501' } }] } });
    const api = new AttachmentsAPI({ post, query: vi.fn() } as any);
    const { alreadyLinked } = await api.link('r', existing, { type: 'Bill', id: '501' });
    expect(alreadyLinked).toBe(false);
    expect(post).toHaveBeenCalledWith('r', 'attachable', {
      Id: '5000000000001',
      SyncToken: '2',
      sparse: true,
      AttachableRef: [
        { EntityRef: { type: 'JournalEntry', value: '37072' }, IncludeOnSend: false },
        { EntityRef: { value: '501', type: 'Bill' } },
      ],
    });
  });

  it('is a no-op when already linked to that entity', async () => {
    const post = vi.fn();
    const api = new AttachmentsAPI({ post, query: vi.fn() } as any);
    const { alreadyLinked } = await api.link('r', existing, { type: 'journalentry', id: '37072' });
    expect(alreadyLinked).toBe(true);
    expect(post).not.toHaveBeenCalled();
  });
});

describe('AttachmentsAPI.listForEntity / download', () => {
  it('queries by entity type and id, escaping quotes', async () => {
    const query = vi.fn().mockResolvedValue({ QueryResponse: { Attachable: [{ Id: '1' }] } });
    const api = new AttachmentsAPI({ post: vi.fn(), query } as any);
    const list = await api.listForEntity('r', 'Bill', "5'01");
    expect(list).toEqual([{ Id: '1' }]);
    expect(query.mock.calls[0][1]).toContain("AttachableRef.EntityRef.Type = 'Bill'");
    expect(query.mock.calls[0][1]).toContain("AttachableRef.EntityRef.value = '5\\'01'");
  });

  it('refuses non-https download URLs', async () => {
    const api = new AttachmentsAPI({ post: vi.fn(), query: vi.fn() } as any);
    await expect(api.download('r', 'http://example.com/x')).rejects.toThrow(/https/);
  });
});
