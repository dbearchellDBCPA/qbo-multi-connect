import type { FastifyInstance } from 'fastify';
import type { QBOManager } from '../../index.js';
import { AlertsNotConfiguredError } from '../../alerts/connection-alerts.js';
import { EmailSendError } from '../../alerts/email.js';
import { authenticateRequest, requireAdmin } from '../middleware.js';

/**
 * Email alerts for broken QuickBooks connections (admin only). Configuration
 * lives in the server environment; these routes let the dashboard show
 * whether it's on, who gets notified, and prove it works with a test send.
 * The Resend API key is never returned.
 */
export async function alertsRoutes(
  fastify: FastifyInstance,
  qboManager: QBOManager,
  masterApiKey: string
): Promise<void> {
  fastify.get('/api/alerts', async (request, reply) => {
    const scope = await authenticateRequest(request, reply, qboManager, masterApiKey);
    if (!scope) return;
    if (!(await requireAdmin(scope, reply))) return;

    try {
      await reply.send(await qboManager.alerts.status());
    } catch (error) {
      await reply.code(500).send({
        error: 'Internal Server Error',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  fastify.post('/api/alerts/test', async (request, reply) => {
    const scope = await authenticateRequest(request, reply, qboManager, masterApiKey);
    if (!scope) return;
    if (!(await requireAdmin(scope, reply))) return;

    try {
      const result = await qboManager.alerts.sendTest();
      await reply.send({ success: true, id: result.id, recipients: result.recipients });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      if (error instanceof AlertsNotConfiguredError) {
        await reply.code(400).send({ error: 'Bad Request', message });
      } else if (error instanceof EmailSendError) {
        await reply.code(502).send({ error: 'Bad Gateway', message });
      } else {
        await reply.code(500).send({ error: 'Internal Server Error', message });
      }
    }
  });
}
