// ─── Fake QBO ledger for the bulk-import tools ───────────────────────────────
//
// A fetch() stand-in for the QBO v3 endpoints the import tools use: query,
// preferences and batch (create / update / delete of names, items and every
// importable transaction type). Like tests/support/fake-intuit.ts, the point
// is to enforce the rules QBO enforces and answer with QBO-shaped faults so
// the tools run end to end without credentials:
//
//   • DisplayName unique across Vendor + Customer + Employee (6240)
//   • every Ref must exist (2500), SyncToken must match (5010)
//   • journal entries balance; A/R lines need a Customer, A/P lines a Vendor;
//     at most one A/R or A/P account per transaction (6000)
//   • sales DocNumber unique per type (6140, "Duplicate Document Number")
//   • payments apply to open balances; a Bill/Invoice with a payment
//     applied cannot be deleted until the payment is (6000)
//   • ≤30 operations per batch request
//   • throttling on demand: HTTP 429 ThrottleExceeded (before or AFTER the
//     batch commits) and item-level 3001 faults; a repeated requestid
//     replays the stored response instead of writing again.
//
// Fault texts marked [docs] follow Intuit's documentation or forum-quoted
// responses; [assumed] wording is ours (the tools match by code / rule).

const TXN_ENTITIES = ['JournalEntry', 'Purchase', 'Deposit', 'Transfer', 'Bill', 'VendorCredit', 'BillPayment', 'Invoice', 'CreditMemo', 'SalesReceipt', 'RefundReceipt', 'Payment'] as const;
const LIST_ENTITIES = ['Account', 'Vendor', 'Customer', 'Employee', 'Class', 'Item', 'Term'] as const;
const NAME_ENTITIES = new Set(['Vendor', 'Customer', 'Employee']);
const SALES_DOC_UNIQUE = new Set(['Invoice', 'CreditMemo', 'SalesReceipt', 'RefundReceipt']);

interface Fault { code: string; message: string; detail: string; element?: string }
class FaultError extends Error {
  constructor(public fault: Fault) { super(fault.detail); }
}
const validation = (detail: string, code = '6000', message = 'A business validation error has occurred while processing your request') =>
  new FaultError({ code, message, detail: code === '6000' ? `Business Validation Error: ${detail}` : detail });
const badRef = (what: string, id: unknown) =>
  new FaultError({ code: '2500', message: 'Invalid Reference Id', detail: `Invalid Reference Id : ${what} element id ${id} not found` });

export interface FakeLedgerOptions {
  closeDate?: string | null;
  classTrackingPerLine?: boolean;
  classTrackingPerTxn?: boolean;
  useAccountNumbers?: boolean;
  /** Clock used to timestamp batch requests (tests pass the runner's virtual clock). */
  clock?: () => number;
}

export interface BatchCall {
  requestId: string | null;
  items: number;
  status: number;
  at: number;
  replayed: boolean;
  committed: boolean;
}

export class FakeQboLedger {
  readonly store: Record<string, Map<string, any>> = {};
  readonly log: { method: string; path: string; body?: any }[] = [];
  readonly batchCalls: BatchCall[] = [];
  private readonly replay = new Map<string, any>();
  private nextId = 5000;
  prefs: Required<Omit<FakeLedgerOptions, 'clock'>>;
  private clock: () => number;

  /** Next N batch POSTs: HTTP 429 ThrottleExceeded without processing. */
  throttleBefore = 0;
  /** Next N batch POSTs: processed and committed, then answered 429 (the response is kept for requestid replay). */
  throttleAfterCommit = 0;
  /** Next N batch items: item-level fault 3001 (not processed). */
  itemThrottle = 0;
  /** Item operations actually applied (create/update/delete), by entity — the test's write counter. */
  readonly applied: { operation: string; entity: string; id: string }[] = [];

  constructor(readonly realmId: string, opts: FakeLedgerOptions = {}) {
    for (const e of [...TXN_ENTITIES, ...LIST_ENTITIES]) this.store[e] = new Map();
    this.prefs = {
      closeDate: opts.closeDate ?? null,
      classTrackingPerLine: opts.classTrackingPerLine ?? true,
      classTrackingPerTxn: opts.classTrackingPerTxn ?? false,
      useAccountNumbers: opts.useAccountNumbers ?? true,
    };
    this.clock = opts.clock ?? Date.now;
  }

