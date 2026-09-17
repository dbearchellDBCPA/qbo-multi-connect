# QBO Skill — patch notes for the 2026-09-17 sales-form prefill

Apply these from a Cowork session AFTER the server is redeployed with the
sales-form prefill (`src/server/prefill.ts`). They keep
`/mnt/skills/user/qbo/SKILL.md` in sync with what the server now does.

## 1. `/mnt/skills/user/qbo/SKILL.md` — *Customer Revenue Cycle* section

Replace the `create_invoice` step with:

> `create_invoice` — create the invoice. It now prefills what you leave blank
> the way the QBO UI does when you pick the customer: the next DocNumber in
> the shared sales sequence (when the company uses custom transaction numbers),
> the line class, BillEmail plus cc/bcc, billing/shipping address, terms, the
> customer message, and `EmailStatus = NeedToSend` so it lands in the Send
> forms queue. Sources, in order: your explicit arguments → the Customer
> record → the customer's most recent invoices → company Preferences.
>
> The response ends with a JSON block: `prefilled` (field → "source → value")
> and `warnings`. Read both and report them, e.g. "Invoice 5813 created —
> numbered from the sales sequence; class 7000 – DCM Ingram Center and cc
> obingram@ingramentities.com copied from invoice #5735".
>
> For class-tracked companies pass `class_id` explicitly when the customer
> has no prior invoice to copy from — the response warns `no class set`.
> Pass `prefill: false` only when you want exactly what you send (the old
> behavior).

The same applies to `create_estimate`, `create_credit_memo` and
`create_sales_receipt` (they fall back to the customer's invoices when there
is no prior form of their own kind), and to `create_bill` /
`create_purchase_order` for vendors (terms, AP account, department, address,
class and expense account of the vendor's last bill; a bill's DocNumber is the
vendor's number and is never generated).

## 2. *Update Behavior*

- `update_invoice` is sparse-safe: header fields you do not pass (DocNumber,
  BillEmail/Cc/Bcc, CustomerMemo, EmailStatus, addresses, terms, department)
  stay as they are. Replacement `lines` that carry no `class_id` inherit the
  class the existing lines shared; `class_id` without `lines` re-classes the
  existing lines in place. New header params: `doc_number`, `class_id`,
  `bill_email`, `bill_email_cc`, `bill_email_bcc`, `customer_memo`,
  `email_status`, `bill_addr`, `ship_addr`.
- Lines returned by `get_invoice` / `get_estimate` / `get_credit_memo` /
  `get_sales_receipt` now round-trip with `class_id` and `tax_code_id` intact
  through the matching `update_*` tool (previously those keys were silently
  dropped).

## 3. *Attachments*

`create_attachment` with `file_url` follows redirects, sends a browser-style
User-Agent, and names the file from `file_name` → `Content-Disposition` → the
URL path → the bytes. Dropbox temporary links (`…/file?c_luid=…`) work. When
something fails the output says what was fetched (HTTP status, byte count,
content type) and what QBO answered — no more bare "no Attachable returned".
An HTML page returned in place of the file (expired or consumed link) is
refused with its first bytes shown; mint a fresh link and retry.

## 4. Parameter cheat-sheet (all sales create tools)

| Param | Default | Meaning |
|---|---|---|
| `prefill` | `true` | Run the prefill layer; `false` = send exactly what was passed |
| `doc_number` | — | Explicit DocNumber |
| `class_id` | — | Header-level class → every line without its own `class_id` |
| `lines[].class_id`, `lines[].tax_code_id` | — | Per-line class / tax code |
| `bill_email`, `bill_email_cc`, `bill_email_bcc` | — | Email recipients |
| `customer_memo` | — | Message printed on the form |
| `email_status` | `NeedToSend` when prefill is on | `NotSet` \| `NeedToSend` \| `EmailSent` |
| `bill_addr`, `ship_addr` | — | Address overrides |

`create_purchase_order` uses `po_email` and `vendor_memo` in place of the
customer email/memo params; `create_bill` has no email params.
