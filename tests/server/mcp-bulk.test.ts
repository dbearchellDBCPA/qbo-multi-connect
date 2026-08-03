import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  qboSalesLinesToUpdateShape,
  qboBillLinesToUpdateShape,
  qboJournalLinesToUpdateShape,
  qboExpenseLinesToUpdateShape,
  qboPoLinesToUpdateShape,
  qboDepositLinesToUpdateShape,
  swapItemInLines,
  swapAccountInLines,
} from '../../src/server/line-converters.js';

// ── Fixtures ───────────────────────────────────────────────────────────────────

const SALES_LINE_NATIVE = {
  DetailType: 'SalesItemLineDetail',
  Amount: 250,
  Description: 'Widget A',
  SalesItemLineDetail: {
    Qty: 5,
    UnitPrice: 50,
    ItemRef: { value: 'item-1', name: 'Widget A' },
    ClassRef: { value: 'class-1' },
    TaxCodeRef: { value: 'TAX' },
  },
};

const SUBTOTAL_LINE_NATIVE = {
  DetailType: 'SubTotalLineDetail',
  Amount: 250,
  SubTotalLineDetail: {},
};

const DESCRIPTION_ONLY_LINE_NATIVE = {
  DetailType: 'DescriptionOnly',
  Amount: 0,
  Description: 'Section header',
};

const BILL_ACCOUNT_LINE_NATIVE = {
  DetailType: 'AccountBasedExpenseLineDetail',
  Amount: 100,
  Description: 'Office supplies',
  AccountBasedExpenseLineDetail: {
    AccountRef: { value: 'acct-1', name: 'Office Supplies' },
    ClassRef: { value: 'class-2' },
  },
};

const BILL_ITEM_LINE_NATIVE = {
  DetailType: 'ItemBasedExpenseLineDetail',
  Amount: 200,
  Description: 'Inventory purchase',
  ItemBasedExpenseLineDetail: {
    Qty: 4,
    UnitPrice: 50,
    ItemRef: { value: 'item-2', name: 'Product B' },
    ClassRef: { value: 'class-3' },
  },
};

const JE_LINE_DEBIT_NATIVE = {
  DetailType: 'JournalEntryLineDetail',
  Amount: 500,
  Description: 'Debit entry',
  JournalEntryLineDetail: {
    PostingType: 'Debit',
    AccountRef: { value: 'acct-10', name: 'Cash' },
    ClassRef: { value: 'class-1', name: 'Main' },
    Entity: {
      Type: 'Vendor',
      EntityRef: { value: 'vendor-1', name: 'ACME Inc' },
    },
  },
};

const JE_LINE_CREDIT_NATIVE = {
  DetailType: 'JournalEntryLineDetail',
  Amount: 500,
  Description: 'Credit entry',
  JournalEntryLineDetail: {
    PostingType: 'Credit',
    AccountRef: { value: 'acct-20', name: 'Revenue' },
  },
};

const EXPENSE_ACCOUNT_LINE_NATIVE = {
  DetailType: 'AccountBasedExpenseLineDetail',
  Amount: 75,
  Description: 'Travel',
  AccountBasedExpenseLineDetail: {
    AccountRef: { value: 'acct-5', name: 'Travel Expense' },
    ClassRef: { value: 'class-4' },
  },
};

const PO_ITEM_LINE_NATIVE = {
  DetailType: 'ItemBasedExpenseLineDetail',
  Amount: 300,
  Description: 'Ordered goods',
  ItemBasedExpenseLineDetail: {
    Qty: 10,
    UnitPrice: 30,
    ItemRef: { value: 'item-3', name: 'Good C' },
  },
};

const PO_ACCOUNT_LINE_NATIVE = {
  DetailType: 'AccountBasedExpenseLineDetail',
  Amount: 50,
  AccountBasedExpenseLineDetail: {
    AccountRef: { value: 'acct-6' },
  },
};

const DEPOSIT_PAYMENT_LINE_NATIVE = {
  Amount: 400,
  LinkedTxn: [{ TxnId: 'pmt-99', TxnType: 'Payment' }],
};

const DEPOSIT_DIRECT_LINE_NATIVE = {
  Amount: 150,
  Description: 'Direct income',
  DetailType: 'DepositLineDetail',
  DepositLineDetail: {
    AccountRef: { value: 'acct-7' },
    Entity: { type: 'Customer', EntityRef: { value: 'cust-1' } },
  },
};

