import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { QBOManager } from '../../index.js';
import { authenticateRequest } from '../middleware.js';
import { extractApiKeyCandidates } from '../auth.js';
import { MIN_PASSWORD_LENGTH } from '../../users.js';

/** Lock a username after this many consecutive failures… */
const MAX_LOGIN_FAILURES = 5;
/** …for this long. */
const LOCKOUT_MS = 60_000;

function credentials(request: FastifyRequest): string[] {
  const queryKey = (request.query as Record<string, string> | undefined)?.key;
  return extractApiKeyCandidates(request.headers.authorization, queryKey);
}

export async function authRoutes(
  fastify: FastifyInstance,
  qboManager: QBOManager,
  masterApiKey: string
): Promise<void> {
  // In-memory brute-force throttle, keyed by normalized username. Resets on
  // success or process restart — a speed bump, not a bank vault.
  const loginFailures = new Map<string, { fails: number; lockedUntil: number }>();

  // ── POST /api/auth/login — username/password → session token ──────────────
  fastify.post<{ Body: { username?: string; password?: string } }>(
    '/api/auth/login',
    async (request, reply) => {
      const username = request.body?.username?.trim().toLowerCase();
      const password = request.body?.password;
      if (!username || !password) {
        await reply.code(400).send({ error: 'Bad Request', message: 'username and password are required' });
        return;
      }

      const entry = loginFailures.get(username);
      if (entry && entry.lockedUntil > Date.now()) {
        await reply.code(429).send({
          error: 'Too Many Requests',
          message: 'Too many failed sign-ins — wait a minute and try again',
        });
        return;
      }

      const user = await qboManager.users.verifyLogin(username, password);
      if (!user) {
        const fails = (entry?.fails ?? 0) + 1;
        loginFailures.set(username, {
          fails,
          lockedUntil: fails >= MAX_LOGIN_FAILURES ? Date.now() + LOCKOUT_MS : 0,
        });
        await reply.code(401).send({ error: 'Unauthorized', message: 'Invalid username or password' });
        return;
      }

      loginFailures.delete(username);
      const { token, expiresAt } = await qboManager.users.createSession(user.id);
      await reply.send({ token, expiresAt: expiresAt.toISOString() });
    }
  );

  // ── POST /api/auth/logout — end the presented session ─────────────────────
  fastify.post('/api/auth/logout', async (request, reply) => {
    const scope = await authenticateRequest(request, reply, qboManager, masterApiKey);
    if (!scope) return;
    for (const candidate of credentials(request)) {
      await qboManager.users.deleteSession(candidate); // no-op for API keys
    }
    await reply.send({ success: true });
  });

  // ── GET /api/me/key — the caller's own API key + connector context ────────
  fastify.get('/api/me/key', async (request, reply) => {
    const scope = await authenticateRequest(request, reply, qboManager, masterApiKey);
    if (!scope) return;

    if (scope.kind === 'master') {
      await reply.send({ apiKey: masterApiKey, keyPrefix: masterApiKey.slice(0, 12), retrievable: true });
      return;
    }

    const user = await qboManager.users.get(scope.userId!);
    let apiKey = await qboManager.users.getApiKey(scope.userId!);
    if (!apiKey) {
      // Legacy key with no encrypted copy — but if the caller authenticated
      // WITH that key just now, we can simply echo it back.
      for (const candidate of credentials(request)) {
        if (!candidate.startsWith('qbos_') && (await qboManager.users.findByApiKey(candidate))?.id === scope.userId) {
          apiKey = candidate;
          break;
        }
      }
    }
    await reply.send({
      apiKey,
      keyPrefix: user?.keyPrefix ?? null,
      retrievable: apiKey != null,
    });
  });

  // ── POST /api/me/password — self-service password change ──────────────────
  fastify.post<{ Body: { currentPassword?: string; newPassword?: string } }>(
    '/api/me/password',
    async (request, reply) => {
      const scope = await authenticateRequest(request, reply, qboManager, masterApiKey);
      if (!scope) return;
      if (scope.kind !== 'user' || scope.userId == null) {
        await reply.code(400).send({
          error: 'Bad Request',
          message: 'The master key has no password — set QBO_API_KEY in the environment instead',
        });
        return;
      }

      const newPassword = request.body?.newPassword;
      if (!newPassword || newPassword.length < MIN_PASSWORD_LENGTH) {
        await reply.code(400).send({
          error: 'Bad Request',
          message: `newPassword must be at least ${MIN_PASSWORD_LENGTH} characters`,
        });
        return;
      }

      const user = await qboManager.users.get(scope.userId);
      if (user?.hasPassword) {
        const current = request.body?.currentPassword;
        if (!current || !(await qboManager.users.checkPassword(scope.userId, current))) {
          await reply.code(403).send({ error: 'Forbidden', message: 'Current password is incorrect' });
          return;
        }
      }

      await qboManager.users.setPassword(scope.userId, newPassword);
      // Changing the password ends every other session for this user; the
      // session that made the change (if any) stays signed in.
      const [presented] = credentials(request);
      await qboManager.users.deleteSessions(scope.userId, presented);
      await reply.send({ success: true });
    }
  );
}
