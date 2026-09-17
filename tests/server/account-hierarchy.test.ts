import { describe, it, expect } from 'vitest';
import {
  indexAccounts,
  addToIndex,
  accountDepth,
  resolveParentAccount,
  validateAccountPlacement,
  explainAccountError,
  parseQboFault,
  describeQboFault,
  planAccountBatch,
  executeAccountBatch,
  findExistingForRow,
  diffExistingAccount,
  buildAccountPayload,
  applyParentToPayload,
  formatAccountTree,
  formatAccountTable,
  projectAccount,
  refChainIncludes,
  type QboAccount,
  type BatchAccountRow,
} from '../../src/server/account-hierarchy.js';

// ─────────────────────────────────────────────────────────────────────────────
// Unit tests for the sub-account helpers. Fixtures mirror the shapes QBO's
// sandbox returns (ParentRef.value, SubAccount, FullyQualifiedName with
// colons, "(deleted)" suffix on inactive accounts).
// ─────────────────────────────────────────────────────────────────────────────

function acct(o: Partial<QboAccount> & { Id: string; Name: string }): QboAccount {
  return { Active: true, SyncToken: '0', AccountType: 'Expense', ...o };
}

const FIXED_ASSETS = acct({ Id: '10', Name: 'Fixed Assets', AcctNum: '1500', AccountType: 'Fixed Asset', AccountSubType: 'OtherFixedAssets', FullyQualifiedName: 'Fixed Assets' });
const VEHICLES = acct({ Id: '11', Name: 'Vehicles', AcctNum: '1510', AccountType: 'Fixed Asset', AccountSubType: 'Vehicles', ParentRef: { value: '10' }, SubAccount: true, FullyQualifiedName: 'Fixed Assets:Vehicles' });
const ACCUM_DEP_VEH = acct({ Id: '12', Name: 'Accumulated Depreciation', AcctNum: '1519', AccountType: 'Fixed Asset', AccountSubType: 'AccumulatedDepreciation', ParentRef: { value: '11' }, SubAccount: true, FullyQualifiedName: 'Fixed Assets:Vehicles:Accumulated Depreciation' });
const EQUIPMENT = acct({ Id: '13', Name: 'Equipment', AcctNum: '1520', AccountType: 'Fixed Asset', AccountSubType: 'MachineryAndEquipment', ParentRef: { value: '10' }, SubAccount: true, FullyQualifiedName: 'Fixed Assets:Equipment' });
const ACCUM_DEP_EQ = acct({ Id: '14', Name: 'Accumulated Depreciation', AcctNum: '1529', AccountType: 'Fixed Asset', AccountSubType: 'AccumulatedDepreciation', ParentRef: { value: '13' }, SubAccount: true, FullyQualifiedName: 'Fixed Assets:Equipment:Accumulated Depreciation' });
const CREDIT_CARDS = acct({ Id: '20', Name: 'Credit Cards', AcctNum: '2100', AccountType: 'Credit Card', AccountSubType: 'CreditCard', FullyQualifiedName: 'Credit Cards' });
const AMEX = acct({ Id: '21', Name: 'AmEx - Entity A', AcctNum: '2110', AccountType: 'Credit Card', AccountSubType: 'CreditCard', ParentRef: { value: '20' }, SubAccount: true, FullyQualifiedName: 'Credit Cards:AmEx - Entity A' });
const OBE = acct({ Id: '30', Name: 'Opening Balance Equity', AccountType: 'Equity', AccountSubType: 'OpeningBalanceEquity', FullyQualifiedName: 'Opening Balance Equity' });
const OLD_CARD = acct({ Id: '22', Name: 'Old Card (deleted)', AcctNum: '2110', AccountType: 'Credit Card', AccountSubType: 'CreditCard', Active: false, FullyQualifiedName: 'Old Card (deleted)' });
const RENT = acct({ Id: '40', Name: 'Rent', AcctNum: '6100', AccountType: 'Expense', AccountSubType: 'RentOrLeaseOfBuildings', FullyQualifiedName: 'Rent' });

const COA = [FIXED_ASSETS, VEHICLES, ACCUM_DEP_VEH, EQUIPMENT, ACCUM_DEP_EQ, CREDIT_CARDS, AMEX, OBE, OLD_CARD, RENT];

function qboFault(code: string, Message: string, Detail: string) {
  const err: any = new Error(`QBO API error: ${Message}`);
  err.name = 'QBOError';
  err.statusCode = 400;
  err.response = JSON.stringify({ Fault: { Error: [{ Message, Detail, code }], type: 'ValidationFault' }, time: '2026-09-17T06:38:00-07:00' });
  return err;
}

