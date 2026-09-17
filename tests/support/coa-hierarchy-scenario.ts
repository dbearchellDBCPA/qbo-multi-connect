// ─── Sub-account acceptance scenario ─────────────────────────────────────────
//
// The same script runs against the fake Intuit API in vitest and against a
// live deployment (scripts/sandbox-coa-hierarchy.ts) through the MCP tools:
//   1. load a three-level chart out of order with batch_create_accounts
//   2. read it back with get_accounts and check parent links + FQNs
//   3. re-run the batch to prove idempotency, then update in place
//   4. single create_account / update_account with parents by number and name
//   5. every QBO rule the loader must explain (type, depth, duplicates, ...)
//   6. update_class / update_department rename, re-parent, deactivate
//   7. clean up: deactivate everything it created, leaves first
// Every account it creates is prefixed so it can never collide with a real
// chart, and every number sits in a 99xx block.

export type ToolCaller = (name: string, args: Record<string, unknown>) => Promise<string>;

export interface ScenarioOptions {
  client: string;
  prefix: string;
  numBase: number;
  log: (line: string) => void;
}

export interface ScenarioResult {
  passed: string[];
  failed: { step: string; detail: string }[];
  skipped: { step: string; reason: string }[];
}

export async function runCoaHierarchyScenario(call: ToolCaller, opts: ScenarioOptions): Promise<ScenarioResult> {
  const { client, prefix: P, numBase: N, log } = opts;
  const result: ScenarioResult = { passed: [], failed: [], skipped: [] };
  const num = (offset: number) => String(N + offset);
  const check = (step: string, ok: boolean, detail: string) => {
    if (ok) result.passed.push(step);
    else result.failed.push({ step, detail });
    log(`${ok ? 'PASS' : 'FAIL'}  ${step}${ok ? '' : `\n      ${detail.split('\n').join('\n      ')}`}`);
  };
  const show = (title: string, text: string) => log(`\n▶ ${title}\n${text.split('\n').map((l) => `  ${l}`).join('\n')}\n`);
  const tool = async (name: string, args: Record<string, unknown>) => {
    const text = await call(name, { client_name: client, ...args });
    show(`${name} ${JSON.stringify(args)}`, text);
    return text;
  };
  const summaryCounts = (text: string) => {
    const m = text.match(/Rows: (\d+) \| (?:would create (\d+) \| would update (\d+)|created (\d+) \| updated (\d+)) \| unchanged (\d+) \| skipped (\d+) \| failed (\d+) \| blocked (\d+)/);
    if (!m) return null;
    return {
      rows: +m[1], created: +(m[2] ?? m[4]), updated: +(m[3] ?? m[5]), unchanged: +m[6], skipped: +m[7], failed: +m[8], blocked: +m[9],
    };
  };
  const readJson = async (filter: string, includeInactive = false): Promise<any[]> => {
    const text = await call('get_accounts', { client_name: client, format: 'json', filter, include_inactive: includeInactive });
    try {
      return JSON.parse(text);
    } catch {
      return [];
    }
  };
  const idFrom = (text: string) => text.match(/\bID: (\S+)/)?.[1];

  // Names: the two "Accumulated Depreciation" accounts deliberately share a
  // Name under different parents — QBO's per-parent uniqueness rule.
  const FA = `${P} Fixed Assets`;
  const VEH = `${P} Vehicles`;
  const EQP = `${P} Equipment`;
  const AD = 'Accumulated Depreciation';
  const CC = `${P} Credit Cards`;
  const rows = [
    // children first on purpose — the tool must sort parents ahead
    { name: AD, account_type: 'Fixed Asset', account_sub_type: 'AccumulatedDepreciation', acct_num: num(19), parent_account_number: num(10), description: 'Accum dep - vehicles' },
    { name: AD, account_type: 'Fixed Asset', account_sub_type: 'AccumulatedDepreciation', acct_num: num(29), parent_account_number: num(20), description: 'Accum dep - equipment' },
    { name: `${P} AmEx - Entity A`, account_type: 'Credit Card', account_sub_type: 'CreditCard', acct_num: num(51), parent_account_number: num(50) },
    { name: `${P} AmEx - Entity B`, account_type: 'Credit Card', account_sub_type: 'CreditCard', acct_num: num(52), parent_account_name: CC },
    { name: VEH, account_type: 'Fixed Asset', account_sub_type: 'Vehicles', acct_num: num(10), parent_account_number: num(0) },
    { name: EQP, account_type: 'Fixed Asset', account_sub_type: 'MachineryAndEquipment', acct_num: num(20), parent_account_name: FA },
    { name: CC, account_type: 'Credit Card', account_sub_type: 'CreditCard', acct_num: num(50) },
    { name: FA, account_type: 'Fixed Asset', account_sub_type: 'OtherFixedAssets', acct_num: num(0) },
  ];

  // Guard: nothing with this prefix may already exist (active).
  const preexisting = await readJson(P, true);
  if (preexisting.some((a) => a.active)) {
    log(`Aborting: active accounts with prefix "${P}" already exist in ${client}: ${preexisting.filter((a) => a.active).map((a) => a.fully_qualified_name).join(', ')}`);
    result.failed.push({ step: 'precondition', detail: 'prefix already in use' });
    return result;
  }

  // 1. Dry run, then the real load.
  const dry = await tool('batch_create_accounts', { accounts: rows, dry_run: true });
  const dryCounts = summaryCounts(dry);
  check('dry run plans all 8 rows as would-create with no failures', !!dryCounts && dryCounts.created === 8 && dryCounts.failed === 0 && dryCounts.blocked === 0, dry);
  check('dry run resolves an in-batch grandparent chain (FQN of level 3 row)', dry.includes(`${FA}:${VEH}:${AD}`), dry);

  const load = await tool('batch_create_accounts', { accounts: rows });
  const loadCounts = summaryCounts(load);
  check('batch creates all 8 accounts, none failed or blocked', !!loadCounts && loadCounts.created === 8 && loadCounts.failed === 0 && loadCounts.blocked === 0, load);

  // 2. Read back: tree for the eye, JSON for the assertions.
  await tool('get_accounts', { format: 'tree', filter: P });
  const table = await tool('get_accounts', { format: 'table', filter: P });
  check('table output carries Id, number, type, detail type, parent and FQN columns', /Id\s+Number\s+Type\s+Detail type\s+Parent Id \[num\]\s+Active\s+Fully qualified name/.test(table), table);
  const loaded = await readJson(P);
  const byNum = new Map(loaded.map((a) => [a.acct_num, a]));
  const expectFqn: Array<[string, string, string | null, number]> = [
    [num(0), FA, null, 1],
    [num(10), `${FA}:${VEH}`, num(0), 2],
    [num(19), `${FA}:${VEH}:${AD}`, num(10), 3],
    [num(20), `${FA}:${EQP}`, num(0), 2],
    [num(29), `${FA}:${EQP}:${AD}`, num(20), 3],
    [num(50), CC, null, 1],
    [num(51), `${CC}:${P} AmEx - Entity A`, num(50), 2],
    [num(52), `${CC}:${P} AmEx - Entity B`, num(50), 2],
  ];
  for (const [n, fqn, parentNum, depth] of expectFqn) {
    const a = byNum.get(n);
    check(
      `read-back ${n}: FQN "${fqn}", parent number ${parentNum ?? 'none'}, depth ${depth}`,
      !!a && a.fully_qualified_name === fqn && (a.parent_acct_num ?? null) === parentNum && a.depth === depth && a.sub_account === Boolean(parentNum),
      JSON.stringify(a)
    );
  }
  check('same Name "Accumulated Depreciation" exists under two different parents', loaded.filter((a) => a.name === AD).length === 2, JSON.stringify(loaded.filter((a) => a.name === AD)));

  // 3. Idempotency: same batch again, then a real change with on_existing=update.
  const rerun = await tool('batch_create_accounts', { accounts: rows });
  const rerunCounts = summaryCounts(rerun);
  check('re-running the identical batch creates nothing and reports 8 unchanged', !!rerunCounts && rerunCounts.created === 0 && rerunCounts.updated === 0 && rerunCounts.unchanged === 8 && rerunCounts.failed === 0, rerun);

  const changed = rows.map((r) => (r.acct_num === num(51) ? { ...r, description: 'Corporate card - Entity A' } : r));
  const skipRun = await tool('batch_create_accounts', { accounts: changed });
  const skipCounts = summaryCounts(skipRun);
  check('a differing row is skipped by default and the difference is reported', !!skipCounts && skipCounts.skipped === 1 && skipCounts.unchanged === 7 && /differs: description/.test(skipRun), skipRun);
  const updateRun = await tool('batch_create_accounts', { accounts: changed, on_existing: 'update' });
  const updateCounts = summaryCounts(updateRun);
  check('on_existing=update applies the differing row and leaves the other 7 unchanged', !!updateCounts && updateCounts.updated === 1 && updateCounts.unchanged === 7 && updateCounts.failed === 0, updateRun);

  // 4. Single create with a parent by number; single re-parent by number, promote, re-parent by name.
  const trucks = await tool('create_account', { name: `${P} Trucks`, account_type: 'Fixed Asset', account_sub_type: 'Vehicles', acct_num: num(30), parent_account_number: num(0) });
  const trucksId = idFrom(trucks);
  check('create_account with parent_account_number lands as a sub-account with the right FQN', !!trucksId && trucks.includes(`as a sub-account of "${FA}"`) && trucks.includes(`Fully qualified name: ${FA}:${P} Trucks`), trucks);

  if (trucksId) {
    const moved = await tool('update_account', { account_id: trucksId, parent_account_number: num(10) });
    check('update_account re-parents by number (FQN gains the new parent)', moved.includes(`Fully qualified name: ${FA}:${VEH}:${P} Trucks`), moved);
    const promoted = await tool('update_account', { account_id: trucksId, make_top_level: true });
    check('update_account make_top_level promotes to a top-level account', promoted.includes('now a top-level account') && promoted.includes(`Fully qualified name: ${P} Trucks`) && /Parent: none/.test(promoted), promoted);
    const back = await tool('update_account', { account_id: trucksId, parent_account_name: FA });
    check('update_account re-parents by name', back.includes(`Fully qualified name: ${FA}:${P} Trucks`), back);
  }

  // 5. Rules, each as the row-level message the loader would print.
  const rules: Array<[string, Record<string, unknown>, RegExp]> = [
    ['ambiguous parent name is rejected with the candidates listed', { name: `${P} Ambiguous`, account_type: 'Fixed Asset', parent_account_name: AD }, /ambiguous: 2 accounts match name "Accumulated Depreciation"[\s\S]*Fixed Assets/],
    ['parent/child account-type mismatch is explained', { name: `${P} Wrong Type`, account_type: 'Expense', acct_num: num(90), parent_account_number: num(0) }, /Account type mismatch: "[^"]+" is Expense but its parent "[^"]+" is Fixed Asset/],
    ['duplicate name under the same parent is explained (pre-flight)', { name: AD, account_type: 'Fixed Asset', account_sub_type: 'AccumulatedDepreciation', acct_num: num(18), parent_account_number: num(10) }, /Duplicate name: an account named "Accumulated Depreciation" already exists under/],
    ['duplicate account number company-wide is explained (QBO fault, no parent given)', { name: `${P} Dup Number`, account_type: 'Expense', acct_num: num(10) }, /Duplicate account number: \d+ is already assigned to another account\. Account numbers are unique company-wide/],
    ['duplicate top-level name is explained (QBO fault, no parent given)', { name: CC, account_type: 'Credit Card', account_sub_type: 'CreditCard' }, /Duplicate name: QBO already has an account named "[^"]+" at the top level/],
    ['an Accumulated Depreciation account cannot be a parent (pre-flight)', { name: `${P} Under Accum Dep`, account_type: 'Fixed Asset', account_sub_type: 'Vehicles', acct_num: num(91), parent_account_number: num(19) }, /Accumulated Amortization, Depletion, or Depreciation detail type to be parent accounts/],
    ['a top-level Accumulated Depreciation account is rejected by QBO and explained', { name: `${P} Accum Dep Top Level`, account_type: 'Fixed Asset', account_sub_type: 'AccumulatedDepreciation', acct_num: num(92) }, /Not allowed as a parent: QBO does not let Fixed Asset accounts with an Accumulated/],
    ['a colon in the name is rejected before the write', { name: `${P} Bad: Name`, account_type: 'Fixed Asset', acct_num: num(93), parent_account_number: num(0) }, /cannot contain colons/],
    ['an unknown parent number is reported as not found', { name: `${P} Orphan`, account_type: 'Expense', acct_num: num(94), parent_account_number: '4242424' }, /Parent account not found: no account has account number 4242424/],
    ['an OpeningBalanceEquity parent is rejected', { name: `${P} Under OBE`, account_type: 'Equity', parent_account_name: 'Opening Balance Equity' }, /OpeningBalanceEquity, which QBO does not allow to have sub-accounts|Parent account not found/],
  ];
  for (const [step, args, pattern] of rules) {
    const text = await tool('create_account', args);
    check(step, pattern.test(text) && !/created/.test(text), text);
  }

  // Depth: level 3 → 4 → 5 succeed under Equipment; level 6 is refused.
  const l3 = await tool('create_account', { name: `${P} L3`, account_type: 'Fixed Asset', account_sub_type: 'MachineryAndEquipment', acct_num: num(21), parent_account_number: num(20) });
  const l4 = await tool('create_account', { name: `${P} L4`, account_type: 'Fixed Asset', account_sub_type: 'MachineryAndEquipment', acct_num: num(22), parent_account_number: num(21) });
  const l5 = await tool('create_account', { name: `${P} L5`, account_type: 'Fixed Asset', account_sub_type: 'MachineryAndEquipment', acct_num: num(23), parent_account_number: num(22) });
  check('levels 3, 4 and 5 can be created', [l3, l4, l5].every((t) => t.includes('created as a sub-account')) && l5.includes(`Fully qualified name: ${FA}:${EQP}:${P} L3:${P} L4:${P} L5`), [l3, l4, l5].join('\n'));
  const l6 = await tool('create_account', { name: `${P} L6`, account_type: 'Fixed Asset', account_sub_type: 'MachineryAndEquipment', acct_num: num(24), parent_account_number: num(23) });
  check('a 6th level is refused with the 5-level rule', /Nesting too deep: "[^"]+" is already at level 5; "[^"]+" beneath it would be level 6/.test(l6) && !l6.includes('created'), l6);

  // Re-parent rules on update_account.
  const amexA = byNum.get(num(51));
  if (amexA) {
    const mismatch = await tool('update_account', { account_id: amexA.id, parent_account_number: num(0) });
    check('update_account refuses to move a Credit Card account under a Fixed Asset parent', /Account type mismatch/.test(mismatch) && /nothing was changed/i.test(mismatch), mismatch);
  }
  const fa = byNum.get(num(0));
  const veh = byNum.get(num(10));
  if (fa && veh) {
    const cycle = await tool('update_account', { account_id: fa.id, parent_account_number: num(10) });
    check('update_account refuses to move a parent under its own sub-account (cycle)', /one of its own sub-accounts/.test(cycle), cycle);
    const retype = await tool('update_account', { account_id: fa.id, account_type: 'Other Asset' });
    check('update_account refuses to change the type of an account that has sub-accounts', /does not change the type of an account with sub-accounts/.test(retype), retype);
  }

  // 6. Classes and departments: rename, re-parent, promote, deactivate.
  const classParent = await tool('create_class', { name: `${P} Class Parent` });
  const classParentId = idFrom(classParent);
  if (!classParentId) {
    result.skipped.push({ step: 'update_class', reason: `create_class failed (class tracking may be off): ${classParent}` });
    log('SKIP  update_class — could not create a class in this company');
  } else {
    const classChild = await tool('create_class', { name: `${P} Class Child` });
    const classChildId = idFrom(classChild);
    if (classChildId) {
      const renamed = await tool('update_class', { class_id: classChildId, name: `${P} Class Child Renamed` });
      check('update_class renames', renamed.includes(`Class "${P} Class Child Renamed" updated`), renamed);
      const nested = await tool('update_class', { class_id: classChildId, parent_class_id: classParentId });
      check('update_class re-parents (FQN gains the parent)', nested.includes(`Fully qualified name: ${P} Class Parent:${P} Class Child Renamed`), nested);
      const selfParent = await tool('update_class', { class_id: classParentId, parent_class_id: classChildId });
      check('update_class refuses a cycle', /one of its own sub-classes/.test(selfParent), selfParent);
      const top = await tool('update_class', { class_id: classChildId, make_top_level: true });
      check('update_class make_top_level promotes', top.includes('Top level') && top.includes(`Fully qualified name: ${P} Class Child Renamed`), top);
      const off = await tool('update_class', { class_id: classChildId, active: false });
      check('update_class deactivates', /Active: false/.test(off), off);
    }
    const offParent = await tool('update_class', { class_id: classParentId, active: false });
    check('update_class deactivates the parent class', /Active: false/.test(offParent), offParent);
  }

  const deptParent = await tool('create_department', { name: `${P} Location Parent` });
  const deptParentId = idFrom(deptParent);
  if (!deptParentId) {
    result.skipped.push({ step: 'update_department', reason: `create_department failed (location tracking may be off): ${deptParent}` });
    log('SKIP  update_department — could not create a department in this company');
  } else {
    const deptChild = await tool('create_department', { name: `${P} Location Child` });
    const deptChildId = idFrom(deptChild);
    if (deptChildId) {
      const renamed = await tool('update_department', { department_id: deptChildId, name: `${P} Location Child Renamed` });
      check('update_department renames', renamed.includes(`Department "${P} Location Child Renamed" updated`), renamed);
      const nested = await tool('update_department', { department_id: deptChildId, parent_department_id: deptParentId });
      check('update_department re-parents (FQN gains the parent)', nested.includes(`Fully qualified name: ${P} Location Parent:${P} Location Child Renamed`), nested);
      const top = await tool('update_department', { department_id: deptChildId, make_top_level: true });
      check('update_department make_top_level promotes', top.includes('Top level'), top);
      const off = await tool('update_department', { department_id: deptChildId, active: false });
      check('update_department deactivates', /Active: false/.test(off), off);
    }
    const offParent = await tool('update_department', { department_id: deptParentId, active: false });
    check('update_department deactivates the parent department', /Active: false/.test(offParent), offParent);
  }

  // 7. Clean up: deactivate everything with the prefix, deepest first.
  const remaining = (await readJson(P)).sort((a, b) => b.depth - a.depth);
  for (const a of remaining) {
    const text = await tool('delete_account', { account_id: a.id });
    check(`cleanup: deactivate ${a.fully_qualified_name}`, /deactivated/.test(text), text);
  }
  const after = await readJson(P, true);
  await tool('get_accounts', { format: 'tree', filter: P, include_inactive: true });
  check('after cleanup every prefixed account is inactive and renamed "(deleted)"', after.length > 0 && after.every((a) => a.active === false && /\(deleted\)$/.test(a.name)), JSON.stringify(after.map((a) => [a.fully_qualified_name, a.active])));
  check('nothing with the prefix is left active', (await readJson(P)).length === 0, '');

  log(`\nRESULT: ${result.passed.length} passed, ${result.failed.length} failed, ${result.skipped.length} skipped`);
  return result;
}
