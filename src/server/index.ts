import Fastify from 'fastify';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import fastifyStatic from '@fastify/static';
import fastifyCors from '@fastify/cors';
import { QBOManager } from '../index.js';
import { appConfig, validateConfig } from '../config.js';
import { connectionsRoutes } from './routes/connections.js';
import { companyRoutes } from './routes/company.js';
import { usersRoutes } from './routes/users.js';
import { authRoutes } from './routes/auth.js';
import { oauthRoutes } from './routes/oauth.js';
import { alertsRoutes } from './routes/alerts.js';
import { firmsRoutes } from './routes/firms.js';
import { connectCallbackRoutes } from './routes/connect-callback.js';
import { registerMcpRoutes } from './mcp.js';
import { resolveSecrets, logFreshSecrets } from '../bootstrap.js';
import { resolvePublicUrl } from './public-url.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** host:port/database of a connection string, never the credentials. */
function describeDatabaseUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.hostname}${parsed.port ? `:${parsed.port}` : ''}${parsed.pathname}`;
  } catch {
    return 'DATABASE_URL';
  }
}

async function startServer() {
  // Validate Intuit credentials (the only secrets that can't be generated).
  validateConfig();

  // Resolve the admin key + encryption key: env → persisted file → generate.
  // A fresh SQLite instance self-provisions and prints the admin key once;
  // a Postgres deployment must set both in its environment.
  const secrets = resolveSecrets(appConfig.db.path, { requireEnv: appConfig.db.url !== null });
  const apiKey = secrets.apiKey;
  logFreshSecrets(secrets);

  // Initialize QBOManager
  const qboManager = new QBOManager({
    dbPath: appConfig.db.path,
    database: appConfig.db.url ? { url: appConfig.db.url, ssl: appConfig.db.ssl } : undefined,
    encryptionKey: secrets.encryptionKey,
    clientId: appConfig.intuit.clientId,
    clientSecret: appConfig.intuit.clientSecret,
    redirectUri: appConfig.oauth.redirectUri,
    environment: appConfig.intuit.environment,
    // Email alerts when a connection breaks. The link in the email uses the
    // address the server can work out without a request (QBO_PUBLIC_URL,
    // QBO_ALLOWED_HOSTS, or Railway's public domain).
    alerts: appConfig.alerts,
    dashboardUrl: () => resolvePublicUrl().baseUrl,
  });

  // Start token refresh daemon (check every 5 minutes)
  qboManager.startRefreshDaemon(5 * 60 * 1000);
  console.log('✅ Token refresh daemon started (interval: 5 minutes)');

  // Initialize Fastify
  const fastify = Fastify({
    logger: {
      level: 'info',
      serializers: {
        // API keys ride in ?key= for Claude connectors — never let them
        // reach the request log.
        req(request) {
          return {
            method: request.method,
            url: String(request.url).replace(/([?&]key=)[^&]*/gi, '$1[REDACTED]'),
            remoteAddress: request.ip,
          };
        },
      },
      transport: {
        target: 'pino-pretty',
        options: {
          translateTime: 'HH:MM:ss Z',
          ignore: 'pid,hostname',
        },
      },
    },
  });

  // Enable CORS for localhost development
  await fastify.register(fastifyCors, {
    origin: true,
    credentials: true,
  });

  // Serve static files from public/
  const publicPath = join(__dirname, 'public');
  await fastify.register(fastifyStatic, {
    root: publicPath,
    prefix: '/',
  });

  // Health check endpoint
  fastify.get('/health', async (_request, reply) => {
    await reply.send({ status: 'ok', timestamp: new Date().toISOString() });
  });

  // Intuit OAuth callback (src/server/routes/connect-callback.ts)
  await connectCallbackRoutes(fastify, qboManager, appConfig.intuit);

  // Register API routes
  await connectionsRoutes(fastify, qboManager, apiKey);
  await companyRoutes(fastify, qboManager, apiKey);
  await usersRoutes(fastify, qboManager, apiKey);
  await authRoutes(fastify, qboManager, apiKey);
  await alertsRoutes(fastify, qboManager, apiKey);
  await firmsRoutes(fastify, qboManager, apiKey);
  // OAuth 2.1 authorization server: lets one shared workspace connector
  // authenticate each team member individually.
  await oauthRoutes(fastify, qboManager);

  // Register MCP server at /mcp
  await registerMcpRoutes(fastify, qboManager, apiKey, join(appConfig.db.dataDir, 'attachments'), {
    importDataDir: appConfig.db.dataDir,
  });

  // Start server
  const port = appConfig.server.port;
  const host = '0.0.0.0';

  try {
    await fastify.listen({ port, host });
    const publicUrl = resolvePublicUrl();
    console.log('\n===========================================');
    console.log(`🚀 QBO Multi-Connect Server Running`);
    console.log(`===========================================`);
    console.log(`📊 Dashboard:  http://localhost:${port}`);
    console.log(`🔌 API:        http://localhost:${port}/api`);
    console.log(`🤖 MCP:        http://localhost:${port}/mcp`);
    console.log(`🔑 Auth:       Bearer ${apiKey.substring(0, 8)}...`);
    console.log(
      `💾 Database:   ${appConfig.db.url ? `Postgres (${describeDatabaseUrl(appConfig.db.url)})` : `SQLite ${appConfig.db.path}`}`
    );
    console.log(`📁 Data dir:   ${appConfig.db.dataDir} (attachments staging, import run logs)`);
    console.log(`🌍 Environment: ${appConfig.intuit.environment}`);
    const alerts = appConfig.alerts;
    if (alerts.enabled) {
      console.log(`📧 Alerts:     on — ${alerts.recipients.join(', ')} (from ${alerts.from})`);
    } else if (alerts.problems.length === 0 && alerts.missing.length === 3) {
      console.log(`📧 Alerts:     off — set RESEND_API_KEY, QBO_ALERT_EMAIL and QBO_ALERT_FROM to be emailed when a connection breaks`);
    } else {
      const why = [...alerts.problems, ...alerts.missing.map((name) => `${name} is not set`)].join('; ');
      console.log(`⚠️  Alerts:     off — ${why}`);
    }
    if (publicUrl.source === 'QBO_PUBLIC_URL') {
      console.log(`🌐 Public URL:  ${publicUrl.baseUrl} (pinned by QBO_PUBLIC_URL)`);
    } else if (publicUrl.baseUrl) {
      console.log(`🌐 Public URL:  ${publicUrl.baseUrl} (default; follows the domain each request uses)`);
    } else {
      console.log(`🌐 Public URL:  follows the domain each request uses`);
    }
    if (process.env.QBO_REDIRECT_URI) {
      console.log(`↩️  Intuit callback: ${process.env.QBO_REDIRECT_URI} (pinned by QBO_REDIRECT_URI)`);
    } else {
      console.log(`↩️  Intuit callback: <domain in use>/callback — register each domain on the Intuit app`);
    }
    console.log(`===========================================\n`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }

  // Graceful shutdown
  const shutdown = async () => {
    console.log('\n🛑 Shutting down gracefully...');
    await qboManager.close();
    await fastify.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

// Prevent crashes from killing the process
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
});
process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection:', err);
});

// Start the server. A failure here (missing Intuit credentials, missing
// secrets on Postgres, unreachable database) must end the process with a
// non-zero code so the host marks the deploy failed instead of leaving a
// half-started server running.
startServer().catch((error) => {
  console.error(`\n❌ Startup failed: ${error instanceof Error ? error.message : error}\n`);
  process.exit(1);
});
