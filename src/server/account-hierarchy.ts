// ─── Sub-account (parent/child) support for the Chart of Accounts ────────────
//
// Pure helpers behind create_account / update_account / batch_create_accounts
// and the get_accounts tree + table views. Nothing here talks to QuickBooks:
// the MCP tools hand in the fetched chart of accounts and get back resolved
// parents, pre-flight validation errors, depth-ordered batch plans, and
// readable explanations of QBO faults.
//
// Every rule cites its source:
//   [docs]    Intuit's Account entity reference (developer.intuit.com → API
//             reference → Account), quoted.
//   [sandbox] a fault QBO's sandbox returned on 2026-09-17 while this was
//             built; the QBO Message / Detail text is quoted verbatim.

export interface QboAccount {
  Id?: string | number;
  Name?: string;
  AcctNum?: string;
  AccountType?: string;
  AccountSubType?: string;
  Classification?: string;
  Active?: boolean;
  SubAccount?: boolean;
  ParentRef?: { value?: string | number; name?: string };
  FullyQualifiedName?: string;
  SyncToken?: string;
  Description?: string;
  CurrentBalance?: number;
  CurrentBalanceWithSubAccounts?: number;
  [key: string]: unknown;
}

/** [docs] AccountType enumeration for the US locale. */
export const QBO_ACCOUNT_TYPES = [
  'Bank', 'Other Current Asset', 'Fixed Asset', 'Other Asset',
  'Accounts Receivable', 'Equity', 'Expense', 'Other Expense',
  'Cost of Goods Sold', 'Accounts Payable', 'Credit Card',
  'Long Term Liability', 'Other Current Liability', 'Income', 'Other Income',
] as const;
export type QboAccountType = (typeof QBO_ACCOUNT_TYPES)[number];

/**
 * [docs] FullyQualifiedName: "Fully qualified name of the object; derived
 * from Name and ParentRef. The fully qualified name prepends the topmost
 * parent, followed by each subaccount separated by colons. Takes the form of
 * Parent:Account1:SubAccount1:SubAccount2. Limited to 5 levels."
 */
export const MAX_ACCOUNT_LEVELS = 5;

/** [docs] Name: max 100 characters. */
export const MAX_ACCOUNT_NAME_LENGTH = 100;

/**
 * [docs] SubAccount: "accounts of these types - OpeningBalanceEquity,
 * UndepositedFunds, RetainedEarnings, CashReceiptIncome,
 * CashExpenditureExpense, ExchangeGainOrLoss cannot have a sub account and
 * cannot be a sub account of another account."
 */
export const NO_SUBACCOUNT_SUBTYPES: ReadonlySet<string> = new Set([
  'OpeningBalanceEquity',
  'UndepositedFunds',
  'RetainedEarnings',
  'CashReceiptIncome',
  'CashExpenditureExpense',
  'ExchangeGainOrLoss',
]);

/**
 * [sandbox] Creating a Fixed Asset account with one of these detail types
 * fails — even with no parent and no children — with QBO code 6000:
 * "Business Validation Error: Fixed asset accounts (Accumulated Amortization,
 * Depletion, or Depreciation) cannot be parent accounts." In practice these
 * accounts must be sub-accounts (of e.g. a MachineryAndEquipment or Vehicles
 * parent) and can never take children of their own.
 */
export const NON_PARENT_FIXED_ASSET_SUBTYPES: ReadonlySet<string> = new Set([
  'AccumulatedDepreciation',
  'AccumulatedAmortization',
  'AccumulatedDepletion',
]);

// ─── Index ───────────────────────────────────────────────────────────────────

export interface AccountIndex {
  all: QboAccount[];
  byId: Map<string, QboAccount>;
  /** lower-cased AcctNum → accounts (an inactive "(deleted)" twin can share a number). */
  byNum: Map<string, QboAccount[]>;
  /** lower-cased Name → accounts (the same Name may legitimately sit under different parents). */
  byName: Map<string, QboAccount[]>;
  /** lower-cased FullyQualifiedName → account. */
  byFqn: Map<string, QboAccount>;
  /** parent Id → children. */
  childrenOf: Map<string, QboAccount[]>;
}

export function indexAccounts(list: QboAccount[]): AccountIndex {
  const index: AccountIndex = {
    all: [],
    byId: new Map(),
    byNum: new Map(),
    byName: new Map(),
    byFqn: new Map(),
    childrenOf: new Map(),
  };
  for (const a of list ?? []) addToIndex(index, a);
  return index;
}

/** Add (or replace, by Id) one account — used after each create/update in a batch. */
export function addToIndex(index: AccountIndex, account: QboAccount): void {
  if (account?.Id == null) return;
  const id = String(account.Id);
  const previous = index.byId.get(id);
  if (previous) removeFromIndex(index, previous);

  index.all.push(account);
  index.byId.set(id, account);
  const num = normalizeKey(account.AcctNum);
  if (num) push(index.byNum, num, account);
  const name = normalizeKey(account.Name);
  if (name) push(index.byName, name, account);
  const fqn = normalizeKey(account.FullyQualifiedName);
  if (fqn) index.byFqn.set(fqn, account);
  const parent = parentIdOf(account);
  if (parent) push(index.childrenOf, parent, account);
}

function removeFromIndex(index: AccountIndex, account: QboAccount): void {
  const id = String(account.Id);
  index.all = index.all.filter((a) => String(a.Id) !== id);
  index.byId.delete(id);
  const drop = (map: Map<string, QboAccount[]>, key: string | null) => {
    if (!key) return;
    const rest = (map.get(key) ?? []).filter((a) => String(a.Id) !== id);
    if (rest.length) map.set(key, rest);
    else map.delete(key);
  };
  drop(index.byNum, normalizeKey(account.AcctNum));
  drop(index.byName, normalizeKey(account.Name));
  const fqn = normalizeKey(account.FullyQualifiedName);
  if (fqn && index.byFqn.get(fqn) === account) index.byFqn.delete(fqn);
  drop(index.childrenOf, parentIdOf(account));
}

