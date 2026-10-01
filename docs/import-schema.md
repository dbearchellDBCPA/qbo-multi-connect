# Bulk transaction import: normalized schema and tools

The bulk-import tools load transaction history from any source system
(NetSuite first) into a QuickBooks Online company. You get real QBO
transactions, so bank registers show payees, vendor and customer
sub-ledgers and aging work, and classes carry through. The agent converts the
source export into the **normalized schema** below. The server validates
every row against the live company, writes through the QBO batch endpoint and
records each `source_id → QBO transaction` mapping. A re-run is always safe.

Workflow for a month of history:

1. `batch_create_names`: vendors, customers and employees.
2. `ensure_items`: one Service item per income account, for invoice and sales lines.
3. `import_transactions` with `dry_run=true`: read the table and fix the failures.
4. `import_transactions` live, with a `run_id` such as `netsuite-2024-07`.
5. Re-run the same file. Every row should come back `unchanged`.
6. `import_status` with that `run_id`. Counts and sums by type should match the source.
7. If needed, `delete_imported_transactions` with that `run_id` rolls the load back.

Nothing in the server refers to any client's chart, names or mappings. Accounts
resolve by number or name, and names resolve by DisplayName, all against the
live company at call time.

## Tools

| Tool | What it does |
|---|---|
| `batch_create_names` | Creates up to 500 vendors, customers and employees per call. A name is checked against all three lists, because QBO requires DisplayName to be unique across them. A name held by another type fails, and the message names that type. Existing names of the same type are `unchanged`, or `updated` with `on_existing="update"`. |
| `ensure_items` | Makes sure a non-taxable Service item exists for each income account. The default name is `History - {account_name}`. |
| `import_transactions` | Loads up to 500 normalized transactions per call. Each row gets a status, and a JSON and CSV log is written. |
| `import_status` | Read-only. Queries the mapping store by run, source ids, type, dates or status. Returns counts and sums by type and status. |
| `rebuild_import_index` | Scans QBO by date range for `[src:…]` stamps and recovers or verifies the store. Reports source ids stamped on more than one transaction. |
| `delete_imported_transactions` | Rolls back a run or a list of source ids. Payments go first. A transaction whose stamp was edited away is refused unless `force=true`. |

All six tools take `client_name`. Every tool except `import_status` also takes `dry_run`.

## Statuses

| Status | Meaning |
|---|---|
| `created` | Written to QBO and recorded in the store. |
| `updated` | The source_id already existed and the row differed. With `on_existing="update"` the QBO transaction was rewritten in place: same Id, and Line Ids carried so lines are replaced, not appended. |
| `unchanged` | Already imported and identical. Nothing was written. |
| `skipped` | Already imported, but the row differs. With `on_existing="skip"` (the default), QBO was left alone. |
| `blocked` | A Payment or BillPayment whose linked Invoice or Bill `source_id` is not imported yet, or failed in this call. Load the target and re-run, and the row then links. This is **not** a failure. |
| `failed` | The row cannot be written. The reason is given: unknown account, name, class or item; wrong account type for the slot; unbalanced JE; A/R line without a Customer; A/P line without a Vendor; more than one A/R or A/P account; date in a closed period; DocNumber over 21 characters; or QBO's own fault text verbatim. |
| `would create` / `would update` | Dry run only. Nothing is written to QBO or the store. |

A row's fate never aborts the batch unless `stop_on_first_failure=true`.

Idempotency has three layers:

1. The mapping store.
2. A PrivateNote stamp scan in QBO, over the date range of rows unknown to the store. A lost store therefore never causes duplicates, and stamped rows found this way are adopted as `indexed`.
3. QBO `requestid` replay on every retried batch request.

## Transaction fields