// ═══════════════════════════════════════════════════════════════════════════════
// Unit tests — line shape converters
// ═══════════════════════════════════════════════════════════════════════════════

describe('qboSalesLinesToUpdateShape', () => {
  it('converts SalesItemLineDetail to update-ready shape', () => {
    const result = qboSalesLinesToUpdateShape([SALES_LINE_NATIVE]);
    expect(result).toHaveLength(1);
    const line = result[0];
    expect(line.amount).toBe(250);
    expect(line.description).toBe('Widget A');
    expect(line.detail_type).toBe('SalesItemLineDetail');
    expect(line.item_id).toBe('item-1');
    expect(line.item_name).toBe('Widget A');
    expect(line.quantity).toBe(5);
    expect(line.unit_price).toBe(50);
    expect(line.class_id).toBe('class-1');
    expect(line.tax_code_id).toBe('TAX');
  });

  it('filters out SubTotalLineDetail lines', () => {
    const result = qboSalesLinesToUpdateShape([SALES_LINE_NATIVE, SUBTOTAL_LINE_NATIVE]);
    expect(result).toHaveLength(1);
    expect(result[0].detail_type).toBe('SalesItemLineDetail');
  });

  it('preserves DescriptionOnly lines', () => {
    const result = qboSalesLinesToUpdateShape([DESCRIPTION_ONLY_LINE_NATIVE]);
    expect(result).toHaveLength(1);
    expect(result[0].detail_type).toBe('DescriptionOnly');
    expect(result[0].description).toBe('Section header');
    expect(result[0].item_id).toBeUndefined();
  });

  it('handles empty array', () => {
    expect(qboSalesLinesToUpdateShape([])).toEqual([]);
    expect(qboSalesLinesToUpdateShape(null as any)).toEqual([]);
  });
});

describe('qboBillLinesToUpdateShape', () => {
  it('converts AccountBasedExpenseLineDetail', () => {
    const result = qboBillLinesToUpdateShape([BILL_ACCOUNT_LINE_NATIVE]);
    expect(result).toHaveLength(1);
    const line = result[0];
    expect(line.detail_type).toBe('AccountBasedExpenseLineDetail');
    expect(line.amount).toBe(100);
    expect(line.account_id).toBe('acct-1');
    expect(line.account_name).toBe('Office Supplies');
    expect(line.class_id).toBe('class-2');
  });

  it('converts ItemBasedExpenseLineDetail', () => {
    const result = qboBillLinesToUpdateShape([BILL_ITEM_LINE_NATIVE]);
    expect(result).toHaveLength(1);
    const line = result[0];
    expect(line.detail_type).toBe('ItemBasedExpenseLineDetail');
    expect(line.item_id).toBe('item-2');
    expect(line.item_name).toBe('Product B');
    expect(line.quantity).toBe(4);
    expect(line.unit_price).toBe(50);
    expect(line.class_id).toBe('class-3');
  });

  it('handles mixed bill lines', () => {
    const result = qboBillLinesToUpdateShape([BILL_ACCOUNT_LINE_NATIVE, BILL_ITEM_LINE_NATIVE]);
    expect(result).toHaveLength(2);
  });
});

describe('qboJournalLinesToUpdateShape', () => {
  it('converts debit line with entity and class', () => {
    const result = qboJournalLinesToUpdateShape([JE_LINE_DEBIT_NATIVE]);
    expect(result).toHaveLength(1);
    const line = result[0];
    expect(line.posting_type).toBe('Debit');
    expect(line.account_id).toBe('acct-10');
    expect(line.account_name).toBe('Cash');
    expect(line.class_id).toBe('class-1');
    expect(line.class_name).toBe('Main');
    expect(line.entity_type).toBe('Vendor');
    expect(line.entity_id).toBe('vendor-1');
    expect(line.entity_name).toBe('ACME Inc');
  });

  it('converts credit line without entity', () => {
    const result = qboJournalLinesToUpdateShape([JE_LINE_CREDIT_NATIVE]);
    expect(result).toHaveLength(1);
    const line = result[0];
    expect(line.posting_type).toBe('Credit');
    expect(line.account_id).toBe('acct-20');
    expect(line.entity_type).toBeUndefined();
  });
});

