import { ConnectionDatabase } from '../db/index.js';
import { encrypt, decrypt } from '../crypto/encrypt.js';
import type {
  Connection,
  ConnectionRecord,
  NewConnection,
  TokenUpdate,
} from '../db/models.js';

/**
 * Token store with encryption
 */
export class TokenStore {
  constructor(
    private db: ConnectionDatabase,
    private encryptionKey: string
  ) {}

  /**
   * Store a connection with encrypted tokens. If the realm is already
   * connected, its tokens are refreshed in place and status reset to
   * active — this is what makes re-authorizing an expired company work
   * without wiping its member assignments.
   */
  async storeConnection(conn: NewConnection): Promise<number> {
    const encryptedAccessToken = encrypt(conn.accessToken, this.encryptionKey);
    const encryptedRefreshToken = encrypt(conn.refreshToken, this.encryptionKey);

    return await this.db.upsertConnection(conn, encryptedAccessToken, encryptedRefreshToken);
  }

  /**
   * Rename a connection's display label.
   */
  async renameConnection(realmId: string, clientName: string): Promise<void> {
    await this.db.renameConnection(realmId, clientName);
  }

  /**
   * Get connection by realm ID with decrypted tokens
   */
  async getConnection(realmId: string): Promise<Connection | null> {
    const record = await this.db.getConnectionByRealmId(realmId);
    if (!record) return null;
    return this.decryptConnection(record);
  }

  /**
   * Get connection by client name with decrypted tokens
   */
  async getConnectionByName(clientName: string): Promise<Connection | null> {
    const record = await this.db.getConnectionByClientName(clientName);
    if (!record) return null;
    return this.decryptConnection(record);
  }

  /**
   * Get all connections with decrypted tokens
   */
  async getAllConnections(): Promise<Connection[]> {
    const records = await this.db.getAllConnections();
    return records.map(record => this.decryptConnection(record));
  }

  /**
   * Update tokens for a connection
   */
  async updateTokens(realmId: string, update: TokenUpdate): Promise<void> {
    const encryptedAccessToken = encrypt(update.accessToken, this.encryptionKey);
    const encryptedRefreshToken = encrypt(update.refreshToken, this.encryptionKey);

    await this.db.updateTokens(realmId, encryptedAccessToken, encryptedRefreshToken, update);
  }

  /**
   * Update connection status
   */
  async updateStatus(realmId: string, status: 'active' | 'expired' | 'revoked'): Promise<void> {
    await this.db.updateStatus(realmId, status);
  }

  /**
   * Delete connection
   */
  async deleteConnection(realmId: string): Promise<void> {
    await this.db.deleteConnection(realmId);
  }

  /**
   * Get connections expiring soon
   */
  async getConnectionsExpiringSoon(minutesThreshold: number = 10): Promise<Connection[]> {
    const records = await this.db.getConnectionsExpiringSoon(minutesThreshold);
    return records.map(record => this.decryptConnection(record));
  }

  /**
   * Expired connections whose refresh window is still open (revival candidates)
   */
  async getRevivableConnections(): Promise<Connection[]> {
    const records = await this.db.getRevivableConnections();
    return records.map(record => this.decryptConnection(record));
  }

  /**
   * Decrypt connection record
   */
  private decryptConnection(record: ConnectionRecord): Connection {
    return {
      id: record.id,
      clientName: record.client_name,
      realmId: record.realm_id,
      accessToken: decrypt(record.access_token, this.encryptionKey),
      refreshToken: decrypt(record.refresh_token, this.encryptionKey),
      tokenExpiry: new Date(record.token_expiry),
      refreshExpiry: new Date(record.refresh_expiry),
      scopes: record.scopes.split(','),
      status: record.status,
      createdAt: new Date(record.created_at),
      updatedAt: new Date(record.updated_at),
    };
  }
}