function push(map: Map<string, QboAccount[]>, key: string, value: QboAccount): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

function normalizeKey(value: unknown): string | null {
  if (value == null) return null;
  const s = String(value).trim().toLowerCase();
  return s || null;
}

export function parentIdOf(account: QboAccount | null | undefined): string | null {
  const v = account?.ParentRef?.value;
  return v == null || v === '' ? null : String(v);
}

export function isActive(account: QboAccount): boolean {
  return account.Active !== false;
}

export function displayName(account: QboAccount): string {
  return String(account.FullyQualifiedName ?? account.Name ?? '');
}

/**
 * Depth in the tree, 1 = top level. Uses FullyQualifiedName when QBO supplied
 * it (names cannot contain colons [docs], so the segment count is exact) and
 * falls back to walking ParentRef.
 */
export function accountDepth(account: QboAccount, index: AccountIndex): number {
  if (account.FullyQualifiedName) return String(account.FullyQualifiedName).split(':').length;
  let depth = 1;
  let current = account;
  const seen = new Set<string>();
  for (;;) {
    const pid = parentIdOf(current);
    if (!pid || seen.has(pid)) break;
    seen.add(pid);
    const parent = index.byId.get(pid);
    if (!parent) break;
    depth++;
    current = parent;
  }
  return depth;
}

/** Ids of every ancestor, nearest first. */
export function ancestorIds(account: QboAccount, index: AccountIndex): string[] {
  const out: string[] = [];
  let current: QboAccount | undefined = account;
  const seen = new Set<string>();
  while (current) {
    const pid = parentIdOf(current);
    if (!pid || seen.has(pid)) break;
    seen.add(pid);
    out.push(pid);
    current = index.byId.get(pid);
  }
  return out;
}

/** Direct children of a parent Id, or the top-level accounts when parentId is null. */
export function siblingsUnder(parentId: string | null, index: AccountIndex): QboAccount[] {
  if (parentId) return index.childrenOf.get(parentId) ?? [];
  return index.all.filter((a) => !parentIdOf(a));
}

/** The FullyQualifiedName a child named `name` would get under `parent`. */
export function fullyQualifiedNameFor(name: string, parent: QboAccount | null): string {
  return parent ? `${displayName(parent)}:${name}` : name;
}

// ─── Parent resolution ───────────────────────────────────────────────────────

export interface ParentSpec {
  id?: string;
  number?: string;
  name?: string;
}

export type ParentResolution =
  | { ok: true; parent: QboAccount }
  | { ok: false; error: string };

export function hasParentSpec(spec: ParentSpec | undefined | null): boolean {
  return Boolean(spec && (spec.id?.trim() || spec.number?.trim() || spec.name?.trim()));
}

/**
 * Resolve a parent given by QBO Id, account number, or name. Numbers and
 * names match exactly (case-insensitive) — never by prefix or substring — so
 * "1500" can never silently pick "1500-1". A name may be a plain Name or a
 * FullyQualifiedName ("Fixed Assets:Vehicles"), which is how to disambiguate
 * when the same Name exists under several parents. Inactive matches lose to
 * an active twin (QBO renames deactivated accounts "X (deleted)", but the
 * number can linger), and an inactive sole match is rejected.
 */
export function resolveParentAccount(index: AccountIndex, spec: ParentSpec): ParentResolution {
  const id = spec.id?.trim();
  const number = spec.number?.trim();
  const name = spec.name?.trim();

  if (id) {
    const parent = index.byId.get(id);
    if (!parent) return { ok: false, error: `Parent account not found: no account has Id ${id}. Use get_accounts to list accounts.` };
    return checkResolved(parent, `Id ${id}`);
  }

  if (number) {
    const candidates = index.byNum.get(number.toLowerCase()) ?? [];
    return pickCandidate(candidates, `account number ${number}`, 'Pass parent_account_id to disambiguate.');
  }

  if (name) {
    const exactFqn = index.byFqn.get(name.toLowerCase());
    if (exactFqn) return checkResolved(exactFqn, `"${name}"`);
    const candidates = index.byName.get(name.toLowerCase()) ?? [];
    return pickCandidate(
      candidates,
      `name "${name}"`,
      'Pass the fully qualified name (e.g. "Parent:Child"), parent_account_number, or parent_account_id to disambiguate.'
    );
  }

  return { ok: false, error: 'No parent identifier given. Pass parent_account_number, parent_account_name, or parent_account_id.' };
}

function pickCandidate(candidates: QboAccount[], what: string, hint: string): ParentResolution {
  if (candidates.length === 0) {
    return { ok: false, error: `Parent account not found: no account has ${what}. Use get_accounts to list accounts (include_inactive=true shows deactivated ones).` };
  }
  const active = candidates.filter(isActive);
  if (active.length === 1) return { ok: true, parent: active[0] };
  if (active.length === 0) return checkResolved(candidates[0], what);
  const listing = active
    .map((a) => `  Id ${a.Id}${a.AcctNum ? ` [${a.AcctNum}]` : ''}  ${displayName(a)}  (${a.AccountType ?? '?'})`)
    .join('\n');
  return { ok: false, error: `Parent account is ambiguous: ${active.length} accounts match ${what}:\n${listing}\n${hint}` };
}

function checkResolved(parent: QboAccount, what: string): ParentResolution {
  if (!isActive(parent)) {
    return {
      ok: false,
      error: `Parent account ${what} ("${displayName(parent)}", Id ${parent.Id}) is inactive. Reactivate it first (update_account active=true) or choose an active parent.`,
    };
  }
  return { ok: true, parent };
}

// ─── Pre-flight validation ───────────────────────────────────────────────────

