import { QBOClient } from './client.js';

/** Intuit rejects a changedSince older than this many days. */
export const CDC_MAX_LOOKBACK_DAYS = 30;

export class CdcRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CdcRequestError';
  }
}

/**
 * Parse changed_since as YYYY-MM-DD (sent as that date at 00:00:00Z) or a
 * full ISO-8601 datetime (passed through).
 */
export function parseChangedSince(input: string): { changedSince: string; parsed: Date } {
  const raw = String(input ?? '').trim();
  if (!raw) throw new CdcRequestError('changed_since is required.');
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const parsed = new Date(`${raw}T00:00:00Z`);
    if (Number.isNaN(parsed.getTime())) {
      throw new CdcRequestError('changed_since must be an ISO datetime or YYYY-MM-DD.');
    }
    return { changedSince: `${raw}T00:00:00Z`, parsed };
  }
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    throw new CdcRequestError('changed_since must be an ISO datetime or YYYY-MM-DD.');
  }
  return { changedSince: raw, parsed };
}

/**
 * Intuit's CDC lookback is 30 days. Compare at UTC date precision so a
 * YYYY-MM-DD of exactly today-minus-30 is accepted even when the clock is
 * later in the day (a strict 30×24h cutoff would reject it).
 */
export function assertCdcLookback(parsed: Date, now = new Date()): void {
  const cutoff = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() - CDC_MAX_LOOKBACK_DAYS,
  ));
  if (parsed.getTime() < cutoff.getTime()) {
    const cutoffDay = cutoff.toISOString().slice(0, 10);
    throw new CdcRequestError(
      `changed_since is older than Intuit's ${CDC_MAX_LOOKBACK_DAYS}-day CDC lookback limit. Use a timestamp on or after ${cutoffDay}.`,
    );
  }
}

export function normalizeCdcEntities(entities: string[]): string[] {
  const cleaned = entities.map((e) => String(e ?? '').trim()).filter(Boolean);
  if (cleaned.length === 0) {
    throw new CdcRequestError('entities must list at least one QBO entity name (e.g. Invoice, Payment, Customer).');
  }
  return cleaned;
}

/**
 * QBO Change Data Capture.
 *
 * GET /v3/company/{realmId}/cdc?entities=Invoice,Payment&changedSince=...
 *
 * Docs: https://developer.intuit.com/app/developer/qbo/docs/learn/explore-the-quickbooks-online-api/change-data-capture
 */
export class CdcAPI {
  constructor(private client: QBOClient) {}

  async getChanged(realmId: string, entities: string[], changedSince: string): Promise<unknown> {
    const names = normalizeCdcEntities(entities);
    const { changedSince: since, parsed } = parseChangedSince(changedSince);
    assertCdcLookback(parsed);
    return this.client.get(realmId, 'cdc', {
      entities: names.join(','),
      changedSince: since,
    });
  }
}
