import { describe, it, expect } from 'vitest';
import { QBOError } from '../../src/api/client.js';
import {
  RecurringRequestError,
  buildRecurringUpdatePayload,
  isNotFoundError,
  lineFingerprint,
  linesUnchanged,
  matchesRecurringId,
  scheduleDiff,
  shapeRecurringInfo,
  summarizeRecurring,
  unwrapRecurring,
  validateScheduleChange,
  END_DATE_SEMANTICS,
} from '../../src/server/recurring-transaction.js';

function monthlyTemplate(type: 'Bill' | 'JournalEntry', id: string, ref: string, extra: Record<string, any> = {}) {
  const schedule = {
    IntervalType: 'Monthly',
    NumInterval: 1,
    DayOfMonth: 1,
    DaysBefore: 5,
    StartDate: '2026-01-01',
    NextDate: '2026-12-01',
    PreviousDate: '2026-11-01',
  };
  const recurringInfo = {
    Name: type === 'Bill' ? 'Monthly Telephone' : 'Prepaid Insurance Amortization',
    RecurType: 'Automated',
    Active: true,
    ScheduleInfo: schedule,
  };
  if (type === 'Bill') {
    return {
      Bill: {
        Id: id,
        SyncToken: '3',
        domain: 'QBO',
        sparse: false,
        RecurringInfo: recurringInfo,
        RecurDataRef: { value: ref },
        TotalAmt: 74.36,
        VendorRef: { value: '32', name: 'Cal Telephone' },
        Line: [
          {
            Id: '1',
            LineNum: 1,
            Description: 'Monthly Phone Bill',
            DetailType: 'AccountBasedExpenseLineDetail',
            Amount: 74.36,
            AccountBasedExpenseLineDetail: { AccountRef: { value: '77', name: 'Utilities:Telephone' } },
          },
        ],
        ...extra,
      },
    };
  }
  return {
    JournalEntry: {
      Id: id,
      SyncToken: '5',
      domain: 'QBO',
      sparse: false,
      RecurringInfo: recurringInfo,
      RecurDataRef: { value: ref },
      Line: [
        {
          Id: '1',
          Description: 'Amortization',
          Amount: 100,
          DetailType: 'JournalEntryLineDetail',
          JournalEntryLineDetail: { PostingType: 'Debit', AccountRef: { value: '91' } },
        },
        {
          Id: '2',
          Description: 'Amortization',
          Amount: 100,
          DetailType: 'JournalEntryLineDetail',
          JournalEntryLineDetail: { PostingType: 'Credit', AccountRef: { value: '44' } },
        },
      ],
      ...extra,
    },
  };
}

const billGet = {
  QueryResponse: {
    startPosition: 1,
    maxResults: 1,
    RecurringTransaction: [monthlyTemplate('Bill', '20', '2')],
  },
};

const jeGet = {
  QueryResponse: {
    RecurringTransaction: [monthlyTemplate('JournalEntry', '88', '7')],
  },
};

describe('unwrapRecurring / summarize', () => {
  it('unwraps a Bill template from a GET QueryResponse and returns full RecurringInfo plus type and total', () => {
    const u = unwrapRecurring(billGet);
    expect(u?.txnType).toBe('Bill');
    expect(u?.txn.Id).toBe('20');
    const summary = summarizeRecurring(u!);
    expect(summary).toMatchObject({
      id: '20',
      sync_token: '3',
      recur_data_ref: '2',
      txn_type: 'Bill',
      total_amt: 74.36,
      line_count: 1,
    });
    expect(summary.recurring_info).toEqual({
      Name: 'Monthly Telephone',
      RecurType: 'Automated',
      Active: true,
      ScheduleInfo: {
        IntervalType: 'Monthly',
        NumInterval: 1,
        DayOfMonth: 1,
        DaysBefore: 5,
        StartDate: '2026-01-01',
        NextDate: '2026-12-01',
        PreviousDate: '2026-11-01',
      },
    });
  });

  it('unwraps a JournalEntry template the same way', () => {
    const u = unwrapRecurring(jeGet);
    expect(u?.txnType).toBe('JournalEntry');
    const summary = summarizeRecurring(u!);
    expect(summary.recur_data_ref).toBe('7');
    expect(summary.line_count).toBe(2);
    expect(summary.recurring_info.ScheduleInfo.DaysBefore).toBe(5);
    expect(summary.recurring_info.ScheduleInfo.DayOfMonth).toBe(1);
  });

  it('matches either the wrapped Id or RecurDataRef.value', () => {
    const wrapper = monthlyTemplate('Bill', '20', '2');
    expect(matchesRecurringId(wrapper, '20')).toBe(true);
    expect(matchesRecurringId(wrapper, '2')).toBe(true);
    expect(matchesRecurringId(wrapper, '99')).toBe(false);
  });
});

