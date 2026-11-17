import { QBOClient } from './client.js';

/**
 * QBO TimeActivity Accounting API.
 *
 * GET  /v3/company/{realmId}/timeactivity/{id}
 * POST /v3/company/{realmId}/timeactivity          (create / full update)
 * POST /v3/company/{realmId}/timeactivity?operation=delete
 *
 * https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/timeactivity
 */
export class TimeActivityAPI {
  constructor(private client: QBOClient) {}

  async get(realmId: string, timeActivityId: string): Promise<unknown> {
    return this.client.get(realmId, `timeactivity/${encodeURIComponent(timeActivityId)}`, {});
  }

  async create(realmId: string, timeActivity: Record<string, unknown>): Promise<unknown> {
    return this.client.post(realmId, 'timeactivity', timeActivity);
  }

  async update(realmId: string, timeActivity: Record<string, unknown>): Promise<unknown> {
    if (!timeActivity.Id || !timeActivity.SyncToken) {
      throw new Error('TimeActivity must have Id and SyncToken for updates');
    }
    return this.client.post(realmId, 'timeactivity', timeActivity);
  }

  async delete(realmId: string, timeActivityId: string, syncToken: string): Promise<unknown> {
    return this.client.post(realmId, 'timeactivity?operation=delete', {
      Id: timeActivityId,
      SyncToken: syncToken,
    });
  }
}
