/**
 * Pure helpers that shape report-tool inputs and outputs:
 *  - resolving human account filters (numbers/names) → QBO Account IDs
 *  - collapsing report payloads to summary form for size control
 *  - filtering Budget entities by name / active date
 *  - rendering the reports whose QBO row structure needs tolerant parsing
 *    (TrialBalance, Aged*) plus the report-Header period helpers
 *
 * Kept free of I/O so the matching semantics are unit-testable.
 */

export function formatCurrency(val: any): string {
  const n = parseFloat(val ?? '0');
  if (isNaN(n)) return '$0.00';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);
}

// ─── Report-Header period echo ────────────────────────────────────────────────
// Rendered report output must state the period QBO ACTUALLY applied (the
// response Header), never just echo the caller's request — a report that
// says "As of 2026-06-30" over 2026-07-31 data is silent wrong data.

export interface ReportPeriod {
  start?: string;
  end?: string;
}

export function headerPeriod(reportData: any): ReportPeriod {
  const h = reportData?.Header;
  return {
    start: h?.StartPeriod || undefined,
    end: h?.EndPeriod || undefined,
  };
}

/**
 * A loud one-line warning when QBO's applied period differs from what the
 * caller requested; null when they agree (or either side is unknown).
 */
export function periodMismatchNote(requested: ReportPeriod, actual: ReportPeriod): string | null {
  const issues: string[] = [];
  if (requested.start && actual.start && requested.start !== actual.start) {
    issues.push(`start ${actual.start} (requested ${requested.start})`);
  }
  if (requested.end && actual.end && requested.end !== actual.end) {
    issues.push(`end ${actual.end} (requested ${requested.end})`);
  }
  if (issues.length === 0) return null;
  return `⚠ QBO applied a different period than requested: ${issues.join(', ')} — the figures reflect QBO's period shown above.`;
}

export interface AccountFilterResolution {
  /** Distinct QBO Account IDs, in first-match order. */
  ids: string[];
  /** Filter terms that matched nothing — callers must surface these, never drop them. */
  unresolved: string[];
}

/**
 * Resolve account filter terms (QBO IDs, account numbers, names, or
 * "number name" strings) against a chart of accounts.
 *
 * Matching semantics per term:
 *  1. Number/ID namespace, as a UNION (so an account-number vs QBO-ID
 *     collision can never silently pick one interpretation):
 *       - exact QBO Account ID
 *       - exact AcctNum (case-insensitive)
 *       - AcctNum prefix at a sub-account boundary: "4404" matches
 *         "4404-1", "4404.2", "4404 1" — but NOT "44040". A bookkeeper
 *         filtering on a parent number expects its sub-accounts.
 *  2. If nothing matched: exact Name / FullyQualifiedName (case-insensitive).
 *  3. If nothing matched and the term looks like "<number> <name>": the
 *     number part via the same prefix rule.
 *  4. Last resort: substring on Name / FullyQualifiedName (may match many).
 */
export function resolveAccountFilterTerms(
  accountList: any[],
  terms: string[]
): AccountFilterResolution {
  const ids = new Set<string>();
  const unresolved: string[] = [];

  const byId = new Map<string, any>();
  const byName = new Map<string, any>();
  for (const a of accountList) {
    if (a.Id != null) byId.set(String(a.Id), a);
    if (a.Name) byName.set(String(a.Name).toLowerCase(), a);
    if (a.FullyQualifiedName) byName.set(String(a.FullyQualifiedName).toLowerCase(), a);
  }

  const acctNumMatches = (term: string): any[] => {
    const t = term.toLowerCase();
    return accountList.filter((a: any) => {
      const num = String(a.AcctNum ?? '').toLowerCase();
      if (!num || !num.startsWith(t)) return false;
      if (num.length === t.length) return true; // exact
      return !/[a-z0-9]/.test(num[t.length]); // boundary: next char is a separator
    });
  };

  for (const raw of terms) {
    const term = raw.trim();
    if (!term) continue;
    const lower = term.toLowerCase();
    const matched = new Set<string>();

    if (byId.has(term)) matched.add(String(byId.get(term)!.Id));
    for (const m of acctNumMatches(term)) matched.add(String(m.Id));

    if (matched.size === 0 && byName.has(lower)) {
      matched.add(String(byName.get(lower)!.Id));
    }

    if (matched.size === 0) {
      const parts = term.split(/\s+/);
      // Number tokens include sub-account forms like "1700-00" — a bare
      // \d+ gate silently skipped them ("1700-00 Partnerships Owned" then
      // fell through to name-substring and could miss entirely).
      if (parts.length > 1 && /^\d/.test(parts[0])) {
        for (const m of acctNumMatches(parts[0])) matched.add(String(m.Id));
      }
    }

    if (matched.size === 0) {
      for (const a of accountList) {
        const n = String(a.Name ?? '').toLowerCase();
        const fq = String(a.FullyQualifiedName ?? '').toLowerCase();
        if (n.includes(lower) || fq.includes(lower)) matched.add(String(a.Id));
      }
    }

    if (matched.size === 0) unresolved.push(raw);
    for (const id of matched) ids.add(id);
  }

  return { ids: Array.from(ids), unresolved };
}

