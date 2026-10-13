// Test database selection. By default every test runs on an in-memory
// SQLite database. Set QBO_TEST_DATABASE_URL to a Postgres server and the
// same tests run there instead, each QBOManager in its own disposable
// schema (created on open, dropped on close), so the suite proves both
// engines behave identically.

import { randomBytes } from 'node:crypto';
import type { QBOManagerConfig } from '../../src/index.js';
import { PostgresDriver } from '../../src/db/postgres-driver.js';
import { loadMigrations, runMigrations } from '../../src/db/migrate.js';
import { ImportStore, openSqliteImportDriver } from '../../src/db/import-store.js';
import { openDatabaseDriver } from '../../src/db/index.js';
import type { SqlDriver } from '../../src/db/driver.js';

export const TEST_DATABASE_URL = process.env.QBO_TEST_DATABASE_URL?.trim() || null;
export const TEST_DIALECT: 'sqlite' | 'postgres' = TEST_DATABASE_URL ? 'postgres' : 'sqlite';

function disposableSchema(): string {
  return `t_${randomBytes(6).toString('hex')}`;
}

/** The database part of a QBOManager config for one test: SQLite in memory, or a fresh Postgres schema. */
export function testDatabaseConfig(): Pick<QBOManagerConfig, 'dbPath' | 'database'> {
  if (!TEST_DATABASE_URL) return { dbPath: ':memory:' };
  return { database: { url: TEST_DATABASE_URL, schema: disposableSchema(), dropSchemaOnClose: true } };
}

/** A standalone driver with the main schema applied, for driver-level tests. */
export function openTestDriver(): SqlDriver {
  if (!TEST_DATABASE_URL) return openDatabaseDriver({ sqlitePath: ':memory:' });
  return new PostgresDriver(
    { connectionString: TEST_DATABASE_URL, schema: disposableSchema(), dropSchemaOnClose: true },
    (x) => runMigrations(x, loadMigrations('postgres', 'main')).then(() => undefined)
  );
}

/** An import store for one test: its own in-memory SQLite file, or a fresh Postgres schema. */
export function openTestImportStore(): ImportStore {
  if (!TEST_DATABASE_URL) return new ImportStore(openSqliteImportDriver(':memory:'), true);
  const driver = new PostgresDriver(
    { connectionString: TEST_DATABASE_URL, schema: disposableSchema(), dropSchemaOnClose: true },
    (x) => runMigrations(x, loadMigrations('postgres', 'main')).then(() => undefined)
  );
  return new ImportStore(driver, true);
}
