import { describe, it, expect } from 'vitest';
import { qboJournalLinesToUpdateShape } from '../../src/server/line-converters.js';

// ─────────────────────────────────────────────────────────────────────────────
// Unit tests for header-level DepartmentRef + SalesTermRef support and the
// bulk_set_department backfill helper.
//
// These mirror the pattern used in mcp-bulk.test.ts — fixtures + small synthetic
// loops that exercise the same logic the MCP tool runs, without spinning up the
// full MCP server.
// ─────────────────────────────────────────────────────────────────────────────

// ── Header payload builder (mirrors create_bill payload construction) ────────

function buildBillCreatePayload(args: {
  vendor_id: string;
  txn_date?: string;
  due_date?: string;
  department_id?: string;
  sales_term_id?: string;
}): any {
  const payload: any = { VendorRef: { value: args.vendor_id }, Line: [] };
  if (args.txn_date) payload.TxnDate = args.txn_date;
  if (args.department_id) payload.DepartmentRef = { value: args.department_id };
  if (args.sales_term_id) payload.SalesTermRef = { value: args.sales_term_id };
  if (args.due_date) payload.DueDate = args.due_date;
  return payload;
}

describe('create_bill — DepartmentRef / SalesTermRef header refs', () => {
  it('sets DepartmentRef.value when department_id is provided', () => {
    const payload = buildBillCreatePayload({ vendor_id: 'v-1', department_id: '1' });
    expect(payload.DepartmentRef).toEqual({ value: '1' });
  });

  it('sets SalesTermRef.value when sales_term_id is provided', () => {
    const payload = buildBillCreatePayload({ vendor_id: 'v-1', sales_term_id: '5' });
    expect(payload.SalesTermRef).toEqual({ value: '5' });
  });

  it('omits ref objects entirely when params are not provided', () => {
    const payload = buildBillCreatePayload({ vendor_id: 'v-1' });
    expect(payload.DepartmentRef).toBeUndefined();
    expect(payload.SalesTermRef).toBeUndefined();
  });

  it('keeps existing fields unchanged when refs are added (no regression)', () => {
    const payload = buildBillCreatePayload({
      vendor_id: 'v-1',
      txn_date: '2026-05-01',
      due_date: '2026-05-15',
      department_id: '1',
      sales_term_id: '5',
    });
    expect(payload.VendorRef).toEqual({ value: 'v-1' });
    expect(payload.TxnDate).toBe('2026-05-01');
    // due_date wins over sales-term-computed DueDate per task spec
    expect(payload.DueDate).toBe('2026-05-15');
    expect(payload.DepartmentRef).toEqual({ value: '1' });
    expect(payload.SalesTermRef).toEqual({ value: '5' });
  });

  it('sets both refs together — common multi-location use case', () => {
    const payload = buildBillCreatePayload({ vendor_id: 'v-1', department_id: '1', sales_term_id: '3' });
    expect(payload.DepartmentRef).toEqual({ value: '1' });
    expect(payload.SalesTermRef).toEqual({ value: '3' });
  });
});

// ── Update payload builder (mirrors update_bill sparse merge) ────────────────

function buildBillUpdatePayload(existing: any, args: {
  department_id?: string;
  sales_term_id?: string;
  due_date?: string;
}): any {
  const payload: any = { ...existing };
  if (args.department_id) payload.DepartmentRef = { value: args.department_id };
  if (args.sales_term_id) payload.SalesTermRef = { value: args.sales_term_id };
  if (args.due_date) payload.DueDate = args.due_date;
  return payload;
}

describe('update_bill — sparse DepartmentRef / SalesTermRef updates', () => {
  const existingBill = {
    Id: '12728',
    SyncToken: '0',
    VendorRef: { value: 'v-1' },
    TxnDate: '2026-05-01',
    Line: [{ Amount: 100, DetailType: 'AccountBasedExpenseLineDetail' }],
  };

  it('sets DepartmentRef on a bill that previously had none', () => {
    const payload = buildBillUpdatePayload(existingBill, { department_id: '1' });
    expect(payload.DepartmentRef).toEqual({ value: '1' });
    expect(payload.VendorRef).toEqual({ value: 'v-1' });
    expect(payload.Line).toEqual(existingBill.Line);
  });

  it('overwrites an existing DepartmentRef', () => {
    const billWithDept = { ...existingBill, DepartmentRef: { value: '7' } };
    const payload = buildBillUpdatePayload(billWithDept, { department_id: '1' });
    expect(payload.DepartmentRef).toEqual({ value: '1' });
  });

  it('leaves DepartmentRef untouched when no department_id is passed', () => {
    const billWithDept = { ...existingBill, DepartmentRef: { value: '7' } };
    const payload = buildBillUpdatePayload(billWithDept, {});
    expect(payload.DepartmentRef).toEqual({ value: '7' });
  });
});

