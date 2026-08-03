import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { exchangeCodeForTokens } from './oauth.js';
import { TokenStore } from './token-store.js';
import type { OAuthConfig } from '../db/models.js';

export interface CallbackResult {
  realmId: string;
  clientName: string;
  success: boolean;
}

/**
 * OAuth callback server
 */
export class CallbackServer {
  private server: FastifyInstance | null = null;
  private resolveCallback: ((result: CallbackResult) => void) | null = null;

  constructor(
    private tokenStore: TokenStore,
    private oauthConfig: OAuthConfig,
    private clientName: string
  ) {}

  /**
   * Start the callback server and wait for OAuth callback
   */
  async start(port: number = 3456): Promise<CallbackResult> {
    return new Promise((resolve, reject) => {
      this.resolveCallback = resolve;

      this.server = Fastify({ logger: false });

      // Callback route
      this.server.get('/callback', async (request, reply) => {
        try {
          const { code, realmId, state: _state, error } = request.query as {
            code?: string;
            realmId?: string;
            state?: string;
            error?: string;
          };

          if (error) {
            await reply.code(400).send({ error: `OAuth error: ${error}` });
            this.resolveCallback?.({
              realmId: '',
              clientName: this.clientName,
              success: false,
            });
            await this.stop();
            return;
          }

          if (!code || !realmId) {
            await reply.code(400).send({ error: 'Missing code or realmId' });
            this.resolveCallback?.({
              realmId: '',
              clientName: this.clientName,
              success: false,
            });
            await this.stop();
            return;
          }

          // Exchange code for tokens
          const tokenResponse = await exchangeCodeForTokens(code, this.oauthConfig);

          const now = Date.now();
          const newConnection = {
            clientName: this.clientName,
            realmId,
            accessToken: tokenResponse.access_token,
            refreshToken: tokenResponse.refresh_token,
            tokenExpiry: new Date(now + tokenResponse.expires_in * 1000),
            refreshExpiry: new Date(now + tokenResponse.x_refresh_token_expires_in * 1000),
            scopes: ['com.intuit.quickbooks.accounting'],
          };

          await this.tokenStore.storeConnection(newConnection);

          await reply.send({
            success: true,
            message: `Successfully connected ${this.clientName}`,
            realmId,
          });

          this.resolveCallback?.({
            realmId,
            clientName: this.clientName,
            success: true,
          });

          // Stop server after successful callback
          setTimeout(() => this.stop(), 1000);
        } catch (error) {
          console.error('Callback error:', error);
          await reply.code(500).send({
            error: error instanceof Error ? error.message : 'Unknown error',
          });
          this.resolveCallback?.({
            realmId: '',
            clientName: this.clientName,
            success: false,
          });
          await this.stop();
        }
      });

      // Health check
      this.server.get('/health', async (_request, reply) => {
        await reply.send({ status: 'ok' });
      });

      this.server.listen({ port, host: '0.0.0.0' }, (err, address) => {
        if (err) {
          reject(err);
          return;
        }
        console.log(`OAuth callback server listening on ${address}`);
      });
    });
  }

  /**
   * Stop the callback server
   */
  async stop(): Promise<void> {
    if (this.server) {
      await this.server.close();
      this.server = null;
      console.log('OAuth callback server stopped');
    }
  }
}
