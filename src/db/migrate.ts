import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { SqlExecutor } from './driver.js';
import { nowIso } from './time.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export interface Migration {
  /** File name without extension, e.g. "001_baseline". Applied in sorted order, recorded once. */
  name: string;
  sql: string;
}

/**
 * Load the numbered .sql files of one migration set, e.g. ('postgres',
 * 'main') → src/db/migrations/postgres/main/*.sql. The build copies the
 * directory next to the compiled code, so the same relative path works in
 * dist/.
 */
export function loadMigrations(dialect: 'sqlite' | 'postgres', set: string): Migration[] {
  const dir = join(__dirname, 'migrations', dialect, set);
  return readdirSync(dir)
    .filter((file) => file.endsWith('.sql'))
    .sort()
    .map((file) => ({ name: file.replace(/\.sql$/, ''), sql: readFileSync(join(dir, file), 'utf-8') }));
}

/**
 * Apply every migration not yet recorded in schema_migrations, each in its
 * own transaction. Baseline migrations use CREATE … IF NOT EXISTS so a
 * database created before this runner existed is adopted in place.
 */
export async function runMigrations(x: SqlExecutor, migrations: Migration[]): Promise<string[]> {
  await x.exec(
    'CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)'
  );
  const applied = new Set(
    (await x.all<{ name: string }>('SELECT name FROM schema_migrations')).map((row) => row.name)
  );
  const newlyApplied: string[] = [];
  for (const migration of migrations) {
    if (applied.has(migration.name)) continue;
    await x.exec('BEGIN');
    try {
      await x.exec(migration.sql);
      await x.run('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)', [migration.name, nowIso()]);
      await x.exec('COMMIT');
    } catch (error) {
      await x.exec('ROLLBACK');
      throw new Error(`Migration ${migration.name} failed: ${error instanceof Error ? error.message : error}`);
    }
    newlyApplied.push(migration.name);
  }
  return newlyApplied;
}
