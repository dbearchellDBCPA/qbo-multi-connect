// ─── Live-company context for the bulk import tools ──────────────────────────
//
// Everything import_transactions / batch_create_names / ensure_items resolve
// against, loaded ONCE per call into in-memory indexes: the chart of
// accounts (reusing account-hierarchy's index), vendors + customers +
// employees in one DisplayName namespace (QBO requires DisplayName to be
// unique across all three), classes, items, terms and the preferences that
// change validation (closing date, class tracking, account numbers).

import { indexAccounts, displayName as accountDisplayName, type AccountIndex, type QboAccount } from './account-hierarchy.js';
import { escapeQboString } from './entity-fields.js';
import type { NameType } from './import-schema.js';

/** Runs one QBO query string and returns the raw response body. */
export type QueryFn = (query: string) => Promise<any>;

const PAGE = 1000;

/** SELECT * FROM <entity> [WHERE …], paged through STARTPOSITION until exhausted. */
export async function queryAll(query: QueryFn, entity: string, where?: string, maxRows = 200_000): Promise<any[]> {
  const out: any[] = [];
  for (let start = 1; start <= maxRows; start += PAGE) {
    const q = `SELECT * FROM ${entity}${where ? ` WHERE ${where}` : ''} MAXRESULTS ${PAGE} STARTPOSITION ${start}`;
    const res = await query(q);
    const rows: any[] = res?.QueryResponse?.[entity] ?? [];
    out.push(...rows);
    if (rows.length < PAGE) break;
  }
  return out;
}

/** Fetch entities by Id (chunks of 100 ids per query). */
export async function queryByIds(query: QueryFn, entity: string, ids: string[]): Promise<Map<string, any>> {
  const out = new Map<string, any>();
  const unique = [...new Set(ids)];
  for (let i = 0; i < unique.length; i += 100) {
    const chunk = unique.slice(i, i + 100);
    const rows = await queryAll(query, entity, `Id IN (${chunk.map((id) => `'${escapeQboString(id)}'`).join(', ')})`);
    for (const r of rows) out.set(String(r.Id), r);
  }
  return out;
}

export interface CompanyPrefs {
  closeDate: string | null;
  classTrackingPerTxn: boolean;
  classTrackingPerLine: boolean;
  /** null when the preference could not be read. */
  useAccountNumbers: boolean | null;
}

export interface NameEntry {
  id: string;
  type: NameType;
  displayName: string;
  active: boolean;
  raw: any;
}

export interface CompanyContext {
  accounts: AccountIndex;
  /** lower-cased DisplayName (and customer FullyQualifiedName) → entries of any type. */
  names: Map<string, NameEntry[]>;
  classes: Map<string, any[]>;
  items: Map<string, any[]>;
  /** income account Id → active Service/NonInventory items mapped to it. */
  itemsByIncomeAccount: Map<string, any[]>;
  terms: Map<string, any[]>;
  prefs: CompanyPrefs;
}

export interface ContextNeeds {
  accounts?: boolean;
  names?: boolean;
  classes?: boolean;
  items?: boolean;
  terms?: boolean;
  prefs?: boolean;
}

function key(value: unknown): string {
  return String(value ?? '').trim().toLowerCase();
}

function push<T>(map: Map<string, T[]>, k: string, v: T): void {
  if (!k) return;
  const list = map.get(k);
  if (list) list.push(v);
  else map.set(k, [v]);
}

export function parsePrefs(prefsBody: any): CompanyPrefs {
  const p = prefsBody?.Preferences ?? prefsBody ?? {};
  const acct = p?.AccountingInfoPrefs ?? {};
  return {
    closeDate: acct.BookCloseDate ? String(acct.BookCloseDate).slice(0, 10) : null,
    classTrackingPerTxn: acct.ClassTrackingPerTxn === true,
    classTrackingPerLine: acct.ClassTrackingPerTxnLine === true,
    useAccountNumbers: typeof acct.UseAccountNumbers === 'boolean' ? acct.UseAccountNumbers : null,
  };
}

