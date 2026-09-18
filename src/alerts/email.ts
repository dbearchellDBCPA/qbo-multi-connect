/**
 * Outbound email transport. The only implementation talks to Resend's REST
 * API directly (one POST, no SDK) — Node's built-in fetch is all it needs.
 * The interface exists so tests, and any future provider, can swap it.
 */
export interface OutboundEmail {
  from: string;
  to: string[];
  subject: string;
  text: string;
  html?: string;
  /**
   * Resend honours an Idempotency-Key for 24 hours: retrying the same
   * logical send (same key) can't deliver the message twice.
   */
  idempotencyKey?: string;
}

export interface EmailSender {
  send(email: OutboundEmail): Promise<{ id: string }>;
}

export class EmailSendError extends Error {
  constructor(
    message: string,
    public statusCode?: number,
    public body?: string
  ) {
    super(message);
    this.name = 'EmailSendError';
  }
}

export const RESEND_EMAILS_ENDPOINT = 'https://api.resend.com/emails';
const SEND_TIMEOUT_MS = 15_000;

export class ResendEmailSender implements EmailSender {
  constructor(
    private apiKey: string,
    private endpoint: string = RESEND_EMAILS_ENDPOINT
  ) {}

  async send(email: OutboundEmail): Promise<{ id: string }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(this.endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
          ...(email.idempotencyKey ? { 'Idempotency-Key': email.idempotencyKey } : {}),
        },
        body: JSON.stringify({
          from: email.from,
          to: email.to,
          subject: email.subject,
          text: email.text,
          ...(email.html ? { html: email.html } : {}),
        }),
        signal: controller.signal,
      });
    } catch (err: any) {
      if (err?.name === 'AbortError') {
        throw new EmailSendError(`Resend request timed out after ${SEND_TIMEOUT_MS}ms`);
      }
      throw new EmailSendError(`Resend request failed: ${err?.message ?? err}`);
    } finally {
      clearTimeout(timer);
    }

    const bodyText = await response.text();
    if (!response.ok) {
      let detail = bodyText;
      try {
        const parsed = JSON.parse(bodyText);
        detail = parsed.message || parsed.error || bodyText;
      } catch {
        /* not JSON — keep the raw body */
      }
      throw new EmailSendError(`Resend rejected the email (${response.status}): ${detail}`, response.status, bodyText);
    }

    try {
      const parsed = JSON.parse(bodyText);
      return { id: String(parsed.id ?? '') };
    } catch {
      return { id: '' };
    }
  }
}