```jsonc
{
  "source_id": "netsuite:21500",          // REQUIRED, unique per company; no "]" or line breaks
  "txn_type": "Bill",                     // see the 15 types below
  "txn_date": "2024-07-15",               // YYYY-MM-DD
  "doc_number": "INV-1001",               // ≤ 21 chars (longer fails unless truncate_doc_numbers=true)
  "memo": "From NetSuite",                // → PrivateNote, followed by " [src:<source_id>]" (≤ 4000 together)
  "entity": { "name": "Acme", "type": "Vendor" },   // payee / vendor / customer (type strongly recommended)
  "account_number": "1000",               // header account slot (bank, card, deposit-to, A/P, A/R…); or account_name
  "class": "East",                        // default class for lines
  "lines": [
    {
      "account_number": "6000",           // or "account_name": "Travel:Meals" (fully qualified OK)
      "amount": 125.00,                   // always positive
      "posting_type": "Debit",            // JournalEntry only
      "description": "…",                 // ≤ 4000
      "entity": { "name": "Globex", "type": "Customer" },  // JE / Deposit / expense-line customer
      "class": "West",
      "item_name": "Consulting",          // sales types: an item, or give the income account instead
      "quantity": 2                       // sales types; unit price = amount / quantity
    }
  ],
  "linked": [{ "source_id": "netsuite:1999", "amount": 125.00 }], // Payment / BillPayment
  "payment_method": "Check",              // Expense: Cash | Check | CreditCard; BillPayment: Check | CreditCard
  "check_number": "5001",                 // Check / BillPayment → DocNumber; Payment → PaymentRefNum
  "transfer_to_account_number": "1010",   // Transfer (or transfer_to_account_name)
  "amount": 1000.00,                      // Transfer amount; Payment/BillPayment total if > sum of linked
  "due_date": "2024-08-14",               // Bill / Invoice
  "terms": "Net 30"                       // Bill / Invoice, by name
}
```

Unknown keys are rejected, so typos like `amout` fail the whole call naming the
field. Account resolution order: exact `AcctNum`, then fully qualified name,
then plain name if it is unique. An active account wins over an inactive one.

Account slots by type:

| txn_type | QBO entity | `account_number` (header) | lines | entity |
|---|---|---|---|---|
| JournalEntry | JournalEntry | not used | account + `posting_type`, must balance | per line; required on A/R (Customer) and A/P (Vendor) lines |
| Expense | Purchase (PaymentType from `payment_method`, default Cash) | Bank paid from (Credit Card if `payment_method=CreditCard`) | expense accounts | payee, any type |
| Check | Purchase, PaymentType Check | Bank | expense accounts | payee |
| CreditCardCharge | Purchase, PaymentType CreditCard | Credit Card | expense accounts | payee |
| CreditCardCredit | Purchase, CreditCard, Credit=true | Credit Card | expense accounts | payee |
| Deposit | Deposit | Bank / Other Current Asset deposit-to | received-from accounts | per line (txn entity = default) |
| Transfer | Transfer | from account | none (`amount`) | not used (QBO has none) |
| Bill / VendorCredit | Bill / VendorCredit | optional A/P account | expense accounts | Vendor, required |
| BillPayment | BillPayment | Bank (Check) or Credit Card (CreditCard) paid from | none (`linked`) | Vendor, required |
| Invoice / CreditMemo | Invoice / CreditMemo | optional A/R account | items or income accounts | Customer, required |
| SalesReceipt / RefundReceipt | SalesReceipt / RefundReceipt | deposit-to / refund-from (required for RefundReceipt) | items or income accounts | Customer, optional |
| Payment | Payment | optional deposit-to (default Undeposited Funds) | none (`linked`) | Customer, required |

## One example per `txn_type`

