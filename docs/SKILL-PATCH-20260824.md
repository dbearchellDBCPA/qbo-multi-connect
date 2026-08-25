# QBO Skill — patch notes for the 2026-08-24 server fixes

Apply these from a Cowork session AFTER the server is redeployed with the
2026-08-24 fixes. They keep `/mnt/skills/user/qbo/SKILL.md` (and the
qbd-financials renderer) in sync with what the server now actually does.

## 1. `/mnt/skills/user/qbo/SKILL.md`

- DELETE the "⚠️ `update_deposit` APPENDS lines" guardrail block (added
  8/11 — it says to remove it once fixed).
- DELETE the "Exception — `update_deposit` appends" paragraph under
  Update Behavior.
- The accurate semantics now are: each array is independent — a provided
  array replaces that kind of line; an OMITTED array preserves the existing
  lines of that kind; `linked_payment_ids: []` explicitly returns those
  payments to Undeposited Funds. Every line change is verified after the
  write and automatically rolled back to the original lines on mismatch.

## 2. `/mnt/skills/user/qbd-financials/` (render_financials.py + input.json builder)

`get_general_ledger` now reports true `debit` / `credit` per transaction and
per-account `total_debits` / `total_credits` that are CORRECT for
credit-normal accounts (liability / equity / income). Before this fix those
totals were swapped for credit-normal accounts (positive amount was always
counted as a debit). If the renderer's GL debits = credits self-check (or
any of its math) compensates for the old swapped labels, remove that
compensation when the fixed server deploys — otherwise the compensation
itself becomes the bug. Each parsed account now also carries a
`classification` field and a top-level `debit_credit_source`
("report_columns" or "amount_sign_by_classification") you can assert on.
