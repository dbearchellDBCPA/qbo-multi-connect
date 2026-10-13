/**
 * Timestamps cross the driver boundary as ISO-8601 strings in UTC.
 *
 * Databases created by earlier versions hold two other shapes that must
 * keep parsing: SQLite's CURRENT_TIMESTAMP ("YYYY-MM-DD HH:MM:SS", UTC, no
 * zone marker — new Date() would read it as LOCAL time) and the second-
 * precision "YYYY-MM-DD HH:MM:SS" the OAuth server used to write.
 */

export function nowIso(): string {
  return new Date().toISOString();
}

export function toIso(date: Date): string {
  return date.toISOString();
}

const SPACE_UTC = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?$/;

/** Parse a timestamp read from either database, in any shape it has ever been stored in. */
export function parseDbTimestamp(value: string | Date): Date {
  if (value instanceof Date) return value;
  if (SPACE_UTC.test(value)) return new Date(`${value.replace(' ', 'T')}Z`);
  return new Date(value);
}

/** Same as parseDbTimestamp, but tolerant of NULL columns. */
export function parseDbTimestampOrNull(value: string | Date | null | undefined): Date | null {
  return value == null ? null : parseDbTimestamp(value);
}

/** Normalize a stored timestamp of any shape to ISO-8601 (falls back to the input if unparseable). */
export function dbTimestampToIso(value: string | Date): string {
  const parsed = parseDbTimestamp(value);
  return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toISOString();
}
