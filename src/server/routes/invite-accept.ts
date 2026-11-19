import type { FastifyInstance, FastifyReply } from 'fastify';
import fastifyFormbody from '@fastify/formbody';
import type { QBOManager } from '../../index.js';
import { MIN_PASSWORD_LENGTH } from '../../users.js';
import { publicBaseUrl } from '../public-url.js';
import { acceptInvitePage, inviteAcceptedPage, inviteInvalidPage } from '../invite-pages.js';

/**
 * Where an invitation link leads. These two routes are public — the token in
 * the path is the credential — so:
 *
 * - GET only shows the form. It changes nothing, which matters because mail
 *   scanners and link previews fetch links before the person does.
 * - POST sets the password and retires the link in one step; a link works
 *   once.
 * - The pages load nothing from elsewhere and send no referrer, and are never
 *   cached, so the token does not travel beyond this server and the browser.
 */
export async function inviteAcceptRoutes(fastify: FastifyInstance, qboManager: QBOManager): Promise<void> {
  // The form posts application/x-www-form-urlencoded. The OAuth routes need
  // the same parser, so register it only if nobody has yet.
  if (!fastify.hasContentTypeParser('application/x-www-form-urlencoded')) {
    await fastify.register(fastifyFormbody);
  }

  function html(reply: FastifyReply, status: number, body: string) {
    return reply
      .code(status)
      .header('Cache-Control', 'no-store')
      .header('Referrer-Policy', 'no-referrer')
      .header('X-Robots-Tag', 'noindex, nofollow')
      .header('X-Frame-Options', 'DENY')
      .type('text/html')
      .send(body);
  }

  async function companyNames(realmIds: string[]): Promise<string[]> {
    const names = new Map((await qboManager.listConnections()).map((c) => [c.realmId, c.clientName]));
    return realmIds.map((id) => names.get(id)).filter((n): n is string => Boolean(n));
  }

  fastify.get<{ Params: { token: string } }>('/invite/:token', async (request, reply) => {
    const firm = await qboManager.branding.firm();
    const user = await qboManager.users.findInvite(request.params.token);
    if (!user) return html(reply, 410, inviteInvalidPage(firm));
    return html(
      reply,
      200,
      acceptInvitePage({
        firm,
        name: user.name,
        username: user.username ?? '',
        companyNames: await companyNames(user.realmIds),
        minPasswordLength: MIN_PASSWORD_LENGTH,
      })
    );
  });

  fastify.post<{ Params: { token: string }; Body: { password?: unknown; confirm?: unknown } }>(
    '/invite/:token',
    async (request, reply) => {
      const firm = await qboManager.branding.firm();
      const { token } = request.params;
      const user = await qboManager.users.findInvite(token);
      if (!user) return html(reply, 410, inviteInvalidPage(firm));

      const retry = async (error: string) =>
        html(
          reply,
          400,
          acceptInvitePage({
            firm,
            name: user.name,
            username: user.username ?? '',
            companyNames: await companyNames(user.realmIds),
            minPasswordLength: MIN_PASSWORD_LENGTH,
            error,
          })
        );

      const password = request.body?.password;
      const confirm = request.body?.confirm;
      if (typeof password !== 'string' || typeof confirm !== 'string' || !password) {
        return retry('Enter a password, and type it a second time to confirm.');
      }
      if (password !== confirm) return retry('Those two passwords are not the same. Type the same one in both boxes.');

      let accepted;
      try {
        accepted = await qboManager.users.acceptInvite(token, password);
      } catch (error) {
        return retry(error instanceof Error ? `${error.message}.` : 'That password cannot be used.');
      }
      if (!accepted) return html(reply, 410, inviteInvalidPage(firm));

      // A new password ends whatever was open under the old one. For a first
      // invitation there is nothing; for a later one, this is the point.
      await qboManager.users.deleteSessions(accepted.id);
      await qboManager.oauth.revokeAllForUser(accepted.id);

      const base = publicBaseUrl(request);
      return html(
        reply,
        200,
        inviteAcceptedPage({
          firm,
          username: accepted.username ?? '',
          connectorUrl: `${base}/mcp`,
          signInUrl: base,
          video: await qboManager.branding.setupVideo(),
        })
      );
    }
  );
}