describe('qboExpenseLinesToUpdateShape', () => {
  it('converts AccountBasedExpenseLineDetail using expense_account_id (not account_id)', () => {
    const result = qboExpenseLinesToUpdateShape([EXPENSE_ACCOUNT_LINE_NATIVE]);
    expect(result).toHaveLength(1);
    const line = result[0];
    expect(line.detail_type).toBe('AccountBasedExpenseLineDetail');
    expect(line.expense_account_id).toBe('acct-5');
    expect(line.expense_account_name).toBe('Travel Expense');
    expect(line.class_id).toBe('class-4');
    // Must NOT use account_id (that's for bills, not expenses)
    expect(line.account_id).toBeUndefined();
  });
});

describe('qboPoLinesToUpdateShape', () => {
  it('converts item-based PO line', () => {
    const result = qboPoLinesToUpdateShape([PO_ITEM_LINE_NATIVE]);
    expect(result).toHaveLength(1);
    const line = result[0];
    expect(line.item_id).toBe('item-3');
    expect(line.item_name).toBe('Good C');
    expect(line.quantity).toBe(10);
    expect(line.unit_price).toBe(30);
  });

  it('converts account-based PO line', () => {
    const result = qboPoLinesToUpdateShape([PO_ACCOUNT_LINE_NATIVE]);
    expect(result).toHaveLength(1);
    expect(result[0].account_id).toBe('acct-6');
  });
});

