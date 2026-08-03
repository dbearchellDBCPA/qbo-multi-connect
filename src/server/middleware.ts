import type { FastifyRequest, FastifyReply } from 'fastify';
import type { QBOManager } from '../index.js';
import { resolveAuth, type AuthScope } from './auth.js';

/**
 * Resolve the request's API key (master key or per-user key) to an
 * AuthScope. Sends a 401 and returns null when the key is missing,
 * unknown, or belongs to a disabled user.
 */
export async function authenticateRequest(
  request: FastifyRequest,
  reply: FastifyReply,
  qboManager: QBOManager,
  masterApiKey: string
): Promise<AuthScope | null> {
  const queryKey = (request.query as Record<string, string> | undefined)?.key;
  const scope = await resolveAuth(qboManager, masterApiKey, request.headers.authorization, queryKey);

  if (!scope) {
    await reply.code(401).send({
      error: 'Unauthorized',
      message: 'Missing or invalid API key',
    });
    return null;
  }

  return scope;
}

/**
 * Gate an endpoint to admin scopes (master key or admin-role users).
 * Sends a 403 and returns false for member users.
 */
export async function requireAdmin(scope: AuthScope, reply: FastifyReply): Promise<boolean> {
  if (scope.role !== 'admin') {
    await reply.code(403).send({
      error: 'Forbidden',
      message: 'This action requires an admin API key',
    });
    return false;
  }
  return true;
}