  seed(entity: string, rows: any[]): this {
    for (const r of rows) {
      const rec = { SyncToken: '0', ...(LIST_ENTITIES as readonly string[]).includes(entity) ? { Active: true } : {}, ...r, Id: String(r.Id) };
      if (entity === 'Account') rec.FullyQualifiedName = this.fqn(rec);
      this.store[entity].set(rec.Id, rec);
      const n = Number(rec.Id);
      if (Number.isFinite(n) && n >= this.nextId) this.nextId = n + 1;
    }
    return this;
  }

  get writes(): number {
    return this.applied.length;
  }

  all(entity: string): any[] {
    return [...this.store[entity].values()];
  }

  /** Every transaction (any entity) whose PrivateNote carries the stamp. */
  stamped(sourceId: string): Array<{ entity: string; rec: any }> {
    const out: Array<{ entity: string; rec: any }> = [];
    for (const e of TXN_ENTITIES) for (const rec of this.store[e].values()) if (String(rec.PrivateNote ?? '').includes(`[src:${sourceId}]`)) out.push({ entity: e, rec });
    return out;
  }

  fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const prefix = `/v3/company/${this.realmId}/`;
    if (!url.pathname.startsWith(prefix)) return this.respond(401, { Fault: { Error: [{ Message: 'AuthenticationFailed', Detail: 'Unknown realm', code: '3200' }], type: 'AUTHENTICATION' } });
    const path = url.pathname.slice(prefix.length);
    this.log.push({ method, path: `${path}${url.search}`, body });
    try {
      if (method === 'GET' && path === 'query') return this.respond(200, this.query(url.searchParams.get('query') ?? ''));
      if (method === 'GET' && path === 'preferences') return this.respond(200, { Preferences: this.preferences(), time: now() });
      if (method === 'POST' && path === 'batch') return this.batch(body, url.searchParams.get('requestid'));
      throw new FaultError({ code: '500', message: 'Unsupported Operation', detail: `Operation ${method} ${path} is not supported by the fake.` });
    } catch (e) {
      if (e instanceof FaultError) return this.respond(400, { Fault: { Error: [faultJson(e.fault)], type: 'ValidationFault' }, time: now() });
      throw e;
    }
  };

  private respond(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }

  private preferences(): any {
    return {
      AccountingInfoPrefs: {
        UseAccountNumbers: this.prefs.useAccountNumbers,
        ClassTrackingPerTxn: this.prefs.classTrackingPerTxn,
        ClassTrackingPerTxnLine: this.prefs.classTrackingPerLine,
        TrackDepartments: false,
        ...(this.prefs.closeDate ? { BookCloseDate: this.prefs.closeDate } : {}),
      },
    };
  }

  // ── query ────────────────────────────────────────────────────────────────

  private query(q: string): any {
    const m = q.match(/^\s*SELECT\s+\*\s+FROM\s+(\w+)(?:\s+WHERE\s+(.+?))?(?:\s+ORDERBY\s+\w+(?:\s+(?:ASC|DESC))?)?(?:\s+MAXRESULTS\s+(\d+))?(?:\s+STARTPOSITION\s+(\d+))?\s*$/i);
    if (!m) throw new FaultError({ code: '4000', message: 'Error parsing query', detail: `QueryParserError: ${q}` });
    const entity = m[1];
    if (!this.store[entity]) throw new FaultError({ code: '4001', message: 'Invalid query', detail: `QueryValidationError: Unknown entity ${entity}` });
    const isList = (LIST_ENTITIES as readonly string[]).includes(entity);
    let activeFiltered = false;
    const preds = (m[2] ? m[2].split(/\s+AND\s+/i) : []).map((c) => {
      const inM = c.match(/^(\w+)\s+IN\s*\((.+)\)$/i);
      if (inM) {
        if (inM[1] === 'Active') activeFiltered = true;
        const vals = inM[2].split(',').map((v) => lit(v.trim()));
        return (r: any) => vals.some((v) => eq(r[inM[1]], v));
      }
      const cmp = c.match(/^(\w+)\s*(>=|<=|=|>|<)\s*(.+)$/);
      if (!cmp) throw new FaultError({ code: '4000', message: 'Error parsing query', detail: `Unsupported condition ${c}` });
      if (cmp[1] === 'Active') activeFiltered = true;
      const v = lit(cmp[3].trim());
      return (r: any) => {
        const a = String(r[cmp[1]] ?? '');
        const b = String(v);
        switch (cmp[2]) {
          case '>=': return a >= b;
          case '<=': return a <= b;
          case '>': return a > b;
          case '<': return a < b;
          default: return eq(r[cmp[1]], v);
        }
      };
    });
    if (isList && !activeFiltered) preds.push((r: any) => r.Active !== false);
    const max = Math.min(Number(m[3] ?? 100), 1000);
    const start = Number(m[4] ?? 1);
    const rows = [...this.store[entity].values()].filter((r) => preds.every((p) => p(r))).slice(start - 1, start - 1 + max);
    const resp: any = { startPosition: start, maxResults: rows.length };
    if (rows.length) resp[entity] = rows.map((r) => structuredClone(r));
    return { QueryResponse: resp, time: now() };
  }

  // ── batch ────────────────────────────────────────────────────────────────

  private batch(body: any, requestId: string | null): Response {
    const items: any[] = body?.BatchItemRequest ?? [];
    const at = this.clock();
    if (requestId && this.replay.has(requestId)) {
      this.batchCalls.push({ requestId, items: items.length, status: 200, at, replayed: true, committed: false });
      return this.respond(200, this.replay.get(requestId));
    }
    if (this.throttleBefore > 0) {
      this.throttleBefore--;
      this.batchCalls.push({ requestId, items: items.length, status: 429, at, replayed: false, committed: false });
      return this.respond(429, throttleBody());
    }
    if (items.length > 30) {
      this.batchCalls.push({ requestId, items: items.length, status: 400, at, replayed: false, committed: false });
      return this.respond(400, { Fault: { Error: [{ Message: 'Request has invalid or unsupported property', Detail: `Batch request has ${items.length} items; the maximum is 30. [assumed]`, code: '2010' }], type: 'ValidationFault' } });
    }
    const responses = items.map((item) => this.batchItem(item));
    const out = { BatchItemResponse: responses, time: now() };
    if (requestId) this.replay.set(requestId, out);
    if (this.throttleAfterCommit > 0) {
      this.throttleAfterCommit--;
      this.batchCalls.push({ requestId, items: items.length, status: 429, at, replayed: false, committed: true });
      return this.respond(429, throttleBody());
    }
    this.batchCalls.push({ requestId, items: items.length, status: 200, at, replayed: false, committed: true });
    return this.respond(200, out);
  }

  private batchItem(item: any): any {
    const bId = item?.bId;
    const entity = Object.keys(item ?? {}).find((k) => !['bId', 'operation', 'optionsData'].includes(k))!;
    if (this.itemThrottle > 0) {
      this.itemThrottle--;
      return { bId, Fault: { Error: [{ Message: 'message=ThrottleExceeded; errorCode=003001; statusCode=429', Detail: 'The request limit was reached. [docs]', code: '3001' }], type: 'SERVICE' } };
    }
    try {
      if (!this.store[entity]) throw new FaultError({ code: '500', message: 'Unsupported Operation', detail: `Entity ${entity} not supported by the fake` });
      const payload = structuredClone(item[entity]);
      const op = String(item.operation);
      const rec = op === 'delete' ? this.remove(entity, payload) : this.write(entity, payload, op === 'update');
      this.applied.push({ operation: op, entity, id: String(rec.Id) });
      return { bId, [entity]: structuredClone(rec) };
    } catch (e) {
      if (e instanceof FaultError) return { bId, Fault: { Error: [faultJson(e.fault)], type: 'ValidationFault' } };
      throw e;
    }
  }

  private mustGet(entity: string, id: unknown): any {
    const r = this.store[entity].get(String(id));
    if (!r) throw new FaultError({ code: '610', message: 'Object Not Found', detail: `Object Not Found : Something you're trying to use has been made inactive. Check the fields with accounts, customers, items, vendors or employees.`, element: 'Id' });
    return r;
  }

  private write(entity: string, payload: any, isUpdate: boolean): any {
    let rec: any;
    let previous: any = null;
    if (isUpdate) {
      previous = this.mustGet(entity, payload.Id);
      if (String(payload.SyncToken) !== String(previous.SyncToken)) {
        throw new FaultError({ code: '5010', message: 'Stale Object Error', detail: 'Stale Object Error : You and another user were working on this at the same time. Reload and try again.' });
      }
      rec = payload.sparse ? { ...previous, ...payload } : { ...payload, MetaData: previous.MetaData };
      rec.Id = String(previous.Id);
      rec.SyncToken = String(Number(previous.SyncToken) + 1);
    } else {
      if (payload.Id != null) throw new FaultError({ code: '2010', message: 'Request has invalid or unsupported property', detail: 'Id is not allowed on create [assumed]' });
      rec = { ...payload, Id: String(this.nextId++), SyncToken: '0', MetaData: { CreateTime: now() } };
    }
    delete rec.sparse;
    rec.MetaData = { ...(rec.MetaData ?? {}), LastUpdatedTime: now() };
    if (NAME_ENTITIES.has(entity)) this.validateName(entity, rec);
    else if (entity === 'Item') this.validateItem(rec);
    else if ((TXN_ENTITIES as readonly string[]).includes(entity)) this.validateTxn(entity, rec, previous);
    if (rec.Active === undefined && (LIST_ENTITIES as readonly string[]).includes(entity)) rec.Active = true;
    this.store[entity].set(rec.Id, rec);
    return rec;
  }

  private remove(entity: string, payload: any): any {
    const rec = this.mustGet(entity, payload.Id);
    if (String(payload.SyncToken) !== String(rec.SyncToken)) {
      throw new FaultError({ code: '5010', message: 'Stale Object Error', detail: 'Stale Object Error : You and another user were working on this at the same time. Reload and try again.' });
    }
    if (entity === 'Bill' || entity === 'Invoice') {
      const payer = entity === 'Bill' ? 'BillPayment' : 'Payment';
      const linked = [...this.store[payer].values()].some((p) => (p.Line ?? []).some((l: any) => (l.LinkedTxn ?? []).some((lt: any) => String(lt.TxnId) === rec.Id)));
      // [assumed] wording; the rule (delete the payment first) is QBO's.
      if (linked) throw validation(`This ${entity === 'Bill' ? 'bill' : 'invoice'} has a ${entity === 'Bill' ? 'bill payment' : 'payment'} applied to it. Delete the payment first.`);
    }
    if (entity === 'Payment' || entity === 'BillPayment') this.applyLinks(entity, rec, -1);
    this.store[entity].delete(rec.Id);
    return { Id: rec.Id, status: 'Deleted', domain: 'QBO' };
  }

  // ── validation ───────────────────────────────────────────────────────────

  private validateName(entity: string, rec: any): void {
    const dn = String(rec.DisplayName ?? '').trim();
    if (!dn) throw new FaultError({ code: '2020', message: 'Required param missing, need to supply the required value for the API', detail: 'Required parameter DisplayName is missing in the request', element: 'DisplayName' });
    if (/[:\t\n]/.test(dn)) throw new FaultError({ code: '2180', message: 'Invalid Enumeration', detail: 'Names cannot include colons, tabs or new lines.', element: 'DisplayName' });
    for (const e of NAME_ENTITIES) {
      for (const other of this.store[e].values()) {
        if (e === entity && other.Id === rec.Id) continue;
        if (String(other.DisplayName).toLowerCase() === dn.toLowerCase()) {
          // [docs] code 6240; detail text as QBO returns it for name lists.
          throw new FaultError({ code: '6240', message: 'Duplicate Name Exists Error', detail: `The name supplied already exists. : Another customer, vendor or employee is already using this name. Please use a different name.`, element: 'DisplayName' });
        }
      }
    }
    if (entity === 'Employee' && !rec.GivenName && !rec.FamilyName) {
      throw new FaultError({ code: '2020', message: 'Required param missing, need to supply the required value for the API', detail: 'Required parameter GivenName or FamilyName is missing in the request [assumed]' });
    }
    if (rec.SalesTermRef?.value != null && !this.store.Term.has(String(rec.SalesTermRef.value))) throw badRef('SalesTermRef', rec.SalesTermRef.value);
    if (rec.TermRef?.value != null && !this.store.Term.has(String(rec.TermRef.value))) throw badRef('TermRef', rec.TermRef.value);
  }

  private validateItem(rec: any): void {
    if (!rec.Name) throw new FaultError({ code: '2020', message: 'Required param missing', detail: 'Required parameter Name is missing in the request' });
    for (const other of this.store.Item.values()) {
      if (other.Id !== rec.Id && String(other.Name).toLowerCase() === String(rec.Name).toLowerCase()) {
        throw new FaultError({ code: '6240', message: 'Duplicate Name Exists Error', detail: 'The name supplied already exists. : Another product or service is already using this name. Please use a different name.', element: 'Name' });
      }
    }
    if (rec.Type === 'Service' || rec.Type === 'NonInventory') {
      const acct = rec.IncomeAccountRef?.value;
      if (acct == null) throw new FaultError({ code: '2020', message: 'Required param missing', detail: 'Required parameter IncomeAccountRef is missing in the request' });
      const a = this.account(acct, 'IncomeAccountRef');
      if (a.AccountType === 'Accounts Receivable' || a.AccountType === 'Accounts Payable') {
        throw validation('Accounts Receivable and Accounts Payable accounts can’t be used for products and services. [docs: 6430]', '6430', 'Invalid account type');
      }
    }
  }

  private account(id: unknown, element: string): any {
    const a = this.store.Account.get(String(id));
    if (!a) throw badRef(element, id);
    return a;
  }

  private name(type: string, id: unknown, element: string): any {
    const n = this.store[type]?.get(String(id));
    if (!n) throw badRef(element, id);
    return n;
  }

  private validateTxn(entity: string, rec: any, previous: any | null): void {
    if (!rec.TxnDate || !/^\d{4}-\d{2}-\d{2}$/.test(rec.TxnDate)) rec.TxnDate = rec.TxnDate ?? new Date().toISOString().slice(0, 10);
    if (this.prefs.closeDate && rec.TxnDate <= this.prefs.closeDate) {
      // [docs] code 6210
      throw new FaultError({ code: '6210', message: 'Account Period Closed', detail: `The account period has closed and the books cannot be updated through Data Services. Please change the transaction date to after the closing date (${this.prefs.closeDate}).` });
    }
    if (String(rec.PrivateNote ?? '').length > 4000) throw new FaultError({ code: '2050', message: 'String length is either shorter or longer than supported by specification', detail: 'PrivateNote: Max length 4000', element: 'PrivateNote' });
    if (rec.DocNumber && String(rec.DocNumber).length > 21) {
      throw new FaultError({ code: '6000', message: 'A business validation error has occurred while processing your request', detail: 'Business Validation Error: The Document Number field can contain at most 21 characters. [docs]', element: 'DocNumber' });
    }
    const lines: any[] = rec.Line ?? [];
    const touchedArAp = new Map<string, string>();
    const touch = (acctId: unknown, entityType: string | undefined, element: string) => {
      const a = this.account(acctId, element);
      if (a.AccountType === 'Accounts Receivable' || a.AccountType === 'Accounts Payable') {
        touchedArAp.set(String(a.Id), a.AccountType);
        if (entity === 'JournalEntry' || entity === 'Deposit') {
          if (a.AccountType === 'Accounts Receivable' && entityType !== 'Customer') throw validation('When you use Accounts Receivable, you must choose a customer in the Name field. [docs]');
          if (a.AccountType === 'Accounts Payable' && entityType !== 'Vendor') throw validation('When you use Accounts Payable, you must choose a vendor in the Name field. [docs]');
        }
      }
      return a;
    };
    let nextLineId = 1;
    for (const l of lines) {
      if (l.Id == null) l.Id = String(nextLineId);
      nextLineId = Math.max(nextLineId, Number(l.Id) || 0) + 1;
      if (l.Amount != null && Number(l.Amount) < 0) throw validation('Amounts must be positive. [assumed]');
      const d = l.JournalEntryLineDetail ?? l.AccountBasedExpenseLineDetail ?? l.DepositLineDetail ?? l.SalesItemLineDetail;
      if (l.JournalEntryLineDetail) {
        const ent = d.Entity;
        if (ent) this.name(ent.Type, ent.EntityRef?.value, 'Entity');
        touch(d.AccountRef?.value, ent?.Type, 'AccountRef');
      }
      if (l.AccountBasedExpenseLineDetail) {
        touch(d.AccountRef?.value, undefined, 'AccountRef');
        if (d.CustomerRef) this.name('Customer', d.CustomerRef.value, 'CustomerRef');
      }
      if (l.DepositLineDetail) {
        // QBO wants the flat ref with an UPPERCASE type on deposit lines.
        const t = d.Entity ? normType(d.Entity.type ?? d.Entity.Type ?? 'Customer') : undefined;
        if (d.AccountRef) touch(d.AccountRef.value, t, 'AccountRef');
        if (d.Entity) this.name(t!, d.Entity.value ?? d.Entity.EntityRef?.value, 'Entity');
      }
      if (l.SalesItemLineDetail) {
        const item = this.store.Item.get(String(d.ItemRef?.value));
        if (!item) throw badRef('ItemRef', d.ItemRef?.value);
      }
      if (d?.ClassRef && !this.store.Class.has(String(d.ClassRef.value))) throw badRef('ClassRef', d.ClassRef.value);
    }
    if (rec.ClassRef && !this.store.Class.has(String(rec.ClassRef.value))) throw badRef('ClassRef', rec.ClassRef.value);
    if (rec.SalesTermRef && !this.store.Term.has(String(rec.SalesTermRef.value))) throw badRef('SalesTermRef', rec.SalesTermRef.value);

    switch (entity) {
      case 'JournalEntry': {
        let dr = 0;
        let cr = 0;
        for (const l of lines) {
          const c = Math.round(Number(l.Amount) * 100);
          if (l.JournalEntryLineDetail?.PostingType === 'Debit') dr += c;
          else if (l.JournalEntryLineDetail?.PostingType === 'Credit') cr += c;
        }
        if (dr !== cr) throw validation('Journal Entry must be balanced: total debits must equal total credits. [assumed]');
        break;
      }
      case 'Purchase': {
        const a = this.account(rec.AccountRef?.value, 'AccountRef');
        if (rec.PaymentType === 'CreditCard' && a.AccountType !== 'Credit Card') throw validation('A credit card expense must be paid from a Credit Card account. [assumed]');
        if (rec.PaymentType !== 'CreditCard' && a.AccountType !== 'Bank' && a.AccountType !== 'Other Current Asset') throw validation('The payment account must be a bank account. [assumed]');
        if (rec.EntityRef) this.name(rec.EntityRef.type ?? 'Vendor', rec.EntityRef.value, 'EntityRef');
        break;
      }
      case 'Deposit':
        this.account(rec.DepositToAccountRef?.value, 'DepositToAccountRef');
        break;
      case 'Transfer':
        this.account(rec.FromAccountRef?.value, 'FromAccountRef');
        this.account(rec.ToAccountRef?.value, 'ToAccountRef');
        if (!(Number(rec.Amount) > 0)) throw validation('Transfer amount must be greater than zero. [assumed]');
        break;
      case 'Bill': case 'VendorCredit':
        this.name('Vendor', rec.VendorRef?.value, 'VendorRef');
        if (rec.APAccountRef) touch(rec.APAccountRef.value, 'Vendor', 'APAccountRef');
        break;
      case 'Invoice': case 'CreditMemo': case 'SalesReceipt': case 'RefundReceipt':
        if (rec.CustomerRef) this.name('Customer', rec.CustomerRef.value, 'CustomerRef');
        else if (entity === 'Invoice' || entity === 'CreditMemo') throw new FaultError({ code: '2020', message: 'Required param missing, need to supply the required value for the API', detail: 'Required parameter CustomerRef is missing in the request' });
        if (rec.DepositToAccountRef) this.account(rec.DepositToAccountRef.value, 'DepositToAccountRef');
        if (rec.ARAccountRef) touch(rec.ARAccountRef.value, 'Customer', 'ARAccountRef');
        break;
      case 'Payment': case 'BillPayment': {
        if (entity === 'BillPayment') {
          this.name('Vendor', rec.VendorRef?.value, 'VendorRef');
          const acct = rec.CheckPayment?.BankAccountRef?.value ?? rec.CreditCardPayment?.CCAccountRef?.value;
          this.account(acct, rec.PayType === 'CreditCard' ? 'CCAccountRef' : 'BankAccountRef');
        } else {
          this.name('Customer', rec.CustomerRef?.value, 'CustomerRef');
          if (rec.DepositToAccountRef) this.account(rec.DepositToAccountRef.value, 'DepositToAccountRef');
        }
        if (previous) this.applyLinks(entity, previous, -1);
        try {
          this.applyLinks(entity, rec, +1);
        } catch (e) {
          if (previous) this.applyLinks(entity, previous, +1);
          throw e;
        }
        break;
      }
    }
    if (new Set(touchedArAp.keys()).size > 1) {
      throw validation('You can only use one A/R or A/P account per transaction. [assumed]');
    }

    // Derived fields
    if (entity === 'JournalEntry') {
      rec.TotalAmt = lines.filter((l) => l.JournalEntryLineDetail?.PostingType === 'Debit').reduce((s, l) => s + Number(l.Amount), 0);
    } else if (entity !== 'Transfer' && entity !== 'Payment' && entity !== 'BillPayment') {
      rec.TotalAmt = Math.round(lines.filter((l) => l.DetailType !== 'SubTotalLineDetail').reduce((s, l) => s + Number(l.Amount ?? 0), 0) * 100) / 100;
    }
    if (entity === 'Bill' || entity === 'Invoice') {
      const paid = previous ? Number(previous.TotalAmt ?? 0) - Number(previous.Balance ?? 0) : 0;
      rec.Balance = Math.round((Number(rec.TotalAmt) - paid) * 100) / 100;
    }
    if (SALES_DOC_UNIQUE.has(entity) && rec.DocNumber) {
      for (const other of this.store[entity].values()) {
        if (other.Id !== rec.Id && String(other.DocNumber ?? '') === String(rec.DocNumber)) {
          // [docs] 6140 wording as QBO returns it.
          throw new FaultError({ code: '6140', message: 'Duplicate Document Number Error', detail: `Duplicate Document Number Error : You must specify a different number. This number has already been used. DocNumber=${rec.DocNumber} is assigned to TxnType=${entity} with TxnId=${other.Id}`, element: 'DocNumber' });
        }
      }
    }
  }

  /** Apply (+1) or reverse (-1) a payment's LinkedTxn amounts against Bill/Invoice balances. */
  private applyLinks(entity: string, rec: any, sign: 1 | -1): void {
    const targetType = entity === 'BillPayment' ? 'Bill' : 'Invoice';
    const changes: Array<[any, number]> = [];
    for (const l of rec.Line ?? []) {
      for (const lt of l.LinkedTxn ?? []) {
        if (lt.TxnType !== targetType && sign > 0) continue; // credits / JEs: not modelled
        const target = this.store[targetType].get(String(lt.TxnId));
        if (!target) {
          if (sign > 0) throw badRef('LinkedTxn', lt.TxnId);
          continue;
        }
        const next = Math.round((Number(target.Balance ?? target.TotalAmt) - sign * Number(l.Amount)) * 100) / 100;
        if (next < -0.001) throw validation(`The payment amount is more than the open balance of ${targetType} ${target.Id}. [assumed]`);
        changes.push([target, next]);
      }
    }
    for (const [t, b] of changes) t.Balance = b;
  }

  private fqn(rec: any): string {
    const parent = rec.ParentRef?.value != null ? this.store.Account.get(String(rec.ParentRef.value)) : null;
    return parent ? `${parent.FullyQualifiedName ?? parent.Name}:${rec.Name}` : rec.Name;
  }
}

