import { Command } from 'commander';
import { QBOManager } from '../index.js';

export function registerAuthCommands(program: Command, qbo: QBOManager): void {
  const auth = program.command('auth').description('OAuth authentication commands');

  auth
    .command('connect')
    .description('Connect a new QBO company')
    .argument('<client-name>', 'Client/company name')
    .option('-p, --port <port>', 'Callback server port', '3456')
    .action(async (clientName: string, options: { port: string }) => {
      try {
        const port = parseInt(options.port, 10);
        const { authUrl, result } = await qbo.connect(clientName, { port });

        console.log(`\n✅ Authorization URL:\n${authUrl}\n`);
        console.log('Waiting for OAuth callback...\n');

        if (result.success) {
          console.log(`✅ Successfully connected ${result.clientName} (Realm ID: ${result.realmId})`);
        } else {
          console.error(`❌ Failed to connect ${clientName}`);
          process.exit(1);
        }
      } catch (error) {
        console.error('Error:', error instanceof Error ? error.message : error);
        process.exit(1);
      }
    });

  auth
    .command('list')
    .description('List all connected companies')
    .option('-s, --status <status>', 'Filter by status (active|expired|revoked)')
    .action(async (options: { status?: string }) => {
      try {
        let connections = await qbo.listConnections();

        if (options.status) {
          connections = connections.filter(c => c.status === options.status);
        }

        if (connections.length === 0) {
          console.log('No connections found.');
          return;
        }

        console.log(`\nConnected Companies (${connections.length}):\n`);
        
        connections.forEach(conn => {
          const expiryStr = conn.tokenExpiry.toISOString().split('T')[0];
          const refreshExpiryStr = conn.refreshExpiry.toISOString().split('T')[0];
          const statusIcon = conn.status === 'active' ? '✅' : conn.status === 'expired' ? '⚠️' : '❌';

          console.log(`${statusIcon} ${conn.clientName}`);
          console.log(`   Realm ID: ${conn.realmId}`);
          console.log(`   Status: ${conn.status}`);
          console.log(`   Token Expiry: ${expiryStr}`);
          console.log(`   Refresh Expiry: ${refreshExpiryStr}`);
          console.log('');
        });
      } catch (error) {
        console.error('Error:', error instanceof Error ? error.message : error);
        process.exit(1);
      }
    });

  auth
    .command('revoke')
    .description('Revoke/disconnect a company')
    .argument('<client-name>', 'Client/company name')
    .action(async (clientName: string) => {
      try {
        const connection = await qbo.getConnectionByName(clientName);
        
        if (!connection) {
          console.error(`❌ Connection not found: ${clientName}`);
          process.exit(1);
        }

        await qbo.revokeConnection(connection.realmId);
        console.log(`✅ Revoked connection for ${clientName}`);
      } catch (error) {
        console.error('Error:', error instanceof Error ? error.message : error);
        process.exit(1);
      }
    });

  auth
    .command('daemon')
    .description('Start proactive token refresh daemon')
    .option('-i, --interval <minutes>', 'Check interval in minutes', '5')
    .action((options: { interval: string }) => {
      try {
        const intervalMs = parseInt(options.interval, 10) * 60 * 1000;
        qbo.startRefreshDaemon(intervalMs);
        
        console.log('✅ Refresh daemon started. Press Ctrl+C to stop.');
        
        // Keep process alive
        process.on('SIGINT', async () => {
          console.log('\n\nStopping refresh daemon...');
          qbo.stopRefreshDaemon();
          await qbo.close();
          process.exit(0);
        });
      } catch (error) {
        console.error('Error:', error instanceof Error ? error.message : error);
        process.exit(1);
      }
    });
}
