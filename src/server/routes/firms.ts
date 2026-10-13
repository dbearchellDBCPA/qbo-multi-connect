import type { FastifyInstance } from 'fastify';
import type { QBOManager } from '../../index.js';
import type { FirmStatus } from '../../db/models.js';
import { authenticateRequest, requireMaster } from '../middleware.js';
import { MIN_PASSWORD_LENGTH } from '../../users.js';

interface FirmBody {
  name?: string;
  slug?: string;
  status?: FirmStatus;
  plan?: string | null;
  companyLimit?: number | null;
  /** Optional first admin to create with the firm. */
  admin?: { name?: string; username?: string; password?: string; email?: string | null };
}

/**
 * Platform operator view of firms (master key only). Firms are the tenants;
 * these routes provision them until self-serve signup exists, and keep
 * working afterwards for support.
 */
export async function firmsRoutes(
  fastify: FastifyInstance,
  qboManager: QBOManager,
  masterApiKey: string
): Promise<void> {
  async function describe(firm: Awaited<ReturnType<QBOManager['firms']['list']>>[number]) {
    return {
      ...firm,
      connectionCount: await qboManager.firms.connectionCount(firm.id),
      userCount: (await qboManager.users.list(firm.id)).length,
    };
  }

  fastify.get('/api/firms', async (request, reply) => {
    const scope = await authenticateRequest(request, reply, qboManager, masterApiKey);
    if (!scope) return;
    if (!(await requireMaster(scope, reply))) return;
    await reply.send(await Promise.all((await qboManager.firms.list()).map(describe)));
  });

  fastify.get<{ Params: { id: string } }>('/api/firms/:id', async (request, reply) => {
    const scope = await authenticateRequest(request, reply, qboManager, masterApiKey);
    if (!scope) return;
    if (!(await requireMaster(scope, reply))) return;
    const id = Number.parseInt(request.params.id, 10);
    const firm = Number.isInteger(id) ? await qboManager.firms.get(id) : null;
    if (!firm) {
      await reply.code(404).send({ error: 'Not Found', message: `Firm ${request.params.id} not found` });
      return;
    }
    await reply.send(await describe(firm));
  });

  fastify.post<{ Body: FirmBody }>('/api/firms', async (request, reply) => {
    const scope = await authenticateRequest(request, reply, qboManager, masterApiKey);
    if (!scope) return;
    if (!(await requireMaster(scope, reply))) return;
    const body = request.body ?? {};
    if (!body.name?.trim()) {
      await reply.code(400).send({ error: 'Bad Request', message: 'name is required' });
      return;
    }
    if (body.admin) {
      if (!body.admin.name?.trim() || !body.admin.username?.trim() || !body.admin.password) {
        await reply.code(400).send({ error: 'Bad Request', message: 'admin needs name, username and password' });
        return;
      }
      if (body.admin.password.length < MIN_PASSWORD_LENGTH) {
        await reply.code(400).send({ error: 'Bad Request', message: `admin password must be at least ${MIN_PASSWORD_LENGTH} characters` });
        return;
      }
    }
    try {
      const firm = await qboManager.firms.create({
        name: body.name,
        slug: body.slug,
        plan: body.plan ?? null,
        companyLimit: body.companyLimit ?? null,
      });
      let admin: { user: unknown; apiKey: string } | undefined;
      if (body.admin) {
        admin = await qboManager.users.create({
          firmId: firm.id,
          name: body.admin.name!,
          username: body.admin.username,
          password: body.admin.password,
          email: body.admin.email ?? null,
          role: 'admin',
        });
      }
      await reply.code(201).send({ firm: await describe(firm), ...(admin ? { admin } : {}) });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      const clientError = /already taken|required|must be|cannot be/i.test(message);
      await reply.code(clientError ? 400 : 500).send({
        error: clientError ? 'Bad Request' : 'Internal Server Error',
        message,
      });
    }
  });

  fastify.patch<{ Params: { id: string }; Body: FirmBody }>('/api/firms/:id', async (request, reply) => {
    const scope = await authenticateRequest(request, reply, qboManager, masterApiKey);
    if (!scope) return;
    if (!(await requireMaster(scope, reply))) return;
    const id = Number.parseInt(request.params.id, 10);
    const body = request.body ?? {};
    if (body.status !== undefined && !['active', 'suspended'].includes(body.status)) {
      await reply.code(400).send({ error: 'Bad Request', message: 'status must be active or suspended' });
      return;
    }
    try {
      const firm = Number.isInteger(id)
        ? await qboManager.firms.update(id, {
            name: body.name,
            slug: body.slug,
            status: body.status,
            plan: body.plan,
            companyLimit: body.companyLimit,
          })
        : null;
      if (!firm) {
        await reply.code(404).send({ error: 'Not Found', message: `Firm ${request.params.id} not found` });
        return;
      }
      await reply.send(await describe(firm));
    } catch (error) {
      await reply.code(400).send({ error: 'Bad Request', message: error instanceof Error ? error.message : 'Invalid update' });
    }
  });
}