function normType(t: string): string {
  const v = String(t).toLowerCase();
  return v.charAt(0).toUpperCase() + v.slice(1);
}

function faultJson(f: Fault): any {
  return { Message: f.message, Detail: f.detail, code: f.code, ...(f.element ? { element: f.element } : {}) };
}

function throttleBody(): any {
  // [docs] the shape Intuit returns for HTTP 429.
  return { Fault: { Error: [{ Message: 'message=ThrottleExceeded; errorCode=003001; statusCode=429', Detail: 'The request limit was reached.', code: '3001' }], type: 'SERVICE' }, time: now() };
}

function lit(token: string): unknown {
  if (/^'.*'$/.test(token)) return token.slice(1, -1).replace(/\\'/g, "'");
  if (token === 'true') return true;
  if (token === 'false') return false;
  return token;
}

function eq(a: unknown, b: unknown): boolean {
  if (typeof b === 'boolean') return (a !== false) === b;
  return String(a ?? '').toLowerCase() === String(b ?? '').toLowerCase();
}

function now(): string {
  return new Date().toISOString();
}

// ── A small US company used by the import tests and the sandbox scenario ──

export const LEDGER_REALM = '9130355371234567';

export function seedImportCompany(ledger: FakeQboLedger): FakeQboLedger {
  ledger.seed('Account', [
    { Id: '1', Name: 'Checking', AcctNum: '1000', AccountType: 'Bank', AccountSubType: 'Checking' },
    { Id: '2', Name: 'Savings', AcctNum: '1010', AccountType: 'Bank', AccountSubType: 'Savings' },
    { Id: '3', Name: 'Accounts Receivable (A/R)', AcctNum: '1200', AccountType: 'Accounts Receivable', AccountSubType: 'AccountsReceivable' },
    { Id: '4', Name: 'Retainage Receivable', AcctNum: '1250', AccountType: 'Accounts Receivable', AccountSubType: 'AccountsReceivable' },
    { Id: '5', Name: 'Undeposited Funds', AcctNum: '1499', AccountType: 'Other Current Asset', AccountSubType: 'UndepositedFunds' },
    { Id: '6', Name: 'Accounts Payable (A/P)', AcctNum: '2000', AccountType: 'Accounts Payable', AccountSubType: 'AccountsPayable' },
    { Id: '7', Name: 'Visa', AcctNum: '2100', AccountType: 'Credit Card', AccountSubType: 'CreditCard' },
    { Id: '8', Name: 'Opening Balance Equity', AcctNum: '3000', AccountType: 'Equity', AccountSubType: 'OpeningBalanceEquity' },
    { Id: '9', Name: 'Consulting Income', AcctNum: '4000', AccountType: 'Income', AccountSubType: 'ServiceFeeIncome' },
    { Id: '10', Name: 'Product Sales', AcctNum: '4100', AccountType: 'Income', AccountSubType: 'SalesOfProductIncome' },
    { Id: '11', Name: 'Office Supplies', AcctNum: '6000', AccountType: 'Expense', AccountSubType: 'OfficeGeneralAdministrativeExpenses' },
    { Id: '12', Name: 'Rent', AcctNum: '6100', AccountType: 'Expense', AccountSubType: 'RentOrLeaseOfBuildings' },
    { Id: '13', Name: 'Travel', AcctNum: '6200', AccountType: 'Expense', AccountSubType: 'Travel' },
    { Id: '14', Name: 'Meals', AcctNum: '6210', AccountType: 'Expense', AccountSubType: 'TravelMeals', ParentRef: { value: '13' } },
    { Id: '15', Name: 'Bank Charges', AcctNum: '6300', AccountType: 'Expense', AccountSubType: 'BankCharges' },
  ]);
  ledger.seed('Class', [{ Id: '100', Name: 'East' }, { Id: '101', Name: 'West' }]);
  ledger.seed('Term', [{ Id: '200', Name: 'Net 30', DueDays: 30 }]);
  ledger.seed('Vendor', [{ Id: '300', DisplayName: 'Acme Supplies', CompanyName: 'Acme Supplies LLC' }]);
  ledger.seed('Customer', [{ Id: '400', DisplayName: 'Globex Corp', FullyQualifiedName: 'Globex Corp' }]);
  ledger.seed('Employee', [{ Id: '500', DisplayName: 'Jane Smith', GivenName: 'Jane', FamilyName: 'Smith' }]);
  return ledger;
}
