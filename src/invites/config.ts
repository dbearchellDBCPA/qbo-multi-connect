import { bareAddress } from '../alerts/config.js';

/**
 * Client-invitation email configuration, parsed from the environment.
 *
 *   RESEND_API_KEY       — the same Resend key the connection alerts use.
 *   QBO_INVITE_FROM      — the sender clients see, on a domain verified in
 *                          Resend, e.g. "Your Firm <hello@yourfirm.com>".
 *                          Deliberately NOT defaulted from QBO_ALERT_FROM:
 *                          mail to clients must be something the firm chose
 *                          to send, from an address it chose, not a side
 *                          effect of having alerts set up.
 *   QBO_INVITE_REPLY_TO  — optional: where a client's reply goes (your real
 *                          inbox), when the sender address isn't monitored.
 *   QBO_FIRM_NAME        — optional: how the firm is named in the email.
 *                          Defaults to the display name in the sender.
 *
 * Invitations stay OFF until there is a key and a usable sender. A partial
 * configuration is reported, not silently ignored, so the dashboard can say
 * exactly what is still needed.
 */
export interface InvitesConfig {
  enabled: boolean;
  resendApiKey: string;
  from: string;
  replyTo: string | null;
  firmName: string;
  /** Variables that must be set before invitations turn on. */
  missing: string[];
  /** Problems with the values that ARE set. */
  problems: string[];
}

const DEFAULT_FIRM_NAME = 'Your accounting firm';

/** `"Your Firm <a@b.com>"` → `Your Firm`; a bare address has no display name. */
function displayName(sender: string): string | null {
  const match = sender.trim().match(/^"?([^"<]+?)"?\s*<[^<>]+>\s*$/);
  return match ? match[1].trim() || null : null;
}

export function parseInvitesConfig(env: NodeJS.ProcessEnv = process.env): InvitesConfig {
  const resendApiKey = env.RESEND_API_KEY?.trim() || '';
  const from = env.QBO_INVITE_FROM?.trim() || '';
  const replyTo = env.QBO_INVITE_REPLY_TO?.trim() || null;

  const missing: string[] = [];
  if (!resendApiKey) missing.push('RESEND_API_KEY');
  if (!from) missing.push('QBO_INVITE_FROM');

  const problems: string[] = [];
  if (from && !bareAddress(from)) {
    problems.push(`QBO_INVITE_FROM is not a valid sender address: ${from}`);
  }
  if (replyTo && !bareAddress(replyTo)) {
    problems.push(`QBO_INVITE_REPLY_TO is not a valid address: ${replyTo}`);
  }

  return {
    enabled: missing.length === 0 && problems.length === 0,
    resendApiKey,
    from,
    replyTo,
    firmName: env.QBO_FIRM_NAME?.trim() || (from ? displayName(from) : null) || DEFAULT_FIRM_NAME,
    missing,
    problems,
  };
}

/** The configuration of a deployment that has not set up invitations. */
export function disabledInvitesConfig(): InvitesConfig {
  return parseInvitesConfig({});
}
