/**
 * Email-alert configuration, parsed from the environment.
 *
 *   RESEND_API_KEY   — a Resend API key ("sending access" is enough).
 *   QBO_ALERT_EMAIL  — who to notify: one address, or several separated by
 *                      commas. "Name <addr@x.com>" is accepted.
 *   QBO_ALERT_FROM   — the sender, on a domain verified in Resend, e.g.
 *                      "QBO Multi-Connect <qbo-alerts@yourfirm.com>".
 *
 * Alerts stay OFF until all three are present and well-formed. A partial
 * configuration is reported rather than silently ignored, so the startup
 * log and the dashboard can say exactly which variable is still needed.
 */
export interface AlertsConfig {
  enabled: boolean;
  resendApiKey: string;
  recipients: string[];
  from: string;
  /** Variables that must be set before alerts turn on. */
  missing: string[];
  /** Problems with the values that ARE set. */
  problems: string[];
}

const ADDRESS_RE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

/** "Name <addr@x.com>" or "addr@x.com" → the bare address, or null if malformed. */
export function bareAddress(value: string): string | null {
  const trimmed = value.trim();
  const angled = trimmed.match(/<([^<>]+)>\s*$/);
  const candidate = (angled ? angled[1] : trimmed).trim();
  return ADDRESS_RE.test(candidate) ? candidate : null;
}

/** Comma/semicolon-separated recipient list; display names survive. */
export function parseRecipients(value: string | undefined): string[] {
  return (value || '')
    .split(/[,;]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function parseAlertsConfig(env: NodeJS.ProcessEnv = process.env): AlertsConfig {
  const resendApiKey = env.RESEND_API_KEY?.trim() || '';
  const recipients = parseRecipients(env.QBO_ALERT_EMAIL);
  const from = env.QBO_ALERT_FROM?.trim() || '';

  const missing: string[] = [];
  if (!resendApiKey) missing.push('RESEND_API_KEY');
  if (recipients.length === 0) missing.push('QBO_ALERT_EMAIL');
  if (!from) missing.push('QBO_ALERT_FROM');

  const problems: string[] = [];
  const badRecipients = recipients.filter((r) => !bareAddress(r));
  if (badRecipients.length > 0) {
    problems.push(`QBO_ALERT_EMAIL contains an invalid address: ${badRecipients.join(', ')}`);
  }
  if (from && !bareAddress(from)) {
    problems.push(`QBO_ALERT_FROM is not a valid sender address: ${from}`);
  }

  return {
    enabled: missing.length === 0 && problems.length === 0,
    resendApiKey,
    recipients,
    from,
    missing,
    problems,
  };
}

/** The configuration of a deployment that has not set up alerts. */
export function disabledAlertsConfig(): AlertsConfig {
  return parseAlertsConfig({});
}