```json
[
  { "source_id": "ns:je-1", "txn_type": "JournalEntry", "txn_date": "2024-07-31", "doc_number": "JE-0731", "memo": "July accrual",
    "lines": [
      { "account_number": "6000", "amount": 100, "posting_type": "Debit", "entity": { "name": "Acme Supplies", "type": "Vendor" }, "class": "East" },
      { "account_number": "6100", "amount": 50, "posting_type": "Debit", "entity": { "name": "Jane Smith", "type": "Employee" } },
      { "account_number": "1200", "amount": 75, "posting_type": "Credit", "entity": { "name": "Globex Corp", "type": "Customer" } },
      { "account_number": "1000", "amount": 75, "posting_type": "Credit" } ] },

  { "source_id": "ns:exp-1", "txn_type": "Expense", "txn_date": "2024-07-02", "payment_method": "Cash", "account_number": "1000",
    "entity": { "name": "Acme Supplies", "type": "Vendor" }, "memo": "Pens", "lines": [{ "account_number": "6000", "amount": 25.10 }] },

  { "source_id": "ns:chk-1", "txn_type": "Check", "txn_date": "2024-07-03", "check_number": "5001", "account_number": "1000",
    "entity": { "name": "Landlord LLC", "type": "Vendor" }, "lines": [{ "account_number": "6100", "amount": 3000 }] },

  { "source_id": "ns:cc-1", "txn_type": "CreditCardCharge", "txn_date": "2024-07-04", "account_number": "2100",
    "entity": { "name": "Acme Supplies", "type": "Vendor" }, "lines": [{ "account_name": "Travel:Meals", "amount": 42 }] },

  { "source_id": "ns:ccc-1", "txn_type": "CreditCardCredit", "txn_date": "2024-07-05", "account_number": "2100",
    "entity": { "name": "Acme Supplies", "type": "Vendor" }, "lines": [{ "account_number": "6000", "amount": 10 }] },

  { "source_id": "ns:dep-1", "txn_type": "Deposit", "txn_date": "2024-07-06", "account_number": "1000",
    "lines": [
      { "account_number": "4000", "amount": 400, "entity": { "name": "Globex Corp", "type": "Customer" } },
      { "account_number": "4100", "amount": 100, "entity": { "name": "Initech", "type": "Customer" } } ] },

  { "source_id": "ns:xfer-1", "txn_type": "Transfer", "txn_date": "2024-07-07", "account_number": "1000",
    "transfer_to_account_number": "1010", "amount": 1000, "memo": "To savings" },

  { "source_id": "ns:bill-100", "txn_type": "Bill", "txn_date": "2024-07-08", "doc_number": "B-100", "due_date": "2024-08-07", "terms": "Net 30",
    "entity": { "name": "Acme Supplies", "type": "Vendor" },
    "lines": [{ "account_number": "6000", "amount": 200, "class": "East" }, { "account_number": "6100", "amount": 300 }] },

  { "source_id": "ns:vc-1", "txn_type": "VendorCredit", "txn_date": "2024-07-09", "entity": { "name": "Acme Supplies", "type": "Vendor" },
    "lines": [{ "account_number": "6000", "amount": 20 }] },

  { "source_id": "ns:bp-1", "txn_type": "BillPayment", "txn_date": "2024-07-14", "entity": { "name": "Acme Supplies", "type": "Vendor" },
    "account_number": "1000", "payment_method": "Check", "check_number": "5002",
    "linked": [{ "source_id": "ns:bill-100", "amount": 500 }] },

  { "source_id": "ns:inv-1", "txn_type": "Invoice", "txn_date": "2024-07-10", "doc_number": "INV-1", "due_date": "2024-08-09",
    "entity": { "name": "Globex Corp", "type": "Customer" },
    "lines": [{ "account_number": "4000", "amount": 750, "description": "Hours" }, { "item_name": "Widget", "amount": 250, "quantity": 5 }] },

  { "source_id": "ns:pmt-1", "txn_type": "Payment", "txn_date": "2024-07-15", "entity": { "name": "Globex Corp", "type": "Customer" },
    "account_number": "1499", "check_number": "881", "linked": [{ "source_id": "ns:inv-1", "amount": 600 }] },

  { "source_id": "ns:cm-1", "txn_type": "CreditMemo", "txn_date": "2024-07-11", "entity": { "name": "Globex Corp", "type": "Customer" },
    "lines": [{ "account_number": "4000", "amount": 40 }] },

  { "source_id": "ns:sr-1", "txn_type": "SalesReceipt", "txn_date": "2024-07-12", "account_number": "1000",
    "entity": { "name": "Walk-in", "type": "Customer" }, "lines": [{ "account_number": "4100", "amount": 120 }] },

  { "source_id": "ns:rr-1", "txn_type": "RefundReceipt", "txn_date": "2024-07-13", "account_number": "1000",
    "entity": { "name": "Walk-in", "type": "Customer" }, "lines": [{ "account_number": "4100", "amount": 30 }] }
]
```

Sales lines given by `account_number` use the item that `ensure_items` made for
that income account. If there is no such item but exactly one item maps to the
account, that item is used. Otherwise the row fails and tells you to run
`ensure_items`.

## Names (`batch_create_names`) and items (`ensure_items`)

```json
{ "display_name": "Acme Supplies", "name_type": "Vendor", "company_name": "Acme Supplies LLC", "email": "ap@acme.test",
  "phone": "555-0100", "billing_address": { "street": "1 Main St", "city": "Albany", "state": "NY", "postal_code": "12207" },
  "terms": "Net 30", "vendor_1099": true, "account_number": "V-001", "notes": "…", "active": true, "source_id": "netsuite:v:88" }
```

`source_id` is stored in the Vendor's `AcctNum` unless `account_number` is
given, or appended to a Customer's Notes as `[src:<id>]`. It is always echoed
back. An Employee without `given_name` or `family_name` gets them from the
display name.

```json
{ "account_number": "4000", "item_name": "History - Consulting", "expense_account_number": "5000", "description": "…" }
```

## Options of `import_transactions`

| Option | Default | Effect |
|---|---|---|
| `dry_run` | false | Resolve and validate against the live company, write nothing. |
| `on_existing` | `skip` | For changed rows that are already imported: `skip`, `update` or `fail`. |
| `run_id` | `run-<UTC timestamp>` | Your label for the load. A transaction keeps the run_id of the call that created it. |
| `stop_on_first_failure` | false | Validation failure: nothing is written. QBO rejection: later batch requests are not sent. |
| `allow_closed_period` | false | Allow dates on or before the books closing date. |
| `allow_doc_number_suffix` | false | On QBO 6140 (duplicate document number), retry with `-2`, `-3`, `-4`. |
| `truncate_doc_numbers` | false | Cut DocNumbers over 21 characters, with a warning, instead of failing the row. |
| `item_name_pattern` | `History - {account_name}` | Must match the pattern `ensure_items` used. |