describe('isNotFoundError', () => {
  function faultError(status: number, error: Record<string, unknown>) {
    const body = JSON.stringify({ Fault: { Error: [error], type: 'ValidationFault' } });
    const message = `QBO API error: ${error.Message ?? ''} — ${error.Detail ?? ''} (QBO code ${error.code ?? ''})`;
    return new QBOError(message, status, body);
  }

  it('treats HTTP 404 as not found', () => {
    expect(isNotFoundError(new QBOError('not found', 404))).toBe(true);
  });

  it('treats Fault 610 (HTTP 400 Object Not Found) as not found', () => {
    expect(isNotFoundError(faultError(400, {
      Message: 'Object Not Found',
      Detail: 'Object Not Found : RecurringTransaction with specified id was not found.',
      code: '610',
    }))).toBe(true);
  });

  it('treats a not-found Fault even when the code is not 610', () => {
    expect(isNotFoundError(faultError(400, {
      Message: 'Object Not Found',
      Detail: 'No matching RecurringTransaction.',
      code: '400',
    }))).toBe(true);
  });

  it('does not treat a business-validation Fault as not found', () => {
    expect(isNotFoundError(faultError(400, {
      Message: 'A business validation error has occurred while processing your request',
      Detail: 'Stale SyncToken. Please refresh and try again.',
      code: '5010',
    }))).toBe(false);
  });

  it('does not treat a connection-missing QBOError as not found', () => {
    expect(isNotFoundError(new QBOError('Connection not found: 9341454121860748'))).toBe(false);
  });
});

describe('validateScheduleChange', () => {
  it('accepts exactly one of end_date or max_occurrences', () => {
    expect(validateScheduleChange({ end_date: '2026-12-01' })).toEqual({ end_date: '2026-12-01' });
    expect(validateScheduleChange({ max_occurrences: 12 })).toEqual({ max_occurrences: 12 });
  });

  it('rejects both, neither, a bad date, or a non-positive max', () => {
    expect(() => validateScheduleChange({ end_date: '2026-12-01', max_occurrences: 12 })).toThrow(RecurringRequestError);
    expect(() => validateScheduleChange({})).toThrow(/exactly one/);
    expect(() => validateScheduleChange({ end_date: '12/01/2026' })).toThrow(/YYYY-MM-DD/);
    expect(() => validateScheduleChange({ max_occurrences: 0 })).toThrow(/positive integer/);
  });
});

