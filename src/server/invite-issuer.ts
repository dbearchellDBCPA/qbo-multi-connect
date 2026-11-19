/**
 * Issuing a client's invitation link, and emailing it when email is set up.
 * Shared by the routes that invite a login directly and the one that
 * approves a request for access — both must send exactly the same thing.
 */
import type { FastifyRequest } from 'fastify';
import type { QBOManager } from '../index.js';
import type { User } from '../db/models.js';
import { publicBaseUrl, resolvePublicUrl } from './public-url.js';

/** What the admin is told about an invitation. */
export interface InviteResult {
  to: string;
  /** Whether the invitation email was accepted for delivery. */
  sent: boolean;
  /** Why it was not, when sending was attempted and failed. */
  error: string | null;
  /** When the link stops working. */
  expiresAt: string;
  /**
   * The invitation link itself — present ONLY when the email did not go
   * out (delivery failed, or email is not configured), so the admin can
   * pass it on another way. When the email was sent, the link exists in
   * the client's inbox and nowhere else.
   */
  link?: string;
}

/** Whether a hostname only means something on the machine that used it. */
function isLoopback(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname.replace(/^\[|\]$/g, '');
    return host === 'localhost' || host === '::1' || host.endsWith('.localhost') || /^127\./.test(host);
  } catch {
    return false;
  }
}

/**
 * The address client-facing links and emails point at: the one this request
 * arrived on — the same one the dashboard shows the admin — unless that is
 * a loopback name (a script or tunnel on the server itself), which would
 * be useless in a client's inbox; then the deployment's own public address
 * is used when it has one.
 */
export function clientFacingBaseUrl(request: FastifyRequest): string {
  const base = publicBaseUrl(request);
  return isLoopback(base) ? (resolvePublicUrl().baseUrl ?? base) : base;
}

export function createInviteIssuer(qboManager: QBOManager) {
  /**
   * Issue a fresh invitation link for a login and email it if we can. Any
   * earlier link stops working; the login's current password, if it has one,
   * keeps working until the new invitation is accepted.
   */
  async function issueInvite(request: FastifyRequest, user: User): Promise<InviteResult> {
    const base = clientFacingBaseUrl(request);
    const { token, expiresAt } = (await qboManager.users.createInvite(user.id))!;
    const link = `${base}/invite/${token}`;
    const result: InviteResult = { to: user.email!, sent: false, error: null, expiresAt: expiresAt.toISOString() };

    if (qboManager.invites.enabled) {
      const names = new Map((await qboManager.listConnections()).map((c) => [c.realmId, c.clientName]));
      const delivery = await qboManager.invites.deliver(
        { name: user.name, email: user.email!, username: user.username! },
        {
          acceptUrl: link,
          expiresAt,
          connectorUrl: `${base}/mcp`,
          companyNames: user.realmIds.map((realmId) => names.get(realmId)).filter((n): n is string => Boolean(n)),
          firm: await qboManager.branding.firm(),
          videoUrl: (await qboManager.branding.setupVideo())?.url ?? null,
        }
      );
      result.sent = delivery.sent;
      result.error = delivery.error;
    }
    if (!result.sent) result.link = link;
    return result;
  }

  return { issueInvite };
}