/**
 * Expand a set of account IDs to include every descendant sub-account
 * (via ParentRef), so filtering on a parent account covers its children.
 */
export function expandToDescendants(accountList: any[], ids: string[]): string[] {
  const childrenByParent = new Map<string, string[]>();
  for (const a of accountList ?? []) {
    const parent = a?.ParentRef?.value != null ? String(a.ParentRef.value) : null;
    if (!parent || a?.Id == null) continue;
    if (!childrenByParent.has(parent)) childrenByParent.set(parent, []);
    childrenByParent.get(parent)!.push(String(a.Id));
  }
  const out = new Set<string>();
  const queue = [...ids];
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (out.has(id)) continue;
    out.add(id);
    for (const child of childrenByParent.get(id) ?? []) queue.push(child);
  }
  return Array.from(out);
}

/**
 * Collapse a parsed General Ledger (see parseGeneralLedger) to per-account
 * totals — drops the transaction rows, keeps a transaction_count instead.
 */
export function summarizeGeneralLedger(parsed: any): any {
  return {
    ...parsed,
    detail_level: 'summary',
    accounts: (parsed?.accounts ?? []).map((a: any) => ({
      number: a.number,
      name: a.name,
      classification: a.classification,
      transaction_count: (a.transactions ?? []).length,
      total_debits: a.total_debits,
      total_credits: a.total_credits,
      ending_balance: a.ending_balance,
    })),
  };
}

// ─── General Ledger parsing ───────────────────────────────────────────────────
// QBO's GL report has no per-row debit/credit by default — its net-amount
// column (subt_nat_amount) is signed POSITIVE IN THE ACCOUNT'S NORMAL-BALANCE
// DIRECTION. "Positive = debit" is only true for debit-normal accounts, so a
// parser that assumes it swaps debits and credits on every liability, equity,
// and income account (found 2026-08-24: liability deposits reported as
// debits, income reported as all-debit). Preferred source is the report's
// explicit Debit/Credit columns (requested via columns=debt_amt,credit_amt);
// when absent, the sign is interpreted through the account's Classification.

const CREDIT_NORMAL_CLASSIFICATIONS = new Set(['Liability', 'Equity', 'Revenue']);

