/**
 * set_closing_date — change Preferences.AccountingInfoPrefs.BookCloseDate.
 *
 * Research notes (2026-10-23):
 *  - Intuit's Preferences reference lists AccountingInfoPrefs.BookCloseDate as
 *    "Read-only (minorVersion 21)". A sparse update may therefore be ignored or
 *    rejected by QBO. We never trust the POST response alone: the tool re-reads
 *    Preferences and reports what QBO actually holds, and fails loudly if the
 *    new value didn't stick.
 *  - No documented or community-verified way exists to CLEAR the closing date
 *    via the API (omitting the field in a sparse update changes nothing by
 *    definition; an empty string is not a valid xs:date). So `null` returns an
 *    explicit "not supported" error and writes nothing.
 *  - The closing-date password is not exposed by the API at all. API writes
 *    into a closed period are refused with faults 6200/6210 "Account Period
 *    Closed" regardless of the password; the password only gates UI edits.
 */

export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isValidIsoDate(s: string): boolean {
  if (!DATE_RE.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

export interface ClosingDateCompanyApi {
  getPreferences(realmId: string): Promise<unknown>;
  updatePreferences(realmId: string, body: Record<string, unknown>): Promise<unknown>;
}

export interface SetClosingDateResult {
  ok: boolean;
  changed: boolean;
  before: string | null;
  after: string | null;
  requested: string | null;
  syncTokenBefore?: string;
  syncToken?: string;
  verified?: boolean;
  error?: string;
}

function unwrap(prefs: any): any {
  return prefs?.Preferences ?? prefs ?? {};
}

export function buildSparsePreferencesUpdate(id: string, syncToken: string, closingDate: string): Record<string, unknown> {
  return { sparse: true, Id: id, SyncToken: syncToken, AccountingInfoPrefs: { BookCloseDate: closingDate } };
}

export const CLEAR_NOT_SUPPORTED =
  "Clearing the closing date (closing_date: null) is not supported through QuickBooks Online's API: Intuit documents " +
  'AccountingInfoPrefs.BookCloseDate as read-only and publishes no way to remove it. Nothing was changed. To turn the ' +
  'close off, a company admin must use QBO: Settings → Account and settings → Advanced → Accounting → Close the books. ' +
  'Alternatively set an earlier date with set_closing_date.';

export async function setClosingDate(
  api: ClosingDateCompanyApi,
  realmId: string,
  closingDate: string | null,
  opts: { canWrite: boolean }
): Promise<SetClosingDateResult> {
  const base = { ok: false, changed: false, before: null, after: null, requested: closingDate };
  if (!opts.canWrite) {
    return { ...base, error: 'This API key is read-only; set_closing_date is a write tool.' };
  }
  if (closingDate !== null && !isValidIsoDate(closingDate)) {
    return { ...base, error: `Invalid closing_date "${closingDate}": expected a real calendar date in YYYY-MM-DD format, or null.` };
  }

  const current = unwrap(await api.getPreferences(realmId));
  const before: string | null = current?.AccountingInfoPrefs?.BookCloseDate ?? null;
  const syncTokenBefore: string | undefined = current?.SyncToken;

  if (before === closingDate) {
    return { ok: true, changed: false, before, after: before, requested: closingDate, syncTokenBefore, syncToken: syncTokenBefore, verified: true };
  }
  if (closingDate === null) {
    return { ...base, before, after: before, syncTokenBefore, error: CLEAR_NOT_SUPPORTED };
  }
  if (!current?.Id || syncTokenBefore === undefined) {
    return { ...base, before, after: before, error: 'Preferences response had no Id/SyncToken; cannot send a safe sparse update.' };
  }

  const resp = unwrap(await api.updatePreferences(realmId, buildSparsePreferencesUpdate(String(current.Id), String(syncTokenBefore), closingDate)));
  const reread = unwrap(await api.getPreferences(realmId));
  const after: string | null = reread?.AccountingInfoPrefs?.BookCloseDate ?? null;
  const syncToken: string | undefined = reread?.SyncToken ?? resp?.SyncToken;
  const verified = after === closingDate;
  return {
    ok: verified,
    changed: after !== before,
    before,
    after,
    requested: closingDate,
    syncTokenBefore,
    syncToken,
    verified,
    ...(verified
      ? {}
      : {
          error:
            `QBO accepted the request but the re-read closing date is ${after ?? 'not set'}, not ${closingDate}. ` +
            'Intuit documents BookCloseDate as read-only, so QBO likely ignored the update. Change it in the QBO UI instead.',
        }),
  };
}

export function formatSetClosingDateResult(clientName: string, r: SetClosingDateResult): string {
  const lines = [`SET CLOSING DATE — ${clientName}`];
  if (r.error) lines.push(`ERROR: ${r.error}`);
  else if (!r.changed) lines.push(`Unchanged: closing date already ${r.before ?? 'not set'} (no write sent).`);
  else lines.push('Updated and confirmed by re-reading Preferences from QBO.');
  lines.push(`Before: ${r.before ?? 'not set'}`, `After (re-read from QBO): ${r.after ?? 'not set'}`);
  if (r.syncToken !== undefined) lines.push(`SyncToken: ${r.syncTokenBefore ?? '?'} → ${r.syncToken}`);
  lines.push(
    'Reminder: the closing-date password is not visible or changeable via the API and is left as-is. ' +
      'If you lifted the close to fix a transaction, restore the original date when done.'
  );
  lines.push('```json', JSON.stringify(r), '```');
  return lines.join('\n');
}
