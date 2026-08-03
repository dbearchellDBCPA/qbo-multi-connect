import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  toQboAddress,
  mergeQboAddress,
  applyContactFields,
  buildCustomerUpdatePayload,
  buildVendorUpdatePayload,
  decodeStrayEntities,
  decodeStrayEntitiesDeep,
  escapeQboString,
} from '../../src/server/entity-fields.js';
import { QBOClient } from '../../src/api/client.js';

// ─── Address mapping ──────────────────────────────────────────────────────────

describe('toQboAddress', () => {
  it('maps all tool params to QBO PhysicalAddress fields', () => {
    expect(
      toQboAddress({
        line1: 'PO Box 1302',
        line2: 'Suite 300',
        city: 'Macon',
        state: 'GA',
        postal_code: '31202-1302',
        country: 'US',
      })
    ).toEqual({
      Line1: 'PO Box 1302',
      Line2: 'Suite 300',
      City: 'Macon',
      CountrySubDivisionCode: 'GA', // the QBO quirk: state, not country
      PostalCode: '31202-1302',
      Country: 'US',
    });
  });

  it('omits fields that were not provided', () => {
    expect(toQboAddress({ city: 'Macon' })).toEqual({ City: 'Macon' });
  });
});

describe('mergeQboAddress (acceptance #2 and #3)', () => {
  const existing = {
    Id: '7',
    Line1: '123 Main St',
    City: 'Macon',
    CountrySubDivisionCode: 'GA',
    PostalCode: '31201',
  };

  it('merges a partial update over the existing address, preserving untouched fields and Id', () => {
    const merged = mergeQboAddress(existing, { postal_code: '31202-1302' });
    expect(merged).toEqual({
      Id: '7',
      Line1: '123 Main St',
      City: 'Macon',
      CountrySubDivisionCode: 'GA',
      PostalCode: '31202-1302',
    });
  });

  it('replace=true overwrites cleanly but still preserves Id (no orphaned address record)', () => {
    const merged = mergeQboAddress(existing, { line1: 'PO Box 9', city: 'Atlanta' }, true);
    expect(merged).toEqual({ Id: '7', Line1: 'PO Box 9', City: 'Atlanta' });
    expect(merged.PostalCode).toBeUndefined(); // clean overwrite: old fields gone
  });

  it('handles a record with no existing address', () => {
    const merged = mergeQboAddress(undefined, { line1: 'PO Box 9', state: 'GA' });
    expect(merged).toEqual({ Line1: 'PO Box 9', CountrySubDivisionCode: 'GA' });
    expect(merged.Id).toBeUndefined();
  });
});

describe('applyContactFields', () => {
  it('maps every contact param to its QBO field', () => {
    const payload: Record<string, unknown> = {};
    applyContactFields(payload, {
      mobile: '478-555-1000',
      alternate_phone: '478-555-2000',
      fax: '478-555-3000',
      website: 'https://uwga.org',
      middle_name: 'Q',
      suffix: 'Jr.',
      title: 'Dr.',
      print_on_check_name: 'UWGA Inc',
      notes: 'Annual dues member',
    });
    expect(payload).toEqual({
      Mobile: { FreeFormNumber: '478-555-1000' },
      AlternatePhone: { FreeFormNumber: '478-555-2000' },
      Fax: { FreeFormNumber: '478-555-3000' },
      WebAddr: { URI: 'https://uwga.org' },
      MiddleName: 'Q',
      Suffix: 'Jr.',
      Title: 'Dr.',
      PrintOnCheckName: 'UWGA Inc',
      Notes: 'Annual dues member',
    });
  });

  it('leaves the payload untouched when no params are provided', () => {
    const payload: Record<string, unknown> = { DisplayName: 'X' };
    applyContactFields(payload, {});
    expect(payload).toEqual({ DisplayName: 'X' });
  });
});

// ─── Sparse update payloads (address bugfix regression tests) ────────────────
// Production bug: updates echoed the full fetched record (incl. sparse:false),
// putting QBO in full-update mode — which re-minted address Ids on every call
// and filled an empty ShipAddr from BillAddr. Sparse payloads must contain
// ONLY caller-provided fields.

