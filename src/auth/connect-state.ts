import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * What a "Connect a client" link carries through Intuit and back.
 *
 * Intuit echoes the `state` parameter to the callback untouched, so it is
 * the only way to know which firm (and which admin) started a connection.
 * It is signed, because the callback is a public URL: an unsigned state
 * would let anyone attach a QuickBooks company to any firm.
 */
export interface ConnectState {
  firmId: number;
  clientName: string;
  /** Who started the connection, for the audit trail. */
  issuedBy?: string | null;
}

const VERSION = 'v1';
/** A connect link is good for an hour — long enough to find the QuickBooks login. */
export const CONNECT_STATE_TTL_MS = 60 * 60 * 1000;

function signingKey(secret: string): Buffer {
  // Derive a purpose-specific key so the token-encryption key is never used directly as a MAC key.
  return createHmac('sha256', 'qbo-multi-connect:connect-state').update(secret).digest();
}

function mac(secret: string, signedPart: string): string {
  return createHmac('sha256', signingKey(secret)).update(signedPart).digest('base64url');
}

export function signConnectState(state: ConnectState, secret: string, now: number = Date.now()): string {
  const payload = Buffer.from(
    JSON.stringify({
      f: state.firmId,
      c: state.clientName,
      u: state.issuedBy ?? null,
      e: now + CONNECT_STATE_TTL_MS,
      n: randomBytes(8).toString('hex'),
    })
  ).toString('base64url');
  const signedPart = `${VERSION}.${payload}`;
  return `${signedPart}.${mac(secret, signedPart)}`;
}

/** The state back from Intuit, or null when missing, malformed, tampered with, or expired. */
export function verifyConnectState(
  state: string | undefined | null,
  secret: string,
  now: number = Date.now()
): ConnectState | null {
  if (typeof state !== 'string') return null;
  const parts = state.split('.');
  if (parts.length !== 3 || parts[0] !== VERSION) return null;
  const [version, payload, presented] = parts;
  const expected = mac(secret, `${version}.${payload}`);
  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  let decoded: { f?: unknown; c?: unknown; u?: unknown; e?: unknown };
  try {
    decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (typeof decoded.f !== 'number' || !Number.isInteger(decoded.f) || decoded.f < 1) return null;
  if (typeof decoded.c !== 'string' || !decoded.c) return null;
  if (typeof decoded.e !== 'number' || decoded.e < now) return null;
  return {
    firmId: decoded.f,
    clientName: decoded.c,
    issuedBy: typeof decoded.u === 'string' ? decoded.u : null,
  };
}