// Fault text captured from QBO's sandbox on 2026-09-17.
const DUP_NAME = () => qboFault('6240', 'Duplicate Name Exists Error', 'The name supplied already exists. : An account already has the same display name. Display Name must be unique. Please provide a different display name.');
const DUP_NUMBER = () => qboFault('6000', 'A business validation error has occurred while processing your request', 'Business Validation Error: Another account is already using this number.  Please use a different number.');
const ACCUM_PARENT = () => qboFault('6000', 'A business validation error has occurred while processing your request', 'Business Validation Error: Fixed asset accounts (Accumulated Amortization, Depletion, or Depreciation) cannot be parent accounts.');
const COLON = () => qboFault('2180', 'Invalid Enumeration', 'Names must have at least one character, must be on one line, and cannot include colons or tabbing.');
const NO_DELETE = () => qboFault('500', 'Unsupported Operation', 'Operation Delete is not supported.');
const TYPE_MISMATCH = () => qboFault('6000', 'A business validation error has occurred while processing your request', 'Business Validation Error: For subaccounts, you must select the same account type as their parent.');

describe('indexAccounts / depth', () => {
  it('indexes by id, number, name and FQN, and links children to parents', () => {
    const index = indexAccounts(COA);
    expect(index.byId.get('11')).toBe(VEHICLES);
    expect(index.byNum.get('1510')).toEqual([VEHICLES]);
    expect(index.byName.get('accumulated depreciation')).toHaveLength(2);
    expect(index.byFqn.get('fixed assets:vehicles')).toBe(VEHICLES);
    expect(index.childrenOf.get('10')?.map((a) => a.Id)).toEqual(['11', '13']);
  });

  it('computes depth from the FullyQualifiedName segments (names cannot contain colons)', () => {
    const index = indexAccounts(COA);
    expect(accountDepth(FIXED_ASSETS, index)).toBe(1);
    expect(accountDepth(VEHICLES, index)).toBe(2);
    expect(accountDepth(ACCUM_DEP_VEH, index)).toBe(3);
  });

  it('falls back to walking ParentRef when FQN is absent', () => {
    const list = COA.map((a) => ({ ...a, FullyQualifiedName: undefined }));
    const index = indexAccounts(list);
    expect(accountDepth(index.byId.get('12')!, index)).toBe(3);
  });

  it('addToIndex replaces an account by Id (post-update) without duplicating it', () => {
    const index = indexAccounts(COA);
    addToIndex(index, { ...RENT, Name: 'Rent Expense', FullyQualifiedName: 'Rent Expense' });
    expect(index.all.filter((a) => a.Id === '40')).toHaveLength(1);
    expect(index.byName.has('rent')).toBe(false);
    expect(index.byName.get('rent expense')?.[0].Id).toBe('40');
  });
});

describe('resolveParentAccount', () => {
  const index = indexAccounts(COA);

  it('resolves by exact account number', () => {
    const r = resolveParentAccount(index, { number: '1510' });
    expect(r.ok && r.parent.Id).toBe('11');
  });

  it('never prefix-matches numbers ("15" must not pick 1500/1510)', () => {
    const r = resolveParentAccount(index, { number: '15' });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/no account has account number 15/);
  });

  it('resolves by fully qualified name when the plain name is ambiguous', () => {
    const ambiguous = resolveParentAccount(index, { name: 'Accumulated Depreciation' });
    expect(ambiguous.ok).toBe(false);
    expect(!ambiguous.ok && ambiguous.error).toMatch(/ambiguous: 2 accounts match/);
    expect(!ambiguous.ok && ambiguous.error).toContain('Fixed Assets:Vehicles:Accumulated Depreciation');
    expect(!ambiguous.ok && ambiguous.error).toContain('Fixed Assets:Equipment:Accumulated Depreciation');

    const exact = resolveParentAccount(index, { name: 'fixed assets:equipment:accumulated depreciation' });
    expect(exact.ok && exact.parent.Id).toBe('14');
  });

  it('prefers the active account when an inactive "(deleted)" twin shares the number', () => {
    const r = resolveParentAccount(index, { number: '2110' });
    expect(r.ok && r.parent.Id).toBe('21');
  });

  it('rejects an inactive sole match with a reactivation hint', () => {
    const r = resolveParentAccount(index, { name: 'Old Card (deleted)' });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/is inactive/);
  });

  it('resolves by Id and reports unknown Ids', () => {
    expect(resolveParentAccount(index, { id: '20' }).ok).toBe(true);
    const r = resolveParentAccount(index, { id: '999' });
    expect(!r.ok && r.error).toMatch(/no account has Id 999/);
  });
});