describe('buildCustomerUpdatePayload (ShipAddr overwrite + Id re-mint bugs)', () => {
  // Mirrors the production reproduction: customer 46 after the address run —
  // populated BillAddr, bare ShipAddr holding only an Id.
  const fetched = {
    Id: '46',
    SyncToken: '3',
    DisplayName: 'Riverside Community Fund',
    sparse: false,
    domain: 'QBO',
    MetaData: { CreateTime: '2020-01-01' },
    BillAddr: {
      Id: '5',
      Line1: 'PO Box 1302',
      City: 'Macon',
      CountrySubDivisionCode: 'GA',
      PostalCode: '31202-1302',
      Country: 'US',
    },
    ShipAddr: { Id: '8' },
    PrimaryPhone: { FreeFormNumber: '478-555-0000' },
  };

  it('regression 1: bill_addr-only update never includes ShipAddr', () => {
    const payload = buildCustomerUpdatePayload(fetched, { bill_addr: { postal_code: '31201' } });
    expect(payload).not.toHaveProperty('ShipAddr');
    expect(payload.BillAddr).toEqual({ ...fetched.BillAddr, PostalCode: '31201' });
  });

  it('regression 2: a non-address update (the delivery-method repro) includes NEITHER address', () => {
    const payload = buildCustomerUpdatePayload(fetched, { preferred_delivery_method: 'Email' });
    expect(payload).not.toHaveProperty('BillAddr');
    expect(payload).not.toHaveProperty('ShipAddr');
    expect(payload).toEqual({
      Id: '46',
      SyncToken: '3',
      sparse: true,
      PreferredDeliveryMethod: 'Email',
    });
  });

  it('regression 2b: phone-only update on a record with a BillAddr sends no addresses', () => {
    const payload = buildCustomerUpdatePayload(fetched, { phone: '478-555-9999' });
    expect(payload).not.toHaveProperty('BillAddr');
    expect(payload).not.toHaveProperty('ShipAddr');
  });

  it('regression 3: ship_addr-only update never includes BillAddr', () => {
    const payload = buildCustomerUpdatePayload(fetched, { ship_addr: { line1: '55 Depot St' } });
    expect(payload).not.toHaveProperty('BillAddr');
    expect(payload.ShipAddr).toEqual({ Id: '8', Line1: '55 Depot St' });
  });

  it('regression 4: ship_same_as_bill copies bill fields but keeps ShipAddr.Id', () => {
    const payload = buildCustomerUpdatePayload(fetched, { ship_same_as_bill: true });
    expect(payload.ShipAddr).toEqual({
      Id: '8', // ship's own Id, NOT bill's Id 5
      Line1: 'PO Box 1302',
      City: 'Macon',
      CountrySubDivisionCode: 'GA',
      PostalCode: '31202-1302',
      Country: 'US',
    });
    // Without bill_addr in the args, BillAddr itself is not resent
    expect(payload).not.toHaveProperty('BillAddr');
  });

  it('regression 5: identical consecutive updates keep BillAddr.Id stable', () => {
    const args = { bill_addr: { postal_code: '31201' } };
    const first = buildCustomerUpdatePayload(fetched, args);
    const second = buildCustomerUpdatePayload(fetched, args);
    expect(first.BillAddr.Id).toBe('5');
    expect(second.BillAddr.Id).toBe('5');
    expect(second).toEqual(first);
  });

  it('always emits sparse:true and never echoes fetched-record noise', () => {
    const payload = buildCustomerUpdatePayload(fetched, { email: 'x@y.com' });
    expect(payload.sparse).toBe(true);
    expect(payload).not.toHaveProperty('domain');
    expect(payload).not.toHaveProperty('MetaData');
    expect(payload).not.toHaveProperty('DisplayName'); // not provided → not sent
    expect(payload).not.toHaveProperty('PrimaryPhone'); // fetched value not echoed
  });

  it('replace_address still yields a clean overwrite with the Id preserved', () => {
    const payload = buildCustomerUpdatePayload(fetched, {
      bill_addr: { line1: 'New HQ' },
      replace_address: true,
    });
    expect(payload.BillAddr).toEqual({ Id: '5', Line1: 'New HQ' });
  });
});

describe('buildVendorUpdatePayload', () => {
  const fetched = {
    Id: '12',
    SyncToken: '1',
    sparse: false,
    BillAddr: { Id: '4', Line1: '9 Vendor Way', City: 'Macon' },
  };

  it('non-address vendor updates send no BillAddr; vendor extras map correctly', () => {
    const payload = buildVendorUpdatePayload(fetched, {
      vendor_1099: true,
      tax_identifier: '58-1234567',
      account_number: 'ACCT-9',
      bill_rate: 125,
      term_id: '3',
    });
    expect(payload).toEqual({
      Id: '12',
      SyncToken: '1',
      sparse: true,
      Vendor1099: true,
      TaxIdentifier: '58-1234567',
      AcctNum: 'ACCT-9',
      BillRate: 125,
      TermRef: { value: '3' },
    });
  });

  it('vendor bill_addr merge preserves the existing Id', () => {
    const payload = buildVendorUpdatePayload(fetched, { bill_addr: { city: 'Atlanta' } });
    expect(payload.BillAddr).toEqual({ Id: '4', Line1: '9 Vendor Way', City: 'Atlanta' });
  });
});

// ─── QBO SQL string escaping (vendor_name resolution) ────────────────────────

