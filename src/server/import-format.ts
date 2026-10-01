// ─── Output tables and run logs for the bulk import tools ────────────────────

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function table(headers: string[], rows: string[][]): string[] {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)));
  const line = (cells: string[]) => cells.map((c, i) => (i === cells.length - 1 ? c : (c ?? '').padEnd(widths[i]))).join('  ').trimEnd();
  return [line(headers), widths.map((w) => '─'.repeat(w)).join('  '), ...rows.map(line)];
}

export function firstLine(text: string, max = 100): string {
  const line = (text ?? '').split('\n')[0];
  return line.length > max ? `${line.slice(0, max - 3)}...` : line;
}

export function statusWord(status: string): string {
  return status.replace(/_/g, ' ');
}

export function slug(value: string): string {
  const s = String(value ?? '').trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return (s || 'unnamed').slice(0, 80);
}

export function csvEscape(value: unknown): string {
  if (value === undefined || value === null) return '';
  const s = typeof value === 'string' ? value : typeof value === 'object' ? JSON.stringify(value) : String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(columns: string[], rows: Array<Record<string, unknown>>): string {
  const out = [columns.join(',')];
  for (const r of rows) out.push(columns.map((c) => csvEscape(r[c])).join(','));
  return `${out.join('\n')}\n`;
}

export interface RunLogPaths {
  json: string;
  csv: string;
}

/**
 * Write a run's full result as JSON + CSV under
 * <dataDir>/import-runs/<client>/<run_id>__<tool>__<timestamp>.{json,csv}.
 * Never throws: a log that cannot be written is reported, not fatal.
 */
export function writeRunLog(
  dataDir: string,
  tool: string,
  clientName: string,
  runId: string,
  document: Record<string, unknown>,
  csvColumns: string[],
  csvRows: Array<Record<string, unknown>>,
  now: Date = new Date()
): RunLogPaths | { error: string } {
  try {
    const dir = join(dataDir, 'import-runs', slug(clientName));
    mkdirSync(dir, { recursive: true });
    const stamp = now.toISOString().replace(/[:.]/g, '-');
    const base = join(dir, `${slug(runId)}__${tool}__${stamp}`);
    writeFileSync(`${base}.json`, `${JSON.stringify(document, null, 2)}\n`);
    writeFileSync(`${base}.csv`, toCsv(csvColumns, csvRows));
    return { json: `${base}.json`, csv: `${base}.csv` };
  } catch (err: any) {
    return { error: `could not write the run log: ${err?.message ?? err}` };
  }
}