// ── JournalEntry line-level DepartmentRef ─────────────────────────────────────

const JE_LINE_WITH_DEPT = {
  DetailType: 'JournalEntryLineDetail',
  Amount: 100,
  JournalEntryLineDetail: {
    PostingType: 'Debit',
    AccountRef: { value: 'acct-1', name: 'Cash' },
    DepartmentRef: { value: '1' },
  },
};

describe('JournalEntry line-level DepartmentRef', () => {
  it('qboJournalLinesToUpdateShape exposes line.department_id', () => {
    const result = qboJournalLinesToUpdateShape([JE_LINE_WITH_DEPT]);
    expect(result[0].department_id).toBe('1');
  });

  it('omits department_id from update shape when DepartmentRef is missing', () => {
    const line = {
      DetailType: 'JournalEntryLineDetail',
      Amount: 100,
      JournalEntryLineDetail: { PostingType: 'Debit', AccountRef: { value: 'acct-1' } },
    };
    const result = qboJournalLinesToUpdateShape([line]);
    expect(result[0].department_id).toBeUndefined();
  });

  it('round-trip: build JE line with department_id puts DepartmentRef in JournalEntryLineDetail', () => {
    function buildJeLine(l: any) {
      const line: any = {
        Amount: l.amount,
        DetailType: 'JournalEntryLineDetail',
        JournalEntryLineDetail: {
          PostingType: l.posting_type,
          AccountRef: { value: l.account_id },
        },
      };
      if (l.department_id) line.JournalEntryLineDetail.DepartmentRef = { value: l.department_id };
      return line;
    }

    const updateShape = qboJournalLinesToUpdateShape([JE_LINE_WITH_DEPT]);
    const rebuilt = buildJeLine(updateShape[0]);
    expect(rebuilt.JournalEntryLineDetail.DepartmentRef).toEqual({ value: '1' });
  });
});

// ── bulk_set_department behavior ─────────────────────────────────────────────
//
// These tests simulate the logic of the bulk_set_department MCP tool by running
// the same fetch/transform/post loop against in-memory fixtures.

interface BulkResult {
  txn_id: string;
  status: 'updated' | 'would_update' | 'no_change' | 'failed';
  previous_department_id?: string;
  new_department_id: string;
  lines_changed?: number;
  error?: string;
}

function bulkSetDepartmentSim(args: {
  entity_type: string;
  transaction_ids: string[];
  department_id: string;
  dry_run: boolean;
  stop_on_error: boolean;
  store: Map<string, any>;
  postUpdate: (entity: string, payload: any) => void;
}): BulkResult[] {
  const results: BulkResult[] = [];
  for (const txnId of args.transaction_ids) {
    const entity = args.store.get(txnId);
    if (!entity) {
      results.push({ txn_id: txnId, status: 'failed', new_department_id: args.department_id, error: 'not found' });
      if (args.stop_on_error) break;
      continue;
    }
    if (args.entity_type === 'JournalEntry') {
      const existingLines: any[] = entity.Line ?? [];
      const jeLines = existingLines.filter((l: any) => l.DetailType === 'JournalEntryLineDetail');
      const allAlreadySet = jeLines.length > 0 && jeLines.every((l: any) =>
        l.JournalEntryLineDetail?.DepartmentRef?.value === args.department_id
      );
      if (allAlreadySet) {
        results.push({ txn_id: txnId, status: 'no_change', previous_department_id: args.department_id, new_department_id: args.department_id, lines_changed: 0 });
        continue;
      }
      let linesChanged = 0;
      const updatedLines = existingLines.map((l: any) => {
        if (l.DetailType !== 'JournalEntryLineDetail') return l;
        const prev = l.JournalEntryLineDetail?.DepartmentRef?.value;
        if (prev === args.department_id) return l;
        linesChanged++;
        return { ...l, JournalEntryLineDetail: { ...l.JournalEntryLineDetail, DepartmentRef: { value: args.department_id } } };
      });
      if (args.dry_run) {
        results.push({ txn_id: txnId, status: 'would_update', new_department_id: args.department_id, lines_changed: linesChanged });
        continue;
      }
      args.postUpdate(args.entity_type, { ...entity, Line: updatedLines });
      results.push({ txn_id: txnId, status: 'updated', new_department_id: args.department_id, lines_changed: linesChanged });
    } else {
      const previous = entity.DepartmentRef?.value;
      if (previous === args.department_id) {
        results.push({ txn_id: txnId, status: 'no_change', previous_department_id: previous, new_department_id: args.department_id });
        continue;
      }
      if (args.dry_run) {
        results.push({ txn_id: txnId, status: 'would_update', previous_department_id: previous, new_department_id: args.department_id });
        continue;
      }
      args.postUpdate(args.entity_type, { ...entity, DepartmentRef: { value: args.department_id } });
      results.push({ txn_id: txnId, status: 'updated', previous_department_id: previous, new_department_id: args.department_id });
    }
  }
  return results;
}

