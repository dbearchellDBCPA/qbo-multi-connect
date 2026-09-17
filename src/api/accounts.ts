import { QBOClient } from './client.js';

/**
 * QBO Accounts API
 */
export class AccountsAPI {
  constructor(private client: QBOClient) {}

  /**
   * Get account by ID
   */
  async get(realmId: string, accountId: string): Promise<unknown> {
    return this.client.get(realmId, `account/${accountId}`, {});
  }

  /**
   * Query accounts
   */
  async query(realmId: string, query: string): Promise<unknown> {
    // Example: "SELECT * FROM Account WHERE AccountType = 'Expense'"
    return this.client.query(realmId, query);
  }

  /**
   * Get all accounts. QBO's query returns active objects only unless Active is
   * filtered explicitly, so includeInactive adds `WHERE Active IN (true, false)`
   * (deactivated accounts come back named "Name (deleted)").
   */
  async getAll(realmId: string, options: { maxResults?: number; includeInactive?: boolean } = {}): Promise<unknown> {
    const maxResults = options.maxResults || 1000;
    const where = options.includeInactive ? ' WHERE Active IN (true, false)' : '';
    return this.query(realmId, `SELECT * FROM Account${where} MAXRESULTS ${maxResults}`);
  }

  /**
   * Get accounts by type
   */
  async getByType(realmId: string, accountType: string): Promise<unknown> {
    return this.query(realmId, `SELECT * FROM Account WHERE AccountType = '${accountType}'`);
  }

  /**
   * Get active accounts only
   */
  async getActive(realmId: string): Promise<unknown> {
    return this.query(realmId, `SELECT * FROM Account WHERE Active = true`);
  }

  /**
   * Get chart of accounts with balances
   * Note: QBO doesn't provide direct balance query, need to aggregate from transactions
   * or use reports API
   */
  async getChartOfAccounts(realmId: string): Promise<unknown> {
    return this.getAll(realmId);
  }

  /**
   * Get accounts by account type
   * Valid types: Bank, Other Current Asset, Fixed Asset, Other Asset,
   * Accounts Receivable, Equity, Expense, Other Expense, Cost of Goods Sold,
   * Accounts Payable, Credit Card, Long Term Liability, Other Current Liability,
   * Income, Other Income
   */
  async getAccountsByType(
    realmId: string,
    accountType: string,
    options: { activeOnly?: boolean } = {}
  ): Promise<unknown> {
    let query = `SELECT * FROM Account WHERE AccountType = '${accountType}'`;
    
    if (options.activeOnly) {
      query += ` AND Active = true`;
    }
    
    return this.query(realmId, query);
  }

  /**
   * Search accounts by name
   */
  async searchByName(realmId: string, name: string): Promise<unknown> {
    return this.query(
      realmId,
      `SELECT * FROM Account WHERE Name LIKE '%${name}%'`
    );
  }

  /**
   * Create a new account
   */
  async create(realmId: string, account: any): Promise<unknown> {
    return this.client.post(realmId, 'account', account);
  }

  /**
   * Update an existing account
   */
  async update(realmId: string, account: any): Promise<unknown> {
    if (!account.Id || !account.SyncToken) {
      throw new Error('Account must have Id and SyncToken for updates');
    }
    return this.client.post(realmId, 'account', account);
  }

  /**
   * Deactivate an account. QBO has no delete operation for Account — posting
   * `account?operation=delete` fails with "Operation Delete is not supported"
   * (QBO code 500) — so this is the documented sparse update setting
   * Active=false. QBO renames the account "Name (deleted)" and frees both the
   * name and the account number for reuse.
   */
  async deactivate(realmId: string, account: any): Promise<unknown> {
    if (!account.Id || account.SyncToken === undefined || account.SyncToken === null) {
      throw new Error('Account must have Id and SyncToken for deactivation');
    }
    return this.client.post(realmId, 'account', {
      Id: account.Id,
      SyncToken: account.SyncToken,
      Active: false,
      sparse: true,
    });
  }

  /**
   * Get expense accounts (for journal entries, bills, etc.)
   */
  async getExpenseAccounts(realmId: string): Promise<unknown> {
    return this.query(
      realmId,
      `SELECT * FROM Account WHERE AccountType = 'Expense' OR AccountType = 'Other Expense' OR AccountType = 'Cost of Goods Sold'`
    );
  }

  /**
   * Get bank and credit card accounts
   */
  async getBankAccounts(realmId: string): Promise<unknown> {
    return this.query(
      realmId,
      `SELECT * FROM Account WHERE AccountType = 'Bank' OR AccountType = 'Credit Card'`
    );
  }

  /**
   * Get income accounts
   */
  async getIncomeAccounts(realmId: string): Promise<unknown> {
    return this.query(
      realmId,
      `SELECT * FROM Account WHERE AccountType = 'Income' OR AccountType = 'Other Income'`
    );
  }
}