describe('validateAccountPlacement — QBO rules before the write', () => {
  const index = indexAccounts(COA);

  it('accepts a well-formed sub-account', () => {
    expect(validateAccountPlacement({ name: 'Trucks', acctNum: '1530', accountType: 'Fixed Asset', accountSubType: 'Vehicles' }, FIXED_ASSETS, index)).toEqual([]);
  });

  it('flags an account type that differs from the parent', () => {
    const errors = validateAccountPlacement({ name: 'Misfiled', accountType: 'Expense' }, FIXED_ASSETS, index);
    expect(errors.join(' ')).toMatch(/Account type mismatch: "Misfiled" is Expense but its parent "Fixed Assets" is Fixed Asset/);
  });

  it('flags nesting beyond 5 levels', () => {
    const l4 = acct({ Id: '15', Name: 'L4', AccountType: 'Fixed Asset', AccountSubType: 'Vehicles', ParentRef: { value: '12' }, FullyQualifiedName: 'A:B:C:L4' });
    const l5 = acct({ Id: '16', Name: 'L5', AccountType: 'Fixed Asset', AccountSubType: 'Vehicles', ParentRef: { value: '15' }, FullyQualifiedName: 'A:B:C:L4:L5' });
    const deep = indexAccounts([...COA, l4, l5]);
    expect(validateAccountPlacement({ name: 'L5b', accountType: 'Fixed Asset' }, l4, deep)).toEqual([]);
    const errors = validateAccountPlacement({ name: 'L6', accountType: 'Fixed Asset' }, l5, deep);
    expect(errors.join(' ')).toMatch(/Nesting too deep: "A:B:C:L4:L5" is already at level 5; "L6" beneath it would be level 6/);
  });

  it('flags the documented no-sub-account detail types on either side', () => {
    expect(validateAccountPlacement({ name: 'X', accountType: 'Equity' }, OBE, index).join(' ')).toMatch(/OpeningBalanceEquity, which QBO does not allow to have sub-accounts/);
    const eq = acct({ Id: '31', Name: 'Equity', AccountType: 'Equity', AccountSubType: 'PartnerEquity', FullyQualifiedName: 'Equity' });
    expect(validateAccountPlacement({ name: 'RE', accountType: 'Equity', accountSubType: 'RetainedEarnings' }, eq, indexAccounts([...COA, eq])).join(' ')).toMatch(/RetainedEarnings, which QBO does not allow to be a sub-account/);
  });

  it('flags an Accumulated Depreciation parent (QBO: cannot be parent accounts)', () => {
    const errors = validateAccountPlacement({ name: 'Under accum dep', accountType: 'Fixed Asset' }, ACCUM_DEP_VEH, index);
    expect(errors.join(' ')).toMatch(/Accumulated Amortization, Depletion, or Depreciation detail type to be parent accounts/);
  });

  it('flags a duplicate name under the same parent but allows it under a different parent', () => {
    const dup = validateAccountPlacement({ name: 'accumulated depreciation', accountType: 'Fixed Asset' }, VEHICLES, index);
    expect(dup.join(' ')).toMatch(/Duplicate name: an account named "Accumulated Depreciation" already exists under "Fixed Assets:Vehicles"/);
    const trucks = acct({ Id: '17', Name: 'Trucks', AccountType: 'Fixed Asset', AccountSubType: 'Vehicles', ParentRef: { value: '10' }, FullyQualifiedName: 'Fixed Assets:Trucks' });
    expect(validateAccountPlacement({ name: 'Accumulated Depreciation', accountType: 'Fixed Asset', accountSubType: 'AccumulatedDepreciation' }, trucks, indexAccounts([...COA, trucks]))).toEqual([]);
  });

  it('flags a duplicate number held by an ACTIVE account only (inactive accounts free their number)', () => {
    expect(validateAccountPlacement({ name: 'New card', acctNum: '2110', accountType: 'Credit Card' }, CREDIT_CARDS, index).join(' ')).toMatch(/Duplicate account number: 2110 is already used by "Credit Cards:AmEx - Entity A"/);
    // 2110 also sits on the inactive "Old Card (deleted)" — that alone must not block.
    const withoutAmex = indexAccounts(COA.filter((a) => a.Id !== '21'));
    expect(validateAccountPlacement({ name: 'New card', acctNum: '2110', accountType: 'Credit Card' }, CREDIT_CARDS, withoutAmex)).toEqual([]);
  });

  it('flags colons, double quotes, tabs and over-long names, and colons in numbers', () => {
    expect(validateAccountPlacement({ name: 'Bad: name', accountType: 'Expense' }, null, index).join(' ')).toMatch(/cannot contain colons/);
    expect(validateAccountPlacement({ name: 'Say "hi"', accountType: 'Expense' }, null, index).join(' ')).toMatch(/double quotes/);
    expect(validateAccountPlacement({ name: 'x'.repeat(101), accountType: 'Expense' }, null, index).join(' ')).toMatch(/at most 100/);
    expect(validateAccountPlacement({ name: 'Ok', acctNum: '1:2', accountType: 'Expense' }, null, index).join(' ')).toMatch(/numbers cannot contain colons/);
  });

  it('prevents self-parenting and cycles when moving an existing account', () => {
    expect(validateAccountPlacement({ id: '10', name: 'Fixed Assets', accountType: 'Fixed Asset' }, FIXED_ASSETS, index).join(' ')).toMatch(/cannot be its own parent/);
    expect(validateAccountPlacement({ id: '10', name: 'Fixed Assets', accountType: 'Fixed Asset' }, VEHICLES, index).join(' ')).toMatch(/one of its own sub-accounts/);
  });

  it('refuses a type change on an account that has sub-accounts', () => {
    const errors = validateAccountPlacement({ id: '10', name: 'Fixed Assets', accountType: 'Other Asset' }, null, index);
    expect(errors.join(' ')).toMatch(/has 2 sub-accounts .* does not change the type of an account with sub-accounts/);
  });

  it('ignores the account itself in duplicate checks during an update', () => {
    expect(validateAccountPlacement({ id: '11', name: 'Vehicles', acctNum: '1510', accountType: 'Fixed Asset' }, FIXED_ASSETS, index)).toEqual([]);
  });
});

