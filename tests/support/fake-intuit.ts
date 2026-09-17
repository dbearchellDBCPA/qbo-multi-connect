// ─── Fake Intuit (QBO v3) API for end-to-end tests ───────────────────────────
//
// A fetch() stand-in that speaks enough of the QuickBooks Online v3 REST API
// for the chart-of-accounts, class and department tools: query, read, create,
// full update, sparse update. The point is not to reimplement QuickBooks but
// to enforce the same business rules QBO does, returning the same Fault
// bodies, so the MCP tools can be exercised end to end without credentials.
//
// Where a rule's fault text was captured from QBO's sandbox (2026-09-17) it is
// reproduced verbatim and marked [sandbox]. Rules whose exact wording could
// not be captured are marked [assumed]; the tools match those by rule, not by
// exact text.

export interface FakeFault {
  status: number;
  code: string;
  message: string;
  detail: string;
  element?: string;
}

class FaultError extends Error {
  constructor(public fault: FakeFault) {
    super(fault.detail);
  }
}

const MAX_LEVELS = 5;
const NO_SUBACCOUNT_SUBTYPES = new Set([
  'OpeningBalanceEquity', 'UndepositedFunds', 'RetainedEarnings',
  'CashReceiptIncome', 'CashExpenditureExpense', 'ExchangeGainOrLoss',
]);
const NON_PARENT_FIXED_ASSET_SUBTYPES = new Set(['AccumulatedDepreciation', 'AccumulatedAmortization', 'AccumulatedDepletion']);

const CLASSIFICATION: Record<string, string> = {
  'Bank': 'Asset', 'Other Current Asset': 'Asset', 'Fixed Asset': 'Asset', 'Other Asset': 'Asset', 'Accounts Receivable': 'Asset',
  'Equity': 'Equity',
  'Expense': 'Expense', 'Other Expense': 'Expense', 'Cost of Goods Sold': 'Expense',
  'Accounts Payable': 'Liability', 'Credit Card': 'Liability', 'Long Term Liability': 'Liability', 'Other Current Liability': 'Liability',
  'Income': 'Revenue', 'Other Income': 'Revenue',
};

type Kind = 'Account' | 'Class' | 'Department';
const KIND_BY_PATH: Record<string, Kind> = { account: 'Account', class: 'Class', department: 'Department' };
const SUB_FLAG: Record<Kind, string> = { Account: 'SubAccount', Class: 'SubClass', Department: 'SubDepartment' };

function businessValidation(detail: string): FaultError {
  // [sandbox] Message text for every code-6000 fault observed.
  return new FaultError({ status: 400, code: '6000', message: 'A business validation error has occurred while processing your request', detail: `Business Validation Error: ${detail}` });
}

export class FakeIntuit {
  readonly store: Record<Kind, Map<string, any>> = { Account: new Map(), Class: new Map(), Department: new Map() };
  readonly log: { method: string; path: string; body?: any }[] = [];
  private nextId = 1000;

  constructor(private readonly realmId: string, seedAccounts: any[] = []) {
    for (const a of seedAccounts) this.store.Account.set(String(a.Id), this.derive('Account', { SyncToken: '0', Active: true, ...a }));
  }

  /** Number of write requests (POSTs) seen so far — the test's proof of idempotency. */
  get writes(): number {
    return this.log.filter((l) => l.method === 'POST').length;
  }

