import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  normalizeParams,
  type DriverInit,
  type LockOutcome,
  type SqlDriver,
  type SqlExecutor,
  type SqlParams,
  type SqlRow,
} from './driver.js';

/**
 * better-sqlite3 behind the async SqlDriver contract. The engine itself is
 * synchronous, which is what makes the transaction wrapper safe: nothing
 * else can run a statement between BEGIN and COMMIT, because the only way
 * to interleave would be an I/O turn, and these calls never take one.
 */
export class SqliteDriver implements SqlDriver {
  readonly dialect = 'sqlite' as const;
  readonly db: Database.Database;
  private readonly ready: Promise<void>;
  private inTransaction = false;
  private closed = false;

  constructor(readonly path: string, init?: DriverInit) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.ready = init ? init(this.raw()) : Promise.resolve();
  }

  /** An executor that does not wait for init — used by init itself. */
  private raw(): SqlExecutor {
    const db = this.db;
    return {
      dialect: 'sqlite',
      async run(sql: string, params?: SqlParams) {
        return db.prepare(sql).run(...normalizeParams(params)).changes;
      },
      async get<T extends object = SqlRow>(sql: string, params?: SqlParams) {
        return db.prepare(sql).get(...normalizeParams(params)) as T | undefined;
      },
      async all<T extends object = SqlRow>(sql: string, params?: SqlParams) {
        return db.prepare(sql).all(...normalizeParams(params)) as T[];
      },
      async exec(sql: string) {
        db.exec(sql);
      },
    };
  }

  async run(sql: string, params?: SqlParams): Promise<number> {
    await this.ready;
    return this.db.prepare(sql).run(...normalizeParams(params)).changes;
  }

  async get<T extends object = SqlRow>(sql: string, params?: SqlParams): Promise<T | undefined> {
    await this.ready;
    return this.db.prepare(sql).get(...normalizeParams(params)) as T | undefined;
  }

  async all<T extends object = SqlRow>(sql: string, params?: SqlParams): Promise<T[]> {
    await this.ready;
    return this.db.prepare(sql).all(...normalizeParams(params)) as T[];
  }

  async exec(sql: string): Promise<void> {
    await this.ready;
    this.db.exec(sql);
  }

  async transaction<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T> {
    await this.ready;
    if (this.inTransaction) return fn(this);
    this.db.exec('BEGIN IMMEDIATE');
    this.inTransaction = true;
    try {
      const result = await fn(this);
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      if (this.db.inTransaction) this.db.exec('ROLLBACK');
      throw error;
    } finally {
      this.inTransaction = false;
    }
  }

  /** One process owns a SQLite file, so a named lock is always available. */
  async withLock<T>(_name: string, fn: () => Promise<T>): Promise<LockOutcome<T>> {
    await this.ready;
    return { acquired: true, result: await fn() };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      await this.ready;
    } finally {
      this.db.close();
    }
  }
}
