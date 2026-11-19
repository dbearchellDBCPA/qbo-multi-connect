import { randomUUID } from 'node:crypto';
import type { EmailSender } from '../alerts/email.js';
import type { InvitesConfig } from './config.js';
import { renderClientInvitationEmail, renderClientPasswordEmail } from './templates.js';

/** Who an invitation is for. */
export interface InviteRecipient {
  name: string;
  email: string;
  username: string;
}

/** Where the login is used — worked out from the request that asked for the invite. */
export interface InviteContext {
  connectorUrl: string;
  signInUrl: string;
  companyNames: string[];
}

/** What happened when an invitation was sent. Never contains the password. */
export interface InviteOutcome {
  to: string;
  /** True only when BOTH emails were accepted for delivery. */
  sent: boolean;
  invitationSent: boolean;
  passwordSent: boolean;
  /** Why it stopped, when it did. */
  error: string | null;
}

export interface InvitesStatus {
  enabled: boolean;
  provider: 'resend';
  from: string | null;
  usingAlertSender: boolean;
  replyTo: string | null;
  firmName: string;
  missing: string[];
  problems: string[];
}

export class InvitesNotConfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvitesNotConfiguredError';
  }
}

/**
 * Sends a new client login its two emails: the invitation (address,
 * username, setup steps) and, separately, the password.
 *
 * Delivery problems are reported in the outcome rather than thrown, because
 * the caller has state to settle either way — a login that now exists, or a
 * password that must not be changed unless the client actually received the
 * new one.
 */
export class ClientInvites {
  constructor(
    private config: InvitesConfig,
    private sender: EmailSender | null
  ) {}

  get enabled(): boolean {
    return this.config.enabled && this.sender !== null;
  }

  status(): InvitesStatus {
    return {
      enabled: this.enabled,
      provider: 'resend',
      from: this.config.from || null,
      usingAlertSender: this.config.usingAlertSender,
      replyTo: this.config.replyTo,
      firmName: this.config.firmName,
      missing: this.config.missing,
      problems: this.config.problems,
    };
  }

  /** Human-readable reason invitations can't be sent, for an error message. */
  whyDisabled(): string {
    const parts: string[] = [];
    if (this.config.missing.length) parts.push(`set ${this.config.missing.join(' and ')}`);
    parts.push(...this.config.problems);
    return `Email invitations are not configured${parts.length ? `: ${parts.join('; ')}` : ''}`;
  }

  /**
   * Send the invitation, then the password. The password only goes out once
   * the invitation has been accepted for delivery: a password with no
   * instructions is no use to the client, and stopping there keeps a failed
   * attempt from leaving a live credential in someone's inbox for nothing.
   */
  async deliver(recipient: InviteRecipient, password: string, context: InviteContext): Promise<InviteOutcome> {
    if (!this.enabled || !this.sender) throw new InvitesNotConfiguredError(this.whyDisabled());

    const outcome: InviteOutcome = {
      to: recipient.email,
      sent: false,
      invitationSent: false,
      passwordSent: false,
      error: null,
    };
    const common = {
      from: this.config.from,
      to: [recipient.email],
      ...(this.config.replyTo ? { replyTo: this.config.replyTo } : {}),
    };
    const canReply = this.config.replyTo !== null;
    // One id per invitation, so a transport-level retry of either message
    // can't deliver it twice, while a deliberate re-send always goes out.
    const attempt = randomUUID();

    try {
      const invitation = renderClientInvitationEmail({
        firmName: this.config.firmName,
        name: recipient.name,
        username: recipient.username,
        connectorUrl: context.connectorUrl,
        signInUrl: context.signInUrl,
        companyNames: context.companyNames,
        canReply,
      });
      await this.sender.send({ ...common, ...invitation, idempotencyKey: `client-invite/${attempt}/invitation` });
      outcome.invitationSent = true;
    } catch (error) {
      outcome.error = `The invitation email could not be sent: ${error instanceof Error ? error.message : String(error)}`;
      return outcome;
    }

    try {
      const secret = renderClientPasswordEmail({
        firmName: this.config.firmName,
        name: recipient.name,
        password,
        canReply,
      });
      await this.sender.send({ ...common, ...secret, idempotencyKey: `client-invite/${attempt}/password` });
      outcome.passwordSent = true;
    } catch (error) {
      outcome.error = `The invitation was sent, but the password email could not be: ${error instanceof Error ? error.message : String(error)}`;
      return outcome;
    }

    outcome.sent = true;
    return outcome;
  }
}