describe('explainAccountError — QBO faults become the rule that was broken', () => {
  it('parses the Fault body carried on QBOError.response', () => {
    expect(parseQboFault(DUP_NUMBER())).toEqual({
      code: '6000',
      message: 'A business validation error has occurred while processing your request',
      detail: 'Business Validation Error: Another account is already using this number.  Please use a different number.',
      element: undefined,
    });
    expect(describeQboFault(DUP_NAME())).toBe('Duplicate Name Exists Error — The name supplied already exists. : An account already has the same display name. Display Name must be unique. Please provide a different display name. (QBO code 6240)');
    expect(describeQboFault(new Error('plain'))).toBe('plain');
  });

  it('duplicate name (6240) names the parent namespace', () => {
    const e = explainAccountError(DUP_NAME(), { name: 'Accumulated Depreciation', parentFqn: 'Fixed Assets:Vehicles' });
    expect(e.kind).toBe('duplicate_name');
    expect(e.text).toMatch(/already has an account named "Accumulated Depreciation" under "Fixed Assets:Vehicles"/);
    expect(e.text).toMatch(/QBO said: Duplicate Name Exists Error/);
  });

  it('duplicate number (6000) is company-wide', () => {
    const e = explainAccountError(DUP_NUMBER(), { acctNum: '2110' });
    expect(e.kind).toBe('duplicate_number');
    expect(e.text).toMatch(/2110 is already assigned to another account. Account numbers are unique company-wide/);
  });

  it('type mismatch, accumulated-depreciation parent, colon, and unsupported delete are recognised', () => {
    expect(explainAccountError(TYPE_MISMATCH(), { name: 'X', parentFqn: 'P' }).kind).toBe('type_mismatch');
    expect(explainAccountError(ACCUM_PARENT()).kind).toBe('not_parentable');
    expect(explainAccountError(COLON()).kind).toBe('invalid_name');
    expect(explainAccountError(NO_DELETE()).kind).toBe('unsupported_operation');
  });

  it('nesting depth wording is recognised and cites the 5-level limit', () => {
    const e = explainAccountError(qboFault('6000', 'A business validation error has occurred while processing your request', 'Business Validation Error: Sub-accounts cannot be nested more than 5 levels deep.'));
    expect(e.kind).toBe('nesting_depth');
    expect(e.text).toMatch(/limits the account hierarchy to 5 levels/);
  });

  it('unknown faults pass through QBO\'s own text untouched', () => {
    const e = explainAccountError(qboFault('6190', 'Something else', 'Detail here'));
    expect(e.kind).toBe('unknown');
    expect(e.text).toBe('Something else — Detail here (QBO code 6190)');
  });
});

