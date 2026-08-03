import { z } from 'zod';

// ─── Address support ──────────────────────────────────────────────────────────
// QBO PhysicalAddress mapping for Customer.BillAddr / Customer.ShipAddr /
// Vendor.BillAddr. Note the QBO quirk: the state/province lives in
// CountrySubDivisionCode (NOT a country code).

export const addressInputShape = {
  line1: z.string().optional().describe('Address line 1'),
  line2: z.string().optional().describe('Address line 2'),
  line3: z.string().optional().describe('Address line 3'),
  line4: z.string().optional().describe('Address line 4'),
  line5: z.string().optional().describe('Address line 5'),
  city: z.string().optional().describe('City'),
  state: z.string().optional().describe('State/province (maps to QBO CountrySubDivisionCode)'),
  postal_code: z.string().optional().describe('ZIP / postal code'),
  country: z.string().optional().describe('Country'),
};

export const addressInput = z.object(addressInputShape);
export type AddressInput = z.infer<typeof addressInput>;

const ADDRESS_FIELD_MAP: Array<[keyof AddressInput, string]> = [
  ['line1', 'Line1'],
  ['line2', 'Line2'],
  ['line3', 'Line3'],
  ['line4', 'Line4'],
  ['line5', 'Line5'],
  ['city', 'City'],
  ['state', 'CountrySubDivisionCode'],
  ['postal_code', 'PostalCode'],
  ['country', 'Country'],
];

/** Convert tool-facing address params to a QBO PhysicalAddress object. */
export function toQboAddress(input: AddressInput): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [param, qboField] of ADDRESS_FIELD_MAP) {
    const value = input[param];
    if (value !== undefined) out[qboField] = value;
  }
  return out;
}

/**
 * Produce the QBO address object to send on an update.
 *
 * QBO's sparse update REPLACES the entire BillAddr/ShipAddr object with
 * whatever is sent — sending only {PostalCode} silently wipes Line1/City/
 * State. So by default we deep-merge the caller's subfields over the
 * existing address. With replace=true the caller gets a clean overwrite of
 * the fields instead.
 *
 * In both modes the existing address Id is preserved so QBO updates the
 * address record in place rather than orphaning it and creating a new one.
 */
export function mergeQboAddress(
  existing: Record<string, unknown> | undefined | null,
  input: AddressInput,
  replace = false
): Record<string, unknown> {
  const provided = toQboAddress(input);
  const base = replace ? {} : { ...(existing ?? {}) };
  const merged: Record<string, unknown> = { ...base, ...provided };
  if (existing && existing.Id !== undefined) merged.Id = existing.Id;
  return merged;
}

// ─── Shared contact fields (Customer + Vendor) ────────────────────────────────

export const contactInputShape = {
  mobile: z.string().optional().describe('Mobile phone number'),
  alternate_phone: z.string().optional().describe('Alternate phone number'),
  fax: z.string().optional().describe('Fax number'),
  website: z.string().optional().describe('Website URL'),
  middle_name: z.string().optional().describe('Middle name'),
  suffix: z.string().optional().describe('Name suffix (Jr., III, …)'),
  title: z.string().optional().describe('Title (Mr., Dr., …)'),
  print_on_check_name: z.string().optional().describe('Name printed on checks'),
  notes: z.string().optional().describe('Internal notes on the record'),
};

export interface ContactInput {
  mobile?: string;
  alternate_phone?: string;
  fax?: string;
  website?: string;
  middle_name?: string;
  suffix?: string;
  title?: string;
  print_on_check_name?: string;
  notes?: string;
}

/** Apply the shared contact params onto a QBO Customer/Vendor payload. */
export function applyContactFields(payload: Record<string, unknown>, input: ContactInput): void {
  if (input.mobile !== undefined) payload.Mobile = { FreeFormNumber: input.mobile };
  if (input.alternate_phone !== undefined) payload.AlternatePhone = { FreeFormNumber: input.alternate_phone };
  if (input.fax !== undefined) payload.Fax = { FreeFormNumber: input.fax };
  if (input.website !== undefined) payload.WebAddr = { URI: input.website };
  if (input.middle_name !== undefined) payload.MiddleName = input.middle_name;
  if (input.suffix !== undefined) payload.Suffix = input.suffix;
  if (input.title !== undefined) payload.Title = input.title;
  if (input.print_on_check_name !== undefined) payload.PrintOnCheckName = input.print_on_check_name;
  if (input.notes !== undefined) payload.Notes = input.notes;
}

// ─── Sparse update payload builders ──────────────────────────────────────────
// QBO has two update modes. FULL update (sparse:false, or echoing a fetched
// record which itself contains "sparse": false) rewrites the entire record:
// QBO re-mints address rows on every call and fills an empty ShipAddr from
// BillAddr server-side — observed in production as ShipAddr being silently
// overwritten by updates that never touched addresses. SPARSE update
// (sparse:true) changes only the fields present in the payload. These
// builders therefore emit Id + SyncToken + sparse:true + ONLY caller-provided
// fields; an address key simply never appears unless the caller asked for it.

export interface PersonUpdateArgs extends ContactInput {
  display_name?: string;
  company_name?: string;
  given_name?: string;
  family_name?: string;
  email?: string;
  phone?: string;
  active?: boolean;
  bill_addr?: AddressInput;
  replace_address?: boolean;
}

export interface CustomerUpdateArgs extends PersonUpdateArgs {
  ship_addr?: AddressInput;
  ship_same_as_bill?: boolean;
  preferred_delivery_method?: 'Print' | 'Email' | 'None';
  sales_term_id?: string;
  resale_num?: string;
  taxable?: boolean;
}

