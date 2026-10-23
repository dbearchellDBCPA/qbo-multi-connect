import { QBOClient } from './client.js';

/**
 * QBO Company API
 */
export class CompanyAPI {
  constructor(private client: QBOClient) {}

  /**
   * Get company information
   */
  async getInfo(realmId: string): Promise<unknown> {
    return this.client.get(realmId, 'companyinfo/' + realmId, {});
  }

  /**
   * Get company preferences
   */
  async getPreferences(realmId: string): Promise<unknown> {
    return this.client.get(realmId, 'preferences', {});
  }

  /**
   * Update company preferences (POST /preferences). Pass `sparse: true` plus
   * Id and SyncToken to change only the fields supplied.
   */
  async updatePreferences(realmId: string, body: Record<string, unknown>): Promise<unknown> {
    return this.client.post(realmId, 'preferences', body);
  }

  /**
   * Get company currency
   */
  async getCurrency(realmId: string): Promise<unknown> {
    // Currency info is in company info
    const companyInfo = await this.getInfo(realmId);
    return companyInfo;
  }

  /**
   * Get fiscal year info
   */
  async getFiscalYear(realmId: string): Promise<unknown> {
    const prefs = await this.getPreferences(realmId);
    return prefs;
  }
}
