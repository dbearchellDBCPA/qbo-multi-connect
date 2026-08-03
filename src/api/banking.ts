import { QBOClient } from './client.js';

/**
 * QBO Banking API
 *
 * Wraps bank-register transaction entities (Deposit, Transfer,
 * CreditCardPayment) and the TransactionList report used to read the
 * posted register for a bank/credit-card account.
 *
 * NOTE: QBO's public API does NOT expose the "For Review" bank feed
 * queue. These tools operate on transactions already posted to the
 * register.
 */
export class BankingAPI {
  constructor(private client: QBOClient) {}

  // ── Deposit ──────────────────────────────────────────────────────────────

  async createDeposit(realmId: string, deposit: any): Promise<unknown> {
    return this.client.post(realmId, 'deposit', deposit);
  }

  async getDeposit(realmId: string, depositId: string): Promise<unknown> {
    return this.client.get(realmId, `deposit/${depositId}`, {});
  }

  async updateDeposit(realmId: string, deposit: any): Promise<unknown> {
    if (!deposit.Id || !deposit.SyncToken) {
      throw new Error('Deposit must have Id and SyncToken for updates');
    }
    return this.client.post(realmId, 'deposit', deposit);
  }

  async deleteDeposit(realmId: string, depositId: string, syncToken: string): Promise<unknown> {
    return this.client.post(realmId, 'deposit?operation=delete', {
      Id: depositId,
      SyncToken: syncToken,
    });
  }

  // ── Transfer ─────────────────────────────────────────────────────────────

  async createTransfer(realmId: string, transfer: any): Promise<unknown> {
    return this.client.post(realmId, 'transfer', transfer);
  }

  async getTransfer(realmId: string, transferId: string): Promise<unknown> {
    return this.client.get(realmId, `transfer/${transferId}`, {});
  }

  async updateTransfer(realmId: string, transfer: any): Promise<unknown> {
    if (!transfer.Id || !transfer.SyncToken) {
      throw new Error('Transfer must have Id and SyncToken for updates');
    }
    return this.client.post(realmId, 'transfer', transfer);
  }

  async deleteTransfer(realmId: string, transferId: string, syncToken: string): Promise<unknown> {
    return this.client.post(realmId, 'transfer?operation=delete', {
      Id: transferId,
      SyncToken: syncToken,
    });
  }

  // ── Credit Card Payment ──────────────────────────────────────────────────
  //
  // Pays a credit card from a bank account. Distinct from the
  // CreditCardPayment sub-object used inside BillPayment: this is a
  // standalone transfer-like entity that clears a CC balance.

  async createCreditCardPayment(realmId: string, payment: any): Promise<unknown> {
    return this.client.post(realmId, 'creditcardpaymenttxn', payment);
  }

  async getCreditCardPayment(realmId: string, paymentId: string): Promise<unknown> {
    return this.client.get(realmId, `creditcardpaymenttxn/${paymentId}`, {});
  }

  // ── TransactionList report (bank register read) ─────────────────────────
  //
  // The TransactionList report is QBO's canonical way to read the posted
  // register for a given account. It accepts many filters but the ones
  // most useful for a bank-register view are `account`, `start_date`,
  // `end_date`, and `cleared`.

  async transactionList(
    realmId: string,
    options: {
      startDate?: string;
      endDate?: string;
      accountId?: string;
      cleared?: 'Cleared' | 'Uncleared' | 'Reconciled' | 'Deposited';
      transactionType?: string;
      customerId?: string;
      vendorId?: string;
      memo?: string;
    } = {}
  ): Promise<unknown> {
    const query: Record<string, string> = {};
    if (options.startDate) query.start_date = options.startDate;
    if (options.endDate) query.end_date = options.endDate;
    if (options.accountId) query.account = options.accountId;
    if (options.cleared) query.cleared = options.cleared;
    if (options.transactionType) query.transaction_type = options.transactionType;
    if (options.customerId) query.customer = options.customerId;
    if (options.vendorId) query.vendor = options.vendorId;
    if (options.memo) query.memo = options.memo;
    return this.client.get(realmId, 'reports/TransactionList', query);
  }
}
