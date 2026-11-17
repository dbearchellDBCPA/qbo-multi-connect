import { describe, it, expect } from 'vitest';
import {
  CDC_MAX_LOOKBACK_DAYS,
  CdcRequestError,
  assertCdcLookback,
  normalizeCdcEntities,
  parseChangedSince,
} from '../../src/api/cdc.js';

describe('parseChangedSince', () => {
  it('accepts YYYY-MM-DD and sends it as midnight UTC', () => {
    const { changedSince, parsed } = parseChangedSince('2026-11-01');
    expect(changedSince).toBe('2026-11-01T00:00:00Z');
    expect(parsed.toISOString()).toBe('2026-11-01T00:00:00.000Z');
  });

  it('passes a full ISO datetime through unchanged', () => {
    const raw = '2026-11-01T15:30:00-05:00';
    const { changedSince, parsed } = parseChangedSince(`  ${raw}  `);
    expect(changedSince).toBe(raw);
    expect(parsed.toISOString()).toBe('2026-11-01T20:30:00.000Z');
  });

  it('rejects an empty or unparseable value', () => {
    expect(() => parseChangedSince('')).toThrow(CdcRequestError);
    expect(() => parseChangedSince('not-a-date')).toThrow(/ISO datetime or YYYY-MM-DD/);
  });
});

describe('assertCdcLookback', () => {
  const now = new Date('2026-11-17T14:30:00Z');

  it('allows a timestamp inside the 30-day window', () => {
    expect(() => assertCdcLookback(new Date('2026-10-20T12:00:00Z'), now)).not.toThrow();
  });

  it('allows a YYYY-MM-DD of exactly today-minus-30 even later in the day', () => {
    // 30 calendar days before 2026-11-17 is 2026-10-18. Midnight UTC is
    // more than 30×24h before 14:30Z, but Intuit's limit is a 30-day lookback.
    expect(() => assertCdcLookback(new Date('2026-10-18T00:00:00Z'), now)).not.toThrow();
  });

  it('rejects a timestamp older than 30 days', () => {
    expect(() => assertCdcLookback(new Date('2026-10-17T23:59:59Z'), now)).toThrow(CdcRequestError);
    expect(() => assertCdcLookback(new Date('2026-10-17T23:59:59Z'), now)).toThrow(/30-day CDC lookback/);
    expect(() => assertCdcLookback(new Date('2026-10-17T23:59:59Z'), now)).toThrow(/2026-10-18/);
  });

  it('uses a 30-day window', () => {
    expect(CDC_MAX_LOOKBACK_DAYS).toBe(30);
  });
});

describe('normalizeCdcEntities', () => {
  it('trims names and drops blanks', () => {
    expect(normalizeCdcEntities([' Invoice', 'Payment ', ' '])).toEqual(['Invoice', 'Payment']);
  });

  it('rejects an empty list', () => {
    expect(() => normalizeCdcEntities([])).toThrow(/at least one/);
    expect(() => normalizeCdcEntities(['', '  '])).toThrow(CdcRequestError);
  });
});
