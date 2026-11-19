import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fastifyFormbody from '@fastify/formbody';
import type { QBOManager } from '../../index.js';
import { authenticateRequest, requireAdmin } from '../middleware.js';
import { AccessRequestInputError, MAX_PENDING_REQUESTS, suggestCompany } from '../../access-requests/service.js';
import { clientFacingBaseUrl, createInviteIssuer, type InviteResult } from '../invite-issuer.js';
import { HIDDEN_FIELD, requestAccessPage, requestBusyPage, requestClosedPage, requestReceivedPage } from '../request-pages.js';

/** Where the public request page lives. */
export const REQUEST_ACCESS_PATH = '/request-access';

/**
 * The network address a submission came from, for the per-source limit.
 * Behind a proxy that is the last hop in X-Forwarded-For — the entry the
 * proxy itself added, which the sender can't forge by adding entries of
 * their own. Without a proxy it is the socket's address. Either way it only
 * bounds how many one address can send; the overall limits don't depend on it.
 */
export function requestSource(request: Pick<FastifyRequest, 'headers' | 'ip'>): string {
  const forwarded = request.headers['x-forwarded-for'];
  const header = Array.isArray(forwarded) ? forwarded[forwarded.length - 1] : forwarded;
  const last = header?.split(',').pop()?.trim();
  return (last || request.ip || 'unknown').slice(0, 64);
}

/** An approval that can't go ahead for a reason the admin should read. */
class ApprovalConflict extends Error {}

/**
 * Asking for access, and deciding on it.
 *
 *   GET/POST /request-access   — public: the form a client fills in.
 *   GET      /invite           — public: forwards to it (an easy address to give out).
 *   /api/access-requests…      — admin: review, approve, decline, settings.
 */
