import { QBOClient } from './client.js';

/**
 * QBO Lists / Dimensions API
 *
 * Wraps list-style entities used to populate dimensional fields on
 * transactions: Item (products & services), Class, Department (Location),
 * Employee, TaxCode, and TaxRate.
 */
export class ListsAPI {
  constructor(private client: QBOClient) {}

  // ── Items (products & services) ─────────────────────────────────────────

  async getItems(
    realmId: string,
    options: { activeOnly?: boolean; maxResults?: number } = {}
  ): Promise<unknown> {
    const max = options.maxResults ?? 1000;
    const where = options.activeOnly ? ' WHERE Active = true' : '';
    return this.client.query(realmId, `SELECT * FROM Item${where} MAXRESULTS ${max}`);
  }

  async getItem(realmId: string, itemId: string): Promise<unknown> {
    return this.client.get(realmId, `item/${itemId}`, {});
  }

  async createItem(realmId: string, item: any): Promise<unknown> {
    return this.client.post(realmId, 'item', item);
  }

  async updateItem(realmId: string, item: any): Promise<unknown> {
    if (!item.Id || !item.SyncToken) {
      throw new Error('Item must have Id and SyncToken for updates');
    }
    return this.client.post(realmId, 'item', item);
  }

  // ── Classes ──────────────────────────────────────────────────────────────

  async getClasses(realmId: string, options: { activeOnly?: boolean } = {}): Promise<unknown> {
    const where = options.activeOnly ? ' WHERE Active = true' : '';
    return this.client.query(realmId, `SELECT * FROM Class${where} MAXRESULTS 1000`);
  }

  async createClass(realmId: string, cls: any): Promise<unknown> {
    return this.client.post(realmId, 'class', cls);
  }

  // ── Departments (a.k.a. Locations) ───────────────────────────────────────

  async getDepartments(realmId: string, options: { activeOnly?: boolean } = {}): Promise<unknown> {
    const where = options.activeOnly ? ' WHERE Active = true' : '';
    return this.client.query(realmId, `SELECT * FROM Department${where} MAXRESULTS 1000`);
  }

  async createDepartment(realmId: string, dept: any): Promise<unknown> {
    return this.client.post(realmId, 'department', dept);
  }

  // ── Employees ────────────────────────────────────────────────────────────

  async getEmployees(realmId: string, options: { activeOnly?: boolean } = {}): Promise<unknown> {
    const where = options.activeOnly ? ' WHERE Active = true' : '';
    return this.client.query(realmId, `SELECT * FROM Employee${where} MAXRESULTS 1000`);
  }

  async createEmployee(realmId: string, emp: any): Promise<unknown> {
    return this.client.post(realmId, 'employee', emp);
  }

  // ── Tax codes / rates ────────────────────────────────────────────────────

  async getTaxCodes(realmId: string): Promise<unknown> {
    return this.client.query(realmId, `SELECT * FROM TaxCode MAXRESULTS 500`);
  }

  async getTaxRates(realmId: string): Promise<unknown> {
    return this.client.query(realmId, `SELECT * FROM TaxRate MAXRESULTS 500`);
  }

  // ── Payment methods (referenced by Payment entity) ──────────────────────

  async getPaymentMethods(realmId: string): Promise<unknown> {
    return this.client.query(realmId, `SELECT * FROM PaymentMethod MAXRESULTS 500`);
  }
}