export function parseGeneralLedger(
  reportData: any,
  clientName: string,
  startDate: string,
  endDate: string,
  accountList?: any[]
): any {
  const columns: string[] = (reportData?.Columns?.Column ?? []).map((c: any) => c.ColTitle ?? '');

  const dateIdx = columns.findIndex(c => c.toLowerCase() === 'date');
  const typeIdx = columns.findIndex(c => c.toLowerCase().includes('transaction type'));
  const numIdx = columns.findIndex(c => c.toLowerCase() === 'num');
  const nameIdx = columns.findIndex(c => c.toLowerCase() === 'name');
  const memoIdx = columns.findIndex(c => c.toLowerCase().includes('memo'));
  const splitIdx = columns.findIndex(c => c.toLowerCase() === 'split');
  const amtIdx = columns.findIndex(c => c.toLowerCase() === 'amount');
  const balIdx = columns.findIndex(c => c.toLowerCase() === 'balance');
  const debitIdx = columns.findIndex(c => c.toLowerCase() === 'debit');
  const creditIdx = columns.findIndex(c => c.toLowerCase() === 'credit');
  const hasDebitCreditColumns = debitIdx >= 0 && creditIdx >= 0;

  // Chart-of-accounts lookups: authoritative AcctNum and Classification.
  const byId = new Map<string, any>();
  const byName = new Map<string, any>();
  const byNum = new Map<string, any>();
  for (const a of accountList ?? []) {
    if (a?.Id != null) byId.set(String(a.Id), a);
    if (a?.Name) byName.set(String(a.Name).toLowerCase(), a);
    if (a?.FullyQualifiedName) byName.set(String(a.FullyQualifiedName).toLowerCase(), a);
    if (a?.AcctNum) byNum.set(String(a.AcctNum).toLowerCase(), a);
  }

  function colVal(cd: any[], idx: number): string {
    return idx >= 0 ? (cd?.[idx]?.value ?? '') : '';
  }

  const accounts: any[] = [];

  function processSection(row: any): void {
    const headerCd = row.Header?.ColData?.[0];
    const accountHeader = String(headerCd?.value ?? '');
    const headerId = headerCd?.id != null ? String(headerCd.id) : '';

    // "2400-01 Advance From H2 Energy" → number "2400-01" (sub-account
    // numbers contain separators, so \d+ alone never matched them).
    const m = accountHeader.match(/^([0-9][\w.\-]*)\s+(.+)$/);
    let accountNumber = m ? m[1] : '';
    const accountName = m ? m[2] : accountHeader;

    const acct =
      (headerId && byId.get(headerId)) ||
      byName.get(accountHeader.toLowerCase()) ||
      byName.get(accountName.toLowerCase()) ||
      (accountNumber && byNum.get(accountNumber.toLowerCase())) ||
      null;
    if (acct?.AcctNum) accountNumber = String(acct.AcctNum);
    const classification = acct ? String(acct.Classification ?? '') : '';
    const creditNormal = CREDIT_NORMAL_CLASSIFICATIONS.has(classification);

    const transactions: any[] = [];
    let totalDebits = 0;
    let totalCredits = 0;
    let endingBalance = 0;

    for (const txnRow of row.Rows?.Row ?? []) {
      if (txnRow.Header || txnRow.Rows) {
        processSection(txnRow); // nested sub-account section
        continue;
      }
      if (txnRow.Summary) continue; // section totals are not transactions
      const cd = txnRow.ColData ?? [];
      if (!cd.length) continue;

      const amount = moneyValue(colVal(cd, amtIdx));
      const balance = moneyValue(colVal(cd, balIdx));

      let debit = 0;
      let credit = 0;
      if (hasDebitCreditColumns) {
        debit = moneyValue(colVal(cd, debitIdx));
        credit = moneyValue(colVal(cd, creditIdx));
      } else if (creditNormal) {
        // Signed amount is positive in the account's normal direction —
        // for liability/equity/income accounts, positive means CREDIT.
        if (amount >= 0) credit = amount;
        else debit = -amount;
      } else {
        if (amount >= 0) debit = amount;
        else credit = -amount;
      }

      totalDebits += debit;
      totalCredits += credit;
      if (balance !== 0) endingBalance = balance; // track last non-zero balance

      transactions.push({
        date: colVal(cd, dateIdx),
        type: colVal(cd, typeIdx),
        doc_number: colVal(cd, numIdx),
        name: colVal(cd, nameIdx),
        memo: colVal(cd, memoIdx),
        split_account: colVal(cd, splitIdx),
        amount: amtIdx >= 0 ? amount : debit - credit,
        debit,
        credit,
        balance,
      });
    }

    // Ending balance from Summary if available — prefer this over last transaction
    if (row.Summary?.ColData) {
      const cd = row.Summary.ColData;
      const summaryBalance = balIdx >= 0 && cd[balIdx]?.value
        ? moneyValue(cd[balIdx].value)
        : moneyValue(cd[cd.length - 1]?.value ?? '0');
      if (summaryBalance !== 0) endingBalance = summaryBalance;
    }

    accounts.push({
      number: accountNumber,
      name: accountName,
      classification,
      transactions,
      total_debits: Math.round(totalDebits * 100) / 100,
      total_credits: Math.round(totalCredits * 100) / 100,
      ending_balance: Math.round(endingBalance * 100) / 100,
    });
  }

  for (const row of reportData?.Rows?.Row ?? []) {
    if (row.Header || row.Rows) processSection(row);
  }

  return {
    client: clientName,
    period: { start: startDate, end: endDate },
    debit_credit_source: hasDebitCreditColumns ? 'report_columns' : 'amount_sign_by_classification',
    accounts,
    total_accounts: accounts.length,
    total_transactions: accounts.reduce((sum: number, a: any) => sum + a.transactions.length, 0),
  };
}

