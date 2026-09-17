// ─── Fake Intuit (QBO v3) API for the sales/purchase-form tools ──────────────
//
// A fetch() stand-in for the prefill end-to-end tests: query (with the WHERE /
// ORDERBY / MAXRESULTS shapes src/server/prefill.ts sends), Customer / Vendor /
// Preferences reads, form creates (with QBO's 6140 duplicate-number fault on
// demand), reads, full updates, deletes, and the multipart /upload endpoint.
// It enforces the rules the tools depend on and returns QBO-shaped bodies;
// it is not a QuickBooks. FakeIntuit (fake-intuit.ts) covers the chart of
// accounts; this one covers transactions.

type Entity =
  | 'Invoice' | 'Estimate' | 'CreditMemo' | 'SalesReceipt' | 'RefundReceipt'
  | 'Bill' | 'PurchaseOrder' | 'Customer' | 'Vendor';

const PATH_ENTITY: Record<string, Entity> = {
  invoice: 'Invoice', estimate: 'Estimate', creditmemo: 'CreditMemo', salesreceipt: 'SalesReceipt',
  refundreceipt: 'RefundReceipt', bill: 'Bill', purchaseorder: 'PurchaseOrder', customer: 'Customer', vendor: 'Vendor',
};

export interface UploadPart {
  metadata: any;
  fileName: string;
  contentType: string;
  size: number;
}

class Fault extends Error {
  constructor(public status: number, public code: string, public msg: string, public detail: string, public element?: string) {
    super(detail);
  }
}

function now(): string {
  return new Date().toISOString();
}

export class FakeQboForms {
  readonly store: Record<Entity, Map<string, any>> = {
    Invoice: new Map(), Estimate: new Map(), CreditMemo: new Map(), SalesReceipt: new Map(), RefundReceipt: new Map(),
    Bill: new Map(), PurchaseOrder: new Map(), Customer: new Map(), Vendor: new Map(),
  };
  /** Every request, in order: the tests read POST bodies from here. */
  readonly log: { method: string; path: string; body?: any }[] = [];
  /** Parsed multipart uploads, in order. */
  readonly uploads: UploadPart[][] = [];
  /** DocNumbers that fail ONCE with QBO's 6140 fault (then succeed). */
  readonly rejectDocNumberOnce = new Set<string>();
  /** When set, POST /upload answers with this body instead of an Attachable. */
  uploadResponseOverride: any | null = null;
  preferences: any;
  private nextId = 200000;
  private autoDocNumber = 1000;

  constructor(private readonly realmId: string, preferences: any) {
    this.preferences = preferences;
  }

  seed(entity: Entity, record: any): any {
    const rec = { SyncToken: '0', MetaData: { CreateTime: now(), LastUpdatedTime: now() }, ...record, Id: String(record.Id) };
    if (Array.isArray(rec.Line)) rec.Line = rec.Line.map((l: any, i: number) => ({ Id: String(i + 1), LineNum: i + 1, ...l }));
    this.store[entity].set(rec.Id, rec);
    return rec;
  }

  get posts(): { path: string; body: any }[] {
    return this.log.filter((l) => l.method === 'POST');
  }

  fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = (init?.method ?? 'GET').toUpperCase();
    const prefix = `/v3/company/${this.realmId}/`;
    if (!url.pathname.startsWith(prefix)) {
      return this.respond(401, { Fault: { Error: [{ Message: 'AuthenticationFailed', Detail: `Unknown realm in ${url.pathname}`, code: '3200' }], type: 'AUTHENTICATION' } });
    }
    const path = url.pathname.slice(prefix.length);
    const isForm = typeof FormData !== 'undefined' && init?.body instanceof FormData;
    const body = init?.body && !isForm ? JSON.parse(String(init.body)) : undefined;
    // Log the path without the idempotency key QBOClient appends, so tests can match on it.
    const loggedParams = new URLSearchParams(url.search);
    loggedParams.delete('requestid');
    const loggedSearch = loggedParams.toString();
    this.log.push({ method, path: loggedSearch ? `${path}?${loggedSearch}` : path, body });
    try {
      if (path === 'query') return this.respond(200, this.query(url.searchParams.get('query') ?? ''));
      if (path === 'preferences') return this.respond(200, { Preferences: this.preferences, time: now() });
      if (path === 'upload' && method === 'POST') return this.respond(200, await this.upload(init!.body as FormData));
      const m = path.match(/^([a-z]+)(?:\/([^/]+))?$/);
      const entity = m ? PATH_ENTITY[m[1]] : undefined;
      if (!entity) throw new Fault(400, '500', 'Unsupported Operation', `Operation ${method} ${path} is not supported.`);
      if (method === 'GET' && m![2]) return this.respond(200, { [entity]: this.mustGet(entity, m![2]), time: now() });
      if (method === 'POST' && !m![2]) {
        if (url.searchParams.get('operation') === 'delete') {
          const existing = this.mustGet(entity, body.Id);
          this.store[entity].delete(existing.Id);
          return this.respond(200, { [entity]: { Id: existing.Id, status: 'Deleted', domain: 'QBO' }, time: now() });
        }
        return this.respond(200, { [entity]: this.write(entity, body ?? {}), time: now() });
      }
      throw new Fault(400, '500', 'Unsupported Operation', `Operation ${method} ${path} is not supported.`);
    } catch (e) {
      if (e instanceof Fault) {
        return this.respond(e.status, {
          Fault: { Error: [{ Message: e.msg, Detail: e.detail, code: e.code, ...(e.element ? { element: e.element } : {}) }], type: 'ValidationFault' },
          time: now(),
        });
      }
      throw e;
    }
  };

  private respond(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }

  private mustGet(entity: Entity, id: string): any {
    const found = this.store[entity].get(String(id));
    if (!found) throw new Fault(400, '610', 'Object Not Found', `Object Not Found : Something you're trying to use has been made inactive. Check the fields with accounts, customers, items, vendors or employees.`, 'Id');
    return found;
  }

  // ── Query ────────────────────────────────────────────────────────────────

  private query(q: string): any {
    const m = q.match(/^\s*SELECT\s+(.+?)\s+FROM\s+(\w+)(?:\s+WHERE\s+(.+?))?(?:\s+ORDERBY\s+(.+?))?(?:\s+MAXRESULTS\s+(\d+))?(?:\s+STARTPOSITION\s+(\d+))?\s*$/i);
    if (!m) throw new Fault(400, '4000', 'Error parsing query', `Error parsing query ${q}`);
    const entity = m[2] as Entity;
    if (!this.store[entity]) throw new Fault(400, '4001', 'Invalid query', `Unknown entity ${entity}`);
    let rows = [...this.store[entity].values()];
    if (m[3]) {
      for (const cond of m[3].split(/\s+AND\s+/i)) {
        const eq = cond.match(/^(\w+)\s*=\s*'((?:\\'|[^'])*)'$/);
        if (!eq) throw new Fault(400, '4000', 'Error parsing query', `Unsupported condition ${cond}`);
        const field = eq[1];
        const value = eq[2].replace(/\\'/g, "'");
        rows = rows.filter((r) => {
          const v = r[field];
          const scalar = v && typeof v === 'object' && 'value' in v ? v.value : v;
          return String(scalar ?? '') === value;
        });
      }
    }
    if (m[4]) {
      const keys = m[4].split(',').map((k) => {
        const [field, dir] = k.trim().split(/\s+/);
        return { field, desc: (dir ?? 'ASC').toUpperCase() === 'DESC' };
      });
      const get = (r: any, field: string): any => field.split('.').reduce((o, k) => o?.[k], r);
      rows.sort((a, b) => {
        for (const { field, desc } of keys) {
          const av = get(a, field);
          const bv = get(b, field);
          const cmp = field === 'Id' ? Number(av) - Number(bv) : String(av ?? '').localeCompare(String(bv ?? ''));
          if (cmp !== 0) return desc ? -cmp : cmp;
        }
        return 0;
      });
    }
    const start = m[6] ? Number(m[6]) : 1;
    const max = m[5] ? Number(m[5]) : 100;
    rows = rows.slice(start - 1, start - 1 + max);
    const cols = m[1].trim();
    const projected = cols === '*'
      ? rows
      : rows.map((r) => Object.fromEntries(['Id', ...cols.split(',').map((c) => c.trim())].map((c) => [c, r[c]]).filter(([, v]) => v !== undefined)));
    const response: any = { startPosition: start, maxResults: projected.length };
    if (projected.length > 0) response[entity] = projected;
    return { QueryResponse: response, time: now() };
  }

  // ── Writes ───────────────────────────────────────────────────────────────

  private write(entity: Entity, body: any): any {
    const table = this.store[entity];
    let record: any;
    if (body.Id != null) {
      const existing = this.mustGet(entity, body.Id);
      if (String(body.SyncToken) !== String(existing.SyncToken)) {
        throw new Fault(400, '5010', 'Stale Object Error', 'Stale Object Error : You and another user were working on this at the same time. Reload and try again.');
      }
      record = body.sparse ? { ...existing, ...body } : { ...body, MetaData: existing.MetaData };
      record.Id = existing.Id;
      record.SyncToken = String(Number(existing.SyncToken) + 1);
    } else {
      record = { ...body, Id: String(this.nextId++), SyncToken: '0', MetaData: { CreateTime: now(), LastUpdatedTime: now() } };
      if (record.TxnDate == null && entity !== 'Customer' && entity !== 'Vendor') record.TxnDate = now().slice(0, 10);
      if (this.isSalesForm(entity) || entity === 'PurchaseOrder') {
        const customOn = entity === 'PurchaseOrder'
          ? (this.preferences?.OtherPrefs?.NameValue ?? []).find((nv: any) => nv.Name === 'VendorAndPurchasesPrefs.UseCustomTxnNumbers')?.Value === 'true'
          : this.preferences?.SalesFormsPrefs?.CustomTxnNumbers === true;
        if (record.DocNumber == null && !customOn) record.DocNumber = String(this.autoDocNumber++);
      }
    }
    // QBO fills the name of a party ref from the record when only the Id was sent.
    for (const [refField, kind] of [['CustomerRef', 'Customer'], ['VendorRef', 'Vendor']] as const) {
      const ref = record[refField];
      if (ref?.value != null && (ref.name == null || ref.name === '')) {
        const party = this.store[kind].get(String(ref.value));
        if (party?.DisplayName) record[refField] = { ...ref, name: party.DisplayName };
      }
    }
    if (record.DocNumber != null && this.rejectDocNumberOnce.has(String(record.DocNumber))) {
      this.rejectDocNumberOnce.delete(String(record.DocNumber));
      // [docs] QBO code 6140 wording.
      throw new Fault(400, '6140', 'Duplicate Document Number Error', 'Duplicate Document Number Error : You must specify a different number. This number has already been used.', 'DocNumber');
    }
    if (this.isSalesForm(entity) || entity === 'Bill' || entity === 'PurchaseOrder') {
      if (!Array.isArray(record.Line) || record.Line.length === 0) {
        throw new Fault(400, '2020', 'Required param missing, need to supply the required value for the API', 'Required parameter Line is missing in the request', 'Line');
      }
      for (const l of record.Line) {
        if (l.DetailType === 'AccountBasedExpenseLineDetail' && !l.AccountBasedExpenseLineDetail?.AccountRef?.value) {
          throw new Fault(400, '2020', 'Required param missing, need to supply the required value for the API', 'Required parameter AccountRef is missing in the request', 'AccountRef');
        }
      }
      const monetary = record.Line.filter((l: any) => l.DetailType !== 'SubTotalLineDetail' && l.DetailType !== 'DescriptionOnly');
      record.Line = record.Line.map((l: any, i: number) => ({ Id: String(i + 1), LineNum: i + 1, ...l }));
      record.TotalAmt = Math.round(monetary.reduce((s: number, l: any) => s + Number(l.Amount ?? 0), 0) * 100) / 100;
      if (entity === 'Invoice' || entity === 'Bill') record.Balance = record.TotalAmt;
      if (entity === 'CreditMemo') record.RemainingCredit = record.TotalAmt;
    }
    if (entity === 'Customer' || entity === 'Vendor') {
      if (!record.DisplayName) throw new Fault(400, '2020', 'Required param missing, need to supply the required value for the API', 'Required parameter DisplayName is missing in the request', 'DisplayName');
    }
    delete record.sparse;
    record.domain = 'QBO';
    record.MetaData = { ...(record.MetaData ?? { CreateTime: now() }), LastUpdatedTime: now() };
    table.set(record.Id, record);
    return record;
  }

  private isSalesForm(entity: Entity): boolean {
    return entity === 'Invoice' || entity === 'Estimate' || entity === 'CreditMemo' || entity === 'SalesReceipt' || entity === 'RefundReceipt';
  }

  // ── Upload ───────────────────────────────────────────────────────────────

  private async upload(form: FormData): Promise<any> {
    const parts: UploadPart[] = [];
    for (let i = 1; ; i++) {
      const n = String(i).padStart(2, '0');
      const meta = form.get(`file_metadata_${n}`);
      const content = form.get(`file_content_${n}`);
      if (!meta || !content) break;
      const metadata = JSON.parse(await (meta as Blob).text());
      const file = content as File;
      parts.push({ metadata, fileName: file.name, contentType: file.type, size: file.size });
    }
    this.uploads.push(parts);
    if (this.uploadResponseOverride) return this.uploadResponseOverride;
    return {
      AttachableResponse: parts.map((p) => ({
        Attachable: {
          Id: String(this.nextId++),
          SyncToken: '0',
          FileName: p.metadata.FileName,
          ContentType: p.metadata.ContentType,
          Size: p.size,
          ...(p.metadata.Note ? { Note: p.metadata.Note } : {}),
          ...(p.metadata.IncludeOnSend !== undefined ? { IncludeOnSend: p.metadata.IncludeOnSend } : {}),
          ...(p.metadata.AttachableRef ? { AttachableRef: p.metadata.AttachableRef.map((r: any) => ({ ...r, IncludeOnSend: p.metadata.IncludeOnSend ?? false })) } : {}),
          MetaData: { CreateTime: now(), LastUpdatedTime: now() },
        },
      })),
      time: now(),
    };
  }
}

/** Ingram-shaped Preferences: custom sales numbers on, class per line, locations on, a default customer message, PO custom numbers off. */
export function ingramLikePreferences(overrides: Record<string, any> = {}): any {
  return {
    AccountingInfoPrefs: {
      TrackDepartments: true,
      ClassTrackingPerTxn: false,
      ClassTrackingPerTxnLine: true,
      ...(overrides.AccountingInfoPrefs ?? {}),
    },
    SalesFormsPrefs: {
      CustomTxnNumbers: true,
      DefaultTerms: { value: '6' },
      DefaultCustomerMessage: 'Please Pay Via ACH with payment instructions Below:\n\nPeopleSouth Bank\n1302 Gray Hwy\nMacon, Ga 31211',
      ...(overrides.SalesFormsPrefs ?? {}),
    },
    TaxPrefs: { UsingSalesTax: false },
    OtherPrefs: {
      NameValue: [
        { Name: 'VendorAndPurchasesPrefs.UseCustomTxnNumbers', Value: overrides.poCustomTxnNumbers ?? 'false' },
        { Name: 'SalesFormsPrefs.DefaultCustomerMessage', Value: 'Please Pay Via ACH with payment instructions Below:\n\nPeopleSouth Bank\n1302 Gray Hwy\nMacon, Ga 31211' },
      ],
    },
    Id: '1',
    SyncToken: '44',
  };
}