describe('bulk_set_department — Bill (header-level)', () => {
  function makeStore(): Map<string, any> {
    const store = new Map<string, any>();
    // 19 bills mirroring the reported scenario, none of which have DepartmentRef
    for (let id = 12728; id <= 12746; id++) {
      store.set(String(id), { Id: String(id), SyncToken: '0', VendorRef: { value: 'v-1' }, Line: [] });
    }
    return store;
  }

  it('dry_run reports would_update for every unset bill without posting', () => {
    const store = makeStore();
    const posted: any[] = [];
    const results = bulkSetDepartmentSim({
      entity_type: 'Bill',
      transaction_ids: Array.from({ length: 19 }, (_, i) => String(12728 + i)),
      department_id: '1',
      dry_run: true,
      stop_on_error: true,
      store,
      postUpdate: (_t, p) => posted.push(p),
    });
    expect(results).toHaveLength(19);
    expect(results.every(r => r.status === 'would_update')).toBe(true);
    expect(posted).toHaveLength(0); // dry_run must not post
  });

  it('live run sets DepartmentRef.value="1" on each bill and posts updates', () => {
    const store = makeStore();
    const posted: any[] = [];
    const results = bulkSetDepartmentSim({
      entity_type: 'Bill',
      transaction_ids: ['12728', '12729', '12730'],
      department_id: '1',
      dry_run: false,
      stop_on_error: true,
      store,
      postUpdate: (_t, p) => posted.push(p),
    });
    expect(results).toHaveLength(3);
    expect(results.every(r => r.status === 'updated')).toBe(true);
    expect(posted).toHaveLength(3);
    for (const p of posted) {
      expect(p.DepartmentRef).toEqual({ value: '1' });
    }
  });

  it('reports no_change when DepartmentRef already matches', () => {
    const store = new Map<string, any>([
      ['1', { Id: '1', SyncToken: '0', DepartmentRef: { value: '1' } }],
    ]);
    const posted: any[] = [];
    const results = bulkSetDepartmentSim({
      entity_type: 'Bill',
      transaction_ids: ['1'],
      department_id: '1',
      dry_run: false,
      stop_on_error: true,
      store,
      postUpdate: (_t, p) => posted.push(p),
    });
    expect(results[0].status).toBe('no_change');
    expect(posted).toHaveLength(0);
  });

  it('reports the previous department_id when overwriting', () => {
    const store = new Map<string, any>([
      ['1', { Id: '1', SyncToken: '0', DepartmentRef: { value: '7' } }],
    ]);
    const results = bulkSetDepartmentSim({
      entity_type: 'Bill',
      transaction_ids: ['1'],
      department_id: '1',
      dry_run: false,
      stop_on_error: true,
      store,
      postUpdate: () => {},
    });
    expect(results[0].status).toBe('updated');
    expect(results[0].previous_department_id).toBe('7');
    expect(results[0].new_department_id).toBe('1');
  });

  it('stop_on_error=true halts after first failure', () => {
    const store = new Map<string, any>([
      ['1', { Id: '1', SyncToken: '0' }],
      // '2' is missing — will fail
      ['3', { Id: '3', SyncToken: '0' }],
    ]);
    const posted: any[] = [];
    const results = bulkSetDepartmentSim({
      entity_type: 'Bill',
      transaction_ids: ['1', '2', '3'],
      department_id: '1',
      dry_run: false,
      stop_on_error: true,
      store,
      postUpdate: (_t, p) => posted.push(p),
    });
    expect(results).toHaveLength(2); // 1 updated, 2 failed, 3 never reached
    expect(results[0].status).toBe('updated');
    expect(results[1].status).toBe('failed');
    expect(posted).toHaveLength(1);
  });

  it('stop_on_error=false continues through failures', () => {
    const store = new Map<string, any>([
      ['1', { Id: '1', SyncToken: '0' }],
      ['3', { Id: '3', SyncToken: '0' }],
    ]);
    const posted: any[] = [];
    const results = bulkSetDepartmentSim({
      entity_type: 'Bill',
      transaction_ids: ['1', '2', '3'],
      department_id: '1',
      dry_run: false,
      stop_on_error: false,
      store,
      postUpdate: (_t, p) => posted.push(p),
    });
    expect(results).toHaveLength(3);
    expect(results[0].status).toBe('updated');
    expect(results[1].status).toBe('failed');
    expect(results[2].status).toBe('updated');
    expect(posted).toHaveLength(2);
  });
});