  /** Drop-in for globalThis.fetch for URLs under the QBO API host. */
  fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const prefix = `/v3/company/${this.realmId}/`;
    if (!url.pathname.startsWith(prefix)) {
      return this.respond(401, { Fault: { Error: [{ Message: 'AuthenticationFailed', Detail: `Unknown realm in ${url.pathname}`, code: '3200' }], type: 'AUTHENTICATION' } });
    }
    const path = url.pathname.slice(prefix.length);
    this.log.push({ method, path: `${path}${url.search}`, body });
    try {
      if (path === 'query') return this.respond(200, this.query(url.searchParams.get('query') ?? ''));
      const m = path.match(/^(account|class|department)(?:\/([^/]+))?$/);
      if (!m) throw new FaultError({ status: 400, code: '500', message: 'Unsupported Operation', detail: `Operation ${method} ${path} is not supported.` });
      const kind = KIND_BY_PATH[m[1]];
      if (method === 'GET' && m[2]) return this.respond(200, { [kind]: this.mustGet(kind, m[2]), time: now() });
      if (method === 'POST' && !m[2]) {
        if (url.searchParams.get('operation') === 'delete') {
          // [sandbox] posting account?operation=delete
          throw new FaultError({ status: 400, code: '500', message: 'Unsupported Operation', detail: 'Operation Delete is not supported.' });
        }
        return this.respond(200, { [kind]: this.write(kind, body ?? {}), time: now() });
      }
      throw new FaultError({ status: 400, code: '500', message: 'Unsupported Operation', detail: `Operation ${method} ${path} is not supported.` });
    } catch (e) {
      if (e instanceof FaultError) {
        return this.respond(e.fault.status, { Fault: { Error: [{ Message: e.fault.message, Detail: e.fault.detail, code: e.fault.code, ...(e.fault.element ? { element: e.fault.element } : {}) }], type: 'ValidationFault' }, time: now() });
      }
      throw e;
    }
  };

  private respond(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }

  private mustGet(kind: Kind, id: string): any {
    const found = this.store[kind].get(String(id));
    if (!found) throw new FaultError({ status: 400, code: '610', message: 'Object Not Found', detail: `Object Not Found : Something you're trying to use has been made inactive. Check the fields with accounts, customers, items, vendors or employees.`, element: 'Id' });
    return found;
  }

  // ── Query ────────────────────────────────────────────────────────────────

  private query(q: string): any {
    const m = q.match(/^\s*SELECT\s+(.+?)\s+FROM\s+(\w+)(?:\s+WHERE\s+(.+?))?(?:\s+MAXRESULTS\s+(\d+))?(?:\s+STARTPOSITION\s+(\d+))?\s*$/i);
    if (!m) throw new FaultError({ status: 400, code: '4000', message: 'Error parsing query', detail: `Error parsing query ${q}` });
    const kind = m[2] as Kind;
    if (!this.store[kind]) throw new FaultError({ status: 400, code: '4001', message: 'Invalid query', detail: `Unknown entity ${kind}` });
    const conditions = m[3] ? m[3].split(/\s+AND\s+/i) : [];
    let activeFiltered = false;
    const predicates = conditions.map((c) => {
      const inMatch = c.match(/^(\w+)\s+IN\s*\((.+)\)$/i);
      if (inMatch) {
        const values = inMatch[2].split(',').map((v) => literal(v.trim()));
        if (inMatch[1].toLowerCase() === 'active') activeFiltered = true;
        return (row: any) => values.some((v) => same(row[inMatch[1]], v));
      }
      const like = c.match(/^(\w+)\s+LIKE\s+'(.*)'$/i);
      if (like) {
        const re = new RegExp(`^${like[2].replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*')}$`, 'i');
        return (row: any) => re.test(String(row[like[1]] ?? ''));
      }
      const eq = c.match(/^(\w+)\s*=\s*(.+)$/);
      if (!eq) throw new FaultError({ status: 400, code: '4000', message: 'Error parsing query', detail: `Unsupported condition ${c}` });
      if (eq[1].toLowerCase() === 'active') activeFiltered = true;
      const value = literal(eq[2].trim());
      return (row: any) => same(row[eq[1]], value);
    });
    // QBO returns active objects only unless Active is filtered explicitly.
    if (!activeFiltered) predicates.push((row: any) => row.Active !== false);
    const max = m[4] ? Number(m[4]) : 100;
    const start = m[5] ? Number(m[5]) : 1;
    const rows = [...this.store[kind].values()].filter((row) => predicates.every((p) => p(row))).slice(start - 1, start - 1 + max);
    const cols = m[1].trim();
    const projected = cols === '*' ? rows : rows.map((row) => Object.fromEntries([...cols.split(',').map((c) => c.trim()), 'sparse'].map((c) => [c, c === 'sparse' ? true : row[c]]).filter(([, v]) => v !== undefined)));
    const response: any = { startPosition: start, maxResults: projected.length };
    if (projected.length > 0) response[kind] = projected;
    return { QueryResponse: response, time: now() };
  }

  // ── Writes ───────────────────────────────────────────────────────────────

  private write(kind: Kind, body: any): any {
    const table = this.store[kind];
    let record: any;
    if (body.Id != null) {
      const existing = this.mustGet(kind, body.Id);
      if (String(body.SyncToken) !== String(existing.SyncToken)) {
        throw new FaultError({ status: 400, code: '5010', message: 'Stale Object Error', detail: `Stale Object Error : You and ${'another user'} were working on this at the same time. ${'Reload and try again.'}` });
      }
      record = body.sparse ? { ...existing, ...stripMeta(body) } : { ...stripMeta(body), MetaData: existing.MetaData };
      record.Id = String(existing.Id);
      record.SyncToken = String(Number(existing.SyncToken) + 1);
      if (record.Active === false && existing.Active !== false && !/\(deleted\)$/.test(record.Name ?? '')) {
        record.Name = `${record.Name} (deleted)`; // [sandbox] QBO renames deactivated objects
      }
      this.validate(kind, record, existing);
    } else {
      record = { ...stripMeta(body), Id: String(this.nextId++), SyncToken: '0', MetaData: { CreateTime: now(), LastUpdatedTime: now() } };
      if (record.Active === undefined) record.Active = true;
      this.validate(kind, record, null);
    }
    delete record.sparse;
    record = this.derive(kind, record);
    table.set(record.Id, record);
    // Derived fields of descendants follow a rename or move; deactivating a
    // parent deactivates its children (QBO UI behaviour; API cascade [assumed]).
    this.refreshDescendants(kind, record.Id, record.Active === false);
    return record;
  }

  private validate(kind: Kind, record: any, previous: any | null): void {
    const name = record.Name;
    if (typeof name !== 'string' || !name.trim() || /[:\t\r\n]/.test(name)) {
      // [sandbox] code 2180 on a colon in the name.
      throw new FaultError({ status: 400, code: '2180', message: 'Invalid Enumeration', detail: 'Names must have at least one character, must be on one line, and cannot include colons or tabbing.', element: 'Name' });
    }
    if (kind === 'Account' && !record.AccountType && !record.AccountSubType) {
      throw new FaultError({ status: 400, code: '2020', message: 'Required param missing, need to supply the required value for the API', detail: 'Required parameter AccountType is missing in the request', element: 'AccountType' });
    }
    const table = this.store[kind];
    const parentId = record.ParentRef?.value == null ? null : String(record.ParentRef.value);
    const parent = parentId ? table.get(parentId) : null;
    if (parentId && !parent) {
      throw new FaultError({ status: 400, code: '2500', message: 'Invalid Reference Id', detail: `Invalid Reference Id : ${kind}s element id ${parentId} not found`, element: 'ParentRef' });
    }
    if (parent) {
      if (parentId === record.Id) throw businessValidation(`A ${kind.toLowerCase()} cannot be its own parent.`); // [assumed]
      if (record.Id && this.isDescendant(kind, parentId!, record.Id)) throw businessValidation(`You can't make a ${kind.toLowerCase()} a sub-${kind.toLowerCase()} of one of its own sub-${kind.toLowerCase()}s.`); // [assumed]
      if (parent.Active === false) throw businessValidation(`You can't add a sub-${kind.toLowerCase()} to an inactive ${kind.toLowerCase()}.`); // [assumed]
      const depth = String(parent.FullyQualifiedName ?? parent.Name).split(':').length + 1;
      if (depth > MAX_LEVELS) throw businessValidation(`Sub-${kind.toLowerCase()}s can't be nested more than ${MAX_LEVELS} levels deep.`); // [assumed]; [docs] limit
    }
    if (kind === 'Account') {
      if (parent) {
        if (parent.AccountType !== record.AccountType) {
          // QBO UI wording; API detail text [assumed] to match.
          throw businessValidation('For subaccounts, you must select the same account type as their parent.');
        }
        if (NO_SUBACCOUNT_SUBTYPES.has(parent.AccountSubType) || NO_SUBACCOUNT_SUBTYPES.has(record.AccountSubType)) {
          throw businessValidation('This type of account cannot have sub-accounts or be a sub-account.'); // [assumed]; [docs] rule
        }
        if (parent.AccountType === 'Fixed Asset' && NON_PARENT_FIXED_ASSET_SUBTYPES.has(parent.AccountSubType)) {
          throw businessValidation('Fixed asset accounts (Accumulated Amortization, Depletion, or Depreciation) cannot be parent accounts.'); // [sandbox]
        }
      } else if (record.AccountType === 'Fixed Asset' && NON_PARENT_FIXED_ASSET_SUBTYPES.has(record.AccountSubType)) {
        // [sandbox] rejected even with no parent and no children.
        throw businessValidation('Fixed asset accounts (Accumulated Amortization, Depletion, or Depreciation) cannot be parent accounts.');
      }
      if (previous && previous.AccountType !== record.AccountType && this.childrenOf(kind, record.Id).length > 0) {
        throw businessValidation('Cannot change the type of an account with subaccounts.'); // QBO UI wording
      }
    }
    // Duplicate name under the same parent (active objects only).
    const fqn = parent ? `${parent.FullyQualifiedName ?? parent.Name}:${name}` : name;
    for (const other of table.values()) {
      if (other.Id === record.Id || other.Active === false) continue;
      if (String(other.FullyQualifiedName ?? other.Name).toLowerCase() === fqn.toLowerCase()) {
        if (kind === 'Account') {
          // [sandbox] code 6240 text.
          throw new FaultError({ status: 400, code: '6240', message: 'Duplicate Name Exists Error', detail: 'The name supplied already exists. : An account already has the same display name. Display Name must be unique. Please provide a different display name.', element: 'Name' });
        }
        throw new FaultError({ status: 400, code: '6240', message: 'Duplicate Name Exists Error', detail: `The name supplied already exists. : Another ${kind.toLowerCase()} is already using this name. Please use a different name.`, element: 'Name' });
      }
      if (kind === 'Account' && record.AcctNum && other.AcctNum && String(other.AcctNum).toLowerCase() === String(record.AcctNum).toLowerCase()) {
        // [sandbox] duplicate number text (two spaces before "Please" as QBO sends it).
        throw businessValidation('Another account is already using this number.  Please use a different number.');
      }
    }
  }

  private derive(kind: Kind, record: any): any {
    const table = this.store[kind];
    const parentId = record.ParentRef?.value == null ? null : String(record.ParentRef.value);
    const parent = parentId ? table.get(parentId) : null;
    const out = { ...record };
    out[SUB_FLAG[kind]] = Boolean(parent);
    if (parent) out.ParentRef = { value: parentId };
    else delete out.ParentRef;
    out.FullyQualifiedName = parent ? `${parent.FullyQualifiedName ?? parent.Name}:${out.Name}` : out.Name;
    if (kind === 'Account') {
      out.Classification = CLASSIFICATION[out.AccountType] ?? out.Classification;
      out.CurrentBalance = out.CurrentBalance ?? 0;
      out.CurrentBalanceWithSubAccounts = out.CurrentBalanceWithSubAccounts ?? 0;
      out.CurrencyRef = out.CurrencyRef ?? { value: 'USD', name: 'United States Dollar' };
    }
    out.domain = 'QBO';
    out.sparse = false;
    out.MetaData = { ...(out.MetaData ?? { CreateTime: now() }), LastUpdatedTime: now() };
    return out;
  }

  private childrenOf(kind: Kind, id: string): any[] {
    return [...this.store[kind].values()].filter((r) => r.ParentRef?.value != null && String(r.ParentRef.value) === String(id));
  }

  private isDescendant(kind: Kind, candidateId: string, ancestorId: string): boolean {
    let current = this.store[kind].get(candidateId);
    const seen = new Set<string>();
    while (current?.ParentRef?.value != null) {
      const pid = String(current.ParentRef.value);
      if (pid === ancestorId) return true;
      if (seen.has(pid)) return false;
      seen.add(pid);
      current = this.store[kind].get(pid);
    }
    return false;
  }

  private refreshDescendants(kind: Kind, id: string, deactivate: boolean): void {
    for (const child of this.childrenOf(kind, id)) {
      const next = { ...child };
      if (deactivate && next.Active !== false) {
        next.Active = false;
        next.Name = `${next.Name} (deleted)`;
      }
      const derived = this.derive(kind, next);
      this.store[kind].set(derived.Id, derived);
      this.refreshDescendants(kind, derived.Id, deactivate);
    }
  }
}

