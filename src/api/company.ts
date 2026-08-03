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
