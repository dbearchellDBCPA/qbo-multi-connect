import type { FastifyInstance, FastifyReply } from 'fastify';
import type { QBOManager } from '../../index.js';
import type { UserAccessLevel, UserRole, UserStatus } from '../../db/models.js';
import { authenticateRequest, requireAdmin } from '../middleware.js';
import { isRealmAllowed } from '../auth.js';
import { MIN_PASSWORD_LENGTH, isValidUsername, normalizeUsername } from '../../users.js';

const VALID_ROLES: UserRole[] = ['admin', 'member'];
const VALID_STATUSES: UserStatus[] = ['active', 'disabled'];
const VALID_ACCESS_LEVELS: UserAccessLevel[] = ['read', 'read_write'];

interface UserBody {
  name?: string;
  email?: string | null;
  role?: UserRole;
  accessLevel?: UserAccessLevel;
  username?: string | null;
  password?: string | null;
  status?: UserStatus;
  realmIds?: string[];
}

export async function usersRoutes(
  fastify: FastifyInstance,
  qboManager: QBOManager,
  masterApiKey: string
): Promise<void> {
  // Resolve friendly client names for a user's assignments
  async function realmNameMap(): Promise<Map<string, string>> {
    const connections = await qboManager.listConnections();
    return new Map(connections.map((c) => [c.realmId, c.clientName]));
  }

  function withClientNames(user: Awaited<ReturnType<QBOManager['users']['list']>>[number], names: Map<string, string>) {
    return {
      ...user,
      clients: user.realmIds.map((realmId) => ({
        realmId,
        clientName: names.get(realmId) ?? realmId,
      })),
    };
  }

  async function validateBody(body: UserBody, reply: FastifyReply): Promise<boolean> {
    if (body.role !== undefined && !VALID_ROLES.includes(body.role)) {
      await reply.code(400).send({ error: 'Bad Request', message: `role must be one of: ${VALID_ROLES.join(', ')}` });
      return false;
    }
    if (body.status !== undefined && !VALID_STATUSES.includes(body.status)) {
      await reply.code(400).send({ error: 'Bad Request', message: `status must be one of: ${VALID_STATUSES.join(', ')}` });
      return false;
    }
    if (body.accessLevel !== undefined && !VALID_ACCESS_LEVELS.includes(body.accessLevel)) {
      await reply.code(400).send({ error: 'Bad Request', message: `accessLevel must be one of: ${VALID_ACCESS_LEVELS.join(', ')}` });
      return false;
    }
    if (body.username != null && body.username.trim() && !isValidUsername(normalizeUsername(body.username))) {
      await reply.code(400).send({ error: 'Bad Request', message: 'Username must be 3-64 characters: letters, digits, @ . _ -' });
      return false;
    }
    if (body.password != null && body.password.length < MIN_PASSWORD_LENGTH) {
      await reply.code(400).send({ error: 'Bad Request', message: `Password must be at least ${MIN_PASSWORD_LENGTH} characters` });
      return false;
    }
    if (body.realmIds !== undefined) {
      if (!Array.isArray(body.realmIds) || body.realmIds.some((r) => typeof r !== 'string')) {
        await reply.code(400).send({ error: 'Bad Request', message: 'realmIds must be an array of realm ID strings' });
        return false;
      }
      const known = new Set((await qboManager.listConnections()).map((c) => c.realmId));
      const unknown = body.realmIds.filter((r) => !known.has(r));
      if (unknown.length > 0) {
        await reply.code(400).send({ error: 'Bad Request', message: `Unknown realm IDs: ${unknown.join(', ')}` });
        return false;
      }
    }
    return true;
  }

  // Who am I — lets the dashboard adapt to the caller's scope
  fastify.get('/api/me', async (request, reply) => {
    const scope = await authenticateRequest(request, reply, qboManager, masterApiKey);
    if (!scope) return;

    const visibleClients = (await qboManager.listConnections())
      .filter((c) => isRealmAllowed(scope, c.realmId))
      .map((c) => ({ realmId: c.realmId, clientName: c.clientName }));

    const self = scope.userId != null ? await qboManager.users.get(scope.userId) : null;

    await reply.send({
      kind: scope.kind,
      userId: scope.userId,
      name: scope.userName,
      role: scope.role,
      allClients: scope.allRealms,
      canWrite: scope.canWrite,
      username: self?.username ?? null,
      hasPassword: self?.hasPassword ?? false,
      clients: visibleClients,
    });
  });

  // List users (admin only)
  fastify.get('/api/users', async (request, reply) => {
    const scope = await authenticateRequest(request, reply, qboManager, masterApiKey);
    if (!scope) return;
    if (!(await requireAdmin(scope, reply))) return;

    const names = await realmNameMap();
    await reply.send((await qboManager.users.list()).map((u) => withClientNames(u, names)));
  });

  // Create a user (admin only). Returns the plaintext key exactly once.
  fastify.post<{ Body: UserBody }>('/api/users', async (request, reply) => {
    const scope = await authenticateRequest(request, reply, qboManager, masterApiKey);
    if (!scope) return;
    if (!(await requireAdmin(scope, reply))) return;

    const body = request.body ?? {};
    if (!body.name?.trim()) {
      await reply.code(400).send({ error: 'Bad Request', message: 'name is required' });
      return;
    }
    if (!(await validateBody(body, reply))) return;

    try {
      const { user, apiKey } = await qboManager.users.create({
        name: body.name,
        email: body.email ?? null,
        role: body.role ?? 'member',
        accessLevel: body.accessLevel ?? 'read_write',
        username: body.username ?? null,
        password: body.password ?? null,
        realmIds: body.realmIds ?? [],
      });
      await reply.code(201).send({ user: withClientNames(user, await realmNameMap()), apiKey });
    } catch (error) {
      // "already taken" and validation messages from the service are client
      // errors, not server faults.
      const message = error instanceof Error ? error.message : 'Unknown error';
      const clientError = /already taken|must be at least|must be 3-64|required/i.test(message);
      await reply.code(clientError ? 400 : 500).send({
        error: clientError ? 'Bad Request' : 'Internal Server Error',
        message,
      });
    }
  });

  // Update a user's profile, role, status, and/or client assignments (admin only)
  fastify.patch<{ Params: { id: string }; Body: UserBody }>('/api/users/:id', async (request, reply) => {
    const scope = await authenticateRequest(request, reply, qboManager, masterApiKey);
    if (!scope) return;
    if (!(await requireAdmin(scope, reply))) return;

    const id = Number.parseInt(request.params.id, 10);
    if (!Number.isInteger(id)) {
      await reply.code(400).send({ error: 'Bad Request', message: 'Invalid user id' });
      return;
    }

    const body = request.body ?? {};
    if (body.name !== undefined && !body.name.trim()) {
      await reply.code(400).send({ error: 'Bad Request', message: 'name cannot be empty' });
      return;
    }
    if (!(await validateBody(body, reply))) return;

    let updated;
    try {
      updated = await qboManager.users.update(id, {
        name: body.name,
        email: body.email,
        role: body.role,
        accessLevel: body.accessLevel,
        username: body.username,
        status: body.status,
      });
    } catch (error) {
      await reply.code(400).send({
        error: 'Bad Request',
        message: error instanceof Error ? error.message : 'Invalid update',
      });
      return;
    }
    if (!updated) {
      await reply.code(404).send({ error: 'Not Found', message: `User ${id} not found` });
      return;
    }

    const finalUser = body.realmIds !== undefined
      ? (await qboManager.users.setClients(id, body.realmIds))!
      : updated;

    await reply.send({ user: withClientNames(finalUser, await realmNameMap()) });
  });

  // Set or reset a member's dashboard password (admin only). Ends the
  // user's existing sessions so a reset locks out whoever held them.
  fastify.post<{ Params: { id: string }; Body: { password?: string } }>(
    '/api/users/:id/password',
    async (request, reply) => {
      const scope = await authenticateRequest(request, reply, qboManager, masterApiKey);
      if (!scope) return;
      if (!(await requireAdmin(scope, reply))) return;

      const id = Number.parseInt(request.params.id, 10);
      const password = request.body?.password;
      if (!password || password.length < MIN_PASSWORD_LENGTH) {
        await reply.code(400).send({
          error: 'Bad Request',
          message: `password must be at least ${MIN_PASSWORD_LENGTH} characters`,
        });
        return;
      }
      if (!Number.isInteger(id) || !(await qboManager.users.setPassword(id, password))) {
        await reply.code(404).send({ error: 'Not Found', message: `User ${request.params.id} not found` });
        return;
      }
      await qboManager.users.deleteSessions(id);
      await reply.send({ success: true });
    }
  );

  // Rotate a user's API key (admin only). Returns the new key exactly once.
  fastify.post<{ Params: { id: string } }>('/api/users/:id/rotate-key', async (request, reply) => {
    const scope = await authenticateRequest(request, reply, qboManager, masterApiKey);
    if (!scope) return;
    if (!(await requireAdmin(scope, reply))) return;

    const id = Number.parseInt(request.params.id, 10);
    const result = Number.isInteger(id) ? await qboManager.users.rotateKey(id) : null;
    if (!result) {
      await reply.code(404).send({ error: 'Not Found', message: `User ${request.params.id} not found` });
      return;
    }

    await reply.send({ user: withClientNames(result.user, await realmNameMap()), apiKey: result.apiKey });
  });

  // Delete a user (admin only)
  fastify.delete<{ Params: { id: string } }>('/api/users/:id', async (request, reply) => {
    const scope = await authenticateRequest(request, reply, qboManager, masterApiKey);
    if (!scope) return;
    if (!(await requireAdmin(scope, reply))) return;

    const id = Number.parseInt(request.params.id, 10);
    if (!Number.isInteger(id) || !(await qboManager.users.remove(id))) {
      await reply.code(404).send({ error: 'Not Found', message: `User ${request.params.id} not found` });
      return;
    }

    await reply.send({ success: true });
  });
}