describe('buildRecurringUpdatePayload — full update, lines preserved', () => {
  it('Bill: sets EndDate 2026-12-01, keeps Active=true, preserves every Line, sparse:false', () => {
    const u = unwrapRecurring(billGet)!;
    const originalLines = structuredClone(u.txn.Line);
    const { wrapper, before, after } = buildRecurringUpdatePayload(u, { end_date: '2026-12-01' });
    expect(wrapper.Bill.Id).toBe('20');
    expect(wrapper.Bill.SyncToken).toBe('3');
    expect(wrapper.Bill.sparse).toBe(false);
    expect(wrapper.Bill.domain).toBeUndefined(); // write-noise stripped
    expect(wrapper.Bill.RecurringInfo.Active).toBe(true);
    expect(wrapper.Bill.RecurringInfo.ScheduleInfo.EndDate).toBe('2026-12-01');
    expect(wrapper.Bill.RecurringInfo.ScheduleInfo.MaxOccurrences).toBeUndefined();
    expect(wrapper.Bill.RecurringInfo.ScheduleInfo.IntervalType).toBe('Monthly');
    expect(wrapper.Bill.RecurringInfo.ScheduleInfo.DayOfMonth).toBe(1);
    expect(wrapper.Bill.RecurringInfo.ScheduleInfo.DaysBefore).toBe(5);
    expect(wrapper.Bill.VendorRef).toEqual({ value: '32', name: 'Cal Telephone' });
    expect(wrapper.Bill.Line).toEqual(originalLines);
    expect(linesUnchanged(u.txn, wrapper.Bill)).toBe(true);
    expect(before.EndDate).toBeUndefined();
    expect(after.EndDate).toBe('2026-12-01');
    expect(scheduleDiff(before, after)).toEqual({ EndDate: { from: null, to: '2026-12-01' } });
  });

  it('JournalEntry: same EndDate change preserves both journal lines', () => {
    const u = unwrapRecurring(jeGet)!;
    const originalLines = structuredClone(u.txn.Line);
    const { wrapper } = buildRecurringUpdatePayload(u, { end_date: '2026-12-01' });
    expect(wrapper.JournalEntry.Line).toEqual(originalLines);
    expect(wrapper.JournalEntry.Line).toHaveLength(2);
    expect(wrapper.JournalEntry.RecurringInfo.ScheduleInfo.EndDate).toBe('2026-12-01');
    expect(wrapper.JournalEntry.sparse).toBe(false);
    expect(lineFingerprint(wrapper.JournalEntry).amounts).toEqual([100, 100]);
  });

  it('setting MaxOccurrences removes EndDate (docs: EndDate or MaxOccurrences)', () => {
    const wrapped = monthlyTemplate('Bill', '20', '2');
    wrapped.Bill.RecurringInfo.ScheduleInfo.EndDate = '2027-06-01';
    const { wrapper } = buildRecurringUpdatePayload(unwrapRecurring(wrapped)!, { max_occurrences: 8 });
    expect(wrapper.Bill.RecurringInfo.ScheduleInfo.MaxOccurrences).toBe(8);
    expect(wrapper.Bill.RecurringInfo.ScheduleInfo.EndDate).toBeUndefined();
    expect(wrapper.Bill.Line).toHaveLength(1);
  });

  it('does not mutate the fetched object', () => {
    const u = unwrapRecurring(billGet)!;
    buildRecurringUpdatePayload(u, { end_date: '2026-12-01' });
    expect(u.txn.RecurringInfo.ScheduleInfo.EndDate).toBeUndefined();
    expect(u.txn.domain).toBe('QBO');
  });
});

describe('EndDate semantics note', () => {
  it('documents inclusive last-scheduled-date behavior for the 2026-12-01 use case', () => {
    expect(END_DATE_SEMANTICS).toMatch(/inclusive/i);
    expect(END_DATE_SEMANTICS).toMatch(/2026-12-01/);
    expect(END_DATE_SEMANTICS).toMatch(/DaysBefore/);
  });
});

describe('shapeRecurringInfo', () => {
  it('includes the documented ScheduleInfo fields and any extras QBO sent', () => {
    const shaped = shapeRecurringInfo({
      Name: 'X',
      RecurType: 'Automated',
      Active: true,
      ScheduleInfo: { IntervalType: 'Monthly', DayOfMonth: 1, DaysBefore: 5, UnknownFuture: 'keep' },
    });
    expect(shaped.ScheduleInfo.UnknownFuture).toBe('keep');
    expect(shaped.ScheduleInfo.DayOfMonth).toBe(1);
  });
});