// ─── QBO query-result noise stripping ─────────────────────────────────────────
// SELECT * responses carry JAXB extension blobs (PurchaseEx, InvoiceEx, …),
// empty CustomExtensions arrays, and domain/sparse flags on every record —
// roughly doubling the payload with zero information. MetaData is kept
// (Create/LastUpdated times are genuinely useful).

const QBO_NOISE_KEY = /^(domain|sparse|CustomExtensions)$|^[A-Z][A-Za-z]*Ex$/;

export function stripQboNoise<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((v) => stripQboNoise(v)) as unknown as T;
  }
  if (value !== null && typeof value === 'object') {
    const out: any = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (QBO_NOISE_KEY.test(k)) continue;
      out[k] = stripQboNoise(v);
    }
    return out;
  }
  return value;
}

export interface BudgetFilters {
  nameContains?: string;
  /** YYYY-MM-DD — keep budgets whose StartDate..EndDate range covers this date. */
  activeOn?: string;
}

/** Apply name/date filters to raw QBO Budget entities. */
export function filterBudgets(budgets: any[], filters: BudgetFilters): any[] {
  const needle = filters.nameContains?.toLowerCase().trim();
  return (budgets ?? []).filter((b: any) => {
    if (needle && !String(b.Name ?? '').toLowerCase().includes(needle)) return false;
    if (filters.activeOn) {
      // ISO dates compare correctly as strings; a missing bound is open-ended.
      if (b.StartDate && String(b.StartDate) > filters.activeOn) return false;
      if (b.EndDate && String(b.EndDate) < filters.activeOn) return false;
    }
    return true;
  });
}

/** Metadata-only view of a QBO Budget entity (no per-account entries). */
export function budgetToSummary(b: any): any {
  return {
    budget_id: String(b.Id ?? ''),
    name: b.Name ?? '',
    budget_type: b.BudgetType ?? '', // 'ProfitAndLoss' or 'BalanceSheet'
    budget_entry_type: b.BudgetEntryType ?? '', // 'Yearly' | 'Quarterly' | 'Monthly'
    start_date: b.StartDate ?? null,
    end_date: b.EndDate ?? null,
    active: b.Active !== false,
    entry_count: (b.BudgetDetail ?? []).length,
  };
}

// ─── Tolerant report-row walking ──────────────────────────────────────────────
// QBO's report row `type` field is OPTIONAL. Summary-style reports
// (TrialBalance, AgedReceivables/Payables) deliver leaf rows as bare ColData
// objects — often nested under an unnamed wrapper Section — so any parser
// that requires row.type === 'Data' drops every one of them and only the
// wrapper's Summary "TOTAL" row survives. That is exactly how a full trial
// balance rendered as zero accounts plus "✓ BALANCED" (2026-08-15), and how
// AR aging rendered $837 of customers under QBO's own $5,281.52 total.

function isSectionish(row: any): boolean {
  return Boolean(row?.Rows || row?.Header || row?.Summary);
}

function moneyValue(v: any): number {
  return parseFloat(String(v ?? '').replace(/,/g, '')) || 0;
}

// ─── Trial Balance ────────────────────────────────────────────────────────────

