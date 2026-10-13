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
 * Firm status enumeration
 */
export type FirmStatus = 'active' | 'suspended';

/**
 * Firm (tenant) raw row
 */
export interface FirmRecord {
  id: number;
  name: string;
  slug: string;
  status: FirmStatus;
  plan: string | null;
  company_limit: number | null;
  created_at: string;
  updated_at: string;
}

/**
 * Firm with camelCase fields
 */
export interface Firm {
  id: number;
  name: string;
  slug: string;
  status: FirmStatus;
  plan: string | null;
  /** Maximum connected companies, or null for unlimited. */
  companyLimit: number | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface NewFirm {
  name: string;
  /** Derived from the name when omitted. */
  slug?: string;
  plan?: string | null;
  companyLimit?: number | null;
}

export interface FirmUpdate {
  name?: string;
  slug?: string;
  status?: FirmStatus;
  plan?: string | null;
  companyLimit?: number | null;
}

/**
 * Database connection record (encrypted tokens)
 */
export interface ConnectionRecord {
  id: number;
  firm_id: number;
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
  firmId: number;
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
  /** The firm the company belongs to. Defaults to the single-firm default (1). */
  firmId?: number;
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
 * What a user's API key may do in QuickBooks. 'read' keys never see the
 * MCP write tools; admins always behave as 'read_write'.
 */
export type UserAccessLevel = 'read' | 'read_write';

/**
 * Database user record (raw row)
 */
export interface UserRecord {
  id: number;
  firm_id: number;
  name: string;
  email: string | null;
  role: UserRole;
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
}

/**
 * User with camelCase fields and assigned realm IDs
 */
export interface User {
  id: number;
  firmId: number;
  name: string;
  email: string | null;
  role: UserRole;
  accessLevel: UserAccessLevel;
  username: string | null;
  /** Whether a dashboard password is set (the hash itself never leaves the DB layer). */
  hasPassword: boolean;
  keyPrefix: string;
  status: UserStatus;
  createdAt: Date;
  updatedAt: Date;
  lastUsedAt: Date | null;
  realmIds: string[];
}

/**
 * New user data (for insertion)
 */
export interface NewUser {
  /** The firm the member belongs to. Defaults to the single-firm default (1). */
  firmId?: number;
  name: string;
  email?: string | null;
  role?: UserRole;
  accessLevel?: UserAccessLevel;
  username?: string | null;
  password?: string | null;
  realmIds?: string[];
}

/**
 * User fields that can be updated
 */
export interface UserUpdate {
  name?: string;
  email?: string | null;
  role?: UserRole;
  accessLevel?: UserAccessLevel;
  username?: string | null;
  status?: UserStatus;
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
