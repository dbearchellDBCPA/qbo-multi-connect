import { randomUUID } from 'node:crypto';
import type { EmailSender } from '../alerts/email.js';
import type { InvitesConfig } from './config.js';
import { renderClientInvitationEmail } from './templates.js';
import { senderWithFirmName, type FirmBrand } from '../branding.js';

/** Who an invitation is for. */
export interface InviteRecipient {
  name: string;
  email: string;
  username: string;
}

/** What the invitation email has to say — worked out from the request that asked for it. */
export interface InviteContext {
  /** The one-time link to the page where they choose their password. */
  acceptUrl: string;
  expiresAt: Date;
  connectorUrl: string;
  companyNames: string[];
  /** Whose name the invitation goes out in. */
  firm: FirmBrand;
  /** The firm's walkthrough video, when it has one. */
  videoUrl?: string | null;
  /** The full address of the firm's logo, when it has one. */
  logoUrl?: string | null;
  /** The full address of the security page. */
  securityUrl?: string | null;
}

/** What happened when an invitation email was sent. Never contains the link. */
export interface InviteDelivery {
  to: string;
  sent: boolean;
  /** Why it was not sent, when it was attempted and failed. */
  error: string | null;
}

export interface InvitesStatus {
  enabled: boolean;
  provider: 'resend';
  from: string | null;
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
 * Emails a client login its invitation: a link to choose a password, plus
 * the connector address, their username, and how to connect an assistant.
 *
 * Delivery problems are reported in the result rather than thrown, because
 * the caller still has an invitation link either way and can hand it to the
 * admin to pass on by other means.
 */
export class ClientInvites {
  constructor(
    private config: InvitesConfig,
    private sender: EmailSender | null
  ) {}

  /** Whether invitation emails can be sent (a link can be issued either way). */
  get enabled(): boolean {
    return this.config.enabled && this.sender !== null;
  }

  status(): InvitesStatus {
    return {
      enabled: this.enabled,
      provider: 'resend',
      from: this.config.from || null,
      replyTo: this.config.replyTo,
      firmName: this.config.firmName,
      missing: this.config.missing,
      problems: this.config.problems,
    };
  }

  /** Human-readable reason invitation emails can't be sent. */
  whyDisabled(): string {
    const parts: string[] = [];
    if (this.config.missing.length) parts.push(`set ${this.config.missing.join(' and ')}`);
    parts.push(...this.config.problems);
    return `Email invitations are not configured${parts.length ? `: ${parts.join('; ')}` : ''}`;
  }

  /** Send the invitation email. */
  async deliver(recipient: InviteRecipient, context: InviteContext): Promise<InviteDelivery> {
    if (!this.enabled || !this.sender) throw new InvitesNotConfiguredError(this.whyDisabled());

    const delivery: InviteDelivery = { to: recipient.email, sent: false, error: null };
    try {
      const email = renderClientInvitationEmail({
        firmName: context.firm.name,
        name: recipient.name,
        username: recipient.username,
        acceptUrl: context.acceptUrl,
        expiresAt: context.expiresAt,
        connectorUrl: context.connectorUrl,
        companyNames: context.companyNames,
        canReply: this.config.replyTo !== null,
        videoUrl: context.videoUrl ?? null,
        logoUrl: context.logoUrl ?? null,
        securityUrl: context.securityUrl ?? null,
      });
      await this.sender.send({
        from: senderWithFirmName(this.config.from, context.firm),
        to: [recipient.email],
        ...(this.config.replyTo ? { replyTo: this.config.replyTo } : {}),
        ...email,
        // A fresh key per invitation: a transport-level retry can't deliver
        // it twice, while a deliberate re-send always goes out.
        idempotencyKey: `client-invite/${randomUUID()}`,
      });
      delivery.sent = true;
    } catch (error) {
      delivery.error = `The invitation email could not be sent: ${error instanceof Error ? error.message : String(error)}`;
    }
    return delivery;
  }
}