describe('planAccountBatch — parents first, deterministic', () => {
  it('sorts children after their in-batch parents regardless of input order', () => {
    const rows: BatchAccountRow[] = [
      { name: 'Accum Dep - Trucks', account_type: 'Fixed Asset', acct_num: '1549', parent_account_number: '1540' },
      { name: 'Trucks', account_type: 'Fixed Asset', acct_num: '1540', parent_account_name: 'Fixed Assets' },
      { name: 'Fixed Assets', account_type: 'Fixed Asset', acct_num: '1500' },
      { name: 'Rent', account_type: 'Expense', acct_num: '6100' },
    ];
    const planned = planAccountBatch(rows);
    expect(planned.map((p) => p.row)).toEqual([3, 4, 2, 1]);
    expect(planned.map((p) => p.batchDepth)).toEqual([1, 1, 2, 3]);
    expect(planned.find((p) => p.row === 1)?.parentRow).toBe(2);
  });

  it('treats a parent that is not in the batch as already existing (depth 1)', () => {
    const planned = planAccountBatch([{ name: 'Child', account_type: 'Expense', parent_account_number: '6100' }]);
    expect(planned[0].batchDepth).toBe(1);
    expect(planned[0].parentRow).toBeUndefined();
    expect(planned[0].planError).toBeUndefined();
  });

  it('flags duplicate numbers, ambiguous in-batch parents, self-parenting and cycles', () => {
    const planned = planAccountBatch([
      { name: 'A', account_type: 'Expense', acct_num: '1' },
      { name: 'A2', account_type: 'Expense', acct_num: '1' },
      { name: 'Twin', account_type: 'Expense', acct_num: '2' },
      { name: 'Twin', account_type: 'Expense', acct_num: '3' },
      { name: 'Kid', account_type: 'Expense', acct_num: '4', parent_account_name: 'Twin' },
      { name: 'Self', account_type: 'Expense', acct_num: '5', parent_account_number: '5' },
      { name: 'C1', account_type: 'Expense', acct_num: '6', parent_account_number: '7' },
      { name: 'C2', account_type: 'Expense', acct_num: '7', parent_account_number: '6' },
    ]);
    const byRow = new Map(planned.map((p) => [p.row, p]));
    expect(byRow.get(2)?.planError).toMatch(/repeats account number 1 already used by row 1/);
    expect(byRow.get(5)?.planError).toMatch(/matches 2 rows in this batch \(rows 3, 4\)/);
    expect(byRow.get(6)?.planError).toMatch(/names itself as its parent/);
    expect(byRow.get(7)?.planError).toMatch(/cycle/);
    expect(byRow.get(8)?.planError).toMatch(/cycle/);
  });
});

