import pg from 'pg';
import {
  normalizeParams,
  toPostgresPlaceholders,
  type DriverInit,
  type LockOutcome,
  type SqlDriver,
  type SqlExecutor,
  type SqlParams,
  type SqlRow,
} from './driver.js';

const { Pool, types } = pg;

// Timestamps come back as ISO-8601 strings, the same shape SQLite hands the
// app, so nothing above the driver has to care which engine is underneath.
// (1184 = timestamptz, 1114 = timestamp without time zone, read as UTC.)
const parseTimestamptz = types.getTypeParser(1184);
types.setTypeParser(1184, (value: string) => (parseTimestamptz(value) as Date).toISOString());
types.setTypeParser(1114, (value: string) => new Date(`${value.replace(' ', 'T')}Z`).toISOString());

export type PostgresSslMode = 'default' | 'no-verify' | 'disable';

export interface PostgresDriverOptions {
  /** postgres://user:pass@host:port/db — Railway injects this as DATABASE_URL. */
  connectionString: string;
  /**
   * Put every table in this schema instead of `public`. Used by the test
   * suite to give each test an isolated, disposable namespace.
   */
  schema?: string;
  /** Drop `schema` (CASCADE) on close. Only for disposable test schemas. */
  dropSchemaOnClose?: boolean;
  /**
   * TLS handling. 'default' lets the connection string decide (sslmode=…),
   * 'no-verify' encrypts without checking the certificate (managed hosts
   * with self-signed proxies), 'disable' never negotiates TLS (private
   * networks such as Railway's internal hostname).
   */
  ssl?: PostgresSslMode;
  /** Pool size. Default 10. */
  max?: number;
}

interface Queryable {
  query(text: string, values?: unknown[]): Promise<pg.QueryResult<SqlRow>>;
}

const placeholderCache = new Map<string, string>();
function pgSql(sql: string): string {
  let converted = placeholderCache.get(sql);
  if (converted === undefined) {
    converted = toPostgresPlaceholders(sql);
    placeholderCache.set(sql, converted);
  }
  return converted;
}

class PostgresExecutor implements SqlExecutor {
  readonly dialect = 'postgres' as const;
  constructor(private readonly target: Queryable) {}

  async run(sql: string, params?: SqlParams): Promise<number> {
    const result = await this.target.query(pgSql(sql), normalizeParams(params));
    return result.rowCount ?? 0;
  }

  async get<T extends object = SqlRow>(sql: string, params?: SqlParams): Promise<T | undefined> {
    const result = await this.target.query(pgSql(sql), normalizeParams(params));
    return result.rows[0] as T | undefined;
  }

  async all<T extends object = SqlRow>(sql: string, params?: SqlParams): Promise<T[]> {
    const result = await this.target.query(pgSql(sql), normalizeParams(params));
    return result.rows as T[];
  }

  async exec(sql: string): Promise<void> {
    // No parameters → simple query protocol, which allows several statements.
    await this.target.query(sql);
  }
}

function quoteIdent(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`Invalid schema name: ${name}`);
  return `"${name}"`;
}

/**
 * node-postgres behind the SqlDriver contract. Transactions take a dedicated
 * client from the pool; everything else goes through the pool directly.
 */
export class PostgresDriver implements SqlDriver {
  readonly dialect = 'postgres' as const;
  private readonly pool: pg.Pool;
  private readonly executor: PostgresExecutor;
  private readonly ready: Promise<void>;
  private closed = false;

  constructor(
    private readonly options: PostgresDriverOptions,
    init?: DriverInit
  ) {
    const ssl =
      options.ssl === 'no-verify' ? { rejectUnauthorized: false } : options.ssl === 'disable' ? false : undefined;
    this.pool = new Pool({
      connectionString: options.connectionString,
      max: options.max ?? 10,
      ...(ssl !== undefined ? { ssl } : {}),
      ...(options.schema ? { options: `-c search_path=${options.schema}` } : {}),
    });
    // Surface idle-client errors (dropped connections) instead of crashing.
    this.pool.on('error', (error) => console.error('[postgres] idle client error:', error.message));
    this.executor = new PostgresExecutor(this.pool);
    this.ready = this.initialize(init);
  }

  private async initialize(init?: DriverInit): Promise<void> {
    if (this.options.schema) {
      await this.executor.exec(`CREATE SCHEMA IF NOT EXISTS ${quoteIdent(this.options.schema)}`);
    }
    if (init) await init(this.executor);
  }

  async run(sql: string, params?: SqlParams): Promise<number> {
    await this.ready;
    return this.executor.run(sql, params);
  }

  async get<T extends object = SqlRow>(sql: string, params?: SqlParams): Promise<T | undefined> {
    await this.ready;
    return this.executor.get<T>(sql, params);
  }

  async all<T extends object = SqlRow>(sql: string, params?: SqlParams): Promise<T[]> {
    await this.ready;
    return this.executor.all<T>(sql, params);
  }

  async exec(sql: string): Promise<void> {
    await this.ready;
    return this.executor.exec(sql);
  }

  async transaction<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T> {
    await this.ready;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(new PostgresExecutor(client));
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        /* the connection is already gone; the error below is the real one */
      }
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Session-level advisory lock on a dedicated connection: pg_try_advisory_lock
   * never blocks, and the lock is released on the same connection (or by
   * the server if the process dies) — exactly the "one replica sweeps at a
   * time" guarantee the refresh daemon needs. Locks are database-wide, not
   * schema-scoped, so the name should be unique to the job.
   */
  async withLock<T>(name: string, fn: () => Promise<T>): Promise<LockOutcome<T>> {
    await this.ready;
    const client = await this.pool.connect();
    try {
      const { rows } = await client.query('SELECT pg_try_advisory_lock(hashtext($1)) AS acquired', [name]);
      if (!rows[0]?.acquired) return { acquired: false };
      try {
        return { acquired: true, result: await fn() };
      } finally {
        await client.query('SELECT pg_advisory_unlock(hashtext($1))', [name]).catch(() => undefined);
      }
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      await this.ready;
      if (this.options.schema && this.options.dropSchemaOnClose) {
        await this.executor.exec(`DROP SCHEMA IF EXISTS ${quoteIdent(this.options.schema)} CASCADE`);
      }
    } finally {
      await this.pool.end();
    }
  }
}
