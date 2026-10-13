import { ConnectionDatabase, type DatabaseOptions, type PostgresDriverOptions, type SqlDialect } from './db/index.js';
import { ImportStoreHandle, IMPORT_STORE_FILENAME } from './db/import-store.js';
import { join } from 'node:path';
import { TokenStore, CallbackServer, generateAuthUrl, RefreshDaemon } from './auth/index.js';
import { QBOClient, ReportsAPI, JournalEntriesAPI, TransactionsAPI, AccountsAPI, CompanyAPI, BankingAPI, ListsAPI, AttachmentsAPI, BatchAPI } from './api/index.js';
import { UserService } from './users.js';
import { UploadTokenService } from './upload-tokens.js';
import { OAuthServerService } from './oauth-server.js';
import { ConnectionAlerts } from './alerts/connection-alerts.js';
import { disabledAlertsConfig, type AlertsConfig } from './alerts/config.js';
import { ResendEmailSender, type EmailSender } from './alerts/email.js';
import type { OAuthConfig, Connection } from './db/models.js';

/** Postgres connection for the hosted platform. When set, dbPath is ignored. */
export interface PostgresDatabaseConfig {
  /** postgres://… (Railway: DATABASE_URL). */
  url: string;
  /** Schema to use instead of public — the test suite gives each test its own. */
  schema?: string;
  /** Drop the schema on close (disposable test schemas only). */
  dropSchemaOnClose?: boolean;
  /** TLS handling; see PostgresDriverOptions.ssl. */
  ssl?: PostgresDriverOptions['ssl'];
}

export interface QBOManagerConfig {
  /** SQLite file (':memory:' for an ephemeral database). Required unless `database` is set. */
  dbPath?: string;
  /** Postgres. Takes precedence over dbPath. */
  database?: PostgresDatabaseConfig;
  encryptionKey: string;
  clientId?: string;
  clientSecret?: string;
  redirectUri?: string;
  environment?: 'sandbox' | 'production';
  /** Email alerts when a connection breaks. Omit, or pass a disabled config, to turn them off. */
  alerts?: AlertsConfig;
  /** Email transport override (tests). Defaults to Resend with alerts.resendApiKey. */
  emailSender?: EmailSender;
  /** The dashboard's public address, for links in alert emails. */
  dashboardUrl?: () => string | null;
}

function databaseOptions(config: QBOManagerConfig): DatabaseOptions {
  if (config.database) {
    return {
      postgres: {
        connectionString: config.database.url,
        schema: config.database.schema,
        dropSchemaOnClose: config.database.dropSchemaOnClose,
        ssl: config.database.ssl,
      },
    };
  }
  if (!config.dbPath) throw new Error('QBOManager needs dbPath (SQLite) or database (Postgres)');
  return { sqlitePath: config.dbPath };
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
  public readonly batch: BatchAPI;
  public readonly uploadTokens: UploadTokenService;
  public readonly oauth: OAuthServerService;
  public readonly users: UserService;
  public readonly alerts: ConnectionAlerts;

  constructor(config: QBOManagerConfig) {
    // Validate config
    if (!config.encryptionKey || config.encryptionKey.length !== 64) {
      throw new Error('encryptionKey must be 64 hex characters (32 bytes)');
    }

    // Initialize database: Postgres when configured, else the SQLite file.
    this.db = new ConnectionDatabase(databaseOptions(config));
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
    this.batch = new BatchAPI(this.client);
    this.uploadTokens = new UploadTokenService(this.db);
    this.oauth = new OAuthServerService(this.db);
    this.users = new UserService(this.db, config.encryptionKey);

    // Email alerts for broken connections: off unless configured. The
    // transport is injectable so tests never reach the network.
    const alertsConfig = config.alerts ?? disabledAlertsConfig();
    const emailSender =
      config.emailSender ?? (alertsConfig.enabled ? new ResendEmailSender(alertsConfig.resendApiKey) : null);
    this.alerts = new ConnectionAlerts(this.db, alertsConfig, emailSender, config.dashboardUrl);
  }

  /** Which engine the connections database runs on. */
  get dialect(): SqlDialect {
    return this.db.dialect;
  }

  /**
   * The bulk-import mapping store. On Postgres it shares this manager's
   * database; on SQLite it is its own file in `dataDir` (next to the
   * connections DB), so it can be deleted and rebuilt without touching
   * tokens or users.
   */
  importStoreHandle(dataDir: string): ImportStoreHandle {
    if (this.db.dialect === 'postgres') return ImportStoreHandle.forDriver(this.db.driver);
    return ImportStoreHandle.forSqliteFile(join(dataDir, IMPORT_STORE_FILENAME));
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

    this.refreshDaemon = new RefreshDaemon(this.tokenStore, this.oauthConfig, checkIntervalMs, undefined, this.alerts);
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
export { parseAlertsConfig } from './alerts/config.js';
export type { AlertsConfig } from './alerts/config.js';
export type { EmailSender, OutboundEmail } from './alerts/email.js';