describe('escapeQboString', () => {
  it('escapes single quotes for QBO SQL literals', () => {
    expect(escapeQboString("O'Brien Supply")).toBe("O\\'Brien Supply");
  });

  it('escapes backslashes before quotes so they cannot un-escape', () => {
    expect(escapeQboString("back\\slash '")).toBe("back\\\\slash \\'");
  });

  it('passes ordinary names through untouched', () => {
    expect(escapeQboString('Shooters Event LLC')).toBe('Shooters Event LLC');
  });
});

// ─── Stray HTML-entity normalization (acceptance #4) ─────────────────────────

describe('decodeStrayEntities', () => {
  it('leaves literal special characters untouched', () => {
    expect(decodeStrayEntities('Smith & Jones <Holdings>')).toBe('Smith & Jones <Holdings>');
  });

  it('decodes the reported &amp; case', () => {
    expect(decodeStrayEntities('Miller &amp; Grant Consulting')).toBe(
      'Miller & Grant Consulting'
    );
  });

  it('decodes lt/gt/quot/apos/#39', () => {
    expect(decodeStrayEntities('&lt;b&gt; &quot;x&quot; &apos;y&apos; &#39;z&#39;')).toBe(
      '<b> "x" \'y\' \'z\''
    );
  });

  it('single-pass decode: double-encoded input decodes exactly one layer', () => {
    expect(decodeStrayEntities('&amp;amp;')).toBe('&amp;');
  });

  it('deep-decodes nested payloads without touching non-strings', () => {
    const decoded = decodeStrayEntitiesDeep({
      Name: 'A &amp; B',
      Amount: 100,
      Nested: { Note: '&lt;ok&gt;', Flags: [true, 'C &amp; D'] },
    });
    expect(decoded).toEqual({
      Name: 'A & B',
      Amount: 100,
      Nested: { Note: '<ok>', Flags: [true, 'C & D'] },
    });
  });
});

// ─── Shared client layer: write bodies + query encoding ──────────────────────

function makeClient() {
  const future = new Date(Date.now() + 60 * 60 * 1000);
  const fakeTokenStore = {
    getConnection: () => ({
      status: 'active',
      tokenExpiry: future,
      accessToken: 'test-token',
    }),
  };
  return new QBOClient(fakeTokenStore as any, { clientId: '', clientSecret: '', redirectUri: '' }, 'sandbox');
}

describe('QBOClient write-path round trip (acceptance #4)', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true }),
    });
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends literal & < > \' byte-identical on the first write of a fresh client', async () => {
    const client = makeClient();
    await client.post('realm-1', 'customer', { CompanyName: `Smith & Jones <Holdings> 'LLC'` });
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.CompanyName).toBe(`Smith & Jones <Holdings> 'LLC'`);
  });

  it('normalizes stray upstream entities before the write reaches QBO', async () => {
    const client = makeClient();
    await client.post('realm-1', 'customer', {
      CompanyName: 'Miller &amp; Grant Consulting',
      BillAddr: { Line1: '1 &lt;Main&gt; St' },
    });
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.CompanyName).toBe('Miller & Grant Consulting');
    expect(body.BillAddr.Line1).toBe('1 <Main> St');
  });

  it('derives the idempotency requestid from the normalized body', async () => {
    const client = makeClient();
    await client.post('realm-1', 'customer', { CompanyName: 'A &amp; B' });
    await client.post('realm-1', 'customer', { CompanyName: 'A & B' });
    const url1 = new URL(fetchSpy.mock.calls[0][0]);
    const url2 = new URL(fetchSpy.mock.calls[1][0]);
    // Same normalized payload → same requestid → QBO dedupes the double-send
    expect(url1.searchParams.get('requestid')).toBe(url2.searchParams.get('requestid'));
  });

  it('does not rewrite GET responses or query strings', async () => {
    const client = makeClient();
    await client.query('realm-1', "SELECT * FROM Customer WHERE DisplayName = 'A &amp; B'");
    const url: string = fetchSpy.mock.calls[0][0];
    // Query text passes through encoded but NOT entity-decoded — reads must
    // match whatever is literally stored.
    expect(decodeURIComponent(url)).toContain("DisplayName = 'A &amp; B'");
  });
});

describe('QBOClient query encoding (item 5 projection passthrough)', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('percent-encodes spaces as %20 (not +) and passes projections through unmangled', async () => {
    const client = makeClient();
    const q = "SELECT Id, DisplayName FROM Customer WHERE Active = true";
    await client.query('realm-1', q);
    const url: string = fetchSpy.mock.calls[0][0];
    expect(url).toContain('/company/realm-1/query?query=');
    expect(url).not.toContain('+'); // no form-encoding ambiguity
    expect(url).toContain('SELECT%20Id%2C%20DisplayName%20FROM%20Customer');
    expect(decodeURIComponent(url.split('query?query=')[1])).toBe(q);
  });
});
