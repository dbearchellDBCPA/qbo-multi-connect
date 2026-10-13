/**
 * Minimal SQL driver abstraction so the same data layer runs on SQLite (one
 * firm, self-hosted, zero-config) and on Postgres (the hosted platform).
 *
 * The contract is deliberately tiny: statements are written once in the
 * portable subset both engines share, with `?` placeholders. The Postgres
 * driver rewrites `?` to `$n`; the SQLite driver passes them through.
 *
 * Portability rules the data layer follows (see ConnectionDatabase):
 *   - `INSERT … RETURNING id` instead of lastInsertRowid
 *   - `ON CONFLICT DO NOTHING` / `ON CONFLICT (col) DO UPDATE` instead of
 *     INSERT OR IGNORE / OR REPLACE
 *   - timestamps are ISO-8601 strings in JavaScript: written as parameters
 *     (never `datetime('now')`), and the Postgres driver converts timestamp
 *     columns back to ISO strings on read, so both engines hand the app the
 *     same shape
 *   - no triggers: `updated_at` is set explicitly by the statements that
 *     should bump it
 */

export type SqlDialect = 'sqlite' | 'postgres';
export type SqlParams = readonly unknown[];
export type SqlRow = Record<string, unknown>;

/** What a statement can be run against: the driver itself, or a transaction. */
export interface SqlExecutor {
  readonly dialect: SqlDialect;
  /** Execute a statement that returns no rows. Resolves to the affected row count. */
  run(sql: string, params?: SqlParams): Promise<number>;
  /** First row of a query (or of an INSERT … RETURNING), or undefined. */
  get<T extends object = SqlRow>(sql: string, params?: SqlParams): Promise<T | undefined>;
  /** Every row of a query. */
  all<T extends object = SqlRow>(sql: string, params?: SqlParams): Promise<T[]>;
  /** Run one or more statements with no parameters (DDL, migrations). */
  exec(sql: string): Promise<void>;
}

export interface SqlDriver extends SqlExecutor {
  /**
   * Run `fn` inside a transaction. Committed when it resolves, rolled back
   * when it rejects. A transaction started inside another joins the outer one.
   */
  transaction<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T>;
  /** Release the connection(s). Safe to call more than once. */
  close(): Promise<void>;
}

/**
 * Runs once, before the first statement, to bring the schema up to date.
 * Drivers queue every call until it has finished, so callers never have to
 * await an explicit "ready" step.
 */
export type DriverInit = (executor: SqlExecutor) => Promise<void>;

/**
 * Rewrite `?` placeholders to `$1 … $n` for Postgres. Question marks inside
 * single-quoted string literals are left alone.
 */
export function toPostgresPlaceholders(sql: string): string {
  let out = '';
  let n = 0;
  let inString = false;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    if (c === "'") {
      inString = !inString;
      out += c;
    } else if (c === '?' && !inString) {
      out += `$${++n}`;
    } else {
      out += c;
    }
  }
  return out;
}

/** Drivers bind `undefined` as NULL so optional fields never reach the engine unbound. */
export function normalizeParams(params: SqlParams | undefined): unknown[] {
  return (params ?? []).map((p) => (p === undefined ? null : p));
}
