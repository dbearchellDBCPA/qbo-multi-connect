/**
 * Redaction of credentials that Intuit embeds in URLs.
 *
 * An Attachable's TempDownloadUri is a bearer URL: its query string carries
 * Intuit's `intuit_apikey` and a `user-auth-info` blob (older S3-hosted
 * URIs carry X-Amz-Credential / X-Amz-Signature instead). Anyone holding the
 * string can fetch the file, and tool output ends up in chat transcripts and
 * logs — so tool output never carries those values unless the caller asked
 * for the live URL explicitly (get_attachments include_download_url=true).
 * The server itself downloads with the raw URL it got from QBO, so
 * include_content keeps working.
 */

export const REDACTED = 'REDACTED';

/** Query-param names whose values are credentials (case-insensitive). */
const SENSITIVE_PARAM =
  /^(intuit_apikey|user-auth-info|user_auth_info|x-amz-credential|x-amz-signature|x-amz-security-token|awsaccesskeyid|signature|sig|key|code)$|token|apikey|api[-_]?key|secret|password|passwd|credential|auth/i;

export function isSensitiveParam(name: string): boolean {
  return SENSITIVE_PARAM.test(name);
}

/**
 * Replace the value of every sensitive query param with REDACTED. The rest
 * of the URL (host, path, realmId, …) is kept so the output stays useful
 * for identifying the file. Non-URLs are returned unchanged.
 */
export function redactUrl(raw: string): string {
  const leading = raw.match(/^\s*/)?.[0] ?? '';
  const trimmed = raw.slice(leading.length);
  const q = trimmed.indexOf('?');
  if (q < 0 || !/^https?:\/\//i.test(trimmed)) return raw;
  const hashAt = trimmed.indexOf('#', q);
  const base = trimmed.slice(0, q);
  const query = trimmed.slice(q + 1, hashAt >= 0 ? hashAt : undefined);
  const hash = hashAt >= 0 ? trimmed.slice(hashAt) : '';
  let changed = false;
  const parts = query.split('&').map((pair) => {
    const eq = pair.indexOf('=');
    const rawName = eq >= 0 ? pair.slice(0, eq) : pair;
    let name = rawName;
    try {
      name = decodeURIComponent(rawName.replace(/\+/g, ' '));
    } catch {
      /* keep raw name */
    }
    if (eq >= 0 && isSensitiveParam(name) && pair.slice(eq + 1) !== REDACTED) {
      changed = true;
      return `${rawName}=${REDACTED}`;
    }
    return pair;
  });
  return changed ? `${leading}${base}?${parts.join('&')}${hash}` : raw;
}

const URL_IN_TEXT = /https?:\/\/[^\s"'<>`\\]+/gi;

/** Redact every URL found in free text (JSON included). */
export function redactUrlsInText(text: string): string {
  if (!text || text.indexOf('?') < 0) return text;
  return text.replace(URL_IN_TEXT, (u) => redactUrl(u));
}

/**
 * Apply redactUrlsInText to every text block of an MCP tool result.
 * Returns the same object shape; non-text blocks are left alone.
 */
export function redactToolResult<T>(result: T): T {
  const content = (result as any)?.content;
  if (!Array.isArray(content)) return result;
  let changed = false;
  const next = content.map((block: any) => {
    if (block?.type === 'text' && typeof block.text === 'string') {
      const text = redactUrlsInText(block.text);
      if (text !== block.text) {
        changed = true;
        return { ...block, text };
      }
    }
    return block;
  });
  return changed ? ({ ...(result as any), content: next } as T) : result;
}

/**
 * Results that deliberately carry a live download URL (the caller passed
 * include_download_url=true) are registered here so the blanket redaction
 * in the tool shim leaves them alone. A WeakSet so nothing is retained.
 */
const unredacted = new WeakSet<object>();

export function allowSensitiveUrls<T extends object>(result: T): T {
  unredacted.add(result);
  return result;
}

export function isSensitiveUrlAllowed(result: unknown): boolean {
  return typeof result === 'object' && result !== null && unredacted.has(result);
}