export function indexNames(vendors: any[], customers: any[], employees: any[]): Map<string, NameEntry[]> {
  const names = new Map<string, NameEntry[]>();
  const add = (list: any[], type: NameType) => {
    for (const r of list ?? []) {
      const entry: NameEntry = { id: String(r.Id), type, displayName: String(r.DisplayName ?? ''), active: r.Active !== false, raw: r };
      push(names, key(r.DisplayName), entry);
      // Inactive names come back as "Name (deleted)"; index the bare name too
      // so a re-created name explains itself instead of colliding blindly.
      const bare = String(r.DisplayName ?? '').replace(/\s*\(deleted\)$/i, '');
      if (r.Active === false && bare !== r.DisplayName) push(names, key(bare), entry);
      if (type === 'Customer' && r.FullyQualifiedName && key(r.FullyQualifiedName) !== key(r.DisplayName)) push(names, key(r.FullyQualifiedName), entry);
    }
  };
  add(vendors, 'Vendor');
  add(customers, 'Customer');
  add(employees, 'Employee');
  return names;
}

export function addNameToIndex(names: Map<string, NameEntry[]>, type: NameType, entity: any): void {
  push(names, key(entity.DisplayName), { id: String(entity.Id), type, displayName: String(entity.DisplayName ?? ''), active: entity.Active !== false, raw: entity });
}

function indexByName(list: any[]): Map<string, any[]> {
  const map = new Map<string, any[]>();
  for (const r of list ?? []) {
    push(map, key(r.Name), r);
    if (r.FullyQualifiedName && key(r.FullyQualifiedName) !== key(r.Name)) push(map, key(r.FullyQualifiedName), r);
  }
  return map;
}

export function indexItemsByIncomeAccount(items: any[]): Map<string, any[]> {
  const map = new Map<string, any[]>();
  for (const it of items ?? []) {
    if (it.Active === false) continue;
    if (it.Type !== 'Service' && it.Type !== 'NonInventory') continue;
    const acct = it.IncomeAccountRef?.value;
    if (acct != null) push(map, String(acct), it);
  }
  return map;
}

export async function loadCompanyContext(query: QueryFn, getPrefs: () => Promise<any>, needs: ContextNeeds): Promise<CompanyContext> {
  const all = (entity: string) => queryAll(query, entity, 'Active IN (true, false)');
  const [accounts, vendors, customers, employees, classes, items, terms, prefs] = await Promise.all([
    needs.accounts ? all('Account') : Promise.resolve([]),
    needs.names ? all('Vendor') : Promise.resolve([]),
    needs.names ? all('Customer') : Promise.resolve([]),
    needs.names ? all('Employee') : Promise.resolve([]),
    needs.classes ? all('Class') : Promise.resolve([]),
    needs.items ? all('Item') : Promise.resolve([]),
    needs.terms ? all('Term') : Promise.resolve([]),
    needs.prefs ? getPrefs() : Promise.resolve(null),
  ]);
  return {
    accounts: indexAccounts(accounts as QboAccount[]),
    names: indexNames(vendors, customers, employees),
    classes: indexByName(classes),
    items: indexByName(items),
    itemsByIncomeAccount: indexItemsByIncomeAccount(items),
    terms: indexByName(terms),
    prefs: parsePrefs(prefs),
  };
}

// ─── Resolution ──────────────────────────────────────────────────────────────

export type Resolved<T> = { ok: true; value: T; warning?: string } | { ok: false; error: string };

/**
 * Account by number (exact, case-insensitive), else by fully qualified name,
 * else by plain name when unique. Active accounts win over an inactive twin;
 * an inactive sole match is an error.
 */
export function resolveAccount(ctx: CompanyContext, ref: { number?: string; name?: string }, slot: string): Resolved<QboAccount> {
  const num = ref.number?.trim();
  const name = ref.name?.trim();
  if (!num && !name) return { ok: false, error: `${slot}: no account given (pass account_number or account_name).` };
  if (num) {
    const hits = ctx.accounts.byNum.get(num.toLowerCase()) ?? [];
    const active = hits.filter((a) => a.Active !== false);
    if (active.length === 1) return { ok: true, value: active[0] };
    if (active.length > 1) return { ok: false, error: `${slot}: account number ${num} matches ${active.length} active accounts (${active.map((a) => `Id ${a.Id} "${accountDisplayName(a)}"`).join(', ')}).` };
    if (hits.length > 0) return { ok: false, error: `${slot}: account ${num} ("${accountDisplayName(hits[0])}", Id ${hits[0].Id}) is inactive. Reactivate it first.` };
    if (!name) return { ok: false, error: `${slot}: unknown account — no account has number ${num}. Load it with batch_create_accounts or fix the number (get_accounts lists the chart).` };
  }
  const k = name!.toLowerCase();
  const fq = ctx.accounts.byFqn.get(k);
  if (fq && fq.Active !== false) return { ok: true, value: fq };
  const hits = (ctx.accounts.byName.get(k) ?? []).filter((a) => a.Active !== false);
  if (hits.length === 1) return { ok: true, value: hits[0] };
  if (hits.length > 1) return { ok: false, error: `${slot}: account name "${name}" is ambiguous (${hits.map((a) => `"${accountDisplayName(a)}"`).join(', ')}). Use the account number or the fully qualified name "Parent:Child".` };
  if (fq) return { ok: false, error: `${slot}: account "${name}" (Id ${fq.Id}) is inactive. Reactivate it first.` };
  return { ok: false, error: `${slot}: unknown account — no account named "${name}"${num ? ` (and none numbered ${num})` : ''}. Load it with batch_create_accounts or fix the name.` };
}