export async function accessRequestRoutes(
  fastify: FastifyInstance,
  qboManager: QBOManager,
  masterApiKey: string
): Promise<void> {
  // The form posts application/x-www-form-urlencoded; other routes need the
  // same parser, so register it only if nobody has yet.
  if (!fastify.hasContentTypeParser('application/x-www-form-urlencoded')) {
    await fastify.register(fastifyFormbody);
  }
  const { issueInvite } = createInviteIssuer(qboManager);
  const requests = qboManager.accessRequests;

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

  // ── Public ───────────────────────────────────────────────────────────────

  fastify.get('/invite', async (_request, reply) => reply.redirect(REQUEST_ACCESS_PATH, 302));

  fastify.get(REQUEST_ACCESS_PATH, async (_request, reply) => {
    const firm = await qboManager.branding.firm();
    if (!(await requests.isEnabled())) return html(reply, 404, requestClosedPage(firm));
    return html(reply, 200, requestAccessPage({ firm, token: requests.formToken() }));
  });

  fastify.post<{ Body: Record<string, unknown> | undefined }>(REQUEST_ACCESS_PATH, async (request, reply) => {
    const firm = await qboManager.branding.firm();
    if (!(await requests.isEnabled())) return html(reply, 404, requestClosedPage(firm));

    const body = request.body && typeof request.body === 'object' ? request.body : {};
    const text = (value: unknown) => (typeof value === 'string' ? value.slice(0, 400) : '');
    const values = { name: text(body.name), email: text(body.email), company: text(body.company) };
    const again = (status: number, error: { field?: 'name' | 'email' | 'company'; message: string }) =>
      html(reply, status, requestAccessPage({ firm, token: requests.formToken(), values, error }));
    const received = () => html(reply, 200, requestReceivedPage({ firm, name: values.name.trim() || 'there', email: values.email.trim() }));

    // A person never sees this field. Something that fills it in is told the
    // same thing as everyone else, and nothing is kept.
    if (text(body[HIDDEN_FIELD]).trim()) return received();

    const token = requests.checkFormToken(body.t);
    if (token !== 'ok') {
      return again(400, {
        message:
          token === 'stale'
            ? 'This page had been open for a long time. Please press Request access again.'
            : 'That did not go through. Please press Request access again.',
      });
    }

    try {
      const outcome = await requests.submit(values, requestSource(request));
      if (outcome === 'closed') return html(reply, 404, requestClosedPage(firm));
      if (outcome === 'busy') return html(reply, 429, requestBusyPage(firm));
      return received();
    } catch (error) {
      if (error instanceof AccessRequestInputError) return again(400, { field: error.field, message: error.message });
      throw error;
    }
  });

  // ── Admin ────────────────────────────────────────────────────────────────

  /** Everything the dashboard shows about requests. */
  async function state(request: FastifyRequest) {
    const [enabled, notice, pending, recent, connections, users] = await Promise.all([
      requests.isEnabled(),
      requests.noticeStatus(),
      requests.pending(),
      requests.recent(),
      qboManager.listConnections(),
      qboManager.users.list(),
    ]);
    const companies = connections.map((c) => ({ realmId: c.realmId, clientName: c.clientName }));
    const companyName = new Map(companies.map((c) => [c.realmId, c.clientName]));
    return {
      enabled,
      /** The address to give clients. */
      url: `${clientFacingBaseUrl(request)}${REQUEST_ACCESS_PATH}`,
      notice,
      maxPending: MAX_PENDING_REQUESTS,
      pending: pending.map((item) => {
        const key = item.email.toLowerCase();
        const login = users.find((u) => u.username === key || (u.email ?? '').toLowerCase() === key) ?? null;
        return {
          ...item,
          // A hint for the reviewer, from what the requester typed. Never
          // acted on without the reviewer choosing the company themselves.
          suggestedRealmId: suggestCompany(item.company, companies)?.realmId ?? null,
          // Whether this address already signs in here, and as what.
          existingLogin: login && {
            id: login.id,
            name: login.name,
            accountType: login.accountType,
            status: login.status,
            hasPassword: login.hasPassword,
            companies: login.realmIds.map((realmId) => ({ realmId, clientName: companyName.get(realmId) ?? realmId })),
          },
        };
      }),
      recent: recent.map((item) => ({ ...item, clientName: item.realmId ? (companyName.get(item.realmId) ?? null) : null })),
    };
  }

  fastify.get('/api/access-requests', async (request, reply) => {
    const scope = await authenticateRequest(request, reply, qboManager, masterApiKey);
    if (!scope) return;
    if (!(await requireAdmin(scope, reply))) return;
    await reply.send(await state(request));
  });

  // Turn the public page on or off, and say who is told about new requests.
  // Send only the fields being changed.
  fastify.put<{ Body: { enabled?: unknown; notifyEmail?: unknown } }>('/api/access-requests/settings', async (request, reply) => {
    const scope = await authenticateRequest(request, reply, qboManager, masterApiKey);
    if (!scope) return;
    if (!(await requireAdmin(scope, reply))) return;

    const body = request.body && typeof request.body === 'object' ? request.body : {};
    if ('enabled' in body && typeof body.enabled !== 'boolean') {
      await reply.code(400).send({ error: 'Bad Request', message: 'enabled must be true or false' });
      return;
    }
    if ('notifyEmail' in body && body.notifyEmail != null && typeof body.notifyEmail !== 'string') {
      await reply.code(400).send({ error: 'Bad Request', message: 'notifyEmail must be text' });
      return;
    }
    try {
      // The address first: it is the one that can be refused, and a refusal
      // must not leave the switch changed.
      if ('notifyEmail' in body) await requests.setNotifyEmail((body.notifyEmail as string | null) ?? null);
      if ('enabled' in body) await requests.setEnabled(body.enabled as boolean);
    } catch (error) {
      await reply.code(400).send({ error: 'Bad Request', message: error instanceof Error ? error.message : 'Invalid value' });
      return;
    }
    await reply.send(await state(request));
  });

  function requestId(raw: string): number | null {
    return /^\d{1,12}$/.test(raw) ? Number(raw) : null;
  }

  // Approve a request: give the person a read-only client login for the
  // company the admin chose — or add that company to the login they already
  // have — and send the invitation. The company comes from the admin, never
  // from what the requester typed.
  fastify.post<{ Params: { id: string }; Body: { realmId?: unknown } }>('/api/access-requests/:id/approve', async (request, reply) => {
    const scope = await authenticateRequest(request, reply, qboManager, masterApiKey);
    if (!scope) return;
    if (!(await requireAdmin(scope, reply))) return;

    const id = requestId(request.params.id);
    const realmId = request.body?.realmId;
    if (typeof realmId !== 'string' || !(await qboManager.listConnections()).some((c) => c.realmId === realmId)) {
      await reply.code(400).send({ error: 'Bad Request', message: 'Choose which company this person should have access to' });
      return;
    }
    const existing = id === null ? null : await requests.get(id);
    if (!existing) {
      await reply.code(404).send({ error: 'Not Found', message: 'That request no longer exists' });
      return;
    }
    // Only one approval can take a request, however many arrive at once.
    const claimed = await requests.claim(existing.id, scope.userName);
    if (!claimed) {
      const now = await requests.get(existing.id);
      await reply.code(409).send({
        error: 'Conflict',
        message: `This request was already ${now?.status === 'declined' ? 'declined' : 'approved'}${now?.decidedBy ? ` by ${now.decidedBy}` : ''}`,
      });
      return;
    }

    try {
      const key = claimed.email.toLowerCase();
      const matches = (await qboManager.users.list()).filter((u) => u.username === key || (u.email ?? '').toLowerCase() === key);
      let invite: InviteResult | null = null;
      let outcome: 'invited' | 'added' | 'already';
      let userId: number;

      if (matches.length === 0) {
        const { user } = await qboManager.users.create({
          name: claimed.name,
          email: claimed.email,
          role: 'member',
          accountType: 'client',
          accessLevel: 'read',
          username: key,
          password: null,
          pendingInvite: true,
          assignments: [{ realmId, accessLevel: 'read' }],
        });
        userId = user.id;
        invite = await issueInvite(request, user);
        outcome = 'invited';
      } else {
        const login = matches.find((u) => u.accountType === 'client');
        if (!login || matches.some((u) => u.accountType !== 'client')) {
          throw new ApprovalConflict(
            `${claimed.email} belongs to ${matches.find((u) => u.accountType !== 'client')!.name}, a team member. A team login can't also be a client login — decline this request, or handle it under Team.`
          );
        }
        if (login.status !== 'active') {
          throw new ApprovalConflict(`${login.name} already has a client login, and it is disabled. Enable it under Team first, then approve this request.`);
        }
        userId = login.id;
        const had = login.realmIds.includes(realmId);
        const updated = had
          ? login
          : (await qboManager.users.setAssignments(login.id, [...login.assignments, { realmId, accessLevel: 'read' }]))!;
        outcome = had ? 'already' : 'added';
        // Someone who has never chosen a password has no way in yet: send
        // the invitation (again), now naming every company they can see.
        if (!updated.hasPassword) invite = await issueInvite(request, updated);
      }

      await requests.complete(claimed.id, userId, realmId);
      await reply.send({ outcome, userId, invite });
    } catch (error) {
      // Nothing was given: put the request back so it can be decided again.
      await requests.release(claimed.id);
      if (error instanceof ApprovalConflict) {
        await reply.code(409).send({ error: 'Conflict', message: error.message });
        return;
      }
      request.log.error({ err: error }, 'approving an access request failed');
      await reply.code(500).send({ error: 'Internal Server Error', message: error instanceof Error ? error.message : 'Unknown error' });
    }
  });

  // Close a request without giving access. Nothing is sent to the requester.
  fastify.post<{ Params: { id: string } }>('/api/access-requests/:id/decline', async (request, reply) => {
    const scope = await authenticateRequest(request, reply, qboManager, masterApiKey);
    if (!scope) return;
    if (!(await requireAdmin(scope, reply))) return;

    const id = requestId(request.params.id);
    if (id === null || !(await requests.get(id))) {
      await reply.code(404).send({ error: 'Not Found', message: 'That request no longer exists' });
      return;
    }
    if (!(await requests.decline(id, scope.userName))) {
      await reply.code(409).send({ error: 'Conflict', message: 'This request was already handled' });
      return;
    }
    await reply.send({ success: true });
  });

  // Close every waiting request at once — for clearing out junk.
  fastify.post('/api/access-requests/decline-all', async (request, reply) => {
    const scope = await authenticateRequest(request, reply, qboManager, masterApiKey);
    if (!scope) return;
    if (!(await requireAdmin(scope, reply))) return;
    await reply.send({ success: true, declined: await requests.declineAll(scope.userName) });
  });
}
