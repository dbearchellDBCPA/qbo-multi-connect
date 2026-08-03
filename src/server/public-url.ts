import type { FastifyRequest } from 'fastify';

/**
 * Where this deployment's public URL comes from.
 *
 * Two modes, chosen by whether QBO_PUBLIC_URL is set:
 *
 *   PINNED   — QBO_PUBLIC_URL is set. Every generated URL uses it, no matter
 *              which hostname the request arrived on. Use when you want one
 *              canonical address and nothing else.
 *
 *   DYNAMIC  — QBO_PUBLIC_URL is unset (recommended). URLs mirror the hostname
 *              the request actually came in on, so the Railway address and any
 *              custom domain both work at the same time, and adding, changing,
 *              or dropping a domain needs no redeploy or config edit.
 *
 * In dynamic mode the hostname comes from a header the client controls, so
 * QBO_ALLOWED_HOSTS optionally restricts it to hosts you actually own. When
 * set, a request arriving on any other hostname is served using the first
 * entry instead of the spoofed one.
 */
export type PublicUrlSource =
  | 'QBO_PUBLIC_URL'
  | 'request'
  | 'QBO_ALLOWED_HOSTS'
  | 'RAILWAY_PUBLIC_DOMAIN'
  | 'none';

export interface PublicUrlResolution {
  /** Absolute origin with no trailing slash, or null if it can't be determined. */
  baseUrl: string | null;
  source: PublicUrlSource;
  /** Hostname the request actually arrived on (proxy-aware), when known. */
  requestHost: string | null;
  /** True when QBO_PUBLIC_URL pins an origin that isn't the one being browsed. */
  pinnedMismatch: boolean;
  /** Set when QBO_ALLOWED_HOSTS rejected the request's hostname. */
  rejectedHost: string | null;
}

/** Accepts "example.com", "https://example.com", "https://example.com/" alike. */
export function normalizeBaseUrl(value: string | undefined | null): string | null {
  const raw = value?.trim();
  if (!raw) return null;
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    const url = new URL(withScheme);
    if (!url.hostname) return null;
    return `${url.protocol}//${url.host}`;
  } catch {
    return null;
  }
}

/** Parse QBO_ALLOWED_HOSTS: comma/whitespace separated, scheme optional, `*.` wildcards ok. */
export function allowedHosts(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env.QBO_ALLOWED_HOSTS || '')
    .split(/[,\s]+/)
    .map((entry) =>
      entry
        .trim()
        .toLowerCase()
        .replace(/^https?:\/\//, '')
        .replace(/\/.*$/, '')
    )
    .filter(Boolean);
}

function hostMatches(host: string, pattern: string): boolean {
  const h = host.toLowerCase();
  if (pattern.startsWith('*.')) {
    const suffix = pattern.slice(1); // ".example.com"
    // Match subdomains only; "*.example.com" does not cover "example.com".
    return h.endsWith(suffix) && h.length > suffix.length;
  }
  return h === pattern;
}

function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  // Proxy chains append, e.g. "https,http" — the client-facing hop is first.
  return raw?.split(',')[0]?.trim() || undefined;
}

/**
 * Work out the origin this deployment is reachable at, and say where the
 * answer came from so the dashboard can explain (and warn about) it.
 */
export function resolvePublicUrl(
  request?: Pick<FastifyRequest, 'headers' | 'protocol'>,
  env: NodeJS.ProcessEnv = process.env
): PublicUrlResolution {
  const headers = request?.headers ?? {};
  const forwardedHost = firstHeaderValue(headers['x-forwarded-host']);
  const hostHeader = forwardedHost || firstHeaderValue(headers.host);
  const proto =
    firstHeaderValue(headers['x-forwarded-proto']) ||
    request?.protocol ||
    (hostHeader && /^(localhost|127\.0\.0\.1|\[::1\])(:|$)/i.test(hostHeader) ? 'http' : 'https');
  const requestHost = hostHeader ?? null;

  const pinned = normalizeBaseUrl(env.QBO_PUBLIC_URL);
  if (pinned) {
    let pinnedMismatch = false;
    if (requestHost) {
      try {
        pinnedMismatch = new URL(pinned).host.toLowerCase() !== requestHost.toLowerCase();
      } catch {
        /* normalizeBaseUrl already validated it; ignore */
      }
    }
    return { baseUrl: pinned, source: 'QBO_PUBLIC_URL', requestHost, pinnedMismatch, rejectedHost: null };
  }

  const allowlist = allowedHosts(env);
  if (requestHost) {
    if (allowlist.length === 0 || allowlist.some((pattern) => hostMatches(requestHost, pattern))) {
      return {
        baseUrl: `${proto}://${requestHost}`,
        source: 'request',
        requestHost,
        pinnedMismatch: false,
        rejectedHost: null,
      };
    }
    // Host header didn't match anything we own — fall back to the canonical
    // entry rather than advertising a hostname an attacker supplied.
    return {
      baseUrl: normalizeBaseUrl(allowlist[0]),
      source: 'QBO_ALLOWED_HOSTS',
      requestHost,
      pinnedMismatch: false,
      rejectedHost: requestHost,
    };
  }

  if (allowlist.length > 0) {
    return {
      baseUrl: normalizeBaseUrl(allowlist[0]),
      source: 'QBO_ALLOWED_HOSTS',
      requestHost: null,
      pinnedMismatch: false,
      rejectedHost: null,
    };
  }

  // No request context (startup banner, background jobs): Railway injects the
  // service's public domain, which is the custom one once you've added it.
  const railway = normalizeBaseUrl(env.RAILWAY_PUBLIC_DOMAIN);
  if (railway) {
    return {
      baseUrl: railway,
      source: 'RAILWAY_PUBLIC_DOMAIN',
      requestHost: null,
      pinnedMismatch: false,
      rejectedHost: null,
    };
  }

  return { baseUrl: null, source: 'none', requestHost: null, pinnedMismatch: false, rejectedHost: null };
}

/** Resolve this deployment's public origin, falling back to loopback. */
export function publicBaseUrl(
  request?: Pick<FastifyRequest, 'headers' | 'protocol'>,
  env: NodeJS.ProcessEnv = process.env
): string {
  const { baseUrl } = resolvePublicUrl(request, env);
  return baseUrl ?? `http://localhost:${env.PORT || env.QBO_SERVER_PORT || '3456'}`;
}

/**
 * The redirect_uri handed to Intuit when connecting a QuickBooks company.
 *
 * QBO_REDIRECT_URI pins it (legacy behaviour). Otherwise it follows whichever
 * hostname the admin is browsing, so a connection started on a custom domain
 * comes back to that same domain. Intuit requires an exact match against the
 * app's registered redirect URIs, so every hostname you use must be listed on
 * the Intuit app — see docs/CUSTOM-DOMAIN.md.
 *
 * The match between the authorize call and the token exchange holds by
 * construction: Intuit sends the browser back to the redirect_uri we gave it,
 * so the callback request arrives on that same host and derives the same value.
 */
export function intuitRedirectUri(
  request?: Pick<FastifyRequest, 'headers' | 'protocol'>,
  env: NodeJS.ProcessEnv = process.env
): string {
  const pinned = env.QBO_REDIRECT_URI?.trim();
  if (pinned) return pinned.replace(/\/+$/, '');
  return `${publicBaseUrl(request, env)}/callback`;
}
