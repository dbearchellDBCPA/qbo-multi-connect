import { describe, it, expect } from 'vitest';
import {
  resolvePublicUrl,
  publicBaseUrl,
  intuitRedirectUri,
  normalizeBaseUrl,
  allowedHosts,
} from '../../src/server/public-url.js';

/** Minimal stand-in for the parts of a Fastify request the resolver reads. */
function req(headers: Record<string, string | string[]>, protocol = 'https') {
  return { headers, protocol } as any;
}

describe('normalizeBaseUrl', () => {
  it('accepts a bare hostname and assumes https', () => {
    expect(normalizeBaseUrl('qbo.example.com')).toBe('https://qbo.example.com');
  });

  it('strips trailing slashes and paths', () => {
    expect(normalizeBaseUrl('https://qbo.example.com/')).toBe('https://qbo.example.com');
    expect(normalizeBaseUrl('https://qbo.example.com/mcp')).toBe('https://qbo.example.com');
  });

  it('keeps an explicit port and scheme', () => {
    expect(normalizeBaseUrl('http://localhost:3456')).toBe('http://localhost:3456');
  });

  it('returns null for blank or unparseable values', () => {
    expect(normalizeBaseUrl('')).toBeNull();
    expect(normalizeBaseUrl(undefined)).toBeNull();
    expect(normalizeBaseUrl('   ')).toBeNull();
    expect(normalizeBaseUrl('http://')).toBeNull();
  });
});

describe('allowedHosts', () => {
  it('parses comma- and space-separated entries, stripping scheme and path', () => {
    expect(
      allowedHosts({ QBO_ALLOWED_HOSTS: 'https://a.example.com/, b.example.com  ,\n*.c.example.com' } as any)
    ).toEqual(['a.example.com', 'b.example.com', '*.c.example.com']);
  });

  it('is empty when unset', () => {
    expect(allowedHosts({} as any)).toEqual([]);
  });
});

describe('resolvePublicUrl — dynamic mode (no QBO_PUBLIC_URL)', () => {
  it('follows the forwarded host, so a custom domain needs no config', () => {
    const r = resolvePublicUrl(
      req({ 'x-forwarded-proto': 'https', 'x-forwarded-host': 'qbo.example.com', host: 'internal:8080' }),
      {} as any
    );
    expect(r.baseUrl).toBe('https://qbo.example.com');
    expect(r.source).toBe('request');
    expect(r.pinnedMismatch).toBe(false);
  });

  it('serves the Railway host and a custom domain from one deployment', () => {
    const env = {} as any;
    expect(resolvePublicUrl(req({ host: 'myapp.up.railway.app' }), env).baseUrl).toBe(
      'https://myapp.up.railway.app'
    );
    expect(resolvePublicUrl(req({ host: 'qbo.example.com' }), env).baseUrl).toBe('https://qbo.example.com');
  });

  it('takes the client-facing hop from an appended proxy chain', () => {
    const r = resolvePublicUrl(
      req({ 'x-forwarded-proto': 'https,http', 'x-forwarded-host': 'qbo.example.com, internal' }),
      {} as any
    );
    expect(r.baseUrl).toBe('https://qbo.example.com');
  });

  it('keeps http for loopback development', () => {
    const r = resolvePublicUrl(req({ host: 'localhost:3456' }, 'http'), {} as any);
    expect(r.baseUrl).toBe('http://localhost:3456');
  });

  it('falls back to RAILWAY_PUBLIC_DOMAIN with no request context', () => {
    const r = resolvePublicUrl(undefined, { RAILWAY_PUBLIC_DOMAIN: 'qbo.example.com' } as any);
    expect(r.baseUrl).toBe('https://qbo.example.com');
    expect(r.source).toBe('RAILWAY_PUBLIC_DOMAIN');
  });

  it('reports nothing resolvable when there is neither a request nor config', () => {
    expect(resolvePublicUrl(undefined, {} as any)).toMatchObject({ baseUrl: null, source: 'none' });
  });
});

