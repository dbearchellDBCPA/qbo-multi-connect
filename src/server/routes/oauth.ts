import type { FastifyInstance, FastifyRequest } from 'fastify';
import fastifyFormbody from '@fastify/formbody';
import type { QBOManager } from '../../index.js';
import { escapeHtml } from '../callback-page.js';
import { BRAND_BASE, BRAND_FAVICON, BRAND_FONT_FACES, BRAND_TOKENS, brandLine } from '../brand-css.js';

/**
 * OAuth 2.1 authorization server endpoints for the MCP connector.
 *
 * The point: a Claude Team workspace installs this connector ONCE, with no
 * key in the URL. Each member who enables it runs this flow and signs in with
 * their own dashboard username/password, so their access token carries their
 * identity and the existing per-client scoping applies per person.
 */

// The OAuth issuer, metadata URLs and redirects all have to name this
// deployment's public origin. That origin follows whichever hostname the
// request came in on (or QBO_PUBLIC_URL when pinned), so a custom domain
// works without touching this file — see ../public-url.ts.
import { publicBaseUrl } from '../public-url.js';
import { waitText } from './auth.js';
import { APP_NAME, type FirmBrand } from '../../branding.js';
import { CLIENT_TERMS_VERSION, agreed, needsAcknowledgment } from '../../client-terms.js';
import { termsBlock } from '../invite-pages.js';
export { publicBaseUrl };

const SIGN_IN_STYLES = `
${BRAND_FONT_FACES}
${BRAND_TOKENS}
${BRAND_BASE}
  .card {
    background:var(--surface); border:1px solid var(--border); border-radius:16px;
    box-shadow:var(--shadow); max-width:420px; width:100%; padding:36px 32px;
  }
  .brand { margin-bottom:22px; }
  h1 { font-size:19px; margin-bottom:6px; }
  .lead { color:var(--text-secondary); font-size:14px; margin-bottom:22px; }
  .lead strong { color:var(--text); }
  label { display:block; font-size:13px; font-weight:600; color:var(--text-secondary); margin-bottom:6px; }
  input[type=text], input[type=password] {
    width:100%; padding:10px 12px; border:1px solid var(--border-input); border-radius:8px;
    background:var(--surface-2); color:var(--text); font-size:14px; margin-bottom:16px;
    font-family:inherit;
  }
  input::placeholder { color:var(--text-faint); }
  /* Focus swaps the border for an accent ring, per the brand's field spec. */
  input:focus-visible {
    outline:none; border-color:transparent; box-shadow:0 0 0 2px var(--primary);
  }
  button {
    width:100%; background:var(--primary); color:var(--on-primary); border:none; border-radius:8px;
    padding:12px; font-size:14.5px; font-weight:600; cursor:pointer; font-family:inherit;
    transition:background .15s;
  }
  button:hover { background:var(--primary-hover); }
  .err {
    background:var(--err-soft); border:1px solid var(--err-border); color:var(--err);
    border-radius:8px; padding:10px 12px; font-size:13.5px; font-weight:500; margin-bottom:16px;
  }
  .note { margin-top:18px; font-size:12.5px; color:var(--text-faint); line-height:1.6; }
  .powered { max-width:420px; margin:14px auto 0; text-align:center; font-size:11.5px; color:var(--text-faint); }
  .info {
    background:var(--primary-soft); border:1px solid var(--primary); color:var(--text);
    border-radius:8px; padding:10px 12px; font-size:13.5px; font-weight:500; margin-bottom:16px;
  }
  .terms { margin:0 0 16px; padding:14px 16px 6px; border:1px solid var(--border); border-radius:10px; background:var(--surface-2); }
  .terms h2 { margin:0 0 8px; font-size:14px; }
  .terms ul { padding-left:20px; margin-bottom:8px; }
  .terms li { font-size:13px; line-height:1.55; color:var(--text-secondary); margin-bottom:6px; }
  .terms li strong { color:var(--text); }
  .terms .more { font-size:12.5px; margin:0 0 8px; }
  .terms a { color:var(--primary); }
  .agree { display:flex; gap:10px; align-items:flex-start; margin:0 0 16px; font-weight:500; font-size:13.5px; color:var(--text); cursor:pointer; }
  .agree input { margin-top:3px; width:16px; height:16px; flex-shrink:0; accent-color:var(--primary); }
`;

/** Small print under the card: the firm is the brand, the app gets the credit line. */
function poweredBy(firm: FirmBrand): string {
  return firm.configured
    ? `<p class="powered">Secure access from ${escapeHtml(firm.name)}, provided through ${APP_NAME}.</p>`
    : '';
}

