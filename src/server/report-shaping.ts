/**
 * Pure helpers that shape report-tool inputs and outputs:
 *  - resolving human account filters (numbers/names) → QBO Account IDs
 *  - collapsing report payloads to summary form for size control
 *  - filtering Budget entities by name / active date
 *
 * Kept free of I/O so the matching semantics are unit-testable.
 */

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
      if (parts.length > 1 && /^\d+$/.test(parts[0])) {
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
      transaction_count: (a.transactions ?? []).length,
      total_debits: a.total_debits,
      total_credits: a.total_credits,
      ending_balance: a.ending_balance,
    })),
  };
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
