import type { FastifyInstance } from 'fastify';
import type { QBOManager } from '../../index.js';
import { ConnectionOwnedByAnotherFirmError } from '../../db/index.js';
import { renderCallbackPage } from '../callback-page.js';
import { exchangeCodeForTokens } from '../../auth/oauth.js';
import { intuitRedirectUri } from '../public-url.js';

export interface IntuitAppConfig {
  clientId: string;
  clientSecret: string;
  environment: 'sandbox' | 'production';
}

/**
 * The Intuit OAuth callback: where QuickBooks sends the browser after a
 * company is authorized. Public by necessity, so everything it trusts comes
 * from the signed state the dashboard minted (firm + client name), never
 * from the query string alone.
 */
export async function connectCallbackRoutes(
  fastify: FastifyInstance,
  qboManager: QBOManager,
  intuit: IntuitAppConfig
): Promise<void> {
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

      // The state is the signed "connect" ticket the dashboard minted: it
      // names the firm the company belongs to and the client name chosen.
      // Anything else (missing, tampered, older than an hour) is refused —
      // the callback is public, and the state is what keeps a company from
      // being attached to the wrong account.
      const ticket = qboManager.verifyConnectState(state);
      if (!ticket) {
        await reply.code(400).type('text/html').send(
          renderCallbackPage({
            variant: 'error',
            heading: 'Connection link expired',
            message:
              'This connection link is no longer valid — it may have expired or been altered. Start the connection again from the dashboard.',
          })
        );
        return;
      }
      const { firmId, clientName } = ticket;

      const allowed = await qboManager.firms.canConnect(firmId, realmId);
      if (!allowed.ok) {
        await reply.code(403).type('text/html').send(
          renderCallbackPage({ variant: 'error', heading: 'Cannot connect this company', message: allowed.reason })
        );
        return;
      }

      console.log('[CALLBACK] Got code for realmId:', realmId, 'firm:', firmId, 'client:', clientName);

      // Exchange code for tokens
      let tokenResponse;
      try {
        console.log('[CALLBACK] Starting token exchange...');
        // Intuit requires the token exchange to repeat the exact redirect_uri
        // from the authorize call. It matches by construction: Intuit sent the
        // browser to that URI, so this request arrived on that same host.
        tokenResponse = await exchangeCodeForTokens(code as string, {
          clientId: intuit.clientId,
          clientSecret: intuit.clientSecret,
          redirectUri: intuitRedirectUri(request),
          environment: intuit.environment,
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
        firmId,
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
      try {
        await tokenStore.storeConnection(newConnection);
      } catch (storeError) {
        if (storeError instanceof ConnectionOwnedByAnotherFirmError) {
          await reply.code(409).type('text/html').send(
            renderCallbackPage({ variant: 'error', heading: 'Already connected elsewhere', message: storeError.message })
          );
          return;
        }
        throw storeError;
      }

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
}