export interface VendorUpdateArgs extends PersonUpdateArgs {
  vendor_1099?: boolean;
  tax_identifier?: string;
  account_number?: string;
  bill_rate?: number;
  term_id?: string;
}

function baseSparsePayload(fetched: Record<string, any>, args: PersonUpdateArgs): Record<string, any> {
  const payload: Record<string, any> = {
    Id: fetched.Id,
    SyncToken: fetched.SyncToken,
    sparse: true,
  };
  if (args.display_name !== undefined) payload.DisplayName = args.display_name;
  if (args.company_name !== undefined) payload.CompanyName = args.company_name;
  if (args.given_name !== undefined) payload.GivenName = args.given_name;
  if (args.family_name !== undefined) payload.FamilyName = args.family_name;
  if (args.email !== undefined) payload.PrimaryEmailAddr = { Address: args.email };
  if (args.phone !== undefined) payload.PrimaryPhone = { FreeFormNumber: args.phone };
  if (args.active !== undefined) payload.Active = args.active;
  if (args.bill_addr) payload.BillAddr = mergeQboAddress(fetched.BillAddr, args.bill_addr, args.replace_address);
  applyContactFields(payload, args);
  return payload;
}

/**
 * Build a sparse QBO Customer update payload. BillAddr/ShipAddr appear ONLY
 * when the caller passes bill_addr / ship_addr / ship_same_as_bill — an
 * update that doesn't mention addresses cannot touch them. Existing address
 * Ids are carried through so QBO edits address rows in place.
 */
export function buildCustomerUpdatePayload(
  fetched: Record<string, any>,
  args: CustomerUpdateArgs
): Record<string, any> {
  const payload = baseSparsePayload(fetched, args);
  if (args.ship_addr) payload.ShipAddr = mergeQboAddress(fetched.ShipAddr, args.ship_addr, args.replace_address);
  if (args.ship_same_as_bill) {
    // Copy the billing FIELDS (the just-merged ones if provided, else the
    // fetched record's) but keep the shipping address's own Id so QBO
    // updates the existing ship-addr row in place.
    const source = payload.BillAddr ?? fetched.BillAddr;
    if (source) {
      const { Id: _billId, ...billFields } = source;
      payload.ShipAddr = {
        ...billFields,
        ...(fetched.ShipAddr?.Id !== undefined ? { Id: fetched.ShipAddr.Id } : {}),
      };
    }
  }
  if (args.preferred_delivery_method !== undefined) payload.PreferredDeliveryMethod = args.preferred_delivery_method;
  if (args.sales_term_id !== undefined) payload.SalesTermRef = { value: args.sales_term_id };
  if (args.resale_num !== undefined) payload.ResaleNum = args.resale_num;
  if (args.taxable !== undefined) payload.Taxable = args.taxable;
  return payload;
}

/**
 * Build a sparse QBO Vendor update payload (vendors have BillAddr only).
 */
export function buildVendorUpdatePayload(
  fetched: Record<string, any>,
  args: VendorUpdateArgs
): Record<string, any> {
  const payload = baseSparsePayload(fetched, args);
  if (args.vendor_1099 !== undefined) payload.Vendor1099 = args.vendor_1099;
  if (args.tax_identifier !== undefined) payload.TaxIdentifier = args.tax_identifier;
  if (args.account_number !== undefined) payload.AcctNum = args.account_number;
  if (args.bill_rate !== undefined) payload.BillRate = args.bill_rate;
  if (args.term_id !== undefined) payload.TermRef = { value: args.term_id };
  return payload;
}

/**
 * Note for the shared `email` param description: QBO exposes exactly one
 * PrimaryEmailAddr.Address — there is no additional-email field. The QBO UI
 * stores multiple recipients as a comma-separated string in this same field;
 * the API stores such a string verbatim, but whether invoice sending honors
 * every address should be verified in the target QBO file.
 */
export const EMAIL_PARAM_DESCRIPTION =
  'Email address. QBO has a single primary email field; for multiple recipients QBO’s own UI comma-separates them in this field (e.g. "a@x.com,b@y.com") — the API stores the string verbatim, but verify invoice-send behavior in your file before relying on it.';

// ─── QBO SQL string escaping ─────────────────────────────────────────────────

/**
 * Escape a string literal for use inside a QBO SQL query. QBO uses
 * backslash-escaped single quotes ("O\'Brien Supply").
 */
export function escapeQboString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

export const DOC_NUMBER_DESCRIPTION =
  "Reference/check number (QBO DocNumber). For check payments this is the check number shown in the register's Ref No. column. Max 21 characters.";

// ─── Stray HTML-entity normalization ─────────────────────────────────────────
// Some MCP clients HTML-escape string arguments on the first write call of a
// session ("Miller & Grant" arrives as "Miller &amp; Grant"). This server
// never escapes — payloads are JSON.stringified untouched — so the entities
// come in from upstream. Since literal "&amp;" in real accounting names is
// vanishingly rare and the bug is recurring, we tolerantly decode the few
// standard entities in every outbound write payload.

const ENTITY_PATTERN = /&(amp|lt|gt|quot|apos|#39|#x27);/g;
const ENTITY_MAP: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  '#39': "'",
  '#x27': "'",
};

export function decodeStrayEntities(value: string): string {
  return value.replace(ENTITY_PATTERN, (_m, name: string) => ENTITY_MAP[name] ?? _m);
}

/** Recursively decode stray HTML entities in every string of a payload. */
export function decodeStrayEntitiesDeep<T>(value: T): T {
  if (typeof value === 'string') return decodeStrayEntities(value) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => decodeStrayEntitiesDeep(v)) as unknown as T;
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = decodeStrayEntitiesDeep(v);
    }
    return out as unknown as T;
  }
  return value;
}
