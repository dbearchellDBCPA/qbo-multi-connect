import type { FastifyInstance } from 'fastify';
import type { QBOManager } from '../../index.js';
import { authenticateRequest, requireAdmin } from '../middleware.js';

/**
 * The activity log, for admins: who called which tool against which company
 * and how it ended, plus sign-ins. Filter by member (`userId`), company
 * (`realmId`), or kind of login (`accountType=client` for everything client
 * logins have done); page backwards with `before` (an entry id).
 */
export async function activityRoutes(
  fastify: FastifyInstance,
  qboManager: QBOManager,
  masterApiKey: string
): Promise<void> {
  fastify.get<{
    Querystring: { userId?: string; realmId?: string; accountType?: string; before?: string; limit?: string };
  }>('/api/activity', async (request, reply) => {
    const scope = await authenticateRequest(request, reply, qboManager, masterApiKey);
    if (!scope) return;
    if (!(await requireAdmin(scope, reply))) return;

    const { userId, realmId, accountType, before, limit } = request.query ?? {};
    const asInt = (value: string | undefined): number | undefined | null => {
      if (value === undefined || value === '') return undefined;
      const n = Number(value);
      return Number.isInteger(n) && n > 0 ? n : null;
    };
    const parsed = { userId: asInt(userId), before: asInt(before), limit: asInt(limit) };
    if (parsed.userId === null || parsed.before === null || parsed.limit === null) {
      await reply.code(400).send({ error: 'Bad Request', message: 'userId, before and limit must be positive integers' });
      return;
    }
    if (accountType !== undefined && !['master', 'staff', 'client'].includes(accountType)) {
      await reply.code(400).send({ error: 'Bad Request', message: 'accountType must be one of: master, staff, client' });
      return;
    }

    const entries = await qboManager.activity.list({
      userId: parsed.userId,
      realmId: realmId || undefined,
      accountType: accountType as 'master' | 'staff' | 'client' | undefined,
      beforeId: parsed.before,
      limit: parsed.limit,
    });
    await reply.send(entries);
  });
}
