import type { FastifyInstance } from 'fastify';
import type { QBOManager } from '../../index.js';
import { authenticateRequest, requireAdmin } from '../middleware.js';
import { isRealmAllowed } from '../auth.js';
import { intuitRedirectUri, resolvePublicUrl, allowedHosts } from '../public-url.js';

export async function connectionsRoutes(
  fastify: FastifyInstance,
  qboManager: QBOManager,
  masterApiKey: string
): Promise<void> {
  // List connections visible to the caller's scope
  fastify.get('/api/connections', async (request, reply) => {
    const scope = await authenticateRequest(request, reply, qboManager, masterApiKey);
    if (!scope) return;

    try {
      const connections = (await qboManager.listConnections())
        .filter((conn) => isRealmAllowed(scope, conn.realmId));
      const formattedConnections = connections.map((conn) => ({
        clientName: conn.clientName,
        realmId: conn.realmId,
        status: conn.status,
        tokenExpiry: conn.tokenExpiry,
        refreshExpiry: conn.refreshExpiry,
        scopes: conn.scopes,
      }));

      await reply.send(formattedConnections);
    } catch (error) {
      await reply.code(500).send({
        error: 'Internal Server Error',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  // Where this deployment thinks it lives, and how it worked that out.
  // The dashboard renders this so an admin adding a custom domain can see
  // exactly which URLs to register with Intuit and paste into Claude —
  // and gets told when a pinned QBO_PUBLIC_URL contradicts what they're using.
  fastify.get('/api/server-url', async (request, reply) => {
    const scope = await authenticateRequest(request, reply, qboManager, masterApiKey);
    if (!scope) return;
    if (!(await requireAdmin(scope, reply))) return;

    const resolution = resolvePublicUrl(request);
    const baseUrl = resolution.baseUrl;
    const redirectUri = intuitRedirectUri(request);
    const pinnedRedirect = Boolean(process.env.QBO_REDIRECT_URI?.trim());
    const hosts = allowedHosts();
    const warnings: string[] = [];

    if (resolution.pinnedMismatch && resolution.requestHost) {
      warnings.push(
        `QBO_PUBLIC_URL pins this server to ${baseUrl}, but you reached it at ${resolution.requestHost}. ` +
          `Claude and QuickBooks will be sent to ${baseUrl}. Unset QBO_PUBLIC_URL to let the address follow whichever domain is used.`
      );
    }
    if (resolution.rejectedHost) {
      warnings.push(
        `This request arrived on ${resolution.rejectedHost}, which is not in QBO_ALLOWED_HOSTS — falling back to ${baseUrl}. ` +
          `Add the domain to QBO_ALLOWED_HOSTS if it's yours.`
      );
    }
    if (pinnedRedirect && baseUrl && !redirectUri.startsWith(`${baseUrl}/`)) {
      warnings.push(
        `QBO_REDIRECT_URI is pinned to ${redirectUri}, which is on a different host than ${baseUrl}. ` +
          `Connecting a company will bounce through that other host. Unset it to follow the domain in use.`
      );
    }

    await reply.send({
      baseUrl,
      source: resolution.source,
      mode: resolution.source === 'QBO_PUBLIC_URL' ? 'pinned' : 'dynamic',
      requestHost: resolution.requestHost,
      connectorUrl: baseUrl ? `${baseUrl}/mcp` : null,
      intuitRedirectUri: redirectUri,
      redirectUriPinned: pinnedRedirect,
      allowedHosts: hosts,
      warnings,
    });
  });

  // Generate OAuth URL for new company (admin only)
  fastify.post<{
    Body: { clientName: string };
  }>('/api/connections/auth-url', async (request, reply) => {
    const scope = await authenticateRequest(request, reply, qboManager, masterApiKey);
    if (!scope) return;
    if (!(await requireAdmin(scope, reply))) return;

    try {
      const { clientName } = request.body;

      if (!clientName) {
        await reply.code(400).send({
          error: 'Bad Request',
          message: 'clientName is required',
        });
        return;
      }

      // Send Intuit back to the hostname the admin is actually using, so a
      // connection started on a custom domain finishes there too. Intuit
      // matches redirect_uri exactly, so this value must be registered on the
      // Intuit app — surfaced here so the UI can say which one to add.
      const redirectUri = intuitRedirectUri(request);
      const authUrl = qboManager.getAuthUrl(clientName, { redirectUri });

      await reply.send({
        authUrl,
        redirectUri,
        message: `Authorization URL generated for ${clientName}. Click the URL to authorize.`,
      });
    } catch (error) {
      await reply.code(500).send({
        error: 'Internal Server Error',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  // Rename a connection's display label (admin only)
  fastify.patch<{
    Params: { realmId: string };
    Body: { clientName?: string };
  }>('/api/connections/:realmId', async (request, reply) => {
    const scope = await authenticateRequest(request, reply, qboManager, masterApiKey);
    if (!scope) return;
    if (!(await requireAdmin(scope, reply))) return;

    try {
      const { realmId } = request.params;
      const clientName = request.body?.clientName?.trim();

      if (!clientName) {
        await reply.code(400).send({ error: 'Bad Request', message: 'clientName is required' });
        return;
      }

      const connection = await qboManager.getConnection(realmId);
      if (!connection) {
        await reply.code(404).send({
          error: 'Not Found',
          message: `Connection with realmId ${realmId} not found`,
        });
        return;
      }

      await qboManager.renameConnection(realmId, clientName);
      await reply.send({ success: true, clientName });
    } catch (error) {
      await reply.code(500).send({
        error: 'Internal Server Error',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  // Replace the set of users who can access a company (admin only)
  fastify.put<{
    Params: { realmId: string };
    Body: { userIds?: unknown };
  }>('/api/connections/:realmId/users', async (request, reply) => {
    const scope = await authenticateRequest(request, reply, qboManager, masterApiKey);
    if (!scope) return;
    if (!(await requireAdmin(scope, reply))) return;

    try {
      const { realmId } = request.params;

      const connection = await qboManager.getConnection(realmId);
      if (!connection) {
        await reply.code(404).send({ error: 'Not Found', message: `Connection with realmId ${realmId} not found` });
        return;
      }

      const userIds = request.body?.userIds;
      if (!Array.isArray(userIds) || userIds.some((u) => !Number.isInteger(u))) {
        await reply.code(400).send({ error: 'Bad Request', message: 'userIds must be an array of integer user IDs' });
        return;
      }

      const known = new Set((await qboManager.users.list()).map((u) => u.id));
      const unknown = userIds.filter((u) => !known.has(u as number));
      if (unknown.length > 0) {
        await reply.code(400).send({ error: 'Bad Request', message: `Unknown user IDs: ${unknown.join(', ')}` });
        return;
      }

      await qboManager.users.setClientUsers(realmId, userIds as number[]);
      await reply.send({ success: true, userIds });
    } catch (error) {
      await reply.code(500).send({
        error: 'Internal Server Error',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  // Revoke/disconnect a connection (admin only)
  fastify.delete<{
    Params: { realmId: string };
  }>('/api/connections/:realmId', async (request, reply) => {
    const scope = await authenticateRequest(request, reply, qboManager, masterApiKey);
    if (!scope) return;
    if (!(await requireAdmin(scope, reply))) return;

    try {
      const { realmId } = request.params;

      const connection = await qboManager.getConnection(realmId);
      if (!connection) {
        await reply.code(404).send({
          error: 'Not Found',
          message: `Connection with realmId ${realmId} not found`,
        });
        return;
      }

      await qboManager.revokeConnection(realmId);

      await reply.send({
        success: true,
        message: `Connection ${connection.clientName} (${realmId}) revoked`,
      });
    } catch (error) {
      await reply.code(500).send({
        error: 'Internal Server Error',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });
}
