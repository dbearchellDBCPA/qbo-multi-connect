/**
 * QBO DocNumber ("Journal no." / "Ref no." / check number) helpers.
 *
 * Pure + unit-tested (tests/server/doc-number.test.ts). Shared by the
 * create_* / update_* handlers for journal entries, deposits, bills,
 * sales receipts and invoices so every tool validates and writes DocNumber
 * the same way.
 *
 * Invariant: these helpers only ever touch `DocNumber`. They never read,
 * rebuild or replace `Line` — a doc_number-only update must post the fetched
 * Line array exactly as QBO returned it (Ids included). Rebuilding lines
 * without Ids makes QBO APPEND instead of replace (see PR #5, update_deposit).
 */

/** QBO rejects DocNumber values longer than 21 characters. */
export const DOC_NUMBER_MAX_LENGTH = 21;

/**
 * Returns a caller-facing error string when doc_number is invalid, otherwise
 * null. Call BEFORE fetching/posting anything so nothing is written.
 */
export function docNumberError(docNumber: string | undefined | null): string | null {
  if (docNumber === undefined || docNumber === null) return null;
  if (docNumber.length > DOC_NUMBER_MAX_LENGTH) {
    return `doc_number "${docNumber}" is ${docNumber.length} characters; QuickBooks allows at most ${DOC_NUMBER_MAX_LENGTH}. Nothing was posted.`;
  }
  return null;
}

/**
 * Create path: set DocNumber only when a non-empty value was supplied.
 * An empty string on create is treated as "not supplied" — QBO stores ""
 * verbatim, which then sorts/filters differently from a truly unset number
 * (same convention as create_expense / create_bill_payment).
 */
export function applyDocNumberOnCreate<T extends Record<string, any>>(payload: T, docNumber: string | undefined): T {
  if (docNumber) (payload as any).DocNumber = docNumber;
  return payload;
}

/**
 * Update path (read-modify-write): set DocNumber only when doc_number was
 * passed (`!== undefined`). Passing "" deliberately CLEARS the number — QBO
 * accepts an empty DocNumber on a full update and the Ref/Journal no. field
 * shows blank. Omitting doc_number leaves the fetched value untouched.
 * Mutates and returns `payload`; never touches `payload.Line`.
 */
export function applyDocNumberOnUpdate<T extends Record<string, any>>(payload: T, docNumber: string | undefined): T {
  if (docNumber !== undefined) (payload as any).DocNumber = docNumber;
  return payload;
}

/**
 * Suffix for success summaries: " | <label>: <DocNumber>" when the saved
 * record has one, otherwise "".
 */
export function docNumberSummary(record: any, label = 'Ref No'): string {
  const dn = record?.DocNumber;
  return dn !== undefined && dn !== null && dn !== '' ? ` | ${label}: ${dn}` : '';
}

export const DOC_NUMBER_PARAM_DESCRIPTION =
  `Reference number (QBO DocNumber — the "Ref no." / "Journal no." field). Max ${DOC_NUMBER_MAX_LENGTH} characters.`;

export const DOC_NUMBER_UPDATE_PARAM_DESCRIPTION =
  `${DOC_NUMBER_PARAM_DESCRIPTION} Only changes when provided; pass "" to clear it. A doc_number-only update leaves every line (and its Id), the date and all other fields exactly as they are.`;
