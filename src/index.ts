import { ConnectionDatabase } from './db/index.js';
import { TokenStore, CallbackServer, generateAuthUrl, RefreshDaemon } from './auth/index.js';
import { QBOClient, ReportsAPI, JournalEntriesAPI, TransactionsAPI, AccountsAPI, CompanyAPI, BankingAPI, ListsAPI, AttachmentsAPI } from './api/index.js';
import { UserService } from './users.js';
import { UploadTokenService } from './upload-tokens.js';
import { OAuthServerService } from './oauth-server.js';
import type { OAuthConfig, Connection } from './db/models.js';

export interface QBOManagerConfig {
  dbPath: string;
  encryptionKey: string;
  clientId?: string;
  clientSecret?: string;
  redirectUri?: string;
  environment?: 'sandbox' | 'production';
}

/**
 * Main QBOManager class - Primary programmatic API
 */
export class QBOManager {
  private db: ConnectionDatabase;
  private tokenStore: TokenStore;
  public readonly client: QBOClient;
  private oauthConfig: OAuthConfig;
  private refreshDaemon: RefreshDaemon | null = null;

  public readonly reports: ReportsAPI;
  public readonly journalEntries: JournalEntriesAPI;
  public readonly transactions: TransactionsAPI;
  public readonly accounts: AccountsAPI;
  public readonly company: CompanyAPI;
  public readonly banking: BankingAPI;
  public readonly lists: ListsAPI;
  public readonly attachments: AttachmentsAPI;
  public readonly uploadTokens: UploadTokenService;
  public readonly oauth: OAuthServerService;
  public readonly users: UserService;

  constructor(config: QBOManagerConfig) {
    // Validate config
    if (!config.encryptionKey || config.encryptionKey.length !== 64) {
      throw new Error('encryptionKey must be 64 hex characters (32 bytes)');
    }

    // Initialize database
    this.db = new ConnectionDatabase(config.dbPath);
    this.tokenStore = new TokenStore(this.db, config.encryptionKey);

    // OAuth configuration
    this.oauthConfig = {
      clientId: config.clientId || '',
      clientSecret: config.clientSecret || '',
      redirectUri: config.redirectUri || 'http://localhost:3456/callback',
      environment: config.environment || 'sandbox',
    };

    // Initialize API client
    this.client = new QBOClient(this.tokenStore, this.oauthConfig, config.environment || 'sandbox');

    // Initialize API modules
    this.reports = new ReportsAPI(this.client);
    this.journalEntries = new JournalEntriesAPI(this.client);
    this.transactions = new TransactionsAPI(this.client);
    this.accounts = new AccountsAPI(this.client);
    this.company = new CompanyAPI(this.client);
    this.banking = new BankingAPI(this.client);
    this.lists = new ListsAPI(this.client);
    this.attachments = new AttachmentsAPI(this.client);
    this.uploadTokens = new UploadTokenService(this.db);
    this.oauth = new OAuthServerService(this.db);
    this.users = new UserService(this.db, config.encryptionKey);
  }

  /**
   * Generate OAuth authorization URL
   */
  getAuthUrl(clientName: string, oauthOverride?: Partial<OAuthConfig>): string {
    const config = { ...this.oauthConfig, ...oauthOverride };
    return generateAuthUrl(config, clientName);
  }

  /**
   * Start OAuth callback server and wait for authorization
   */
  async startCallbackServer(
    clientName: string,
    port: number = 3456,
    oauthOverride?: Partial<OAuthConfig>
  ): Promise<{ realmId: string; clientName: string; success: boolean }> {
    const config = { ...this.oauthConfig, ...oauthOverride };
    const server = new CallbackServer(this.tokenStore, config, clientName);
    return server.start(port);
  }

  /**
   * Connect a new client (generate URL + start callback server)
   */
  async connect(
    clientName: string,
    options: {
      port?: number;
      oauthConfig?: Partial<OAuthConfig>;
      openBrowser?: boolean;
    } = {}
  ): Promise<{ authUrl: string; result: { realmId: string; clientName: string; success: boolean } }> {
    const config = { ...this.oauthConfig, ...options.oauthConfig };
    const port = options.port || 3456;

    const authUrl = this.getAuthUrl(clientName, config);
    
    console.log(`\nAuthorization URL for ${clientName}:\n${authUrl}\n`);
    
    if (options.openBrowser) {
      // Could use 'open' package here, but keeping dependencies minimal
      console.log('Opening browser...');
    }

    const result = await this.startCallbackServer(clientName, port, config);
    
    return { authUrl, result };
  }

  /**
   * List all connections
   */
  async listConnections(): Promise<Connection[]> {
    return this.tokenStore.getAllConnections();
  }

  /**
   * Get connection by realm ID
   */
  async getConnection(realmId: string): Promise<Connection | null> {
    return this.tokenStore.getConnection(realmId);
  }

  /**
   * Get connection by client name
   */
  async getConnectionByName(clientName: string): Promise<Connection | null> {
    return this.tokenStore.getConnectionByName(clientName);
  }

  /**
   * Rename a connection's display label (does not touch QuickBooks).
   */
  async renameConnection(realmId: string, clientName: string): Promise<void> {
    await this.tokenStore.renameConnection(realmId, clientName);
  }

  /**
   * Revoke/disconnect a connection
   */
  async revokeConnection(realmId: string): Promise<void> {
    // Assignments go first: if we crash mid-way, members lose access to a
    // still-listed company (safe) rather than silently regaining access if
    // the same realm is ever reconnected (unsafe).
    await this.users.removeRealmAssignments(realmId);
    await this.tokenStore.updateStatus(realmId, 'revoked');
    await this.tokenStore.deleteConnection(realmId);
  }

  /**
   * Start proactive token refresh daemon
   */
  startRefreshDaemon(checkIntervalMs: number = 5 * 60 * 1000): void {
    if (this.refreshDaemon?.isRunning()) {
      console.warn('Refresh daemon already running');
      return;
    }

    this.refreshDaemon = new RefreshDaemon(this.tokenStore, this.oauthConfig, checkIntervalMs);
    this.refreshDaemon.start();
  }

  /**
   * Stop refresh daemon
   */
  stopRefreshDaemon(): void {
    this.refreshDaemon?.stop();
  }

  /**
   * Close database connection
   */
  async close(): Promise<void> {
    this.stopRefreshDaemon();
    await this.db.close();
  }
}

// Re-export types and utilities
export type { Connection, OAuthConfig, User, NewUser, UserUpdate, UserRole, UserStatus } from './db/models.js';
export { QBOError } from './api/index.js';
export { UserService, generateApiKey, hashApiKey } from './users.js';
