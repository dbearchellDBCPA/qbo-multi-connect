import { createHash } from 'node:crypto';
import type { ConnectionDatabase } from '../db/index.js';
import type { AlertsConfig } from './config.js';
import type { EmailSender } from './email.js';
import { renderBrokenConnectionsEmail, renderTestEmail } from './templates.js';

export type BrokenReason = 'invalid_grant' | 'refresh_window_lapsed';

/** What the refresh daemon reports about a connection that needs re-authorization. */
export interface BrokenConnection {
  clientName: string;
  realmId: string;
  /** The refresh window in force when it broke — identifies this particular break. */
  refreshExpiry: Date;
  reason: BrokenReason;
}

export interface BrokenConnectionNotifier {
  notifyBroken(items: BrokenConnection[]): Promise<void>;
}

export interface AlertsStatus {
  enabled: boolean;
  provider: 'resend';
  recipients: string[];
  from: string | null;
  missing: string[];
  problems: string[];
  /** Where alert emails link to, or null when the server can't tell its own address. */
  dashboardUrl: string | null;
  lastAlert: { clientName: string; realmId: string; sentAt: string; recipients: string } | null;
  lastError: string | null;
}

// After a failed send, wait this long before trying again so a provider
// outage doesn't turn every daemon tick into another failing request.
const RETRY_BACKOFF_MS = 15 * 60 * 1000;

/**
 * Emails the operator when a QuickBooks connection breaks and needs to be
 * reconnected from the dashboard.
 *
 * The refresh daemon calls notifyBroken() on every tick with everything it
 * currently knows to be broken; this class decides what is NEW. Each break
 * is keyed by the connection's refresh_expiry at the time (a reconnect
 * mints a new one), and a key is recorded only after the provider accepted
 * the email — so a restart never re-sends, and a failed send is retried.
 * Several breaks in one tick go out as a single email.
 */
export class ConnectionAlerts implements BrokenConnectionNotifier {
  private retryAfter = 0;
  private lastError: string | null = null;

  constructor(
    private db: ConnectionDatabase,
    private config: AlertsConfig,
    private sender: EmailSender | null,
    private dashboardUrl: () => string | null = () => null,
    private now: () => Date = () => new Date()
  ) {}

  get enabled(): boolean {
    return this.config.enabled && this.sender !== null;
  }

  get recipients(): string[] {
    return this.config.recipients;
  }

  async status(): Promise<AlertsStatus> {
    const last = await this.db.getLatestConnectionAlert();
    return {
      enabled: this.enabled,
      provider: 'resend',
      recipients: this.config.recipients,
      from: this.config.from || null,
      missing: this.config.missing,
      problems: this.config.problems,
      dashboardUrl: this.dashboardUrl(),
      lastAlert: last
        ? {
            clientName: last.client_name,
            realmId: last.realm_id,
            sentAt: sqliteTimestampToIso(last.sent_at),
            recipients: last.recipients,
          }
        : null,
      lastError: this.lastError,
    };
  }

  async notifyBroken(items: BrokenConnection[]): Promise<void> {
    if (!this.enabled || items.length === 0) return;

    const fresh: BrokenConnection[] = [];
    for (const item of items) {
      if (!(await this.db.hasConnectionAlert(item.realmId, 'broken', dedupeKey(item)))) {
        fresh.push(item);
      }
    }
    if (fresh.length === 0) return;
    if (Date.now() < this.retryAfter) return;

    const now = this.now();
    const email = renderBrokenConnectionsEmail(fresh, { dashboardUrl: this.dashboardUrl(), now });
    // Same set of breaks → same key, so a retry after a lost response can't
    // deliver the message twice.
    const idempotencyKey = createHash('sha256')
      .update(fresh.map((item) => `${item.realmId}@${dedupeKey(item)}`).sort().join('|'))
      .digest('hex');

    let providerId: string | null = null;
    try {
      const result = await this.sender!.send({
        from: this.config.from,
        to: this.config.recipients,
        subject: email.subject,
        text: email.text,
        html: email.html,
        idempotencyKey,
      });
      providerId = result.id || null;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.lastError = `${now.toISOString()} — ${message}`;
      this.retryAfter = Date.now() + RETRY_BACKOFF_MS;
      console.error(
        `[alerts] Could not send the broken-connection email (will retry in ${RETRY_BACKOFF_MS / 60000} min): ${message}`
      );
      return;
    }

    this.lastError = null;
    for (const item of fresh) {
      await this.db.insertConnectionAlert({
        realmId: item.realmId,
        clientName: item.clientName,
        kind: 'broken',
        dedupeKey: dedupeKey(item),
        recipients: this.config.recipients,
        providerId,
      });
    }
    console.log(
      `[alerts] Emailed ${this.config.recipients.join(', ')}: ${fresh.length} connection(s) need reconnecting — ${fresh
        .map((item) => item.clientName)
        .join(', ')}`
    );
  }

  /** Send a "this works" email to the configured recipients. */
  async sendTest(): Promise<{ id: string; recipients: string[] }> {
    if (!this.enabled) {
      const why =
        this.config.problems[0] ??
        (this.config.missing.length > 0 ? `${this.config.missing.join(', ')} not set` : 'no email transport');
      throw new AlertsNotConfiguredError(`Email alerts are not configured: ${why}`);
    }
    const email = renderTestEmail({
      dashboardUrl: this.dashboardUrl(),
      recipients: this.config.recipients,
      now: this.now(),
    });
    const result = await this.sender!.send({
      from: this.config.from,
      to: this.config.recipients,
      subject: email.subject,
      text: email.text,
      html: email.html,
    });
    // A working test proves the transport: drop any backoff from an earlier failure.
    this.lastError = null;
    this.retryAfter = 0;
    return { id: result.id, recipients: this.config.recipients };
  }
}

export class AlertsNotConfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AlertsNotConfiguredError';
  }
}

function dedupeKey(item: BrokenConnection): string {
  return item.refreshExpiry.toISOString();
}

/** SQLite's CURRENT_TIMESTAMP is "YYYY-MM-DD HH:MM:SS" in UTC with no zone marker. */
function sqliteTimestampToIso(value: string): string {
  const parsed = new Date(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value) ? `${value.replace(' ', 'T')}Z` : value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString();
}
