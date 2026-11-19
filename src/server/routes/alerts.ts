import type { FastifyInstance } from 'fastify';
import type { QBOManager } from '../../index.js';
import { AlertsNotConfiguredError } from '../../alerts/connection-alerts.js';
import { EmailSendError } from '../../alerts/email.js';
import { authenticateRequest, requireAdmin } from '../middleware.js';
import { cleanFirmName, cleanVideoUrl } from '../../branding.js';

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
  /** The firm's name and video as clients see them, wherever each was set. */
  async function brandingState() {
    const firm = await qboManager.branding.firm();
    const video = await qboManager.branding.setupVideo();
    return {
      firmName: firm.name,
      firmNameConfigured: firm.configured,
      firmNameSource: firm.source,
      setupVideoUrl: video?.url ?? null,
      /** Whether the video will play on the page, or only be linked. */
      setupVideoEmbedded: Boolean(video?.embedUrl),
    };
  }

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
    await reply.send({ ...qboManager.invites.status(), ...(await brandingState()) });
  });

  // What clients see that is the firm's own: its name — on the invitation
  // email, the page where they choose a password, and the sign-in page — and
  // its walkthrough video. Send only the fields being changed; a blank value
  // clears that one (the name then falls back to the environment's).
  fastify.put<{ Body: { firmName?: unknown; setupVideoUrl?: unknown } }>('/api/branding', async (request, reply) => {
    const scope = await authenticateRequest(request, reply, qboManager, masterApiKey);
    if (!scope) return;
    if (!(await requireAdmin(scope, reply))) return;

    const body = request.body ?? {};
    for (const key of ['firmName', 'setupVideoUrl'] as const) {
      if (body[key] != null && typeof body[key] !== 'string') {
        await reply.code(400).send({ error: 'Bad Request', message: `${key} must be text` });
        return;
      }
    }
    try {
      // Validate both before saving either, so a bad link doesn't leave a
      // half-applied change behind.
      if (typeof body.firmName === 'string' && body.firmName.trim()) cleanFirmName(body.firmName);
      if (typeof body.setupVideoUrl === 'string' && body.setupVideoUrl.trim()) cleanVideoUrl(body.setupVideoUrl);
      if ('firmName' in body) await qboManager.branding.setFirmName((body.firmName as string | null) ?? null);
      if ('setupVideoUrl' in body) await qboManager.branding.setSetupVideoUrl((body.setupVideoUrl as string | null) ?? null);
      await reply.send(await brandingState());
    } catch (error) {
      await reply.code(400).send({ error: 'Bad Request', message: error instanceof Error ? error.message : 'Invalid value' });
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
