import { config } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Load .env from project root
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = join(__dirname, '..');
config({ path: join(rootDir, '.env') });

export interface AppConfig {
  intuit: {
    clientId: string;
    clientSecret: string;
    environment: 'sandbox' | 'production';
    authEndpoint: string;
    tokenEndpoint: string;
    apiBaseUrl: string;
  };
  oauth: {
    redirectUri: string;
    scopes: string[];
  };
  db: {
    path: string;
  };
  encryption: {
    key: string;
  };
  server: {
    port: number;
    apiKey: string;
  };
}

const environment = (process.env.QBO_ENVIRONMENT || 'sandbox') as 'sandbox' | 'production';

export const appConfig: AppConfig = {
  intuit: {
    clientId: process.env.INTUIT_CLIENT_ID || '',
    clientSecret: process.env.INTUIT_CLIENT_SECRET || '',
    environment,
    authEndpoint: 'https://appcenter.intuit.com/connect/oauth2',
    tokenEndpoint: 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer',
    apiBaseUrl:
      environment === 'sandbox'
        ? 'https://sandbox-quickbooks.api.intuit.com/v3'
        : 'https://quickbooks.api.intuit.com/v3',
  },
  oauth: {
    redirectUri: process.env.QBO_REDIRECT_URI || 'http://localhost:3456/callback',
    scopes: ['com.intuit.quickbooks.accounting'],
  },
  db: {
    path: process.env.QBO_DB_PATH || './qbo-connections.db',
  },
  encryption: {
    key: process.env.QBO_ENCRYPTION_KEY || '',
  },
  server: {
    port: parseInt(process.env.PORT || process.env.QBO_SERVER_PORT || '3456', 10),
    apiKey: process.env.QBO_API_KEY || '',
  },
};

/**
 * Validate required configuration. The API key and encryption key are
 * resolved (and, if absent, generated) by the deployment bootstrap, so only
 * the Intuit app credentials — which cannot be auto-generated — are required
 * here. If an encryption key IS supplied via env, its length is validated.
 */
export function validateConfig(): void {
  const missing: string[] = [];

  if (!appConfig.intuit.clientId) missing.push('INTUIT_CLIENT_ID');
  if (!appConfig.intuit.clientSecret) missing.push('INTUIT_CLIENT_SECRET');

  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }

  if (appConfig.encryption.key && appConfig.encryption.key.length !== 64) {
    throw new Error('QBO_ENCRYPTION_KEY must be 64 hex characters (32 bytes)');
  }
}
