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
import { registerMcpRoutes } from './mcp.js';
import { renderCallbackPage } from './callback-page.js';
import { exchangeCodeForTokens } from '../auth/oauth.js';
import { resolveSecrets, logFreshSecrets } from '../bootstrap.js';
import { intuitRedirectUri, resolvePublicUrl } from './public-url.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function startServer() {
  // Validate Intuit credentials (the only secrets that can't be generated).
  validateConfig();

  // Resolve the admin key + encryption key: env → persisted file → generate.
  // A fresh instance self-provisions and prints the admin key once.
  const secrets = resolveSecrets(appConfig.db.path);
  const apiKey = secrets.apiKey;
  logFreshSecrets(secrets);

  // Initialize QBOManager
  const qboManager = new QBOManager({
    dbPath: appConfig.db.path,
    encryptionKey: secrets.encryptionKey,
    clientId: appConfig.intuit.clientId,
    clientSecret: appConfig.intuit.clientSecret,
    redirectUri: appConfig.oauth.redirectUri,
    environment: appConfig.intuit.environment,
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

  // OAuth callback route
  fastify.get('/callback', async (request, reply) => {
    try {
      const query = request.query as Record<string, string>;
      const code = query.code;
      const realmId = query.realmId;
      const state = query.state;
      const error = query.error;

      if (error) {
        await reply.code(400).type('text/html').send(
          renderCallbackPage({
            variant: 'error',
            heading: 'Authorization failed',
            message: `QuickBooks reported an error: ${error}`,
          })
        );
        return;
      }

      if (!code || !realmId) {
        await reply.code(400).type('text/html').send(
          renderCallbackPage({
            variant: 'error',
            heading: 'Authorization incomplete',
            message:
              'This authorization link is missing required information. Please start the connection again from the dashboard.',
          })
        );
        return;
      }

      // Extract client name from state parameter
      const clientName = state || `Company-${realmId}`;

      console.log('[CALLBACK] Got code:', code, 'realmId:', realmId, 'state:', state);

      // Exchange code for tokens
      let tokenResponse;
      try {
        console.log('[CALLBACK] Starting token exchange...');
        // Intuit requires the token exchange to repeat the exact redirect_uri
        // from the authorize call. It matches by construction: Intuit sent the
        // browser to that URI, so this request arrived on that same host.
        tokenResponse = await exchangeCodeForTokens(code as string, {
          clientId: appConfig.intuit.clientId,
          clientSecret: appConfig.intuit.clientSecret,
          redirectUri: intuitRedirectUri(request),
          environment: appConfig.intuit.environment,
        });
      } catch (tokenError: any) {
        console.error('Token exchange error:', tokenError?.message || tokenError);
        await reply.code(500).type('text/html').send(
          renderCallbackPage({
            variant: 'error',
            heading: 'Connection failed',
            message: `We couldn't complete the connection with QuickBooks: ${
              tokenError?.message || 'an unknown error occurred during authorization.'
            }`,
          })
        );
        return;
      }

      const now = Date.now();
      const newConnection = {
        clientName,
        realmId,
        accessToken: tokenResponse.access_token,
        refreshToken: tokenResponse.refresh_token,
        tokenExpiry: new Date(now + tokenResponse.expires_in * 1000),
        refreshExpiry: new Date(now + tokenResponse.x_refresh_token_expires_in * 1000),
        scopes: ['com.intuit.quickbooks.accounting'],
      };

      // Store connection using QBOManager's token store
      const tokenStore = (qboManager as any).tokenStore;
      await tokenStore.storeConnection(newConnection);

      // Return success page
      await reply.type('text/html').send(
        renderCallbackPage({
          variant: 'success',
          heading: 'Connection successful',
          message: 'You’ve authorized',
          company: clientName,
          details: [
            { label: 'Company ID', value: realmId, mono: true },
            {
              label: 'Authorization valid until',
              value: newConnection.refreshExpiry.toLocaleDateString('en-US', {
                year: 'numeric',
                month: 'long',
                day: 'numeric',
              }),
            },
          ],
          autoRedirect: true,
        })
      );
    } catch (error) {
      fastify.log.error(error);
      await reply.code(500).type('text/html').send(
        renderCallbackPage({
          variant: 'error',
          heading: 'Something went wrong',
          message: `The connection couldn’t be completed: ${
            error instanceof Error ? error.message : 'an unexpected error occurred.'
          }`,
        })
      );
    }
  });

  // Register API routes
  await connectionsRoutes(fastify, qboManager, apiKey);
  await companyRoutes(fastify, qboManager, apiKey);
  await usersRoutes(fastify, qboManager, apiKey);
  await authRoutes(fastify, qboManager, apiKey);
  // OAuth 2.1 authorization server: lets one shared workspace connector
  // authenticate each team member individually.
  await oauthRoutes(fastify, qboManager);

  // Register MCP server at /mcp
  await registerMcpRoutes(fastify, qboManager, apiKey, join(dirname(appConfig.db.path), 'attachments'));

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
    console.log(`💾 Database:   ${appConfig.db.path}`);
    console.log(`🌍 Environment: ${appConfig.intuit.environment}`);
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

// Start the server
startServer();
