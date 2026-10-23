import { describe, it, expect, vi } from 'vitest';
import {
  setClosingDate,
  buildSparsePreferencesUpdate,
  formatSetClosingDateResult,
  isValidIsoDate,
  CLEAR_NOT_SUPPORTED,
} from '../../src/server/closing-date.js';

const REALM = '123';

/** Mock company API: an in-memory Preferences record that honours (or ignores) writes. */
function mockApi(initial: string | null, opts: { honourWrites?: boolean; syncToken?: string } = {}) {
  const state = { closeDate: initial, syncToken: opts.syncToken ?? '7' };
  const prefs = () => ({
    Preferences: {
      Id: '1',
      SyncToken: state.syncToken,
      AccountingInfoPrefs: state.closeDate === null ? { FirstMonthOfFiscalYear: 'January' } : { BookCloseDate: state.closeDate },
    },
  });
  const api = {
    getPreferences: vi.fn(async () => prefs()),
    updatePreferences: vi.fn(async (_realm: string, body: any) => {
      if (body.SyncToken !== state.syncToken) throw new Error('Stale Object Error');
      state.syncToken = String(Number(state.syncToken) + 1);
      if (opts.honourWrites !== false) state.closeDate = body.AccountingInfoPrefs.BookCloseDate;
      return prefs();
    }),
  };
  return { api, state };
}

describe('set_closing_date', () => {
  it('builds the sparse Preferences payload shape', () => {
    expect(buildSparsePreferencesUpdate('1', '7', '2025-12-31')).toEqual({
      sparse: true,
      Id: '1',
      SyncToken: '7',
      AccountingInfoPrefs: { BookCloseDate: '2025-12-31' },
    });
  });

  it('posts the sparse update with the current SyncToken and nothing else', async () => {
    const { api } = mockApi('2025-12-31', { syncToken: '42' });
    await setClosingDate(api, REALM, '2025-06-30', { canWrite: true });
    expect(api.updatePreferences).toHaveBeenCalledTimes(1);
    const [realm, body] = api.updatePreferences.mock.calls[0];
    expect(realm).toBe(REALM);
    expect(body).toEqual({ sparse: true, Id: '1', SyncToken: '42', AccountingInfoPrefs: { BookCloseDate: '2025-06-30' } });
  });

  it('returns before/after (re-read) and the new SyncToken', async () => {
    const { api } = mockApi('2025-12-31');
    const r = await setClosingDate(api, REALM, '2025-06-30', { canWrite: true });
    expect(r).toMatchObject({ ok: true, changed: true, verified: true, before: '2025-12-31', after: '2025-06-30', syncTokenBefore: '7', syncToken: '8' });
    expect(api.getPreferences).toHaveBeenCalledTimes(2); // read, then confirm
    const text = formatSetClosingDateResult('Acme', r);
    expect(text).toContain('Before: 2025-12-31');
    expect(text).toContain('After (re-read from QBO): 2025-06-30');
    expect(text).toContain('SyncToken: 7 → 8');
  });

  it('reports an error if QBO ignores the write (re-read does not match)', async () => {
    const { api } = mockApi('2025-12-31', { honourWrites: false });
    const r = await setClosingDate(api, REALM, '2025-06-30', { canWrite: true });
    expect(r.ok).toBe(false);
    expect(r.after).toBe('2025-12-31');
    expect(r.error).toMatch(/read-only/);
  });

  it('is a no-op when the date already matches', async () => {
    const { api } = mockApi('2025-12-31');
    const r = await setClosingDate(api, REALM, '2025-12-31', { canWrite: true });
    expect(r).toMatchObject({ ok: true, changed: false, before: '2025-12-31', after: '2025-12-31' });
    expect(api.updatePreferences).not.toHaveBeenCalled();
    expect(formatSetClosingDateResult('Acme', r)).toContain('Unchanged');
  });

  it('null (clear) returns a not-supported error and writes nothing', async () => {
    const { api } = mockApi('2025-12-31');
    const r = await setClosingDate(api, REALM, null, { canWrite: true });
    expect(r.ok).toBe(false);
    expect(r.error).toBe(CLEAR_NOT_SUPPORTED);
    expect(r.before).toBe('2025-12-31');
    expect(api.updatePreferences).not.toHaveBeenCalled();
  });

  it('null when no close is set is a no-op', async () => {
    const { api } = mockApi(null);
    const r = await setClosingDate(api, REALM, null, { canWrite: true });
    expect(r).toMatchObject({ ok: true, changed: false, before: null, after: null });
    expect(api.updatePreferences).not.toHaveBeenCalled();
  });

  it.each(['2025/12/31', '12-31-2025', '2025-13-01', '2025-02-30', '', 'yesterday'])('rejects bad date %j without calling QBO', async (bad) => {
    const { api } = mockApi('2025-12-31');
    const r = await setClosingDate(api, REALM, bad, { canWrite: true });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/YYYY-MM-DD/);
    expect(api.getPreferences).not.toHaveBeenCalled();
    expect(api.updatePreferences).not.toHaveBeenCalled();
  });

  it('accepts real dates incl. leap day', () => {
    expect(isValidIsoDate('2024-02-29')).toBe(true);
    expect(isValidIsoDate('2025-02-29')).toBe(false);
  });

  it('rejects a read-only API key before touching QBO', async () => {
    const { api } = mockApi('2025-12-31');
    const r = await setClosingDate(api, REALM, '2025-06-30', { canWrite: false });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/read-only/);
    expect(api.getPreferences).not.toHaveBeenCalled();
    expect(api.updatePreferences).not.toHaveBeenCalled();
  });
});
