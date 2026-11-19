import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { QBOManager } from '../../index.js';
import type { ClientAssignment, UserAccessLevel, UserAccountType, UserRole, UserStatus } from '../../db/models.js';
import { authenticateRequest, requireAdmin } from '../middleware.js';
import { isRealmAllowed, canWriteRealm } from '../auth.js';
import {
  MIN_PASSWORD_LENGTH,
  USERNAME_RULE,
  effectiveAccessLevel,
  isValidUsername,
  normalizeUsername,
} from '../../users.js';
import { bareAddress } from '../../alerts/config.js';
import { publicBaseUrl, resolvePublicUrl } from '../public-url.js';
import type { User } from '../../db/models.js';

const VALID_ROLES: UserRole[] = ['admin', 'member'];
const VALID_STATUSES: UserStatus[] = ['active', 'disabled'];
const VALID_ACCESS_LEVELS: UserAccessLevel[] = ['read', 'read_write'];
const VALID_ACCOUNT_TYPES: UserAccountType[] = ['staff', 'client'];

interface UserBody {
  name?: string;
  email?: string | null;
  role?: UserRole;
  /** 'client' creates a client login: always read-only, never admin, no API key. */
  accountType?: UserAccountType;
  accessLevel?: UserAccessLevel;
  username?: string | null;
  password?: string | null;
  status?: UserStatus;
  /** Assign these companies; ones already assigned keep their access level. */
  realmIds?: string[];
  /** Assign these companies with an explicit access level each. Wins over realmIds. */
  clients?: Array<{ realmId?: unknown; accessLevel?: unknown }>;
  /**
   * Client logins only: invite them instead of choosing a password for them.
   * They get a one-time link to a page where they set their own, plus the
   * connector address and setup steps. `username` may be left out — it
   * defaults to their email address. Leave `password` out.
   */
  sendInvite?: boolean;
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
      // accessLevel is the level set on the assignment; effectiveAccessLevel
      // is what applies once the member-wide read-only ceiling is counted.
      clients: user.assignments.map(({ realmId, accessLevel }) => ({
        realmId,
        clientName: names.get(realmId) ?? realmId,
        accessLevel,
        effectiveAccessLevel: effectiveAccessLevel(user, realmId) ?? accessLevel,
      })),
    };
  }

  /** Logins with an invitation being sent right now — see POST /api/users/:id/invite. */
  const invitesInFlight = new Set<number>();

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
   * The address invitation links and emails point at: the one this request
   * arrived on — the same one the dashboard shows the admin — unless that is
   * a loopback name (a script or tunnel on the server itself), which would
   * be useless in a client's inbox; then the deployment's own public address
   * is used when it has one.
   */
  function inviteBaseUrl(request: FastifyRequest): string {
    const base = publicBaseUrl(request);
    return isLoopback(base) ? (resolvePublicUrl().baseUrl ?? base) : base;
  }

  /** What the admin is told about an invitation. */
  interface InviteResult {
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

  /**
   * Issue a fresh invitation link for a login and email it if we can. Any
   * earlier link stops working; the login's current password, if it has one,
   * keeps working until the new invitation is accepted.
   */
  async function issueInvite(request: FastifyRequest, user: User): Promise<InviteResult> {
    const base = inviteBaseUrl(request);
    const { token, expiresAt } = (await qboManager.users.createInvite(user.id))!;
    const link = `${base}/invite/${token}`;
    const result: InviteResult = { to: user.email!, sent: false, error: null, expiresAt: expiresAt.toISOString() };

    if (qboManager.invites.enabled) {
      const names = await realmNameMap();
      const delivery = await qboManager.invites.deliver(
        { name: user.name, email: user.email!, username: user.username! },
        {
          acceptUrl: link,
          expiresAt,
          connectorUrl: `${base}/mcp`,
          companyNames: user.realmIds.map((realmId) => names.get(realmId)).filter((n): n is string => Boolean(n)),
        }
      );
      result.sent = delivery.sent;
      result.error = delivery.error;
    }
    if (!result.sent) result.link = link;
    return result;
  }

  /**
   * Why an invitation can't be sent for a login with these details, or null
   * when it can. Shared by create-with-invite and re-invite.
   */
  function inviteBlocker(login: {
    accountType?: string;
    email?: string | null;
    username?: string | null;
    companyCount: number;
  }): string | null {
    if (login.accountType !== 'client') return 'Invitations are for client logins (accountType "client")';
    if (!login.email?.trim() || !bareAddress(login.email)) return 'A valid email address is required to send an invitation';
    if (!login.username?.trim()) return 'A username is required to send an invitation';
    // An invitation says "here are your books". With nothing assigned, the
    // client would follow every step and find an empty connector.
    if (login.companyCount === 0) return 'Assign a company to this login before sending an invitation';
    return null;
  }

  /** The assignments a validated body asks for, or undefined when it names none. */
  function assignmentsFromBody(body: UserBody): ClientAssignment[] | undefined {
    if (body.clients === undefined) return undefined;
    return body.clients.map((c) => ({
      realmId: c.realmId as string,
      accessLevel: (c.accessLevel ?? 'read_write') as UserAccessLevel,
    }));
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
    if (body.accountType !== undefined && !VALID_ACCOUNT_TYPES.includes(body.accountType)) {
      await reply.code(400).send({ error: 'Bad Request', message: `accountType must be one of: ${VALID_ACCOUNT_TYPES.join(', ')}` });
      return false;
    }
    if (body.accessLevel !== undefined && !VALID_ACCESS_LEVELS.includes(body.accessLevel)) {
      await reply.code(400).send({ error: 'Bad Request', message: `accessLevel must be one of: ${VALID_ACCESS_LEVELS.join(', ')}` });
      return false;
    }
    if (body.username != null && body.username.trim() && !isValidUsername(normalizeUsername(body.username))) {
      await reply.code(400).send({ error: 'Bad Request', message: USERNAME_RULE });
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
    }
    if (body.clients !== undefined) {
      const wellFormed =
        Array.isArray(body.clients) &&
        body.clients.every(
          (c) =>
            c != null &&
            typeof c === 'object' &&
            typeof c.realmId === 'string' &&
            (c.accessLevel === undefined || VALID_ACCESS_LEVELS.includes(c.accessLevel as UserAccessLevel))
        );
      if (!wellFormed) {
        await reply.code(400).send({
          error: 'Bad Request',
          message: `clients must be an array of { realmId, accessLevel } where accessLevel is one of: ${VALID_ACCESS_LEVELS.join(', ')}`,
        });
        return false;
      }
      const ids = body.clients.map((c) => c.realmId as string);
      if (new Set(ids).size !== ids.length) {
        await reply.code(400).send({ error: 'Bad Request', message: 'clients lists the same realmId more than once' });
        return false;
      }
    }
    const named = [...(body.realmIds ?? []), ...(body.clients ?? []).map((c) => c.realmId as string)];
    if (named.length > 0) {
      const known = new Set((await qboManager.listConnections()).map((c) => c.realmId));
      const unknown = [...new Set(named.filter((r) => !known.has(r)))];
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
      .map((c) => ({
        realmId: c.realmId,
        clientName: c.clientName,
        canWrite: canWriteRealm(scope, c.realmId),
      }));

    const self = scope.userId != null ? await qboManager.users.get(scope.userId) : null;

    await reply.send({
      kind: scope.kind,
      userId: scope.userId,
      name: scope.userName,
      role: scope.role,
      accountType: scope.accountType,
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

    // With sendInvite the person chooses their own password from a link, so
    // an admin who typed one as well has asked for two different things. The
    // username defaults to their email address: one less thing to invent, and
    // the one thing they are sure to remember.
    if (body.sendInvite !== undefined && typeof body.sendInvite !== 'boolean') {
      await reply.code(400).send({ error: 'Bad Request', message: 'sendInvite must be true or false' });
      return;
    }
    let username = body.username ?? null;
    if (body.sendInvite) {
      if (!username?.trim()) username = bareAddress(body.email ?? '')?.toLowerCase() ?? null;
      const blocker = body.password
        ? 'sendInvite lets them choose their own password — leave password out'
        : inviteBlocker({ ...body, username, companyCount: (body.clients ?? body.realmIds ?? []).length }) ??
          (isValidUsername(normalizeUsername(username!))
            ? null
            : `That email address can't be used as a username. Enter a username for them. ${USERNAME_RULE}`);
      if (blocker) {
        await reply.code(400).send({ error: 'Bad Request', message: blocker });
        return;
      }
    }

    try {
      const { user, apiKey } = await qboManager.users.create({
        name: body.name,
        email: body.email ?? null,
        role: body.role ?? 'member',
        accountType: body.accountType ?? 'staff',
        accessLevel: body.accessLevel ?? (body.accountType === 'client' ? 'read' : 'read_write'),
        username,
        password: body.sendInvite ? null : (body.password ?? null),
        pendingInvite: Boolean(body.sendInvite),
        realmIds: body.realmIds ?? [],
        assignments: assignmentsFromBody(body),
      });

      // The login exists from here on, with no password until the invitation
      // is accepted. If the email can't be sent, the response carries the
      // link so the admin can pass it on another way.
      let invite: InviteResult | null = null;
      let created = user;
      if (body.sendInvite) {
        invite = await issueInvite(request, user);
        created = (await qboManager.users.get(user.id)) ?? user;
      }

      // A client login's key is never accepted, so it is never handed out.
      await reply.code(201).send({
        user: withClientNames(created, await realmNameMap()),
        apiKey: created.accountType === 'client' ? null : apiKey,
        ...(invite ? { invite } : {}),
      });
    } catch (error) {
      // "already taken" and validation messages from the service are client
      // errors, not server faults.
      let message = error instanceof Error ? error.message : 'Unknown error';
      // The admin gave an email, not a username — say it in those terms.
      if (/already taken/i.test(message) && body.sendInvite && !body.username?.trim()) {
        message =
          'A login with this email address already exists. To give that person another company, add it to their existing login under Team; to let them choose a new password, send a new invitation from there.';
      }
      const clientError = /already taken|already exists|must be at least|must be an email|must be 3|required|client login/i.test(message);
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
        accountType: body.accountType,
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

    // Disabling ends what the login had open, not just what it can start: an
    // assistant connected before would otherwise resume if re-enabled later.
    if (body.status === 'disabled') {
      await qboManager.users.deleteSessions(id);
      await qboManager.oauth.revokeAllForUser(id);
    }

    const assignments = assignmentsFromBody(body);
    const finalUser = assignments !== undefined
      ? (await qboManager.users.setAssignments(id, assignments))!
      : body.realmIds !== undefined
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
      // …and signs out every AI assistant connected with the old password.
      // For a client login that is the whole point of a reset: the connector
      // is the only way they sign in.
      await qboManager.oauth.revokeAllForUser(id);
      // A reset is how a locked-out person gets back in — don't leave them
      // waiting out the lock on a password that no longer exists.
      qboManager.users.clearLoginFailures((await qboManager.users.get(id))?.username);
      await reply.send({ success: true });
    }
  );

  // Send (or re-send) a client login an invitation link (admin only). The
  // link leads to a page where they choose a password, so this is also how a
  // client who has forgotten theirs gets back in. Any earlier link stops
  // working; their current password keeps working until they accept — to cut
  // access off at once, disable the login instead.
  fastify.post<{ Params: { id: string } }>('/api/users/:id/invite', async (request, reply) => {
    const scope = await authenticateRequest(request, reply, qboManager, masterApiKey);
    if (!scope) return;
    if (!(await requireAdmin(scope, reply))) return;

    const id = Number.parseInt(request.params.id, 10);
    const user = Number.isInteger(id) ? await qboManager.users.get(id) : null;
    if (!user) {
      await reply.code(404).send({ error: 'Not Found', message: `User ${request.params.id} not found` });
      return;
    }
    const blocker =
      user.status !== 'active'
        ? 'This login is disabled — enable it before sending an invitation'
        : inviteBlocker({ ...user, companyCount: user.realmIds.length });
    if (blocker) {
      await reply.code(400).send({ error: 'Bad Request', message: blocker });
      return;
    }

    // One invitation per login at a time: each new link retires the last, so
    // two overlapping requests would leave the client with a dead link in one
    // of their two emails.
    if (invitesInFlight.has(id)) {
      await reply.code(409).send({
        error: 'Conflict',
        message: 'An invitation for this login is already being sent — wait a moment before sending another',
      });
      return;
    }
    invitesInFlight.add(id);
    try {
      const invite = await issueInvite(request, user);
      await reply.send({
        user: withClientNames((await qboManager.users.get(id))!, await realmNameMap()),
        invite,
      });
    } finally {
      invitesInFlight.delete(id);
    }
  });

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

    await reply.send({
      user: withClientNames(result.user, await realmNameMap()),
      apiKey: result.user.accountType === 'client' ? null : result.apiKey,
    });
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
