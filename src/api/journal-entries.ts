import { QBOClient } from './client.js';

export interface JournalEntryLine {
  Description?: string;
  Amount: number;
  DetailType: 'JournalEntryLineDetail';
  JournalEntryLineDetail: {
    PostingType: 'Credit' | 'Debit';
    AccountRef: {
      value: string; // Account ID
      name?: string;
    };
    Entity?: {
      Type: 'Customer' | 'Vendor' | 'Employee';
      EntityRef: {
        value: string;
        name?: string;
      };
    };
    ClassRef?: {
      value: string;
      name?: string;
    };
  };
}

export interface JournalEntryCreate {
  TxnDate?: string; // YYYY-MM-DD
  PrivateNote?: string;
  Line: JournalEntryLine[];
}

/**
 * QBO Journal Entries API
 */
export class JournalEntriesAPI {
  constructor(private client: QBOClient) {}

  /**
   * Create a journal entry
   */
  async create(realmId: string, journalEntry: JournalEntryCreate): Promise<unknown> {
    return this.client.post(realmId, 'journalentry', journalEntry);
  }

  /**
   * Get journal entry by ID
   */
  async get(realmId: string, journalEntryId: string): Promise<unknown> {
    return this.client.get(realmId, `journalentry/${journalEntryId}`, {});
  }

  /**
   * Query journal entries
   */
  async query(realmId: string, queryString: string): Promise<unknown> {
    // Example: "SELECT * FROM JournalEntry WHERE TxnDate >= '2026-01-01'"
    return this.client.query(realmId, queryString);
  }

  /**
   * Get all journal entries (paginated)
   */
  async getAll(realmId: string, options: { maxResults?: number; startPosition?: number } = {}): Promise<unknown> {
    const maxResults = options.maxResults || 100;
    const startPosition = options.startPosition || 1;
    
    return this.query(
      realmId,
      `SELECT * FROM JournalEntry MAXRESULTS ${maxResults} STARTPOSITION ${startPosition}`
    );
  }

  /**
   * Get journal entries by date range
   */
  async getByDateRange(
    realmId: string,
    startDate: string,
    endDate: string,
    options: { maxResults?: number } = {}
  ): Promise<unknown> {
    const maxResults = options.maxResults || 100;
    return this.query(
      realmId,
      `SELECT * FROM JournalEntry WHERE TxnDate >= '${startDate}' AND TxnDate <= '${endDate}' MAXRESULTS ${maxResults}`
    );
  }

  /**
   * Update a journal entry
   */
  async update(realmId: string, journalEntry: any): Promise<unknown> {
    if (!journalEntry.Id || !journalEntry.SyncToken) {
      throw new Error('Journal entry must have Id and SyncToken for updates');
    }
    return this.client.post(realmId, 'journalentry', journalEntry);
  }

  /**
   * Delete a journal entry (soft delete)
   */
  async delete(realmId: string, journalEntryId: string, syncToken: string): Promise<unknown> {
    return this.client.post(realmId, `journalentry?operation=delete`, {
      Id: journalEntryId,
      SyncToken: syncToken,
    });
  }
}