## QBO limits and rules applied

Sources: Intuit developer docs, *Batch* and *Throttles*, checked 2026-09-30.

- **Batch endpoint:** at most 30 operations per request, and at most 40 batch
  requests per minute per company (realm). The runner sends ≤30-operation
  chunks one at a time and keeps a per-realm sliding 60-second window shared
  by all calls in the process. The general limits (500 requests per minute,
  10 concurrent per realm) are never approached.
- **Throttling:** HTTP 429 `ThrottleExceeded` (error code 003001 / 3001),
  408 and 5xx responses, and network errors are retried with exponential
  backoff (2 s, 4 s, … up to 60 s, 6 retries, honouring Retry-After). The
  retry reuses the **same `requestid`**, so QBO replays a request that had
  already committed instead of writing it twice. Item-level 3001 faults are
  re-queued alone. Every fault is logged with the row's source_id.
- **6140 (Duplicate Document Number):** explained. Fix it by changing
  `doc_number`, or by passing `allow_doc_number_suffix`.
- **A/R and A/P:** one transaction may use at most **one** A/R or A/P
  account: not two A/R, not two A/P, and not A/R together with A/P. An A/R
  line needs a Customer and an A/P line needs a Vendor. These are checked
  before QBO sees the row.
- DocNumber is limited to 21 characters, PrivateNote and line descriptions to
  4000. Amounts must be positive with at most 2 decimals, and dates must be
  real.

## Where the store and logs live

Both are in the server's **data directory**, the directory of `QBO_DB_PATH`.
On Railway that is the persistent volume `/data`.

- Mapping store: `<data dir>/qbo-import-index.db`, a SQLite file **separate**
  from `qbo-connections.db`. No migration touches the connections database.
  Table `imported_transactions` has one live row per (realm, source_id), and
  `deleted` rows are kept as history.
- Run logs: `<data dir>/import-runs/<client>/<run_id>__<tool>__<timestamp>.json`
  and `.csv`, for every `import_transactions` and `delete_imported_transactions`
  call. The JSON has every row, its status, QBO id, warnings and QBO fault, plus
  the counts and throttle stats.

If the store is lost, delete `qbo-import-index.db` together with its `-wal`
and `-shm` files and run `rebuild_import_index` per run date range. Even
without a rebuild, `import_transactions` finds stamped rows in QBO before
writing.

## Sandbox test plan

Run this against a **sandbox** company on a sandbox deployment only.
`scripts/sandbox-import.ts` (`npm run sandbox:import`) automates it with the
same scenario the vitest suite runs against a fake QBO
(`tests/support/bulk-import-scenario.ts`). It then deletes every transaction it
imported.

```
npm run sandbox:import -- --url https://<sandbox-host>/mcp --key <api key> \
  --client "Sandbox Company_US_1" --accounts accounts.json --closed-date 2025-12-31 --confirm
```

1. `batch_create_names` with new, existing and cross-type names. Re-run and confirm `unchanged`.
2. `ensure_items` for two income accounts. Re-run.
3. `import_transactions` dry run, then live, with every `txn_type`:
   - a JE with vendor, customer and employee line names and a class
   - an Expense paid in Cash and a Check with a check number
   - a Deposit with two received-from lines
   - a Bill and its BillPayment, plus a BillPayment sent before its Bill, which comes back `blocked`
   - an Invoice using an `ensure_items` item, and a Payment linked to it
   - a Transfer, a CreditCardCharge and a CreditCardCredit
4. Re-run the batch: all `unchanged`, with 0 batch requests. Change a memo: `skipped`. With `on_existing="update"`: `updated`.
5. Bad rows: unbalanced JE, unknown account, a name of the wrong type, a date before the closing date, and a 25-character DocNumber. Each one fails clearly while the good row loads.
6. `rebuild_import_index` after deleting the SQLite file restores the store. On a remote server the script runs it verify-only.
7. `delete_imported_transactions` for each run, then `import_status` shows the rows as `deleted`.
8. A 400-transaction batch: throttling and backoff, a complete table, and the JSON and CSV log. Re-run it, then delete it.

The names and items the plan creates are prefixed (`ZZI …`). QBO cannot
delete names or items, so deactivate them in the sandbox if you want them gone.