/**
 * Name across vendors, customers and employees. With a type, a name that
 * exists only under another type fails and says which type holds it.
 */
export function resolveName(ctx: CompanyContext, ref: { name: string; type?: NameType }, slot: string, required?: NameType): Resolved<NameEntry> {
  const want = ref.type ?? required;
  if (ref.type && required && ref.type !== required) {
    return { ok: false, error: `${slot}: "${ref.name}" is given as a ${ref.type}, but this slot needs a ${required}.` };
  }
  const hits = ctx.names.get(key(ref.name)) ?? [];
  const active = hits.filter((h) => h.active);
  const ofType = want ? active.filter((h) => h.type === want) : active;
  if (ofType.length === 1) return { ok: true, value: ofType[0] };
  if (ofType.length > 1) return { ok: false, error: `${slot}: "${ref.name}" matches ${ofType.length} active ${want ?? 'names'} (Ids ${ofType.map((h) => h.id).join(', ')}).` };
  if (want && active.length > 0) {
    const holder = active[0];
    return {
      ok: false,
      error: `${slot}: "${ref.name}" is a ${holder.type} (Id ${holder.id}), not a ${want}. QBO display names are unique across vendors, customers and employees combined — use the ${holder.type}, or create the ${want} under a different display name with batch_create_names.`,
    };
  }
  const inactive = hits.find((h) => !h.active && (!want || h.type === want));
  if (inactive) return { ok: false, error: `${slot}: ${inactive.type} "${ref.name}" (Id ${inactive.id}) is inactive. Reactivate it first.` };
  return { ok: false, error: `${slot}: unknown ${want ?? 'name'} "${ref.name}" — create it first with batch_create_names.` };
}

export function resolveNamed(map: Map<string, any[]>, name: string, what: string, slot: string, hint: string): Resolved<any> {
  const hits = map.get(key(name)) ?? [];
  const active = hits.filter((h) => h.Active !== false);
  if (active.length === 1) return { ok: true, value: active[0] };
  if (active.length > 1) return { ok: false, error: `${slot}: ${what} "${name}" is ambiguous (Ids ${active.map((h) => h.Id).join(', ')}); use the fully qualified name.` };
  if (hits.length > 0) return { ok: false, error: `${slot}: ${what} "${name}" (Id ${hits[0].Id}) is inactive. Reactivate it first.` };
  return { ok: false, error: `${slot}: unknown ${what} "${name}". ${hint}` };
}

export function itemNameForAccount(pattern: string, account: QboAccount): string {
  return pattern
    .replace(/\{account_name\}/g, String(account.Name ?? ''))
    .replace(/\{account_number\}/g, String(account.AcctNum ?? ''))
    .replace(/\{account_fqn\}/g, accountDisplayName(account).replace(/:/g, ' - '));
}

/** The Service item a sales line should use for an income account. */
export function resolveItemForAccount(ctx: CompanyContext, account: QboAccount, pattern: string, slot: string): Resolved<any> {
  const candidates = ctx.itemsByIncomeAccount.get(String(account.Id)) ?? [];
  const preferred = itemNameForAccount(pattern, account).toLowerCase();
  const named = candidates.find((c) => key(c.Name) === preferred);
  if (named) return { ok: true, value: named };
  if (candidates.length === 1) return { ok: true, value: candidates[0] };
  if (candidates.length > 1) {
    return { ok: false, error: `${slot}: ${candidates.length} items map to account "${accountDisplayName(account)}" (${candidates.slice(0, 4).map((c) => `"${c.Name}"`).join(', ')}); pass item_name to choose one.` };
  }
  return { ok: false, error: `${slot}: no Service item maps to account "${accountDisplayName(account)}"${account.AcctNum ? ` (${account.AcctNum})` : ''}. Run ensure_items for that account first, or pass item_name.` };
}