describe('bulk_set_department — JournalEntry (line-level)', () => {
  it('sets DepartmentRef on every JE line, not on the header', () => {
    const je = {
      Id: '99',
      SyncToken: '0',
      Line: [
        { DetailType: 'JournalEntryLineDetail', Amount: 100, JournalEntryLineDetail: { PostingType: 'Debit', AccountRef: { value: 'acct-1' } } },
        { DetailType: 'JournalEntryLineDetail', Amount: 100, JournalEntryLineDetail: { PostingType: 'Credit', AccountRef: { value: 'acct-2' } } },
      ],
    };
    const store = new Map<string, any>([['99', je]]);
    const posted: any[] = [];
    const results = bulkSetDepartmentSim({
      entity_type: 'JournalEntry',
      transaction_ids: ['99'],
      department_id: '1',
      dry_run: false,
      stop_on_error: true,
      store,
      postUpdate: (_t, p) => posted.push(p),
    });
    expect(results[0].status).toBe('updated');
    expect(results[0].lines_changed).toBe(2);
    expect(posted[0].DepartmentRef).toBeUndefined(); // header must NOT have DepartmentRef
    expect(posted[0].Line[0].JournalEntryLineDetail.DepartmentRef).toEqual({ value: '1' });
    expect(posted[0].Line[1].JournalEntryLineDetail.DepartmentRef).toEqual({ value: '1' });
  });

  it('reports no_change when every JE line already targets the department', () => {
    const je = {
      Id: '99',
      SyncToken: '0',
      Line: [
        { DetailType: 'JournalEntryLineDetail', Amount: 100, JournalEntryLineDetail: { PostingType: 'Debit', AccountRef: { value: 'acct-1' }, DepartmentRef: { value: '1' } } },
        { DetailType: 'JournalEntryLineDetail', Amount: 100, JournalEntryLineDetail: { PostingType: 'Credit', AccountRef: { value: 'acct-2' }, DepartmentRef: { value: '1' } } },
      ],
    };
    const store = new Map<string, any>([['99', je]]);
    const posted: any[] = [];
    const results = bulkSetDepartmentSim({
      entity_type: 'JournalEntry',
      transaction_ids: ['99'],
      department_id: '1',
      dry_run: false,
      stop_on_error: true,
      store,
      postUpdate: (_t, p) => posted.push(p),
    });
    expect(results[0].status).toBe('no_change');
    expect(posted).toHaveLength(0);
  });

  it('only changes lines that need it, leaves the rest alone', () => {
    const je = {
      Id: '99',
      SyncToken: '0',
      Line: [
        // already on department 1
        { DetailType: 'JournalEntryLineDetail', Amount: 100, JournalEntryLineDetail: { PostingType: 'Debit', AccountRef: { value: 'acct-1' }, DepartmentRef: { value: '1' } } },
        // unset — must be changed
        { DetailType: 'JournalEntryLineDetail', Amount: 100, JournalEntryLineDetail: { PostingType: 'Credit', AccountRef: { value: 'acct-2' } } },
      ],
    };
    const store = new Map<string, any>([['99', je]]);
    const posted: any[] = [];
    const results = bulkSetDepartmentSim({
      entity_type: 'JournalEntry',
      transaction_ids: ['99'],
      department_id: '1',
      dry_run: false,
      stop_on_error: true,
      store,
      postUpdate: (_t, p) => posted.push(p),
    });
    expect(results[0].lines_changed).toBe(1);
    expect(posted[0].Line[0].JournalEntryLineDetail.DepartmentRef).toEqual({ value: '1' });
    expect(posted[0].Line[1].JournalEntryLineDetail.DepartmentRef).toEqual({ value: '1' });
  });
});
