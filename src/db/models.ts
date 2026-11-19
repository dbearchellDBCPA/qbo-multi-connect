/**
 * Connection status enumeration
 */
export type ConnectionStatus = 'active' | 'expired' | 'revoked';

/**
 * OAuth token pair (decrypted)
 */
export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  tokenExpiry: Date;
  refreshExpiry: Date;
}

/**
 * Database connection record (encrypted tokens)
 */
export interface ConnectionRecord {
  id: number;
  client_name: string;
  realm_id: string;
  access_token: string;  // encrypted
  refresh_token: string; // encrypted
  token_expiry: string;  // ISO datetime string
  refresh_expiry: string; // ISO datetime string
  scopes: string;
  status: ConnectionStatus;
  created_at: string;
  updated_at: string;
}

/**
 * Connection with decrypted tokens
 */
export interface Connection {
  id: number;
  clientName: string;
  realmId: string;
  accessToken: string;
  refreshToken: string;
  tokenExpiry: Date;
  refreshExpiry: Date;
  scopes: string[];
  status: ConnectionStatus;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * New connection data (for insertion)
 */
export interface NewConnection {
  clientName: string;
  realmId: string;
  accessToken: string;
  refreshToken: string;
  tokenExpiry: Date;
  refreshExpiry: Date;
  scopes: string[];
}

/**
 * Token update data
 */
export interface TokenUpdate {
  accessToken: string;
  refreshToken: string;
  tokenExpiry: Date;
  refreshExpiry: Date;
}

/**
 * User role enumeration. Admins see every client; members see only
 * the clients assigned to them in user_clients.
 */
export type UserRole = 'admin' | 'member';

/**
 * User status enumeration
 */
export type UserStatus = 'active' | 'disabled';

/**
 * Who a login is for. 'staff' is a firm team member. 'client' is a login
 * given to a client so their own AI assistant can read their own books: it
 * is always read-only, can never be an admin, and signs in through the
 * connector only (its API key is never accepted).
 */
export type UserAccountType = 'staff' | 'client';

/**
 * What a user's API key may do in QuickBooks: 'read' is reports and lookups
 * only, 'read_write' is full access. It is set per assigned company
 * (ClientAssignment); the level on the user itself is a ceiling — a 'read'
 * user is read-only on every company. Admins always behave as 'read_write'.
 */
export type UserAccessLevel = 'read' | 'read_write';

/**
 * One company a member may access, and what they may do there.
 */
export interface ClientAssignment {
  realmId: string;
  accessLevel: UserAccessLevel;
}

/**
 * Database user record (raw row)
 */
export interface UserRecord {
  id: number;
  name: string;
  email: string | null;
  role: UserRole;
  account_type: UserAccountType;
  access_level: UserAccessLevel;
  username: string | null;
  password_hash: string | null;
  api_key_hash: string;
  api_key_encrypted: string | null;
  key_prefix: string;
  status: UserStatus;
  created_at: string;
  updated_at: string;
  last_used_at: string | null;
  invite_sent_at: string | null;
}

/**
 * User with camelCase fields and assigned realm IDs
 */
export interface User {
  id: number;
  name: string;
  email: string | null;
  role: UserRole;
  accountType: UserAccountType;
  accessLevel: UserAccessLevel;
  username: string | null;
  /** Whether a dashboard password is set (the hash itself never leaves the DB layer). */
  hasPassword: boolean;
  keyPrefix: string;
  status: UserStatus;
  createdAt: Date;
  updatedAt: Date;
  lastUsedAt: Date | null;
  /** When the invitation and password emails were last sent (client logins). */
  inviteSentAt: Date | null;
  realmIds: string[];
  /**
   * Access level per assigned company, as stored. The user-level accessLevel
   * still caps it — use effectiveAccessLevel() for what actually applies.
   */
  assignments: ClientAssignment[];
}

/**
 * New user data (for insertion)
 */
export interface NewUser {
  name: string;
  email?: string | null;
  role?: UserRole;
  accountType?: UserAccountType;
  accessLevel?: UserAccessLevel;
  username?: string | null;
  password?: string | null;
  /** Companies to assign at the default level (read & write). */
  realmIds?: string[];
  /** Companies to assign with an explicit level each; wins over realmIds. */
  assignments?: ClientAssignment[];
}

/**
 * User fields that can be updated
 */
export interface UserUpdate {
  name?: string;
  email?: string | null;
  role?: UserRole;
  accountType?: UserAccountType;
  accessLevel?: UserAccessLevel;
  username?: string | null;
  status?: UserStatus;
}

/**
 * One entry in the activity log. Records that something happened and how it
 * ended — never the arguments or results, which are client financial data.
 */
export type ActivityEvent = 'tool_call' | 'sign_in' | 'sign_in_failed' | 'locked_out';
export type ActivityOutcome = 'ok' | 'denied' | 'error';

export interface ActivityEntry {
  id: number;
  at: Date;
  userId: number | null;
  userName: string;
  accountType: 'master' | UserAccountType;
  event: ActivityEvent;
  /** The MCP tool, or for sign-ins where it happened ('connector' | 'dashboard'). */
  tool: string | null;
  /** Whether the tool can change QuickBooks data. */
  writes: boolean;
  realmId: string | null;
  clientName: string | null;
  outcome: ActivityOutcome;
}

export interface NewActivityEntry {
  userId: number | null;
  userName: string;
  accountType: 'master' | UserAccountType;
  event: ActivityEvent;
  tool?: string | null;
  writes?: boolean;
  realmId?: string | null;
  clientName?: string | null;
  outcome: ActivityOutcome;
}

/**
 * Dashboard sign-in session (raw row). Tokens are stored hashed.
 */
export interface SessionRecord {
  id: number;
  user_id: number;
  token_hash: string;
  created_at: string;
  expires_at: string;
  last_used_at: string | null;
}

/**
 * Intuit OAuth token response
 */
export interface IntuitTokenResponse {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in: number;
  x_refresh_token_expires_in: number;
}

/**
 * OAuth configuration
 */
export interface OAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  environment?: 'sandbox' | 'production';
}

/**
 * A record of an alert email sent about a connection (raw row)
 */
export interface ConnectionAlertRecord {
  id: number;
  realm_id: string;
  client_name: string;
  kind: 'broken';
  dedupe_key: string;
  recipients: string;
  provider_id: string | null;
  sent_at: string;
}
