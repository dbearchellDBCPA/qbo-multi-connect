import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { QBOManager } from '../../src/index.js';
import { oauthRoutes } from '../../src/server/routes/oauth.js';
import { registerMcpRoutes } from '../../src/server/mcp.js';
import { resolveAuth } from '../../src/server/auth.js';

const ENCRYPTION_KEY = 'a'.repeat(64);
const MASTER_KEY = 'master-key-for-tests';
const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';

function pkcePair() {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

describe('OAuth authorization server for per-user MCP sign-in', () => {
  let qbo: QBOManager;
  let app: FastifyInstance;

  beforeEach(async () => {
    qbo = new QBOManager({ dbPath: ':memory:', encryptionKey: ENCRYPTION_KEY });
    const now = Date.now();
    for (const [name, realm] of [['Acme Corp', 'realm-1'], ['Beta LLC', 'realm-2']]) {
      await (qbo as any).tokenStore.storeConnection({
        clientName: name,
        realmId: realm,
        accessToken: 'at',
        refreshToken: 'rt',
        tokenExpiry: new Date(now + 3600e3),
        refreshExpiry: new Date(now + 90 * 864e5),
        scopes: ['x'],
      });
    }
    app = Fastify({ logger: false });
    await oauthRoutes(app, qbo);
    await registerMcpRoutes(app, qbo, MASTER_KEY);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    await qbo.close();
  });

  const HOST = { host: 'qbo.example.com', 'x-forwarded-proto': 'https' };

  // ── Discovery ─────────────────────────────────────────────────────────────

  it('advertises protected resource metadata pointing at this authorization server', async () => {
    for (const url of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']) {
      const res = await app.inject({ method: 'GET', url, headers: HOST });
      expect(res.statusCode, url).toBe(200);
      expect(res.json()).toMatchObject({
        resource: 'https://qbo.example.com/mcp',
        authorization_servers: ['https://qbo.example.com'],
      });
    }
  });

  it('advertises authorization server metadata with PKCE S256 and DCR', async () => {
    const res = await app.inject({ method: 'GET', url: '/.well-known/oauth-authorization-server', headers: HOST });
    expect(res.statusCode).toBe(200);
    const meta = res.json();
    expect(meta.issuer).toBe('https://qbo.example.com');
    expect(meta.authorization_endpoint).toBe('https://qbo.example.com/oauth/authorize');
    expect(meta.token_endpoint).toBe('https://qbo.example.com/oauth/token');
    expect(meta.registration_endpoint).toBe('https://qbo.example.com/oauth/register');
    expect(meta.code_challenge_methods_supported).toEqual(['S256']);
    expect(meta.grant_types_supported).toEqual(['authorization_code', 'refresh_token']);
  });

  it('challenges unauthenticated /mcp with a resource_metadata pointer', async () => {
    const res = await app.inject({ method: 'POST', url: '/mcp', headers: HOST, payload: {} });
    expect(res.statusCode).toBe(401);
    expect(res.headers['www-authenticate']).toContain(
      'resource_metadata="https://qbo.example.com/.well-known/oauth-protected-resource"'
    );
  });

  // ── Dynamic client registration ───────────────────────────────────────────

  async function registerClient(redirectUris: string[] = [REDIRECT]) {
    const res = await app.inject({
      method: 'POST',
      url: '/oauth/register',
      headers: HOST,
      payload: { client_name: 'Claude', redirect_uris: redirectUris, token_endpoint_auth_method: 'none' },
    });
    expect(res.statusCode).toBe(201);
    return res.json();
  }

  it('registers a public client dynamically (RFC 7591)', async () => {
    const client = await registerClient();
    expect(client.client_id).toMatch(/^qboc_/);
    expect(client.client_secret).toBeUndefined(); // public client → PKCE only
    expect(client.redirect_uris).toEqual([REDIRECT]);
  });

  it('rejects non-https redirect URIs (loopback http allowed)', async () => {
    const bad = await app.inject({
      method: 'POST',
      url: '/oauth/register',
      headers: HOST,
      payload: { redirect_uris: ['http://evil.example.com/cb'] },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toBe('invalid_client_metadata');

    const loopback = await app.inject({
      method: 'POST',
      url: '/oauth/register',
      headers: HOST,
      payload: { redirect_uris: ['http://127.0.0.1:5173/cb'] },
    });
    expect(loopback.statusCode).toBe(201);
  });

  // ── Full authorization code + PKCE flow ───────────────────────────────────

  async function makeMember(overrides: Record<string, unknown> = {}) {
    return qbo.users.create({
      name: 'Jane Smith',
      username: 'jane',
      password: 'correct-horse-battery',
      realmIds: ['realm-1'],
      ...overrides,
    });
  }

  async function authorizeAndGetCode(clientId: string, challenge: string, creds = { username: 'jane', password: 'correct-horse-battery' }) {
    const res = await app.inject({
      method: 'POST',
      url: '/oauth/authorize',
      headers: HOST,
      payload: {
        client_id: clientId,
        redirect_uri: REDIRECT,
        response_type: 'code',
        code_challenge: challenge,
        code_challenge_method: 'S256',
        state: 'xyz-state',
        ...creds,
      },
    });
    return res;
  }

  it('shows a sign-in page at the authorization endpoint', async () => {
    const client = await registerClient();
    const { challenge } = pkcePair();
    const res = await app.inject({
      method: 'GET',
      url: `/oauth/authorize?client_id=${client.client_id}&redirect_uri=${encodeURIComponent(REDIRECT)}&response_type=code&code_challenge=${challenge}&code_challenge_method=S256&state=abc`,
      headers: HOST,
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Sign in to connect');
    expect(res.body).toContain('name="password"');
    expect(res.body).toContain('abc'); // state round-trips through the form
  });

  it('completes the flow: sign-in → code → token → scoped MCP access', async () => {
    const client = await registerClient();
    const { verifier, challenge } = pkcePair();
    const { user } = await makeMember();

    // 1. User signs in on the authorization page
    const authRes = await authorizeAndGetCode(client.client_id, challenge);
    expect(authRes.statusCode).toBe(302);
    const location = new URL(authRes.headers.location as string);
    expect(location.origin + location.pathname).toBe(REDIRECT);
    expect(location.searchParams.get('state')).toBe('xyz-state');
    const code = location.searchParams.get('code')!;
    expect(code).toMatch(/^qboac_/);

    // 2. Client exchanges the code (PKCE verifier proves possession)
    const tokenRes = await app.inject({
      method: 'POST',
      url: '/oauth/token',
      headers: HOST,
      payload: {
        grant_type: 'authorization_code',
        code,
        client_id: client.client_id,
        code_verifier: verifier,
        redirect_uri: REDIRECT,
      },
    });
    expect(tokenRes.statusCode).toBe(200);
    const tokens = tokenRes.json();
    expect(tokens.access_token).toMatch(/^qboat_/);
    expect(tokens.token_type).toBe('Bearer');
    expect(tokens.refresh_token).toMatch(/^qbort_/);

    // 3. The access token resolves to THAT user's scope
    const scope = await resolveAuth(qbo, MASTER_KEY, `Bearer ${tokens.access_token}`);
    expect(scope?.userId).toBe(user.id);
    expect(scope?.userName).toBe('Jane Smith');
    expect(scope?.allRealms).toBe(false);
    expect([...(scope?.realmIds ?? [])]).toEqual(['realm-1']);

    // 4. /mcp accepts it and lists only her company. Uses a real socket:
    // the MCP transport hands off raw req/res, which Fastify's synthetic
    // inject socket cannot tear down cleanly.
    const address = await app.listen({ port: 0, host: '127.0.0.1' });
    try {
      const mcpRes = await fetch(`${address}/mcp`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${tokens.access_token}`,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_clients', arguments: {} } }),
      });
      expect(mcpRes.status).toBe(200);
      const text = await mcpRes.text();
      expect(text).toContain('Acme Corp');
      expect(text).not.toContain('Beta LLC'); // scoping applied per user
    } finally {
      // closed by afterEach
    }
  });

  it('two members using the SAME connector get different client access', async () => {
    const client = await registerClient();
    await makeMember(); // jane → realm-1
    await qbo.users.create({
      name: 'Bob Lee',
      username: 'bob',
      password: 'another-good-password',
      realmIds: ['realm-2'],
    });

    async function tokenFor(username: string, password: string) {
      const { verifier, challenge } = pkcePair();
      const authRes = await authorizeAndGetCode(client.client_id, challenge, { username, password });
      const code = new URL(authRes.headers.location as string).searchParams.get('code')!;
      const res = await app.inject({
        method: 'POST',
        url: '/oauth/token',
        headers: HOST,
        payload: { grant_type: 'authorization_code', code, client_id: client.client_id, code_verifier: verifier, redirect_uri: REDIRECT },
      });
      return res.json().access_token as string;
    }

    const janeScope = await resolveAuth(qbo, MASTER_KEY, `Bearer ${await tokenFor('jane', 'correct-horse-battery')}`);
    const bobScope = await resolveAuth(qbo, MASTER_KEY, `Bearer ${await tokenFor('bob', 'another-good-password')}`);

    expect([...(janeScope!.realmIds)]).toEqual(['realm-1']);
    expect([...(bobScope!.realmIds)]).toEqual(['realm-2']);
    expect(janeScope!.userId).not.toBe(bobScope!.userId);
  });

  it('rejects bad credentials without issuing a code', async () => {
    const client = await registerClient();
    const { challenge } = pkcePair();
    await makeMember();
    const res = await authorizeAndGetCode(client.client_id, challenge, { username: 'jane', password: 'wrong' });
    expect(res.statusCode).toBe(401);
    expect(res.body).toContain('Incorrect username or password');
    expect(res.headers.location).toBeUndefined();
  });

  // ── PKCE and code hardening ───────────────────────────────────────────────

  it('rejects a wrong PKCE verifier', async () => {
    const client = await registerClient();
    const { challenge } = pkcePair();
    const other = pkcePair();
    await makeMember();
    const authRes = await authorizeAndGetCode(client.client_id, challenge);
    const code = new URL(authRes.headers.location as string).searchParams.get('code')!;

    const res = await app.inject({
      method: 'POST',
      url: '/oauth/token',
      headers: HOST,
      payload: { grant_type: 'authorization_code', code, client_id: client.client_id, code_verifier: other.verifier },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid_grant');
    expect(res.json().error_description).toMatch(/PKCE/);
  });

  it('authorization codes are single-use', async () => {
    const client = await registerClient();
    const { verifier, challenge } = pkcePair();
    await makeMember();
    const authRes = await authorizeAndGetCode(client.client_id, challenge);
    const code = new URL(authRes.headers.location as string).searchParams.get('code')!;
    const payload = { grant_type: 'authorization_code', code, client_id: client.client_id, code_verifier: verifier };

    expect((await app.inject({ method: 'POST', url: '/oauth/token', headers: HOST, payload })).statusCode).toBe(200);
    const replay = await app.inject({ method: 'POST', url: '/oauth/token', headers: HOST, payload });
    expect(replay.statusCode).toBe(400);
    expect(replay.json().error).toBe('invalid_grant');
  });

  it('rejects a code redeemed by a different client', async () => {
    const client = await registerClient();
    const attacker = await registerClient(['https://attacker.example.com/cb']);
    const { verifier, challenge } = pkcePair();
    await makeMember();
    const authRes = await authorizeAndGetCode(client.client_id, challenge);
    const code = new URL(authRes.headers.location as string).searchParams.get('code')!;

    const res = await app.inject({
      method: 'POST',
      url: '/oauth/token',
      headers: HOST,
      payload: { grant_type: 'authorization_code', code, client_id: attacker.client_id, code_verifier: verifier },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid_grant');
  });

  it('rejects unregistered redirect_uri at the authorization endpoint', async () => {
    const client = await registerClient();
    const { challenge } = pkcePair();
    const res = await app.inject({
      method: 'GET',
      url: `/oauth/authorize?client_id=${client.client_id}&redirect_uri=${encodeURIComponent('https://attacker.example.com/cb')}&response_type=code&code_challenge=${challenge}&code_challenge_method=S256`,
      headers: HOST,
    });
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('not registered');
  });

  it('requires PKCE S256', async () => {
    const client = await registerClient();
    const res = await app.inject({
      method: 'GET',
      url: `/oauth/authorize?client_id=${client.client_id}&redirect_uri=${encodeURIComponent(REDIRECT)}&response_type=code&state=s`,
      headers: HOST,
    });
    expect(res.statusCode).toBe(302);
    const loc = new URL(res.headers.location as string);
    expect(loc.searchParams.get('error')).toBe('invalid_request');
    expect(loc.searchParams.get('state')).toBe('s');
  });

  // ── Refresh and revocation ────────────────────────────────────────────────

  it('refreshes access tokens and rotates the refresh token', async () => {
    const client = await registerClient();
    const { verifier, challenge } = pkcePair();
    await makeMember();
    const authRes = await authorizeAndGetCode(client.client_id, challenge);
    const code = new URL(authRes.headers.location as string).searchParams.get('code')!;
    const first = (await app.inject({
      method: 'POST', url: '/oauth/token', headers: HOST,
      payload: { grant_type: 'authorization_code', code, client_id: client.client_id, code_verifier: verifier },
    })).json();

    const refreshed = await app.inject({
      method: 'POST', url: '/oauth/token', headers: HOST,
      payload: { grant_type: 'refresh_token', refresh_token: first.refresh_token, client_id: client.client_id },
    });
    expect(refreshed.statusCode).toBe(200);
    const second = refreshed.json();
    expect(second.access_token).not.toBe(first.access_token);
    expect(second.refresh_token).not.toBe(first.refresh_token);

    // Old refresh token is consumed
    const replay = await app.inject({
      method: 'POST', url: '/oauth/token', headers: HOST,
      payload: { grant_type: 'refresh_token', refresh_token: first.refresh_token, client_id: client.client_id },
    });
    expect(replay.statusCode).toBe(400);

    // New access token still authenticates
    expect((await resolveAuth(qbo, MASTER_KEY, `Bearer ${second.access_token}`))?.userName).toBe('Jane Smith');
  });

  it('revokes a token (RFC 7009) and always answers 200', async () => {
    const client = await registerClient();
    const { verifier, challenge } = pkcePair();
    await makeMember();
    const authRes = await authorizeAndGetCode(client.client_id, challenge);
    const code = new URL(authRes.headers.location as string).searchParams.get('code')!;
    const tokens = (await app.inject({
      method: 'POST', url: '/oauth/token', headers: HOST,
      payload: { grant_type: 'authorization_code', code, client_id: client.client_id, code_verifier: verifier },
    })).json();

    const revoke = await app.inject({
      method: 'POST', url: '/oauth/revoke', headers: HOST, payload: { token: tokens.access_token },
    });
    expect(revoke.statusCode).toBe(200);
    expect(await resolveAuth(qbo, MASTER_KEY, `Bearer ${tokens.access_token}`)).toBeNull();

    // Unknown token also 200
    expect((await app.inject({ method: 'POST', url: '/oauth/revoke', headers: HOST, payload: { token: 'nope' } })).statusCode).toBe(200);
  });

  it('a disabled user\'s OAuth token stops working immediately', async () => {
    const client = await registerClient();
    const { verifier, challenge } = pkcePair();
    const { user } = await makeMember();
    const authRes = await authorizeAndGetCode(client.client_id, challenge);
    const code = new URL(authRes.headers.location as string).searchParams.get('code')!;
    const tokens = (await app.inject({
      method: 'POST', url: '/oauth/token', headers: HOST,
      payload: { grant_type: 'authorization_code', code, client_id: client.client_id, code_verifier: verifier },
    })).json();

    expect(await resolveAuth(qbo, MASTER_KEY, `Bearer ${tokens.access_token}`)).not.toBeNull();
    await qbo.users.update(user.id, { status: 'disabled' });
    expect(await resolveAuth(qbo, MASTER_KEY, `Bearer ${tokens.access_token}`)).toBeNull();
  });

  // Real OAuth traffic is form-encoded (browser sign-in form, RFC 6749 token
  // requests) — JSON-only parsing silently breaks the whole flow.
  it('accepts application/x-www-form-urlencoded on authorize and token', async () => {
    const client = await registerClient();
    const { verifier, challenge } = pkcePair();
    await makeMember();

    const form = (obj: Record<string, string>) => new URLSearchParams(obj).toString();
    const FORM = { ...HOST, 'content-type': 'application/x-www-form-urlencoded' };

    const authRes = await app.inject({
      method: 'POST',
      url: '/oauth/authorize',
      headers: FORM,
      payload: form({
        client_id: client.client_id,
        redirect_uri: REDIRECT,
        response_type: 'code',
        code_challenge: challenge,
        code_challenge_method: 'S256',
        state: 'form-state',
        username: 'jane',
        password: 'correct-horse-battery',
      }),
    });
    expect(authRes.statusCode).toBe(302);
    const code = new URL(authRes.headers.location as string).searchParams.get('code')!;

    const tokenRes = await app.inject({
      method: 'POST',
      url: '/oauth/token',
      headers: FORM,
      payload: form({
        grant_type: 'authorization_code',
        code,
        client_id: client.client_id,
        code_verifier: verifier,
        redirect_uri: REDIRECT,
      }),
    });
    expect(tokenRes.statusCode).toBe(200);
    expect(tokenRes.json().access_token).toMatch(/^qboat_/);
  });

  it('still accepts legacy API keys (existing connectors keep working)', async () => {
    const { apiKey } = await qbo.users.create({ name: 'Legacy', realmIds: ['realm-2'] });
    const scope = await resolveAuth(qbo, MASTER_KEY, `Bearer ${apiKey}`);
    expect([...(scope!.realmIds)]).toEqual(['realm-2']);
  });
});
