import type { FastifyInstance } from 'fastify';
import type { QBOManager } from '../../index.js';
import { AlertsNotConfiguredError } from '../../alerts/connection-alerts.js';
import { EmailSendError } from '../../alerts/email.js';
import { authenticateRequest, requireAdmin } from '../middleware.js';

/**
 * Outbound email status (admin only): alerts for broken QuickBooks
 * connections, and invitations for client logins. Configuration lives in the
 * server environment; these routes let the dashboard show whether each is
 * on, who is involved, and prove alerts work with a test send. The Resend
 * API key is never returned.
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

  // Whether client invitation emails can be sent, and from whom — so the
  // dashboard can offer the option, or say what is still missing.
  fastify.get('/api/invites', async (request, reply) => {
    const scope = await authenticateRequest(request, reply, qboManager, masterApiKey);
    if (!scope) return;
    if (!(await requireAdmin(scope, reply))) return;
    const firm = await qboManager.branding.firm();
    await reply.send({
      ...qboManager.invites.status(),
      // The name clients see, wherever it was set (dashboard, environment, sender).
      firmName: firm.name,
      firmNameConfigured: firm.configured,
      firmNameSource: firm.source,
    });
  });

  // The firm's name as clients see it — on the invitation email, the page
  // where they choose a password, and the sign-in page. Blank clears the
  // dashboard's value and falls back to the environment's.
  fastify.put<{ Body: { firmName?: unknown } }>('/api/branding', async (request, reply) => {
    const scope = await authenticateRequest(request, reply, qboManager, masterApiKey);
    if (!scope) return;
    if (!(await requireAdmin(scope, reply))) return;

    const raw = request.body?.firmName;
    if (raw != null && typeof raw !== 'string') {
      await reply.code(400).send({ error: 'Bad Request', message: 'firmName must be text' });
      return;
    }
    try {
      const firm = await qboManager.branding.setFirmName(raw ?? null);
      await reply.send({ firmName: firm.name, firmNameConfigured: firm.configured, firmNameSource: firm.source });
    } catch (error) {
      await reply.code(400).send({ error: 'Bad Request', message: error instanceof Error ? error.message : 'Invalid firm name' });
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