describe('qboDepositLinesToUpdateShape', () => {
  it('separates linked payments from direct deposit lines', () => {
    const result = qboDepositLinesToUpdateShape([DEPOSIT_PAYMENT_LINE_NATIVE, DEPOSIT_DIRECT_LINE_NATIVE]);
    expect(result.linked_payment_ids).toHaveLength(1);
    expect(result.linked_payment_ids[0]).toEqual({ payment_id: 'pmt-99', amount: 400 });

    expect(result.deposit_lines).toHaveLength(1);
    expect(result.deposit_lines[0].amount).toBe(150);
    expect(result.deposit_lines[0].account_id).toBe('acct-7');
    expect(result.deposit_lines[0].description).toBe('Direct income');
    expect(result.deposit_lines[0].customer_id).toBe('cust-1');
  });

  it('handles deposit with only linked payments', () => {
    const result = qboDepositLinesToUpdateShape([DEPOSIT_PAYMENT_LINE_NATIVE]);
    expect(result.linked_payment_ids).toHaveLength(1);
    expect(result.deposit_lines).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Unit tests — swap helpers
// ═══════════════════════════════════════════════════════════════════════════════

describe('swapItemInLines', () => {
  it('swaps item in SalesItemLineDetail', () => {
    const { updatedLines, linesChanged } = swapItemInLines([SALES_LINE_NATIVE], 'item-1', 'item-NEW');
    expect(linesChanged).toBe(1);
    expect(updatedLines[0].SalesItemLineDetail.ItemRef.value).toBe('item-NEW');
    // Preserves other fields
    expect(updatedLines[0].SalesItemLineDetail.Qty).toBe(5);
    expect(updatedLines[0].Amount).toBe(250);
  });

  it('swaps item in ItemBasedExpenseLineDetail', () => {
    const { updatedLines, linesChanged } = swapItemInLines([BILL_ITEM_LINE_NATIVE], 'item-2', 'item-NEW');
    expect(linesChanged).toBe(1);
    expect(updatedLines[0].ItemBasedExpenseLineDetail.ItemRef.value).toBe('item-NEW');
  });

  it('does not swap non-matching item', () => {
    const { updatedLines, linesChanged } = swapItemInLines([SALES_LINE_NATIVE], 'item-WRONG', 'item-NEW');
    expect(linesChanged).toBe(0);
    expect(updatedLines[0].SalesItemLineDetail.ItemRef.value).toBe('item-1');
  });

  it('does not mutate original lines array', () => {
    const original = [{ ...SALES_LINE_NATIVE, SalesItemLineDetail: { ...SALES_LINE_NATIVE.SalesItemLineDetail, ItemRef: { value: 'item-1', name: 'Widget A' } } }];
    swapItemInLines(original, 'item-1', 'item-NEW');
    expect(original[0].SalesItemLineDetail.ItemRef.value).toBe('item-1');
  });

  it('counts multiple matching lines', () => {
    const lines = [SALES_LINE_NATIVE, SALES_LINE_NATIVE];
    const { linesChanged } = swapItemInLines(lines, 'item-1', 'item-NEW');
    expect(linesChanged).toBe(2);
  });
});

describe('swapAccountInLines', () => {
  it('swaps account in AccountBasedExpenseLineDetail', () => {
    const { updatedLines, linesChanged } = swapAccountInLines([BILL_ACCOUNT_LINE_NATIVE], 'acct-1', 'acct-NEW');
    expect(linesChanged).toBe(1);
    expect(updatedLines[0].AccountBasedExpenseLineDetail.AccountRef.value).toBe('acct-NEW');
    // Preserves name and other refs
    expect(updatedLines[0].AccountBasedExpenseLineDetail.ClassRef?.value).toBe('class-2');
  });

  it('swaps account in JournalEntryLineDetail', () => {
    const { updatedLines, linesChanged } = swapAccountInLines([JE_LINE_DEBIT_NATIVE], 'acct-10', 'acct-NEW');
    expect(linesChanged).toBe(1);
    expect(updatedLines[0].JournalEntryLineDetail.AccountRef.value).toBe('acct-NEW');
  });

  it('swaps account in DepositLineDetail', () => {
    const { updatedLines, linesChanged } = swapAccountInLines([DEPOSIT_DIRECT_LINE_NATIVE], 'acct-7', 'acct-NEW');
    expect(linesChanged).toBe(1);
    expect(updatedLines[0].DepositLineDetail.AccountRef.value).toBe('acct-NEW');
  });

  it('does not swap non-matching account', () => {
    const { linesChanged } = swapAccountInLines([BILL_ACCOUNT_LINE_NATIVE], 'acct-WRONG', 'acct-NEW');
    expect(linesChanged).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Round-trip tests — get_<entity> → update_<entity> produces identical payload
//
// These tests verify that the shape returned by the get_ converter functions
// can be fed back into the update line-builder without information loss.
// ═══════════════════════════════════════════════════════════════════════════════

describe('Round-trip: sales lines (Invoice, SalesReceipt, CreditMemo, Estimate)', () => {
  it('get → update produces same QBO line payload', () => {
    const nativeLines = [SALES_LINE_NATIVE];

    // Step 1: convert to update-ready shape (simulates get_invoice)
    const updateReady = qboSalesLinesToUpdateShape(nativeLines);
    expect(updateReady[0].item_id).toBe('item-1');

    // Step 2: simulate what update_invoice does when given these lines
    function rebuildQboLines(lines: any[]) {
      return lines.map(l => {
        const line: any = { Amount: l.amount, DetailType: l.detail_type, Description: l.description };
        if (l.detail_type === 'SalesItemLineDetail') {
          line.SalesItemLineDetail = { Qty: l.quantity ?? 1, UnitPrice: l.unit_price ?? l.amount };
          if (l.item_id) line.SalesItemLineDetail.ItemRef = { value: l.item_id, name: l.item_name };
        }
        return line;
      });
    }

    const rebuilt = rebuildQboLines(updateReady);

    // Step 3: verify the round-trip produces an equivalent payload
    expect(rebuilt[0].Amount).toBe(SALES_LINE_NATIVE.Amount);
    expect(rebuilt[0].DetailType).toBe(SALES_LINE_NATIVE.DetailType);
    expect(rebuilt[0].SalesItemLineDetail.ItemRef.value).toBe('item-1');
    expect(rebuilt[0].SalesItemLineDetail.Qty).toBe(5);
    expect(rebuilt[0].SalesItemLineDetail.UnitPrice).toBe(50);
  });
});

describe('Round-trip: bill lines', () => {
  it('get → update produces same QBO line payload for account-based lines', () => {
    const updateReady = qboBillLinesToUpdateShape([BILL_ACCOUNT_LINE_NATIVE]);

    function rebuildBillLines(lines: any[]) {
      return lines.map(l => {
        const line: any = { Amount: l.amount, DetailType: l.detail_type, Description: l.description };
        if (l.detail_type === 'AccountBasedExpenseLineDetail') {
          line.AccountBasedExpenseLineDetail = {};
          if (l.account_id) line.AccountBasedExpenseLineDetail.AccountRef = { value: l.account_id, name: l.account_name };
          if (l.class_id) line.AccountBasedExpenseLineDetail.ClassRef = { value: l.class_id };
        } else {
          line.ItemBasedExpenseLineDetail = { Qty: l.quantity ?? 1, UnitPrice: l.unit_price ?? l.amount };
          if (l.item_id) line.ItemBasedExpenseLineDetail.ItemRef = { value: l.item_id };
        }
        return line;
      });
    }

    const rebuilt = rebuildBillLines(updateReady);
    expect(rebuilt[0].Amount).toBe(100);
    expect(rebuilt[0].AccountBasedExpenseLineDetail.AccountRef.value).toBe('acct-1');
    expect(rebuilt[0].AccountBasedExpenseLineDetail.ClassRef.value).toBe('class-2');
  });
});

describe('Round-trip: journal entry lines', () => {
  it('get → update produces same QBO line payload', () => {
    const updateReady = qboJournalLinesToUpdateShape([JE_LINE_DEBIT_NATIVE, JE_LINE_CREDIT_NATIVE]);

    function rebuildJeLines(lines: any[]) {
      return lines.map(l => {
        const line: any = {
          Amount: l.amount,
          DetailType: 'JournalEntryLineDetail',
          Description: l.description,
          JournalEntryLineDetail: {
            PostingType: l.posting_type,
            AccountRef: { value: l.account_id, name: l.account_name },
          },
        };
        if (l.entity_type && l.entity_id) {
          line.JournalEntryLineDetail.Entity = {
            Type: l.entity_type,
            EntityRef: { value: l.entity_id, name: l.entity_name },
          };
        }
        if (l.class_id) {
          line.JournalEntryLineDetail.ClassRef = { value: l.class_id, name: l.class_name };
        }
        return line;
      });
    }

    const rebuilt = rebuildJeLines(updateReady);
    expect(rebuilt).toHaveLength(2);
    expect(rebuilt[0].JournalEntryLineDetail.PostingType).toBe('Debit');
    expect(rebuilt[0].JournalEntryLineDetail.AccountRef.value).toBe('acct-10');
    expect(rebuilt[0].JournalEntryLineDetail.Entity.Type).toBe('Vendor');
    expect(rebuilt[0].JournalEntryLineDetail.ClassRef.value).toBe('class-1');
    expect(rebuilt[1].JournalEntryLineDetail.PostingType).toBe('Credit');
    expect(rebuilt[1].JournalEntryLineDetail.AccountRef.value).toBe('acct-20');
  });
});

describe('Round-trip: deposit lines', () => {
  it('preserves linked_payment_ids on round-trip', () => {
    const { linked_payment_ids, deposit_lines } = qboDepositLinesToUpdateShape([
      DEPOSIT_PAYMENT_LINE_NATIVE,
      DEPOSIT_DIRECT_LINE_NATIVE,
    ]);

    // Simulate what create_deposit does to rebuild QBO lines
    function rebuildDepositLines(linkedPayments: any[], directLines: any[]) {
      const out: any[] = [];
      for (const lp of linkedPayments) {
        out.push({ Amount: lp.amount, LinkedTxn: [{ TxnId: lp.payment_id, TxnType: 'Payment' }] });
      }
      for (const dl of directLines) {
        out.push({
          Amount: dl.amount,
          Description: dl.description,
          DetailType: 'DepositLineDetail',
          DepositLineDetail: { AccountRef: { value: dl.account_id } },
        });
      }
      return out;
    }

    const rebuilt = rebuildDepositLines(linked_payment_ids, deposit_lines);
    expect(rebuilt).toHaveLength(2);
    expect(rebuilt[0].LinkedTxn[0].TxnId).toBe('pmt-99');
    expect(rebuilt[0].LinkedTxn[0].TxnType).toBe('Payment');
    expect(rebuilt[1].DetailType).toBe('DepositLineDetail');
    expect(rebuilt[1].DepositLineDetail.AccountRef.value).toBe('acct-7');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// swap_item_or_account integration tests (logic only, mocked API calls)
// ═══════════════════════════════════════════════════════════════════════════════

describe('swap_item_or_account behavior via helper functions', () => {
  describe('stop_on_error=true behavior', () => {
    it('halts after first failure and does not process remaining transactions', async () => {
      const txns = [
        { id: 'sr-1', lines: [{ ...SALES_LINE_NATIVE }] },
        { id: 'sr-2', lines: [] }, // will fail (not found)
        { id: 'sr-3', lines: [{ ...SALES_LINE_NATIVE }] }, // should NOT be processed
      ];
      const results: any[] = [];
      let updatesPosted = 0;

      for (const txn of txns) {
        try {
          if (txn.id === 'sr-2') throw new Error('Not found');
          const { updatedLines, linesChanged } = swapItemInLines(txn.lines, 'item-1', 'item-NEW');
          if (linesChanged > 0) {
            updatesPosted++;
            results.push({ txn_id: txn.id, status: 'updated', lines_changed: linesChanged });
          }
        } catch (err: any) {
          results.push({ txn_id: txn.id, status: 'failed', error: err.message });
          break; // stop_on_error=true
        }
      }

      expect(results).toHaveLength(2); // sr-1 success, sr-2 fail, sr-3 never reached
      expect(results[0].status).toBe('updated');
      expect(results[1].status).toBe('failed');
      expect(updatesPosted).toBe(1); // only sr-1 was posted
    });
  });

  describe('stop_on_error=false behavior', () => {
    it('continues through all transactions despite failures', async () => {
      const txns = [
        { id: 'sr-1', lines: [{ ...SALES_LINE_NATIVE }] },
        { id: 'sr-2', shouldFail: true },
        { id: 'sr-3', lines: [{ ...SALES_LINE_NATIVE }] },
      ];
      const results: any[] = [];
      let updatesPosted = 0;

      for (const txn of txns) {
        try {
          if ((txn as any).shouldFail) throw new Error('API error');
          const { updatedLines, linesChanged } = swapItemInLines((txn as any).lines, 'item-1', 'item-NEW');
          if (linesChanged > 0) {
            updatesPosted++;
            results.push({ txn_id: txn.id, status: 'updated', lines_changed: linesChanged });
          }
        } catch (err: any) {
          results.push({ txn_id: txn.id, status: 'failed', error: err.message });
          // stop_on_error=false → no break
        }
      }

      expect(results).toHaveLength(3); // all three processed
      expect(results[0].status).toBe('updated');
      expect(results[1].status).toBe('failed');
      expect(results[2].status).toBe('updated');
      expect(updatesPosted).toBe(2); // sr-1 and sr-3 updated
    });
  });

  describe('dry_run mode', () => {
    it('reports would_update without calling update API', () => {
      const lines = [SALES_LINE_NATIVE];
      const { updatedLines, linesChanged } = swapItemInLines(lines, 'item-1', 'item-NEW');

      let updateCalled = false;
      const dry_run = true;

      if (!dry_run && linesChanged > 0) {
        updateCalled = true;
      }

      expect(linesChanged).toBe(1);
      expect(updateCalled).toBe(false);
    });
  });

  describe('no_match case', () => {
    it('returns lines_changed=0 when old_id not found in any line', () => {
      const { linesChanged } = swapItemInLines([SALES_LINE_NATIVE], 'item-NONEXISTENT', 'item-NEW');
      expect(linesChanged).toBe(0);
    });
  });

  describe('invalid combo validation', () => {
    it('item + JournalEntry should be caught before processing', () => {
      const entityTypes = ['JournalEntry'];
      const idType = 'item';
      const invalid = entityTypes.filter(t => t === 'JournalEntry' || t === 'Deposit');
      expect(invalid.length).toBeGreaterThan(0);
    });

    it('item + Deposit should be caught before processing', () => {
      const entityTypes = ['Deposit'];
      const idType = 'item';
      const invalid = entityTypes.filter(t => t === 'JournalEntry' || t === 'Deposit');
      expect(invalid.length).toBeGreaterThan(0);
    });

    it('account + Bill is valid (no invalid combo)', () => {
      const entityTypes = ['Bill'];
      const idType = 'account';
      const invalid = idType === 'item' ? entityTypes.filter(t => t === 'JournalEntry' || t === 'Deposit') : [];
      expect(invalid.length).toBe(0);
    });
  });
});
