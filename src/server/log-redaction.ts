/**
 * A request URL with its credentials removed, safe to write to the log.
 *
 * Two kinds of secret ride in URLs here: API keys in `?key=` (Claude
 * connectors can't send headers), and an invitation link's token in its
 * path (`/invite/<token>`).
 */
export function redactUrlForLog(url: string): string {
  return url
    .replace(/([?&]key=)[^&]*/gi, '$1[REDACTED]')
    .replace(/^(\/invite\/)[^/?#]+/i, '$1[REDACTED]');
}
