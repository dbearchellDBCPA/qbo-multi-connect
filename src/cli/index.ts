#!/usr/bin/env node

import { Command } from 'commander';
import { QBOManager } from '../index.js';
import { appConfig, validateConfig } from '../config.js';
import { resolveSecrets } from '../bootstrap.js';
import { registerAuthCommands } from './auth-commands.js';
import { registerQueryCommands } from './query-commands.js';

const program = new Command();

program
  .name('qbo')
  .description('QuickBooks Online multi-client connection tool')
  .version('0.1.0');

// Validate config before executing commands
try {
  validateConfig();
} catch (error) {
  console.error('Configuration error:', error instanceof Error ? error.message : error);
  console.error('\nPlease set the required environment variables in your .env file.');
  process.exit(1);
}

// Resolve the encryption key the same way the server does (env → persisted
// secrets file on the data volume), so the CLI reads the same database with a
// matching key rather than a mismatched or empty one.
const secrets = resolveSecrets(appConfig.db.path);

// Initialize QBOManager
const qbo = new QBOManager({
  dbPath: appConfig.db.path,
  encryptionKey: secrets.encryptionKey,
  clientId: appConfig.intuit.clientId,
  clientSecret: appConfig.intuit.clientSecret,
  redirectUri: appConfig.oauth.redirectUri,
  environment: appConfig.intuit.environment,
});

// Register command groups
registerAuthCommands(program, qbo);
registerQueryCommands(program, qbo);

// Parse and execute
program.parse();

// Cleanup on exit
process.on('exit', () => {
  qbo.close();
});