export function formatTrialBalance(
  reportData: any,
  clientName: string,
  startDate?: string,
  endDate?: string
): string {
  const columns: any[] = reportData?.Columns?.Column ?? [];
  let debitIdx = -1;
  let creditIdx = -1;
  columns.forEach((col: any, i: number) => {
    const title = (col.ColTitle ?? '').toLowerCase();
    if (title === 'debit') debitIdx = i;
    if (title === 'credit') creditIdx = i;
  });
  // Blank column titles: fall back to the conventional [account, debit, credit] layout.
  if (debitIdx < 0 && creditIdx < 0 && columns.length >= 3) {
    debitIdx = 1;
    creditIdx = 2;
  }

  const accountRows: Array<{ label: string; debit: number; credit: number }> = [];
  let qboTotalDebit: number | null = null;
  let qboTotalCredit: number | null = null;

  // The report's own grand-total row is reconciliation data, not an account.
  const captureGrandTotal = (cd: any[], group?: string): boolean => {
    const label = String(cd?.[0]?.value ?? '').trim();
    if (group !== 'GrandTotal' && label.toUpperCase() !== 'TOTAL') return false;
    if (debitIdx >= 0) qboTotalDebit = moneyValue(cd[debitIdx]?.value);
    if (creditIdx >= 0) qboTotalCredit = moneyValue(cd[creditIdx]?.value);
    return true;
  };

  function walk(rowSet: any): void {
    for (const row of rowSet?.Row ?? []) {
      if (isSectionish(row)) {
        walk(row.Rows);
        if (row.Summary?.ColData) captureGrandTotal(row.Summary.ColData, row.group);
        continue;
      }
      const cd: any[] = row.ColData ?? [];
      const label = String(cd[0]?.value ?? '');
      if (!label) continue;
      if (captureGrandTotal(cd, row.group)) continue;
      accountRows.push({
        label,
        debit: debitIdx >= 0 ? moneyValue(cd[debitIdx]?.value) : 0,
        credit: creditIdx >= 0 ? moneyValue(cd[creditIdx]?.value) : 0,
      });
    }
  }
  walk(reportData?.Rows);

  const actual = headerPeriod(reportData);
  const lines: string[] = [`TRIAL BALANCE — ${clientName}`];
  const start = actual.start ?? startDate;
  const end = actual.end ?? endDate;
  if (start || end) lines.push(`Period: ${start ?? '(company start)'} to ${end ?? '(today)'}`);
  const note = periodMismatchNote({ start: startDate, end: endDate }, actual);
  if (note) lines.push(note);

  const hasQboTotal = (qboTotalDebit ?? 0) !== 0 || (qboTotalCredit ?? 0) !== 0;

  if (accountRows.length === 0) {
    if (hasQboTotal) {
      // A non-empty report we could not parse must fail LOUDLY — an empty
      // rendering stamped "BALANCED" is how this bug hid in the first place.
      lines.push(
        '',
        `⚠ PARSE ERROR: QBO returned a non-empty Trial Balance (its summary row reports ${formatCurrency(qboTotalDebit)} / ${formatCurrency(qboTotalCredit)}) but no account rows could be parsed from the response. Do not rely on this rendering. Raw report JSON follows:`,
        '',
        JSON.stringify(reportData, null, 2)
      );
    } else {
      lines.push('─'.repeat(75), '(no account balances — the Trial Balance is empty for this period)');
    }
    return lines.join('\n');
  }

  lines.push('─'.repeat(75));
  lines.push(`  ${'Account'.padEnd(45)} ${'Debit'.padStart(14)} ${'Credit'.padStart(14)}`);
  lines.push('─'.repeat(75));

  let totalDebit = 0;
  let totalCredit = 0;
  for (const r of accountRows) {
    totalDebit += r.debit;
    totalCredit += r.credit;
    const dFmt = r.debit ? formatCurrency(r.debit) : '';
    const cFmt = r.credit ? formatCurrency(r.credit) : '';
    lines.push(`  ${r.label.padEnd(45)} ${dFmt.padStart(14)} ${cFmt.padStart(14)}`);
  }

  lines.push('─'.repeat(75));
  lines.push(`  ${'TOTALS'.padEnd(45)} ${formatCurrency(totalDebit).padStart(14)} ${formatCurrency(totalCredit).padStart(14)}`);

  // "Balanced" must mean the PARSED rows agree with QBO's own summary row —
  // validating the tool's accumulation against itself let an empty parse
  // read as a healthy report.
  const balanced = Math.abs(totalDebit - totalCredit) < 0.01;
  const matchesQbo =
    !hasQboTotal ||
    ((qboTotalDebit === null || Math.abs(totalDebit - qboTotalDebit) < 0.01) &&
      (qboTotalCredit === null || Math.abs(totalCredit - qboTotalCredit) < 0.01));

  if (!matchesQbo) {
    lines.push(
      '',
      `⚠ PARSE MISMATCH: parsed account rows total ${formatCurrency(totalDebit)} / ${formatCurrency(totalCredit)} but QBO's summary row reports ${formatCurrency(qboTotalDebit)} / ${formatCurrency(qboTotalCredit)} — rows are missing from this rendering. Do not rely on it.`
    );
  } else if (balanced) {
    lines.push('', hasQboTotal ? `✓ BALANCED (parsed rows match QBO's reported total ${formatCurrency(qboTotalDebit)})` : '✓ BALANCED');
  } else {
    lines.push('', `⚠ DIFFERENCE: ${formatCurrency(Math.abs(totalDebit - totalCredit))}`);
  }

  return lines.join('\n');
}

// ─── AR / AP Aging ────────────────────────────────────────────────────────────