describe('resolvePublicUrl — QBO_ALLOWED_HOSTS', () => {
  const env = { QBO_ALLOWED_HOSTS: 'qbo.example.com, myapp.up.railway.app' } as any;

  it('honours a listed host', () => {
    const r = resolvePublicUrl(req({ host: 'qbo.example.com' }), env);
    expect(r.baseUrl).toBe('https://qbo.example.com');
    expect(r.rejectedHost).toBeNull();
  });

  it('refuses a spoofed Host header and falls back to the canonical entry', () => {
    const r = resolvePublicUrl(req({ host: 'evil.example.com' }), env);
    expect(r.baseUrl).toBe('https://qbo.example.com');
    expect(r.rejectedHost).toBe('evil.example.com');
    expect(r.source).toBe('QBO_ALLOWED_HOSTS');
  });

  it('matches wildcard subdomains but not the bare apex', () => {
    const wildcard = { QBO_ALLOWED_HOSTS: '*.example.com' } as any;
    expect(resolvePublicUrl(req({ host: 'qbo.example.com' }), wildcard).rejectedHost).toBeNull();
    expect(resolvePublicUrl(req({ host: 'example.com' }), wildcard).rejectedHost).toBe('example.com');
    // A lookalike suffix must not slip through.
    expect(resolvePublicUrl(req({ host: 'evil-example.com' }), wildcard).rejectedHost).toBe('evil-example.com');
  });

  it('is case-insensitive about hostnames', () => {
    expect(resolvePublicUrl(req({ host: 'QBO.EXAMPLE.com' }), env).rejectedHost).toBeNull();
  });
});

describe('resolvePublicUrl — pinned mode (QBO_PUBLIC_URL)', () => {
  const env = { QBO_PUBLIC_URL: 'https://qbo.example.com/' } as any;

  it('wins over the request host and normalizes the trailing slash', () => {
    const r = resolvePublicUrl(req({ host: 'myapp.up.railway.app' }), env);
    expect(r.baseUrl).toBe('https://qbo.example.com');
    expect(r.source).toBe('QBO_PUBLIC_URL');
  });

  it('flags the mismatch so the dashboard can warn about it', () => {
    expect(resolvePublicUrl(req({ host: 'myapp.up.railway.app' }), env).pinnedMismatch).toBe(true);
    expect(resolvePublicUrl(req({ host: 'qbo.example.com' }), env).pinnedMismatch).toBe(false);
  });
});

describe('publicBaseUrl', () => {
  it('falls back to loopback when nothing else resolves', () => {
    expect(publicBaseUrl(undefined, { PORT: '4000' } as any)).toBe('http://localhost:4000');
  });
});

describe('intuitRedirectUri', () => {
  it('follows the domain in use, so a connection started on a custom domain returns there', () => {
    expect(intuitRedirectUri(req({ host: 'qbo.example.com' }), {} as any)).toBe('https://qbo.example.com/callback');
  });

  it('stays pinned when QBO_REDIRECT_URI is set (legacy deployments)', () => {
    const env = { QBO_REDIRECT_URI: 'https://myapp.up.railway.app/callback' } as any;
    expect(intuitRedirectUri(req({ host: 'qbo.example.com' }), env)).toBe(
      'https://myapp.up.railway.app/callback'
    );
  });

  it('derives the same value on the authorize call and the callback that follows', () => {
    // Intuit requires an exact match between the two; they agree because the
    // callback lands on whichever host the authorize call named.
    const authorizeReq = req({ 'x-forwarded-proto': 'https', 'x-forwarded-host': 'qbo.example.com' });
    const callbackReq = req({ 'x-forwarded-proto': 'https', 'x-forwarded-host': 'qbo.example.com' });
    expect(intuitRedirectUri(authorizeReq, {} as any)).toBe(intuitRedirectUri(callbackReq, {} as any));
  });
});
