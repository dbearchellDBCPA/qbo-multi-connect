import { QBOClient, QBOError } from './client.js';
import {
  isNotFoundError,
  listRecurringWrappers,
  matchesRecurringId,
  unwrapRecurring,
  type UnwrappedRecurring,
} from '../server/recurring-transaction.js';

/**
 * QBO RecurringTransaction API.
 *
 * GET    /v3/company/{realmId}/recurringtransaction/{id}
 * POST   /v3/company/{realmId}/recurringtransaction          (full type-wrapped update)
 * GET    /v3/company/{realmId}/query?query=SELECT * FROM RecurringTransaction
 *
 * There is no documented sparse-update operation for this entity.
 */
export class RecurringAPI {
  constructor(private client: QBOClient) {}

  async get(realmId: string, recurringTransactionId: string): Promise<unknown> {
    return this.client.get(realmId, `recurringtransaction/${encodeURIComponent(recurringTransactionId)}`, {});
  }

  async queryAll(realmId: string): Promise<unknown> {
    return this.client.query(realmId, 'SELECT * FROM RecurringTransaction MAXRESULTS 1000');
  }

  /**
   * Resolve a RecurringTransaction by the wrapped txn Id (what GET
   * /recurringtransaction/{id} uses) or by RecurDataRef.value (the id
   * stamped on generated transactions). Direct GET first; on HTTP 404 or
   * a not-found Fault (code 610 / "Object Not Found"), scan the query list.
   */
  async resolve(realmId: string, id: string): Promise<{ unwrapped: UnwrappedRecurring; raw: unknown; matched_by: 'id' | 'recur_data_ref' }> {
    const rawId = String(id).trim();
    if (!rawId) throw new QBOError('Recurring transaction id is required.');

    try {
      const raw = await this.get(realmId, rawId);
      const unwrapped = unwrapRecurring(raw);
      if (unwrapped) {
        const matched_by = unwrapped.txn?.RecurDataRef?.value != null && String(unwrapped.txn.RecurDataRef.value) === rawId && String(unwrapped.txn.Id) !== rawId
          ? 'recur_data_ref' as const
          : 'id' as const;
        return { unwrapped, raw, matched_by };
      }
    } catch (err) {
      if (!isNotFoundError(err)) throw err;
    }

    const queried = await this.queryAll(realmId);
    const match = listRecurringWrappers(queried).find((w) => matchesRecurringId(w, rawId));
    const unwrapped = match ? unwrapRecurring(match) : null;
    if (!unwrapped) {
      throw new QBOError(
        `RecurringTransaction "${rawId}" was not found by Id or RecurDataRef. Use query_transactions with "SELECT * FROM RecurringTransaction" to list templates.`,
        404,
      );
    }
    const matched_by = unwrapped.txn?.RecurDataRef?.value != null && String(unwrapped.txn.RecurDataRef.value) === rawId
      ? 'recur_data_ref' as const
      : 'id' as const;
    return { unwrapped, raw: { QueryResponse: { RecurringTransaction: [match] } }, matched_by };
  }

  /**
   * Full update. Body must be the type-wrapped object, e.g. `{ Bill: { ... } }`,
   * including SyncToken and the complete Line array. Do not send a sparse patch.
   */
  async update(realmId: string, wrapper: Record<string, unknown>): Promise<unknown> {
    return this.client.post(realmId, 'recurringtransaction', wrapper);
  }

  /** Create a type-wrapped RecurringTransaction (Bill, JournalEntry, …). */
  async create(realmId: string, wrapper: Record<string, unknown>): Promise<unknown> {
    return this.client.post(realmId, 'recurringtransaction', wrapper);
  }

  /**
   * Delete requires the full type-wrapped object (Id + SyncToken + lines),
   * not a sparse Id/SyncToken body.
   */
  async delete(realmId: string, wrapper: Record<string, unknown>): Promise<unknown> {
    return this.client.post(realmId, 'recurringtransaction?operation=delete', wrapper);
  }
}