export function formatAgingReport(
  reportData: any,
  clientName: string,
  type: 'AR' | 'AP',
  asOfDate?: string
): string {
  const label = type === 'AR' ? 'AR AGING' : 'AP AGING';
  const entityLabel = type === 'AR' ? 'Customer' : 'Vendor';

  const columns: any[] = reportData?.Columns?.Column ?? [];
  const colTitles: string[] = columns.map((c: any) => c.ColTitle ?? '');

  const nameWidth = 30;
  const colWidth = 12;
  const lines: string[] = [`${label} — ${clientName}`];

  const actual = headerPeriod(reportData);
  const effectiveAsOf = actual.end ?? asOfDate;
  if (effectiveAsOf) lines.push(`As of: ${effectiveAsOf}`);
  const note = periodMismatchNote({ end: asOfDate }, actual);
  if (note) lines.push(note);

  const headerParts = [entityLabel.padEnd(nameWidth)];
  for (let i = 1; i < colTitles.length; i++) {
    headerParts.push(colTitles[i].padStart(colWidth));
  }
  const separator = '─'.repeat(nameWidth + colTitles.length * colWidth + 2);
  lines.push(separator);
  lines.push(headerParts.join(' '));
  lines.push(separator);

  const colTotals: number[] = new Array(colTitles.length).fill(0);
  let dataRowCount = 0;
  let qboGrandTotal: number | null = null; // last column of QBO's own TOTAL row

  const isGrandTotal = (cd: any[], group?: string): boolean => {
    const rowLabel = String(cd?.[0]?.value ?? '').trim();
    return group === 'GrandTotal' || rowLabel.toUpperCase() === 'TOTAL';
  };

  const renderRow = (cd: any[], accumulate: boolean): void => {
    const rowLabel = String(cd?.[0]?.value ?? '');
    if (!rowLabel) return;
    const parts = [rowLabel.padEnd(nameWidth)];
    for (let i = 1; i < colTitles.length; i++) {
      const num = moneyValue(cd[i]?.value);
      if (accumulate) colTotals[i] += num;
      parts.push((num ? formatCurrency(num) : '').padStart(colWidth));
    }
    lines.push(parts.join(' '));
  };

  function processRows(rows: any): void {
    for (const row of rows?.Row ?? []) {
      if (isSectionish(row)) {
        if (row.Header?.ColData) {
          const sectionLabel = row.Header.ColData[0]?.value ?? '';
          if (sectionLabel) lines.push(`\n${sectionLabel.toUpperCase()}`);
        }
        processRows(row.Rows);
        if (row.Summary?.ColData) {
          if (isGrandTotal(row.Summary.ColData, row.group)) {
            qboGrandTotal = moneyValue(row.Summary.ColData[colTitles.length - 1]?.value);
          }
          renderRow(row.Summary.ColData, false); // subtotal/total display only — never accumulated
        }
      } else if (row.ColData?.length) {
        // Row `type` is optional in QBO report payloads — plain (un-sectioned)
        // customers/vendors arrive as bare ColData rows; requiring
        // type === 'Data' silently dropped them from the rendering.
        if (isGrandTotal(row.ColData, row.group)) {
          qboGrandTotal = moneyValue(row.ColData[colTitles.length - 1]?.value);
          renderRow(row.ColData, false);
          continue;
        }
        renderRow(row.ColData, true);
        dataRowCount++;
      }
    }
  }

  processRows(reportData?.Rows);

  lines.push(separator);
  const totalParts = ['TOTAL'.padEnd(nameWidth)];
  for (let i = 1; i < colTitles.length; i++) {
    totalParts.push((colTotals[i] ? formatCurrency(colTotals[i]) : '$0.00').padStart(colWidth));
  }
  lines.push(totalParts.join(' '));

  // Reconcile the computed grand total against QBO's own TOTAL row so a row
  // that fails to parse can never vanish silently.
  const computedGrand = colTotals[colTitles.length - 1] ?? 0;
  if (qboGrandTotal !== null && Math.abs(computedGrand - qboGrandTotal) > 0.01) {
    lines.push(
      '',
      `⚠ PARSE MISMATCH: parsed ${entityLabel.toLowerCase()} rows total ${formatCurrency(computedGrand)} but QBO's summary row reports ${formatCurrency(qboGrandTotal)} — rows are missing from this rendering. Do not rely on it.`
    );
  } else if (dataRowCount === 0 && (qboGrandTotal === null || qboGrandTotal === 0)) {
    lines.push('', `(no open ${type === 'AR' ? 'receivables' : 'payables'} as of this date)`);
  }

  return lines.join('\n');
}