function stripMeta(body: any): any {
  const { MetaData: _m, domain: _d, ...rest } = body;
  return rest;
}

function literal(token: string): unknown {
  if (/^'.*'$/.test(token)) return token.slice(1, -1);
  if (token === 'true') return true;
  if (token === 'false') return false;
  return token;
}

function same(a: unknown, b: unknown): boolean {
  if (typeof b === 'boolean') return (a !== false) === b;
  return String(a ?? '').toLowerCase() === String(b ?? '').toLowerCase();
}

function now(): string {
  return new Date().toISOString();
}

/** Accounts QBO seeds into a fresh US company (the ones that cannot be deleted), plus the sandbox's twin-named pair. */
export function defaultSeedAccounts(): any[] {
  return [
    { Id: '1', Name: 'Opening Balance Equity', AccountType: 'Equity', AccountSubType: 'OpeningBalanceEquity' },
    { Id: '2', Name: 'Retained Earnings', AccountType: 'Equity', AccountSubType: 'RetainedEarnings' },
    { Id: '3', Name: 'Undeposited Funds', AccountType: 'Other Current Asset', AccountSubType: 'UndepositedFunds' },
    { Id: '4', Name: 'Accounts Payable (A/P)', AccountType: 'Accounts Payable', AccountSubType: 'AccountsPayable' },
    { Id: '5', Name: 'Accounts Receivable (A/R)', AccountType: 'Accounts Receivable', AccountSubType: 'AccountsReceivable' },
    { Id: '6', Name: 'Uncategorized Asset', AccountType: 'Other Current Asset', AccountSubType: 'OtherCurrentAssets' },
    { Id: '58', Name: 'Job Expenses', AccountType: 'Expense', AccountSubType: 'OtherMiscellaneousServiceCost' },
    { Id: '63', Name: 'Job Materials', AccountType: 'Expense', AccountSubType: 'SuppliesMaterials', ParentRef: { value: '58' } },
    { Id: '45', Name: 'Landscaping Services', AccountType: 'Income', AccountSubType: 'OtherPrimaryIncome' },
    { Id: '46', Name: 'Job Materials', AccountType: 'Income', AccountSubType: 'OtherPrimaryIncome', ParentRef: { value: '45' } },
  ];
}