describe('executeAccountBatch — idempotent, per-row, keeps going', () => {
  function fakeWriter(index = indexAccounts(COA)) {
    let nextId = 100;
    const calls: { op: 'create' | 'update'; payload: any }[] = [];
    const store = new Map<string, QboAccount>(index.all.map((a) => [String(a.Id), a]));
    const fqnFor = (payload: any) => {
      const pid = payload.ParentRef?.value;
      const parent = pid ? store.get(String(pid)) : undefined;
      return parent ? `${parent.FullyQualifiedName ?? parent.Name}:${payload.Name}` : payload.Name;
    };
    const writer = {
      async create(payload: any) {
        calls.push({ op: 'create', payload });
        if (payload.Name === 'Boom') throw DUP_NUMBER();
        const created: QboAccount = { ...payload, Id: String(nextId++), SyncToken: '0', Active: true, SubAccount: Boolean(payload.ParentRef), FullyQualifiedName: fqnFor(payload) };
        store.set(String(created.Id), created);
        return created;
      },
      async update(payload: any) {
        calls.push({ op: 'update', payload });
        const updated: QboAccount = { ...payload, SyncToken: String(Number(payload.SyncToken ?? '0') + 1), FullyQualifiedName: fqnFor(payload) };
        store.set(String(updated.Id), updated);
        return updated;
      },
    };
    return { writer, calls, index };
  }

  const TREE: BatchAccountRow[] = [
    { name: 'Accum Dep - Trucks', account_type: 'Fixed Asset', account_sub_type: 'AccumulatedDepreciation', acct_num: '1549', parent_account_number: '1540' },
    { name: 'Trucks', account_type: 'Fixed Asset', account_sub_type: 'Vehicles', acct_num: '1540', parent_account_number: '1500' },
    { name: 'Fixed Assets', account_type: 'Fixed Asset', account_sub_type: 'OtherFixedAssets', acct_num: '1500' },
  ];

  it('creates a three-level tree parents-first and reads back fully qualified names', async () => {
    const { writer, calls, index } = fakeWriter();
    const out = await executeAccountBatch(TREE, index, writer, { onExisting: 'skip', dryRun: false });
    // Row 3 ("Fixed Assets" 1500) already exists in the chart → unchanged; the other two are new.
    expect(out.results.map((r) => r.status)).toEqual(['created', 'created', 'unchanged']);
    expect(out.results[2]).toMatchObject({ row: 3, status: 'unchanged', id: '10' });
    expect(out.results[1]).toMatchObject({ row: 2, status: 'created', fully_qualified_name: 'Fixed Assets:Trucks' });
    expect(out.results[0]).toMatchObject({ row: 1, status: 'created', fully_qualified_name: 'Fixed Assets:Trucks:Accum Dep - Trucks' });
    // Parents were written before children even though the input listed them last.
    expect(calls.map((c) => c.payload.Name)).toEqual(['Trucks', 'Accum Dep - Trucks']);
  });

  it('is idempotent: re-running the same batch creates nothing and reports unchanged', async () => {
    const rows: BatchAccountRow[] = [
      { name: 'Deprec - Trucks', account_type: 'Fixed Asset', account_sub_type: 'AccumulatedDepreciation', acct_num: '1559', parent_account_number: '1550' },
      { name: 'Trailers', account_type: 'Fixed Asset', account_sub_type: 'Vehicles', acct_num: '1550', parent_account_number: '1500' },
    ];
    const { writer, calls, index } = fakeWriter();
    const first = await executeAccountBatch(rows, index, writer, { onExisting: 'skip', dryRun: false });
    expect(first.results.map((r) => r.status)).toEqual(['created', 'created']);
    expect(first.results[0].fully_qualified_name).toBe('Fixed Assets:Trailers:Deprec - Trucks');
    expect(calls).toHaveLength(2);
    expect(calls[0].payload.Name).toBe('Trailers'); // parent first

    const second = await executeAccountBatch(rows, index, writer, { onExisting: 'skip', dryRun: false });
    expect(second.results.map((r) => r.status)).toEqual(['unchanged', 'unchanged']);
    expect(calls).toHaveLength(2);
  });

  it('skips a differing existing account by default and updates it with on_existing=update', async () => {
    const rows: BatchAccountRow[] = [{ name: 'AmEx - Entity A', account_type: 'Credit Card', acct_num: '2110', description: 'Corporate card' }];
    const skip = fakeWriter();
    const s = await executeAccountBatch(rows, skip.index, skip.writer, { onExisting: 'skip', dryRun: false });
    expect(s.results[0].status).toBe('skipped');
    expect(s.results[0].message).toMatch(/matched by number.*differs: parent 20 → \(top level\); description/);
    expect(skip.calls).toHaveLength(0);

    const upd = fakeWriter();
    const u = await executeAccountBatch(rows, upd.index, upd.writer, { onExisting: 'update', dryRun: false });
    expect(u.results[0].status).toBe('updated');
    expect(upd.calls[0].op).toBe('update');
    expect(upd.calls[0].payload.ParentRef).toBeUndefined();
    expect(upd.calls[0].payload.SubAccount).toBe(false);
    expect(upd.calls[0].payload.Description).toBe('Corporate card');
    expect(upd.calls[0].payload.Id).toBe('21');
  });

  it('matches by name under the same parent when the row has no number, and can assign the number', async () => {
    const rows: BatchAccountRow[] = [{ name: 'Rent', account_type: 'Expense', acct_num: '6150' }];
    // Existing "Rent" has number 6100; the row's 6150 does not match by number → falls back to name at top level.
    const { writer, index } = fakeWriter();
    const out = await executeAccountBatch(rows, index, writer, { onExisting: 'skip', dryRun: false });
    expect(out.results[0].status).toBe('skipped');
    expect(out.results[0].message).toMatch(/matched by name.*number 6100 → 6150/);
  });

  it('keeps going after a row fails, blocks that row\'s children, and explains the QBO fault', async () => {
    const rows: BatchAccountRow[] = [
      { name: 'Boom', account_type: 'Expense', acct_num: '7000' },
      { name: 'Under Boom', account_type: 'Expense', acct_num: '7010', parent_account_number: '7000' },
      { name: 'Fine', account_type: 'Expense', acct_num: '7100' },
    ];
    const { writer, index } = fakeWriter();
    const out = await executeAccountBatch(rows, index, writer, { onExisting: 'skip', dryRun: false });
    expect(out.results.map((r) => r.status)).toEqual(['failed', 'blocked', 'created']);
    expect(out.results[0].message).toMatch(/Duplicate account number: 7000 is already assigned/);
    expect(out.results[1].message).toMatch(/Parent row 1 \("Boom"\) did not land \(failed\)/);
    expect(out.counts).toMatchObject({ created: 1, failed: 1, blocked: 1 });
  });

  it('rejects rule breaks before calling QBO, with the row and the rule', async () => {
    const rows: BatchAccountRow[] = [
      { name: 'Wrong type', account_type: 'Expense', acct_num: '1590', parent_account_number: '1500' },
      { name: 'Accumulated Depreciation', account_type: 'Fixed Asset', acct_num: '1518', parent_account_number: '1510' },
      { name: 'Orphan', account_type: 'Expense', acct_num: '8000', parent_account_number: '4242' },
    ];
    const { writer, calls, index } = fakeWriter();
    const out = await executeAccountBatch(rows, index, writer, { onExisting: 'skip', dryRun: false });
    expect(calls).toHaveLength(0);
    expect(out.results.map((r) => r.status)).toEqual(['failed', 'skipped', 'failed']);
    expect(out.results[0].message).toMatch(/Account type mismatch/);
    // Same name under the same parent IS that account (QBO default-account fold-in): matched by name, number difference reported.
    expect(out.results[1].message).toMatch(/matched by name.*differs: number 1519 → 1518/);
    expect(out.results[2].message).toMatch(/no account has account number 4242/);

    // An ambiguous parent name against QBO (two existing "Accumulated Depreciation") fails with the candidates listed.
    const vague = await executeAccountBatch(
      [{ name: 'Vague', account_type: 'Fixed Asset', acct_num: '8001', parent_account_name: 'Accumulated Depreciation' }],
      index, writer, { onExisting: 'skip', dryRun: false }
    );
    expect(vague.results[0].status).toBe('failed');
    expect(vague.results[0].message).toMatch(/ambiguous: 2 accounts match name "Accumulated Depreciation"/);
  });

  it('a parent named by another row in the batch takes precedence over same-named QBO accounts', async () => {
    const { writer, index } = fakeWriter();
    const out = await executeAccountBatch([
      { name: 'Accumulated Depreciation', account_type: 'Fixed Asset', account_sub_type: 'OtherFixedAssets', acct_num: '1590', parent_account_number: '1500' },
      { name: 'Kid', account_type: 'Fixed Asset', acct_num: '1591', parent_account_name: 'Accumulated Depreciation' },
    ], index, writer, { onExisting: 'skip', dryRun: false });
    // Row 1 is a new account (number 1590, no name clash directly under 1500); row 2 hangs off it, not off Id 12 or 14.
    expect(out.results[0].status).toBe('created');
    expect(out.results[1]).toMatchObject({ status: 'created', fully_qualified_name: 'Fixed Assets:Accumulated Depreciation:Kid' });
  });

  it('dry_run plans the whole tree, including children of not-yet-created parents, and writes nothing', async () => {
    const rows: BatchAccountRow[] = [
      { name: 'Loans', account_type: 'Long Term Liability', account_sub_type: 'NotesPayable', acct_num: '2700' },
      { name: 'Loan - Bank A', account_type: 'Long Term Liability', account_sub_type: 'NotesPayable', acct_num: '2710', parent_account_number: '2700' },
      { name: 'Loan - Bank A', account_type: 'Long Term Liability', account_sub_type: 'NotesPayable', acct_num: '2720', parent_account_number: '2700' },
    ];
    const { writer, calls, index } = fakeWriter();
    const out = await executeAccountBatch(rows, index, writer, { onExisting: 'skip', dryRun: true });
    expect(calls).toHaveLength(0);
    expect(out.results.map((r) => r.status)).toEqual(['would_create', 'would_create', 'failed']);
    expect(out.results[1].fully_qualified_name).toBe('Loans:Loan - Bank A');
    expect(out.results[2].message).toMatch(/Duplicate within this batch: "Loan - Bank A" under "Loans" is the same account as row 2 \(number 2710/);
  });

  it('notes an inactive account that still carries the number of a created row', async () => {
    const withoutAmex = indexAccounts(COA.filter((a) => a.Id !== '21'));
    const { writer, index } = fakeWriter(withoutAmex);
    const out = await executeAccountBatch([{ name: 'New Card', account_type: 'Credit Card', acct_num: '2110', parent_account_number: '2100' }], index, writer, { onExisting: 'skip', dryRun: false });
    expect(out.results[0].status).toBe('created');
    expect(out.results[0].message).toMatch(/inactive account Id 22 "Old Card \(deleted\)" also carries number 2110/);
  });
});

describe('payload builders', () => {
  it('buildAccountPayload sets ParentRef + SubAccount for a child and drops the derived FQN on updates', () => {
    const create = buildAccountPayload({ name: 'Trucks', account_type: 'Fixed Asset', account_sub_type: 'Vehicles', acct_num: '1540' }, FIXED_ASSETS);
    expect(create).toEqual({ Name: 'Trucks', AccountType: 'Fixed Asset', AccountSubType: 'Vehicles', AcctNum: '1540', ParentRef: { value: '10' }, SubAccount: true });
    const update = buildAccountPayload({ name: 'Vehicles', account_type: 'Fixed Asset', acct_num: '1510' }, CREDIT_CARDS, VEHICLES);
    expect(update.Id).toBe('11');
    expect(update.SyncToken).toBe('0');
    expect(update.ParentRef).toEqual({ value: '20' });
    expect(update.FullyQualifiedName).toBeUndefined();
    expect(update.Active).toBe(true);
  });

  it('applyParentToPayload(null) promotes to top level', () => {
    const payload: any = { ...VEHICLES };
    applyParentToPayload(payload, null);
    expect(payload.ParentRef).toBeUndefined();
    expect(payload.SubAccount).toBe(false);
    expect(payload.FullyQualifiedName).toBeUndefined();
  });

  it('findExistingForRow / diffExistingAccount', () => {
    const index = indexAccounts(COA);
    expect(findExistingForRow({ name: 'x', account_type: 'Credit Card', acct_num: '2110' }, null, index)?.account.Id).toBe('21');
    expect(findExistingForRow({ name: 'Vehicles', account_type: 'Fixed Asset' }, FIXED_ASSETS, index)?.matchedBy).toBe('name');
    expect(findExistingForRow({ name: 'Vehicles', account_type: 'Fixed Asset' }, null, index)).toBeNull();
    expect(diffExistingAccount(VEHICLES, { name: 'Vehicles', account_type: 'Fixed Asset', acct_num: '1510' }, FIXED_ASSETS)).toEqual([]);
    expect(diffExistingAccount(VEHICLES, { name: 'Autos', account_type: 'Fixed Asset', acct_num: '1511' }, CREDIT_CARDS)).toEqual([
      'name "Vehicles" → "Autos"',
      'number 1510 → 1511',
      'parent 10 → 20 "Credit Cards"',
    ]);
  });

  it('refChainIncludes detects descendants through ParentRef (also for Class/Department)', () => {
    const byId = new Map(COA.map((a) => [String(a.Id), a]));
    expect(refChainIncludes(byId, '12', '10')).toBe(true);
    expect(refChainIncludes(byId, '10', '12')).toBe(false);
    expect(refChainIncludes(byId, '21', '10')).toBe(false);
  });
});

describe('output formatting', () => {
  const index = indexAccounts(COA);

  it('renders an indented tree sorted by number, flagging inactive accounts', () => {
    const lines = formatAccountTree(COA);
    expect(lines).toEqual([
      '[1500] Fixed Assets — Fixed Asset / OtherFixedAssets (Id 10)',
      '    [1510] Vehicles — Fixed Asset / Vehicles (Id 11)',
      '        [1519] Accumulated Depreciation — Fixed Asset / AccumulatedDepreciation (Id 12)',
      '    [1520] Equipment — Fixed Asset / MachineryAndEquipment (Id 13)',
      '        [1529] Accumulated Depreciation — Fixed Asset / AccumulatedDepreciation (Id 14)',
      '[2100] Credit Cards — Credit Card / CreditCard (Id 20)',
      '    [2110] AmEx - Entity A — Credit Card / CreditCard (Id 21)',
      '[2110] Old Card (deleted) — Credit Card / CreditCard (Id 22) [inactive]',
      '[6100] Rent — Expense / RentOrLeaseOfBuildings (Id 40)',
      'Opening Balance Equity — Equity / OpeningBalanceEquity (Id 30)',
    ]);
  });

  it('flags orphans whose parent is not in the rendered list', () => {
    const lines = formatAccountTree([ACCUM_DEP_VEH]);
    expect(lines[0]).toMatch(/\[parent Id 11 not in this list\]/);
  });

  it('table carries Id, number, type, detail type, parent Id+number, active and FQN', () => {
    const lines = formatAccountTable([FIXED_ASSETS, ACCUM_DEP_VEH, OLD_CARD], index);
    expect(lines[0]).toMatch(/^Id\s+Number\s+Type\s+Detail type\s+Parent Id \[num\]\s+Active\s+Fully qualified name$/);
    expect(lines.find((l) => l.startsWith('12'))).toMatch(/^12\s+1519\s+Fixed Asset\s+AccumulatedDepreciation\s+11 \[1510\]\s+yes\s+Fixed Assets:Vehicles:Accumulated Depreciation$/);
    expect(lines.find((l) => l.startsWith('22'))).toMatch(/\s+no\s+Old Card \(deleted\)$/);
  });

  it('projectAccount is the diff-friendly JSON shape', () => {
    expect(projectAccount(ACCUM_DEP_VEH, index)).toEqual({
      id: '12',
      acct_num: '1519',
      name: 'Accumulated Depreciation',
      account_type: 'Fixed Asset',
      account_sub_type: 'AccumulatedDepreciation',
      classification: null,
      parent_id: '11',
      parent_acct_num: '1510',
      fully_qualified_name: 'Fixed Assets:Vehicles:Accumulated Depreciation',
      sub_account: true,
      active: true,
      depth: 3,
    });
  });
});