export interface PlacementCandidate {
  /** Set when validating an existing account (update / re-parent). */
  id?: string;
  name: string;
  acctNum?: string;
  accountType: string;
  accountSubType?: string;
}

/**
 * Everything QBO would reject that can be checked against the chart of
 * accounts before the write. Returns human-readable messages, one per rule.
 */
export function validateAccountPlacement(
  candidate: PlacementCandidate,
  parent: QboAccount | null,
  index: AccountIndex
): string[] {
  const errors: string[] = [];
  const name = candidate.name ?? '';
  const parentLabel = parent ? `"${displayName(parent)}"` : 'the top level';

  // [docs] "The Account.Name attribute must not contain double quotes (") or
  // colon (:)." [sandbox] code 2180: "Names must have at least one character,
  // must be on one line, and cannot include colons or tabbing."
  if (!name.trim()) errors.push('Account name is required (QBO: names must have at least one character).');
  if (/[:"]/.test(name)) errors.push(`Invalid account name "${name}": QBO account names cannot contain colons (:) or double quotes (").`);
  if (/[\t\r\n]/.test(name)) errors.push(`Invalid account name "${name}": QBO account names must be on one line with no tabs.`);
  if (name.length > MAX_ACCOUNT_NAME_LENGTH) errors.push(`Account name "${name}" is ${name.length} characters; QBO allows at most ${MAX_ACCOUNT_NAME_LENGTH}.`);

  // [docs] "The Account.AcctNum attribute must not contain colon (:)."
  if (candidate.acctNum && candidate.acctNum.includes(':')) {
    errors.push(`Invalid account number "${candidate.acctNum}": QBO account numbers cannot contain colons (:).`);
  }

  // [QBO UI] "Cannot change the type of an account with subaccounts."
  if (candidate.id) {
    const self = index.byId.get(candidate.id);
    const children = index.childrenOf.get(candidate.id) ?? [];
    if (self && self.AccountType && self.AccountType !== candidate.accountType && children.length > 0) {
      errors.push(
        `Cannot change "${displayName(self)}" from ${self.AccountType} to ${candidate.accountType}: it has ${children.length} sub-account${children.length === 1 ? '' : 's'} (${children.slice(0, 3).map((c) => `"${c.Name}"`).join(', ')}${children.length > 3 ? ', …' : ''}) and QBO does not change the type of an account with sub-accounts. Move or re-type the sub-accounts first.`
      );
    }
  }

  if (parent) {
    const parentId = String(parent.Id);
    if (candidate.id && candidate.id === parentId) {
      errors.push(`"${name}" cannot be its own parent.`);
    } else if (candidate.id) {
      const self = index.byId.get(candidate.id);
      if (self && ancestorIds(parent, index).includes(candidate.id)) {
        errors.push(`Cannot move "${displayName(self)}" under ${parentLabel}: that account is one of its own sub-accounts (this would create a cycle).`);
      }
    }

    // [sandbox] QBO code 6000 — the same rule the QBO UI states as "For
    // subaccounts, you must select the same account type as their parent."
    if (parent.AccountType && parent.AccountType !== candidate.accountType) {
      errors.push(
        `Account type mismatch: "${name}" is ${candidate.accountType} but its parent ${parentLabel} is ${parent.AccountType}. QBO requires a sub-account to have the same account type as its parent (detail types may differ).`
      );
    }

    // [docs] FullyQualifiedName "Limited to 5 levels."
    const parentDepth = accountDepth(parent, index);
    if (parentDepth + 1 > MAX_ACCOUNT_LEVELS) {
      errors.push(
        `Nesting too deep: ${parentLabel} is already at level ${parentDepth}; "${name}" beneath it would be level ${parentDepth + 1}, and QBO limits the account hierarchy to ${MAX_ACCOUNT_LEVELS} levels.`
      );
    }

    // [docs] types that "cannot have a sub account and cannot be a sub account".
    if (parent.AccountSubType && NO_SUBACCOUNT_SUBTYPES.has(parent.AccountSubType)) {
      errors.push(`${parentLabel} has detail type ${parent.AccountSubType}, which QBO does not allow to have sub-accounts.`);
    }
    if (candidate.accountSubType && NO_SUBACCOUNT_SUBTYPES.has(candidate.accountSubType)) {
      errors.push(`"${name}" has detail type ${candidate.accountSubType}, which QBO does not allow to be a sub-account of another account.`);
    }

    // [sandbox] "Fixed asset accounts (Accumulated Amortization, Depletion, or
    // Depreciation) cannot be parent accounts."
    if (parent.AccountType === 'Fixed Asset' && parent.AccountSubType && NON_PARENT_FIXED_ASSET_SUBTYPES.has(parent.AccountSubType)) {
      errors.push(
        `${parentLabel} has detail type ${parent.AccountSubType}; QBO does not allow Fixed Asset accounts with an Accumulated Amortization, Depletion, or Depreciation detail type to be parent accounts.`
      );
    }
  }

  // [sandbox] Duplicate name within the same parent → code 6240 "Duplicate
  // Name Exists Error … An account already has the same display name." The
  // sandbox's own chart carries the same Name under different parents (e.g.
  // "Job Materials" under both "Job Expenses" and "Landscaping Services"), so
  // the namespace is the parent, not the company.
  const siblings = siblingsUnder(parent ? String(parent.Id) : null, index);
  const nameKey = name.trim().toLowerCase();
  const clash = siblings.find((s) => String(s.Id) !== candidate.id && isActive(s) && normalizeKey(s.Name) === nameKey);
  if (nameKey && clash) {
    errors.push(
      `Duplicate name: an account named "${clash.Name}" already exists under ${parentLabel} (Id ${clash.Id}${clash.AcctNum ? `, number ${clash.AcctNum}` : ''}). QBO requires names to be unique among accounts that share the same parent; the same name under a different parent is allowed.`
    );
  }

  // [sandbox] Duplicate number → code 6000 "Another account is already using
  // this number." Numbers are unique across the whole company.
  const numKey = normalizeKey(candidate.acctNum);
  if (numKey) {
    const holders = (index.byNum.get(numKey) ?? []).filter((a) => String(a.Id) !== candidate.id && isActive(a));
    if (holders.length > 0) {
      const h = holders[0];
      errors.push(
        `Duplicate account number: ${candidate.acctNum} is already used by "${displayName(h)}" (Id ${h.Id}). QBO requires account numbers to be unique company-wide.`
      );
    }
  }

  return errors;
}

// ─── QBO fault explanation ───────────────────────────────────────────────────

export interface QboFaultInfo {
  code?: string;
  message?: string;
  detail?: string;
  element?: string;
}

/** Pull the first Fault.Error out of a QBOError (its `response` is the raw body). */
export function parseQboFault(err: unknown): QboFaultInfo | null {
  const raw = (err as { response?: unknown } | null)?.response;
  if (raw == null) return null;
  let body: any = raw;
  if (typeof raw === 'string') {
    try {
      body = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  const e = body?.Fault?.Error?.[0];
  if (!e) return null;
  return {
    code: e.code != null ? String(e.code) : undefined,
    message: e.Message,
    detail: e.Detail,
    element: e.element,
  };
}

/** "Message — Detail (QBO code N)" when a fault is present, else the error's own message. */
export function describeQboFault(err: unknown): string {
  const fault = parseQboFault(err);
  if (!fault) return String((err as any)?.message ?? err);
  const head = [fault.message, fault.detail].filter(Boolean).join(' — ');
  return `${head || 'QBO returned a fault'}${fault.code ? ` (QBO code ${fault.code})` : ''}`;
}

export type AccountErrorKind =
  | 'duplicate_name'
  | 'duplicate_number'
  | 'type_mismatch'
  | 'nesting_depth'
  | 'invalid_name'
  | 'not_parentable'
  | 'has_subaccounts'
  | 'stale_object'
  | 'unsupported_operation'
  | 'unknown';

export interface AccountErrorContext {
  name?: string;
  acctNum?: string;
  parentFqn?: string;
}

/**
 * Turn a raw QBO fault into the rule that was broken, in plain words, keeping
 * QBO's own text so nothing is lost. Patterns come from the sandbox probes
 * cited at the top of this file.
 */
export function explainAccountError(err: unknown, ctx: AccountErrorContext = {}): { kind: AccountErrorKind; text: string } {
  const fault = parseQboFault(err);
  const raw = fault
    ? `${[fault.message, fault.detail].filter(Boolean).join(' — ')}${fault.code ? ` (QBO code ${fault.code})` : ''}`
    : String((err as any)?.message ?? err);
  const haystack = `${fault?.message ?? ''} ${fault?.detail ?? ''} ${fault ? '' : raw}`.toLowerCase();
  const where = ctx.parentFqn ? `under "${ctx.parentFqn}"` : 'at the top level';
  const nameLabel = ctx.name ? `"${ctx.name}"` : 'this account';

  let kind: AccountErrorKind = 'unknown';
  let text: string;

  if (fault?.code === '6240' || haystack.includes('duplicate name exists')) {
    kind = 'duplicate_name';
    text = `Duplicate name: QBO already has an account named ${nameLabel} ${where}. Names must be unique among accounts sharing the same parent (the same name under a different parent is fine). Rename it, or pick the other parent.`;
  } else if (haystack.includes('already using this number')) {
    kind = 'duplicate_number';
    text = `Duplicate account number: ${ctx.acctNum ? `${ctx.acctNum} ` : ''}is already assigned to another account. Account numbers are unique company-wide — use get_accounts (include_inactive=true) to find the holder.`;
  } else if (haystack.includes('same account type') || (haystack.includes('account type') && haystack.includes('parent'))) {
    kind = 'type_mismatch';
    text = `Account type mismatch: QBO requires ${nameLabel} to have the same account type as its parent${ctx.parentFqn ? ` "${ctx.parentFqn}"` : ''}. Change the account type (the detail type may differ) or choose a parent of the same type.`;
  } else if (haystack.includes('cannot be parent accounts')) {
    kind = 'not_parentable';
    text = `Not allowed as a parent: QBO does not let Fixed Asset accounts with an Accumulated Amortization, Depletion, or Depreciation detail type be parent accounts (nor exist as top-level accounts). Give ${nameLabel} a parent of a different detail type, or make the accumulated account the child rather than the parent.`;
  } else if (haystack.includes('subaccounts') && (haystack.includes('change the type') || haystack.includes('cannot change'))) {
    kind = 'has_subaccounts';
    text = `QBO will not change the type of ${nameLabel} while it has sub-accounts. Re-type or move the sub-accounts first.`;
  } else if (/\blevels?\b/.test(haystack) && (haystack.includes('sub') || haystack.includes('nest') || haystack.includes('deep'))) {
    kind = 'nesting_depth';
    text = `Nesting too deep: QBO limits the account hierarchy to ${MAX_ACCOUNT_LEVELS} levels (FullyQualifiedName "Parent:Account1:SubAccount1:SubAccount2"). Flatten the branch ${ctx.parentFqn ? `below "${ctx.parentFqn}" ` : ''}so ${nameLabel} lands at level ${MAX_ACCOUNT_LEVELS} or above.`;
  } else if (fault?.code === '2180' || haystack.includes('cannot include colons')) {
    kind = 'invalid_name';
    text = `Invalid name: QBO account names must have at least one character, be on one line, and cannot include colons or tabs.`;
  } else if (fault?.code === '5010' || haystack.includes('stale object')) {
    kind = 'stale_object';
    text = `The account changed in QBO after it was read (stale SyncToken). Re-run the operation; it re-fetches the current version.`;
  } else if (haystack.includes('operation delete is not supported')) {
    kind = 'unsupported_operation';
    text = `QBO does not support deleting accounts; deactivate instead (delete_account now does this via Active=false).`;
  } else {
    text = raw;
  }

  return { kind, text: kind === 'unknown' ? text : `${text}\nQBO said: ${raw}` };
}

// ─── Batch planning and execution ────────────────────────────────────────────

export interface BatchAccountRow {
  name: string;
  account_type: string;
  account_sub_type?: string;
  acct_num?: string;
  description?: string;
  parent_account_number?: string;
  parent_account_name?: string;
  parent_account_id?: string;
}

export interface PlannedRow {
  /** 1-based position in the input. */
  row: number;
  input: BatchAccountRow;
  /** Depth relative to the batch: 1 = parent is none or already in QBO. */
  batchDepth: number;
  /** 1-based row of the in-batch parent, when the parent is another row. */
  parentRow?: number;
  /** Set when the row can never be attempted (bad parent reference, cycle, duplicate row). */
  planError?: string;
}

function rowParentSpec(row: BatchAccountRow): ParentSpec {
  return { id: row.parent_account_id, number: row.parent_account_number, name: row.parent_account_name };
}

/**
 * Order rows parents-first. Rows that name another row as their parent (by
 * number or by name) sort after it; rows whose parent is not in the batch are
 * assumed to exist in QBO already and go first. Input order is preserved
 * within a depth level, so the output is deterministic.
 */
export function planAccountBatch(rows: BatchAccountRow[]): PlannedRow[] {
  const planned: PlannedRow[] = rows.map((input, i) => ({ row: i + 1, input, batchDepth: 1 }));

  const byNum = new Map<string, PlannedRow[]>();
  const byName = new Map<string, PlannedRow[]>();
  for (const p of planned) {
    const num = normalizeKey(p.input.acct_num);
    if (num) {
      const list = byNum.get(num) ?? [];
      list.push(p);
      byNum.set(num, list);
    }
    const name = normalizeKey(p.input.name);
    if (name) {
      const list = byName.get(name) ?? [];
      list.push(p);
      byName.set(name, list);
    }
  }

  // Duplicate numbers inside the batch: the first row keeps it, later ones fail.
  for (const [num, list] of byNum) {
    if (list.length > 1) {
      for (const p of list.slice(1)) {
        p.planError = `Row ${p.row} repeats account number ${p.input.acct_num} already used by row ${list[0].row} — account numbers must be unique (${num}).`;
      }
    }
  }

  // Link each row to its in-batch parent, if the reference points at one.
  for (const p of planned) {
    const spec = rowParentSpec(p.input);
    if (!hasParentSpec(spec)) continue;
    if (spec.id?.trim()) continue; // Ids can only refer to accounts already in QBO
    let matches: PlannedRow[] = [];
    if (spec.number?.trim()) {
      matches = (byNum.get(spec.number.trim().toLowerCase()) ?? []).filter((m) => !m.planError);
    } else if (spec.name?.trim()) {
      const key = spec.name.trim().toLowerCase();
      matches = byName.get(key) ?? [];
      // A "Parent:Child" spelling can only name an existing QBO account.
      if (key.includes(':')) matches = [];
    }
    if (matches.length > 1) {
      p.planError = `Row ${p.row}: parent "${spec.number ?? spec.name}" matches ${matches.length} rows in this batch (rows ${matches.map((m) => m.row).join(', ')}). Give the parent a unique account number and reference it by parent_account_number.`;
    } else if (matches.length === 1) {
      if (matches[0] === p) p.planError = `Row ${p.row}: "${p.input.name}" names itself as its parent.`;
      else p.parentRow = matches[0].row;
    }
  }

  // Depth via parent chain, with cycle detection.
  const depthOf = (p: PlannedRow, trail: number[]): number => {
    if (p.parentRow == null) return 1;
    if (trail.includes(p.row)) {
      const cycle = [...trail.slice(trail.indexOf(p.row)), p.row].join(' → ');
      p.planError = p.planError ?? `Row ${p.row}: parent references form a cycle (rows ${cycle}).`;
      return 1;
    }
    const parent = planned[p.parentRow - 1];
    return depthOf(parent, [...trail, p.row]) + 1;
  };
  for (const p of planned) p.batchDepth = depthOf(p, []);
  // A row whose in-batch parent has a planError is left to execution, where
  // it reports "blocked" once the parent row has failed.

  return planned.slice().sort((a, b) => a.batchDepth - b.batchDepth || a.row - b.row);
}

export type BatchRowStatus =
  | 'created'
  | 'updated'
  | 'unchanged'
  | 'skipped'
  | 'failed'
  | 'blocked'
  | 'would_create'
  | 'would_update';

export interface BatchRowResult {
  row: number;
  acct_num?: string;
  name: string;
  status: BatchRowStatus;
  id?: string;
  fully_qualified_name?: string;
  parent_id?: string;
  message?: string;
}

export interface BatchOptions {
  /** What to do when a row matches an existing account (by number, else by parent+name). */
  onExisting: 'skip' | 'update';
  /** Validate and plan only; nothing is written. */
  dryRun: boolean;
}

export interface AccountWriter {
  create(payload: Record<string, unknown>): Promise<QboAccount>;
  update(payload: Record<string, unknown>): Promise<QboAccount>;
}

export interface BatchOutcome {
  results: BatchRowResult[];
  counts: Record<BatchRowStatus, number>;
}

/** Find the QBO account a row refers to: by account number first, then by parent + name. */
export function findExistingForRow(row: BatchAccountRow, parent: QboAccount | null, index: AccountIndex): { account: QboAccount; matchedBy: 'number' | 'name' } | null {
  // Active accounts only. [sandbox] A deactivated account keeps its AcctNum,
  // yet QBO accepts a new active account with the same number — so an
  // inactive twin is reported (see inactiveNumberTwins), never reused.
  const num = normalizeKey(row.acct_num);
  if (num) {
    const active = (index.byNum.get(num) ?? []).filter(isActive);
    if (active[0]) return { account: active[0], matchedBy: 'number' };
  }
  const nameKey = normalizeKey(row.name);
  if (!nameKey) return null;
  const parentId = parent ? String(parent.Id) : null;
  const sibling = siblingsUnder(parentId, index).find((s) => isActive(s) && normalizeKey(s.Name) === nameKey);
  return sibling ? { account: sibling, matchedBy: 'name' } : null;
}

/** Deactivated accounts still carrying this number — QBO allows the reuse, but the load should say so. */
export function inactiveNumberTwins(acctNum: string | undefined, index: AccountIndex): QboAccount[] {
  const key = normalizeKey(acctNum);
  if (!key) return [];
  return (index.byNum.get(key) ?? []).filter((a) => !isActive(a));
}

/** True when walking ParentRef from `startId` reaches `targetId` (works for Account, Class and Department). */
export function refChainIncludes(byId: Map<string, { ParentRef?: { value?: string | number } }>, startId: string, targetId: string): boolean {
  const seen = new Set<string>();
  let current = byId.get(startId);
  while (current) {
    const pid = current.ParentRef?.value == null ? null : String(current.ParentRef.value);
    if (!pid || seen.has(pid)) return false;
    if (pid === targetId) return true;
    seen.add(pid);
    current = byId.get(pid);
  }
  return false;
}

/** Field-by-field differences between an existing account and what a row asks for. */
export function diffExistingAccount(existing: QboAccount, row: BatchAccountRow, parent: QboAccount | null): string[] {
  const diffs: string[] = [];
  if ((existing.Name ?? '') !== row.name) diffs.push(`name "${existing.Name ?? ''}" → "${row.name}"`);
  if (normalizeKey(existing.AcctNum) !== normalizeKey(row.acct_num) && row.acct_num !== undefined) {
    diffs.push(`number ${existing.AcctNum ?? '(none)'} → ${row.acct_num || '(none)'}`);
  }
  if ((existing.AccountType ?? '') !== row.account_type) diffs.push(`type ${existing.AccountType ?? '?'} → ${row.account_type}`);
  if (row.account_sub_type && (existing.AccountSubType ?? '') !== row.account_sub_type) {
    diffs.push(`detail type ${existing.AccountSubType ?? '?'} → ${row.account_sub_type}`);
  }
  const wantParent = parent ? String(parent.Id) : null;
  if (parentIdOf(existing) !== wantParent) {
    diffs.push(`parent ${parentIdOf(existing) ?? '(top level)'} → ${wantParent ? `${wantParent} "${displayName(parent!)}"` : '(top level)'}`);
  }
  if (row.description !== undefined && (existing.Description ?? '') !== row.description) diffs.push('description');
  if (!isActive(existing)) diffs.push('inactive → active');
  return diffs;
}

/** Build the QBO Account payload for a create (no Id) or full update (spread of the fetched entity). */
export function buildAccountPayload(row: BatchAccountRow, parent: QboAccount | null, existing?: QboAccount): Record<string, unknown> {
  const payload: Record<string, unknown> = existing ? { ...existing } : {};
  payload.Name = row.name;
  payload.AccountType = row.account_type;
  if (row.account_sub_type) payload.AccountSubType = row.account_sub_type;
  if (row.acct_num !== undefined) payload.AcctNum = row.acct_num;
  if (row.description !== undefined) payload.Description = row.description;
  applyParentToPayload(payload, parent);
  if (existing) payload.Active = true;
  return payload;
}

/**
 * Set or clear the parent on an Account payload. [docs] ParentRef "Specifies
 * the Parent AccountId if this represents a SubAccount"; SubAccount and
 * FullyQualifiedName are system-derived, so the stale FullyQualifiedName is
 * dropped and SubAccount is kept consistent with ParentRef.
 */
export function applyParentToPayload(payload: Record<string, unknown>, parent: QboAccount | null): void {
  if (parent) {
    payload.ParentRef = { value: String(parent.Id) };
    payload.SubAccount = true;
  } else {
    delete payload.ParentRef;
    payload.SubAccount = false;
  }
  delete payload.FullyQualifiedName;
}

export async function executeAccountBatch(
  rows: BatchAccountRow[],
  index: AccountIndex,
  writer: AccountWriter,
  options: BatchOptions
): Promise<BatchOutcome> {
  const planned = planAccountBatch(rows);
  const results = new Map<number, BatchRowResult>();
  // Row → the account it produced (real, or a placeholder in dry runs) so
  // children can resolve it as their parent.
  const producedByRow = new Map<number, QboAccount>();
  // Existing account Id → the row that already matched it this run, so two
  // rows that resolve to the same account (same name under the same parent)
  // fail loudly instead of the second silently renumbering the first.
  const claimedBy = new Map<string, number>();
  let placeholderSeq = 0;

  for (const p of planned) {
    const row = p.input;
    const base: BatchRowResult = { row: p.row, acct_num: row.acct_num, name: row.name, status: 'failed' };

    if (p.planError) {
      results.set(p.row, { ...base, message: p.planError });
      continue;
    }

    // Parent: another row in this batch, or an account already in QBO.
    let parent: QboAccount | null = null;
    const spec = rowParentSpec(row);
    if (p.parentRow != null) {
      const parentResult = results.get(p.parentRow);
      const produced = producedByRow.get(p.parentRow);
      if (!produced || !parentResult || parentResult.status === 'failed' || parentResult.status === 'blocked') {
        results.set(p.row, {
          ...base,
          status: 'blocked',
          message: `Parent row ${p.parentRow} ("${rows[p.parentRow - 1]?.name}") did not land (${parentResult?.status ?? 'not processed'}), so this row was not attempted.`,
        });
        continue;
      }
      parent = produced;
    } else if (hasParentSpec(spec)) {
      const resolved = resolveParentAccount(index, spec);
      if (!resolved.ok) {
        results.set(p.row, { ...base, message: resolved.error });
        continue;
      }
      parent = resolved.parent;
    }

    const existing = findExistingForRow(row, parent, index);
    const parentFqn = parent ? displayName(parent) : undefined;

    if (existing) {
      const existingId = String(existing.account.Id);
      const claimant = claimedBy.get(existingId);
      if (claimant != null && claimant !== p.row) {
        results.set(p.row, {
          ...base,
          message: `Duplicate within this batch: "${row.name}" under ${parent ? `"${displayName(parent)}"` : 'the top level'} is the same account as row ${claimant} (${rows[claimant - 1]?.acct_num ? `number ${rows[claimant - 1].acct_num}, ` : ''}Id ${existingId}). QBO requires names to be unique among accounts sharing a parent — give one of them a different name.`,
        });
        continue;
      }
      claimedBy.set(existingId, p.row);
      const diffs = diffExistingAccount(existing.account, row, parent);
      const label = `exists as Id ${existingId} "${displayName(existing.account)}" (matched by ${existing.matchedBy})`;
      producedByRow.set(p.row, existing.account);
      if (diffs.length === 0) {
        results.set(p.row, { ...base, status: 'unchanged', id: String(existing.account.Id), fully_qualified_name: existing.account.FullyQualifiedName, parent_id: parentIdOf(existing.account) ?? undefined, message: label });
        continue;
      }
      if (options.onExisting === 'skip') {
        results.set(p.row, { ...base, status: 'skipped', id: String(existing.account.Id), fully_qualified_name: existing.account.FullyQualifiedName, parent_id: parentIdOf(existing.account) ?? undefined, message: `${label}; differs: ${diffs.join('; ')}. Re-run with on_existing="update" to apply.` });
        continue;
      }
      const errors = validateAccountPlacement(
        { id: String(existing.account.Id), name: row.name, acctNum: row.acct_num ?? existing.account.AcctNum, accountType: row.account_type, accountSubType: row.account_sub_type ?? existing.account.AccountSubType },
        parent,
        index
      );
      if (errors.length > 0) {
        results.set(p.row, { ...base, id: String(existing.account.Id), message: `${label}; update rejected before calling QBO: ${errors.join(' ')}` });
        continue;
      }
      const payload = buildAccountPayload(row, parent, existing.account);
      if (options.dryRun) {
        const placeholder: QboAccount = { ...existing.account, ...payload, FullyQualifiedName: fullyQualifiedNameFor(row.name, parent) };
        producedByRow.set(p.row, placeholder);
        addToIndex(index, placeholder);
        results.set(p.row, { ...base, status: 'would_update', id: String(existing.account.Id), fully_qualified_name: placeholder.FullyQualifiedName, parent_id: parent ? String(parent.Id) : undefined, message: `${label}; would change: ${diffs.join('; ')}` });
        continue;
      }
      try {
        const updated = await writer.update(payload);
        addToIndex(index, updated);
        producedByRow.set(p.row, updated);
        results.set(p.row, { ...base, status: 'updated', id: String(updated.Id), fully_qualified_name: updated.FullyQualifiedName, parent_id: parentIdOf(updated) ?? undefined, message: `${label}; changed: ${diffs.join('; ')}` });
      } catch (err) {
        results.set(p.row, { ...base, id: String(existing.account.Id), message: explainAccountError(err, { name: row.name, acctNum: row.acct_num, parentFqn }).text });
      }
      continue;
    }

    // Create.
    const errors = validateAccountPlacement(
      { name: row.name, acctNum: row.acct_num, accountType: row.account_type, accountSubType: row.account_sub_type },
      parent,
      index
    );
    if (errors.length > 0) {
      results.set(p.row, { ...base, message: `Rejected before calling QBO: ${errors.join(' ')}` });
      continue;
    }
    const payload = buildAccountPayload(row, parent);
    if (options.dryRun) {
      placeholderSeq++;
      const placeholder: QboAccount = {
        ...payload,
        Id: `pending-row-${p.row}-${placeholderSeq}`,
        Active: true,
        FullyQualifiedName: fullyQualifiedNameFor(row.name, parent),
      };
      producedByRow.set(p.row, placeholder);
      addToIndex(index, placeholder);
      claimedBy.set(String(placeholder.Id), p.row);
      results.set(p.row, { ...base, status: 'would_create', fully_qualified_name: placeholder.FullyQualifiedName, parent_id: parent ? String(parent.Id) : undefined, message: parent ? `would create under "${parentFqn}"` : 'would create at the top level' });
      continue;
    }
    try {
      const created = await writer.create(payload);
      addToIndex(index, created);
      producedByRow.set(p.row, created);
      claimedBy.set(String(created.Id), p.row);
      const twins = inactiveNumberTwins(row.acct_num, index).filter((t) => String(t.Id) !== String(created.Id));
      results.set(p.row, {
        ...base,
        status: 'created',
        id: String(created.Id),
        fully_qualified_name: created.FullyQualifiedName ?? fullyQualifiedNameFor(row.name, parent),
        parent_id: parentIdOf(created) ?? undefined,
        message: twins.length ? `note: inactive account${twins.length > 1 ? 's' : ''} ${twins.map((t) => `Id ${t.Id} "${t.Name}"`).join(', ')} also carr${twins.length > 1 ? 'y' : 'ies'} number ${row.acct_num}` : undefined,
      });
    } catch (err) {
      results.set(p.row, { ...base, message: explainAccountError(err, { name: row.name, acctNum: row.acct_num, parentFqn }).text });
    }
  }

  const ordered = rows.map((_, i) => results.get(i + 1)!).filter(Boolean);
  const counts: Record<BatchRowStatus, number> = {
    created: 0, updated: 0, unchanged: 0, skipped: 0, failed: 0, blocked: 0, would_create: 0, would_update: 0,
  };
  for (const r of ordered) counts[r.status]++;
  return { results: ordered, counts };
}

// ─── Output formatting ───────────────────────────────────────────────────────

function compareAccounts(a: QboAccount, b: QboAccount): number {
  const an = String(a.AcctNum ?? '');
  const bn = String(b.AcctNum ?? '');
  if (an && bn && an !== bn) return an.localeCompare(bn, undefined, { numeric: true });
  if (an && !bn) return -1;
  if (!an && bn) return 1;
  return String(a.Name ?? '').localeCompare(String(b.Name ?? ''));
}

export interface AccountRowView {
  id: string;
  acct_num: string | null;
  name: string;
  account_type: string | null;
  account_sub_type: string | null;
  classification: string | null;
  parent_id: string | null;
  parent_acct_num: string | null;
  fully_qualified_name: string;
  sub_account: boolean;
  active: boolean;
  depth: number;
}

/** The compact, diff-friendly projection get_accounts returns as JSON. */
export function projectAccount(a: QboAccount, index: AccountIndex): AccountRowView {
  const parentId = parentIdOf(a);
  const parent = parentId ? index.byId.get(parentId) : undefined;
  return {
    id: String(a.Id ?? ''),
    acct_num: a.AcctNum ?? null,
    name: String(a.Name ?? ''),
    account_type: a.AccountType ?? null,
    account_sub_type: a.AccountSubType ?? null,
    classification: a.Classification ?? null,
    parent_id: parentId,
    parent_acct_num: parent?.AcctNum ?? null,
    fully_qualified_name: displayName(a),
    sub_account: Boolean(parentId),
    active: isActive(a),
    depth: accountDepth(a, index),
  };
}

function table(headers: string[], rows: string[][]): string[] {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)));
  const line = (cells: string[]) => cells.map((c, i) => (i === cells.length - 1 ? c : (c ?? '').padEnd(widths[i]))).join('  ').trimEnd();
  return [line(headers), widths.map((w) => '─'.repeat(w)).join('  '), ...rows.map(line)];
}

/** Flat table: one row per account with everything needed to verify or diff a load. */
export function formatAccountTable(list: QboAccount[], index: AccountIndex): string[] {
  const rows = list.slice().sort(compareAccounts).map((a) => {
    const v = projectAccount(a, index);
    const parent = v.parent_id ? `${v.parent_id}${v.parent_acct_num ? ` [${v.parent_acct_num}]` : ''}` : '';
    return [v.id, v.acct_num ?? '', v.account_type ?? '', v.account_sub_type ?? '', parent, v.active ? 'yes' : 'no', v.fully_qualified_name];
  });
  return table(['Id', 'Number', 'Type', 'Detail type', 'Parent Id [num]', 'Active', 'Fully qualified name'], rows);
}

/** Indented tree, siblings sorted by number then name. Orphans (parent not in the list) are shown at the root, flagged. */
export function formatAccountTree(list: QboAccount[]): string[] {
  const lines: string[] = [];
  const listed = new Set(list.map((a) => String(a.Id)));
  const childrenOf = new Map<string | null, QboAccount[]>();
  for (const a of list) {
    const pid = parentIdOf(a);
    const key = pid && listed.has(pid) ? pid : null;
    const bucket = childrenOf.get(key) ?? [];
    bucket.push(a);
    childrenOf.set(key, bucket);
  }
  const render = (parentKey: string | null, depth: number) => {
    for (const a of (childrenOf.get(parentKey) ?? []).slice().sort(compareAccounts)) {
      const pid = parentIdOf(a);
      const orphan = depth === 0 && pid && !listed.has(pid) ? ` [parent Id ${pid} not in this list]` : '';
      const inactive = isActive(a) ? '' : ' [inactive]';
      const num = a.AcctNum ? `[${a.AcctNum}] ` : '';
      const detail = a.AccountSubType ? ` / ${a.AccountSubType}` : '';
      lines.push(`${'    '.repeat(depth)}${num}${a.Name ?? ''} — ${a.AccountType ?? ''}${detail} (Id ${a.Id})${inactive}${orphan}`);
      render(String(a.Id), depth + 1);
    }
  };
  render(null, 0);
  return lines;
}

/** Per-row results table plus a failures section, for the batch tool's text output. */
export function formatBatchOutcome(outcome: BatchOutcome, options: BatchOptions): string[] {
  const c = outcome.counts;
  const summary = options.dryRun
    ? `would create ${c.would_create} | would update ${c.would_update} | unchanged ${c.unchanged} | skipped ${c.skipped} | failed ${c.failed} | blocked ${c.blocked}`
    : `created ${c.created} | updated ${c.updated} | unchanged ${c.unchanged} | skipped ${c.skipped} | failed ${c.failed} | blocked ${c.blocked}`;
  const rows = outcome.results.map((r) => [
    String(r.row),
    r.acct_num ?? '',
    r.status.replace('_', ' '),
    r.id ?? '',
    r.fully_qualified_name ?? r.name,
    firstLine(r.message ?? ''),
  ]);
  const lines = [
    `Rows: ${outcome.results.length} | ${summary}`,
    '',
    ...table(['Row', 'Number', 'Status', 'Id', 'Account (fully qualified)', 'Note'], rows),
  ];
  const problems = outcome.results.filter((r) => r.status === 'failed' || r.status === 'blocked' || r.status === 'skipped');
  if (problems.length > 0) {
    lines.push('', 'Rows needing attention:');
    for (const r of problems) {
      lines.push(`  Row ${r.row} ${r.acct_num ? `[${r.acct_num}] ` : ''}"${r.name}" — ${r.status.toUpperCase()}: ${r.message ?? ''}`);
    }
  }
  return lines;
}

function firstLine(text: string): string {
  const line = text.split('\n')[0];
  return line.length > 90 ? `${line.slice(0, 87)}...` : line;
}