function signInPage(opts: {
  clientName: string;
  params: Record<string, string>;
  firm: FirmBrand;
  error?: string;
  /** Show the "before you connect" points and their checkbox: this client login has not accepted them yet. */
  terms?: boolean;
  /** The username to keep in the box when the page is shown again. */
  username?: string;
}): string {
  const hidden = Object.entries(opts.params)
    .map(([k, v]) => `<input type="hidden" name="${escapeHtml(k)}" value="${escapeHtml(v)}">`)
    .join('\n      ');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Sign in — ${escapeHtml(opts.firm.displayName)}</title>
${BRAND_FAVICON}
<style>${SIGN_IN_STYLES}</style>
</head>
<body>
  <div>
  <div class="card">
    <div class="brand">${brandLine(opts.firm)}</div>
    <h1>Sign in to connect</h1>
    <p class="lead"><strong>${escapeHtml(opts.clientName)}</strong> is requesting access to QuickBooks on your behalf. Sign in with your email or username and your password — you'll only reach the companies assigned to you.</p>
    ${opts.error ? `<div class="err">${escapeHtml(opts.error)}</div>` : ''}
    ${opts.terms ? '<div class="info">One more step before you connect: read the points below, tick the box, and sign in again.</div>' : ''}
    <form method="POST" action="/oauth/authorize">
      ${hidden}
      <label for="username">Email or username</label>
      <input type="text" id="username" name="username" value="${escapeHtml(opts.username ?? '')}" autocomplete="username"${opts.username ? '' : ' autofocus'} required>
      <label for="password">Password</label>
      <input type="password" id="password" name="password" autocomplete="current-password"${opts.username ? ' autofocus' : ''} required>
      ${opts.terms ? termsBlock() : ''}
      <button type="submit">Sign in and allow access</button>
    </form>
    <p class="note">Trouble signing in? Contact ${opts.firm.configured ? escapeHtml(opts.firm.name) : 'the person who set up your access'} — they can check your username or reset your password.</p>
  </div>
  ${poweredBy(opts.firm)}
  </div>
</body>
</html>`;
}

const AUTHORIZE_PARAM_KEYS = [
  'client_id',
  'redirect_uri',
  'response_type',
  'code_challenge',
  'code_challenge_method',
  'scope',
  'state',
  'resource',
];

function pickParams(source: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of AUTHORIZE_PARAM_KEYS) {
    const v = source[key];
    if (typeof v === 'string' && v) out[key] = v;
  }
  return out;
}

/** Append query params to a redirect URI, preserving any it already has. */
function redirectWith(base: string, params: Record<string, string | undefined>): string {
  const url = new URL(base);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) url.searchParams.set(k, v);
  }
  return url.href;
}

export async function oauthRoutes(fastify: FastifyInstance, qboManager: QBOManager): Promise<void> {
  // OAuth is form-encoded: the browser sign-in form posts
  // application/x-www-form-urlencoded, and so do token/revocation requests
  // per RFC 6749. Fastify only parses JSON out of the box.
  if (!fastify.hasContentTypeParser('application/x-www-form-urlencoded')) {
    await fastify.register(fastifyFormbody);
  }

  // ── Discovery: protected resource metadata (RFC 9728) ─────────────────────
  // Claude reads this after a 401 to learn which authorization server to use.
  const protectedResource = async (request: FastifyRequest, reply: any) => {
    const base = publicBaseUrl(request);
    await reply.header('Access-Control-Allow-Origin', '*').send({
      resource: `${base}/mcp`,
      authorization_servers: [base],
      scopes_supported: ['qbo'],
      resource_name: 'QBO Multi-Connect',
      bearer_methods_supported: ['header'],
    });
  };
  fastify.get('/.well-known/oauth-protected-resource', protectedResource);
  fastify.get('/.well-known/oauth-protected-resource/mcp', protectedResource);

  // ── Discovery: authorization server metadata (RFC 8414) ───────────────────
  const authServerMetadata = async (request: FastifyRequest, reply: any) => {
    const base = publicBaseUrl(request);
    await reply.header('Access-Control-Allow-Origin', '*').send({
      issuer: base,
      authorization_endpoint: `${base}/oauth/authorize`,
      token_endpoint: `${base}/oauth/token`,
      registration_endpoint: `${base}/oauth/register`,
      revocation_endpoint: `${base}/oauth/revoke`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['client_secret_post', 'none'],
      revocation_endpoint_auth_methods_supported: ['client_secret_post', 'none'],
      scopes_supported: ['qbo'],
    });
  };
  fastify.get('/.well-known/oauth-authorization-server', authServerMetadata);
  fastify.get('/.well-known/oauth-authorization-server/mcp', authServerMetadata);
  // Some clients probe the OIDC path; answer with the same document.
  fastify.get('/.well-known/openid-configuration', authServerMetadata);

  // ── Dynamic client registration (RFC 7591) ────────────────────────────────
  fastify.post<{ Body: Record<string, any> }>('/oauth/register', async (request, reply) => {
    const body: Record<string, any> = request.body ?? {};
    try {
      const client = await qboManager.oauth.registerClient({
        clientName: body.client_name ?? null,
        redirectUris: body.redirect_uris ?? [],
        grantTypes: body.grant_types,
        scope: body.scope ?? null,
        tokenEndpointAuthMethod: body.token_endpoint_auth_method,
      });
      await reply.code(201).send({
        client_id: client.clientId,
        ...(client.clientSecret ? { client_secret: client.clientSecret } : {}),
        client_name: client.clientName ?? undefined,
        redirect_uris: client.redirectUris,
        grant_types: client.grantTypes,
        response_types: ['code'],
        token_endpoint_auth_method: client.clientSecret ? 'client_secret_post' : 'none',
        ...(client.scope ? { scope: client.scope } : {}),
      });
    } catch (err: any) {
      await reply.code(400).send({
        error: 'invalid_client_metadata',
        error_description: err?.message ?? 'Registration failed',
      });
    }
  });

  // ── Authorization endpoint: show the sign-in page ─────────────────────────
  fastify.get<{ Querystring: Record<string, string> }>('/oauth/authorize', async (request, reply) => {
    const q = request.query ?? {};
    const params = pickParams(q);

    // Errors that cannot be safely redirected (unknown client / bad redirect)
    // must be shown directly rather than bounced to an unverified URI.
    const client = params.client_id ? await qboManager.oauth.getClient(params.client_id) : null;
    if (!client) {
      await reply.code(400).type('text/html').send(errorPage('Unknown or missing client_id. The connector may need to be re-added in Claude.', await qboManager.branding.firm()));
      return;
    }
    const redirectUri = params.redirect_uri ?? (client.redirectUris.length === 1 ? client.redirectUris[0] : undefined);
    if (!redirectUri || !client.redirectUris.includes(redirectUri)) {
      await reply.code(400).type('text/html').send(errorPage('The redirect_uri was not registered for this client.', await qboManager.branding.firm()));
      return;
    }
    params.redirect_uri = redirectUri;

    // From here errors go back to the client as OAuth error redirects.
    if (q.response_type !== 'code') {
      await reply.redirect(redirectWith(redirectUri, { error: 'unsupported_response_type', state: params.state }));
      return;
    }
    if (!params.code_challenge || q.code_challenge_method !== 'S256') {
      await reply.redirect(redirectWith(redirectUri, {
        error: 'invalid_request',
        error_description: 'PKCE with code_challenge_method=S256 is required',
        state: params.state,
      }));
      return;
    }

    await reply.type('text/html').send(
      signInPage({ clientName: client.clientName || 'An MCP client', params, firm: await qboManager.branding.firm() })
    );
  });

  // ── Authorization endpoint: verify credentials, issue the code ────────────
  fastify.post<{ Body: Record<string, string> }>('/oauth/authorize', async (request, reply) => {
    const body = request.body ?? {};
    const params = pickParams(body);
    const client = params.client_id ? await qboManager.oauth.getClient(params.client_id) : null;
    if (!client || !params.redirect_uri || !client.redirectUris.includes(params.redirect_uri)) {
      await reply.code(400).type('text/html').send(errorPage('This sign-in request is no longer valid. Start again from Claude.', await qboManager.branding.firm()));
      return;
    }

    const username = body.username?.trim();
    const password = body.password;
    // Same lock as the dashboard sign-in (UserService.login): this page is
    // reachable by anyone who has the connector address, so repeated guesses
    // at one username are slowed, then stopped.
    const result = username && password
      ? await qboManager.users.login(username, password)
      : ({ status: 'invalid', account: null } as const);
    if (result.status !== 'ok') {
      const locked = result.status === 'locked';
      await qboManager.activity.recordSignInFailure(result, 'connector');
      await reply.code(locked ? 429 : 401).type('text/html').send(
        signInPage({
          clientName: client.clientName || 'An MCP client',
          params,
          firm: await qboManager.branding.firm(),
          error: locked
            ? `Too many failed sign-ins. Wait ${waitText(result.retryAfterMs)} and try again, or ask for a password reset.`
            : 'Incorrect username or password. Try again.',
        })
      );
      return;
    }
    const user = result.user;

    // A client login connects an AI assistant to someone's books, so before
    // the first connection they accept a short list of what is theirs to
    // manage. Logins invited by link accepted it when they chose a password;
    // one given a password directly is asked here, once. Nothing is issued
    // until the box comes back ticked alongside the right password.
    if (needsAcknowledgment(user)) {
      if (!agreed(body.agree)) {
        await reply.code(200).type('text/html').send(
          signInPage({ clientName: client.clientName || 'An MCP client', params, firm: await qboManager.branding.firm(), terms: true, username })
        );
        return;
      }
      await qboManager.users.recordAcknowledgment(user.id, CLIENT_TERMS_VERSION);
    }

    await qboManager.activity.record({
      userId: user.id,
      userName: user.name,
      accountType: user.accountType,
      event: 'sign_in',
      tool: 'connector',
      outcome: 'ok',
    });

    const code = await qboManager.oauth.createAuthCode({
      clientId: client.clientId,
      userId: user.id,
      redirectUri: params.redirect_uri,
      codeChallenge: params.code_challenge,
      scope: params.scope ?? null,
      resource: params.resource ?? null,
    });

    await reply.redirect(redirectWith(params.redirect_uri, { code, state: params.state }));
  });

  // ── Token endpoint ────────────────────────────────────────────────────────
  fastify.post<{ Body: Record<string, string> }>('/oauth/token', async (request, reply) => {
    const body = request.body ?? {};
    const clientId = body.client_id;
    if (!clientId) {
      await reply.code(400).send({ error: 'invalid_request', error_description: 'client_id is required' });
      return;
    }
    if (!(await qboManager.oauth.checkClientSecret(clientId, body.client_secret))) {
      await reply.code(401).send({ error: 'invalid_client', error_description: 'Client authentication failed' });
      return;
    }

    try {
      let tokens;
      if (body.grant_type === 'authorization_code') {
        tokens = await qboManager.oauth.exchangeAuthCode({
          code: body.code,
          clientId,
          codeVerifier: body.code_verifier,
          redirectUri: body.redirect_uri,
        });
      } else if (body.grant_type === 'refresh_token') {
        tokens = await qboManager.oauth.refresh({ refreshToken: body.refresh_token, clientId });
        // A client login that has not accepted the current "before you
        // connect" points does not get to carry on by renewing: its tokens
        // are dropped, the assistant asks it to sign in again, and the
        // sign-in page shows the points. Without this, an assistant that
        // was already connected would never be asked.
        const owner = await qboManager.oauth.verifyAccessToken(tokens.accessToken);
        const user = owner ? await qboManager.users.get(owner.userId) : null;
        if (user && needsAcknowledgment(user)) {
          await qboManager.oauth.revokeAllForUser(user.id);
          throw new Error('invalid_grant: sign in again to continue');
        }
      } else {
        await reply.code(400).send({ error: 'unsupported_grant_type' });
        return;
      }

      await reply.header('Cache-Control', 'no-store').send({
        access_token: tokens.accessToken,
        token_type: 'Bearer',
        expires_in: tokens.expiresIn,
        refresh_token: tokens.refreshToken,
        ...(tokens.scope ? { scope: tokens.scope } : {}),
      });
    } catch (err: any) {
      const message = err?.message ?? 'Token exchange failed';
      await reply.code(400).send({
        error: message.startsWith('invalid_grant') ? 'invalid_grant' : 'invalid_request',
        error_description: message.replace(/^invalid_grant:\s*/, ''),
      });
    }
  });

  // ── Revocation (RFC 7009) ─────────────────────────────────────────────────
  fastify.post<{ Body: Record<string, string> }>('/oauth/revoke', async (request, reply) => {
    const token = request.body?.token;
    if (token) await qboManager.oauth.revoke(token);
    await reply.send({}); // RFC 7009: always 200, even for unknown tokens
  });
}

function errorPage(message: string, firm: FirmBrand): string {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Sign-in error — ${escapeHtml(firm.displayName)}</title>${BRAND_FAVICON}<style>${SIGN_IN_STYLES}</style></head>
<body><div class="card">
  <div class="brand">${brandLine(firm)}</div>
  <h1>Can't complete sign-in</h1>
  <p class="lead">${escapeHtml(message)}</p>
</div></body></html>`;
}
