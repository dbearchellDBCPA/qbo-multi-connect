/**
 * Requests for access, from the public request page.
 *
 * A firm that wants to offer this to all its clients points them at one
 * page. Each fills in a name, an email address and a business name, and the
 * request waits for an admin. Approving it creates (or extends) a read-only
 * client login and sends the ordinary invitation; declining it does nothing
 * more than close it.
 *
 * What keeps a public form from being a way in:
 *  - It is off until an admin turns it on, and can be turned off again.
 *  - A request grants nothing and sends nothing to the address typed. The
 *    only email it causes goes to the firm's own notice address.
 *  - Access only ever follows an admin's approval, and the invitation goes
 *    to the address on the request — so the requester has to control it.
 *  - The page answers everyone the same way, whether or not the address is
 *    already known, so it can't be used to find out who is a client.
 *  - Submissions are bounded per source, per hour overall, and by the number
 *    waiting, so the queue can't be flooded without limit; notices to the
 *    firm are spaced out so its inbox can't be either.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { ConnectionDatabase } from '../db/index.js';
import type { AccessRequestRecord, AccessRequestStatus } from '../db/models.js';
import type { EmailSender } from '../alerts/email.js';
import { bareAddress, parseRecipients } from '../alerts/config.js';
import { isValidUsername } from '../users.js';
import { renderAccessRequestNotice } from './notice-email.js';

const ENABLED_SETTING = 'access_requests_enabled';
const NOTIFY_SETTING = 'access_requests_notify';

export const MAX_REQUEST_NAME_LENGTH = 80;
export const MAX_REQUEST_COMPANY_LENGTH = 120;
/** How many requests may wait at once. Beyond it the page asks people to get in touch instead. */
export const MAX_PENDING_REQUESTS = 300;
/** New requests accepted per hour, from everyone together. */
export const MAX_REQUESTS_PER_HOUR = 100;
/** Submissions accepted per hour from one network address. */
export const MAX_REQUESTS_PER_SOURCE_PER_HOUR = 20;
/** The shortest gap between two notice emails to the firm. */
export const NOTICE_INTERVAL_MS = 15 * 60_000;
/** A form must be at least this old when it comes back: people take longer than scripts. */
export const FORM_MIN_AGE_MS = 1_000;
/** …and no older than this. */
export const FORM_MAX_AGE_MS = 12 * 60 * 60_000;
export const MAX_NOTIFY_RECIPIENTS = 5;

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;
/** Handled requests are kept this long as a record of who approved what. */
const DECIDED_RETENTION_MS = 365 * DAY_MS;
/** A request nobody acted on is dropped after this long. */
const PENDING_RETENTION_MS = 90 * DAY_MS;
const NOTICE_BATCH = 50;

export type RequestField = 'name' | 'email' | 'company';

/** Something about what was typed needs fixing. The message is for the person filling in the form. */
export class AccessRequestInputError extends Error {
  constructor(
    public field: RequestField,
    message: string
  ) {
    super(message);
    this.name = 'AccessRequestInputError';
  }
}

export interface AccessRequestInput {
  name: string;
  email: string;
  emailKey: string;
  company: string;
}

/**
 * One line of ordinary text: no control characters, runs of space collapsed,
 * and none of the invisible or direction-changing characters that could make
 * what a reviewer reads differ from what is stored.
 */
function oneLine(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, ' ')
    .replace(/[\u00ad\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * A name or business name is shown to an admin and put in an email to the
 * firm, so it must not be able to carry a link or markup.
 */
function looksLikeLinkOrMarkup(value: string): boolean {
  return /[<>]|:\/\/|\bwww\.|https?:/i.test(value);
}

/** Validate and tidy what was typed into the request form. Throws AccessRequestInputError. */
export function cleanRequestInput(raw: { name?: unknown; email?: unknown; company?: unknown }): AccessRequestInput {
  const name = oneLine(raw.name);
  if (name.length < 2) throw new AccessRequestInputError('name', 'Please enter your name.');
  if (name.length > MAX_REQUEST_NAME_LENGTH) throw new AccessRequestInputError('name', `Please keep your name under ${MAX_REQUEST_NAME_LENGTH} characters.`);
  // A person's name has no slash and no "word.word": that shape is a web
  // address, which a mail client would turn into a link in the firm's inbox.
  if (looksLikeLinkOrMarkup(name) || /[@/\\]|\.[a-z]{2,}/i.test(name)) throw new AccessRequestInputError('name', 'Please enter just your name.');

  const email = oneLine(raw.email);
  if (!email) throw new AccessRequestInputError('email', 'Please enter your email address.');
  // The address becomes their username, so it has to be usable as one.
  if (email.length > 254 || bareAddress(email) !== email || !isValidUsername(email.toLowerCase())) {
    throw new AccessRequestInputError('email', 'That email address does not look right. Please check it.');
  }

  const company = oneLine(raw.company);
  if (company.length < 2) throw new AccessRequestInputError('company', 'Please enter the name of your business.');
  if (company.length > MAX_REQUEST_COMPANY_LENGTH) {
    throw new AccessRequestInputError('company', `Please keep the business name under ${MAX_REQUEST_COMPANY_LENGTH} characters.`);
  }
  if (looksLikeLinkOrMarkup(company)) throw new AccessRequestInputError('company', 'Please enter just the name of your business.');

  return { name, email, emailKey: email.toLowerCase(), company };
}

/** A request as the dashboard sees it. */
export interface AccessRequest {
  id: number;
  name: string;
  email: string;
  company: string;
  status: AccessRequestStatus;
  createdAt: string;
  decidedAt: string | null;
  decidedBy: string | null;
  userId: number | null;
  realmId: string | null;
}

function toRequest(row: AccessRequestRecord): AccessRequest {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    company: row.company,
    status: row.status,
    createdAt: row.created_at,
    decidedAt: row.decided_at,
    decidedBy: row.decided_by,
    userId: row.user_id,
    realmId: row.realm_id,
  };
}

/** Where notices go, and whether they can be sent at all. */
export interface NoticeStatus {
  /** Whether a notice email can be sent right now. */
  available: boolean;
  /** Why not, in words for an admin. */
  reason: string | null;
  recipients: string[];
  /** Whether the recipients were set in the dashboard or fall back to the alert recipients. */
  source: 'settings' | 'alerts' | 'none';
  /** What an admin typed in Settings, as stored. */
  setting: string;
  lastError: string | null;
}

export interface AccessRequestsOptions {
  /** The email transport, or null when none is configured. */
  sender: EmailSender | null;
  /** The address notices are sent from, or null when no sender address is configured. */
  from: string | null;
  /** Who gets notices when no address has been set in the dashboard. */
  fallbackRecipients: string[];
  /** Where the dashboard lives, for the link in the notice. */
  dashboardUrl?: () => string | null;
  now?: () => Date;
}

export type FormTokenCheck = 'ok' | 'invalid' | 'early' | 'stale';
export type SubmitOutcome = 'received' | 'busy' | 'closed';

export class AccessRequests {
  /** Recent submission times per network address. In memory: a restart forgets them. */
  private bySource = new Map<string, number[]>();
  /** Signs the timestamp a form carries. Per process: forms open across a restart are simply asked to resubmit. */
  private readonly formSecret = randomBytes(32);
  private lastNoticeAt = 0;
  private noticeTimer: ReturnType<typeof setTimeout> | null = null;
  private sending: Promise<void> | null = null;
  private sendAgain = false;
  private lastNoticeError: string | null = null;
  private readonly now: () => Date;

  constructor(
    private db: ConnectionDatabase,
    private opts: AccessRequestsOptions
  ) {
    this.now = opts.now ?? (() => new Date());
  }

  // ── Settings ─────────────────────────────────────────────────────────────

  /** Whether the public page is accepting requests. Off until an admin turns it on. */
  async isEnabled(): Promise<boolean> {
    return (await this.db.getSetting(ENABLED_SETTING)) === '1';
  }

  async setEnabled(on: boolean): Promise<void> {
    await this.db.setSetting(ENABLED_SETTING, on ? '1' : null);
  }

  /**
   * Set who is told about new requests: one address or a few, separated by
   * commas. Blank falls back to the connection-alert recipients.
   */
  async setNotifyEmail(raw: string | null): Promise<void> {
    const entries = parseRecipients(raw ?? '');
    if (entries.length === 0) {
      await this.db.setSetting(NOTIFY_SETTING, null);
      return;
    }
    if (entries.length > MAX_NOTIFY_RECIPIENTS) throw new Error(`Enter at most ${MAX_NOTIFY_RECIPIENTS} addresses`);
    const addresses = entries.map((entry) => {
      const address = bareAddress(entry);
      if (!address || address !== entry || address.length > 254) throw new Error(`"${entry.slice(0, 80)}" is not a valid email address`);
      return address;
    });
    await this.db.setSetting(NOTIFY_SETTING, [...new Set(addresses)].join(', '));
  }

  async noticeStatus(): Promise<NoticeStatus> {
    const setting = (await this.db.getSetting(NOTIFY_SETTING)) ?? '';
    const chosen = parseRecipients(setting);
    const recipients = chosen.length > 0 ? chosen : this.opts.fallbackRecipients;
    const source = chosen.length > 0 ? 'settings' : recipients.length > 0 ? 'alerts' : 'none';
    const reason = !this.opts.sender
      ? 'Email is not set up on this server (RESEND_API_KEY is not set).'
      : !this.opts.from
        ? 'No sender address is set (QBO_ALERT_FROM or QBO_INVITE_FROM).'
        : recipients.length === 0
          ? 'No address to notify has been set.'
          : null;
    return { available: reason === null, reason, recipients, source, setting, lastError: this.lastNoticeError };
  }

  // ── The form's own guard ─────────────────────────────────────────────────

  /** A signed timestamp for a freshly rendered form. */
  formToken(): string {
    const at = String(this.now().getTime());
    return `${at}.${createHmac('sha256', this.formSecret).update(at).digest('hex')}`;
  }

  /**
   * Whether a form came from this server, and was open for a believable
   * length of time. It stops scripts that post without loading the page, or
   * the instant they do; it is a speed bump, not a lock.
   */
  checkFormToken(token: unknown): FormTokenCheck {
    if (typeof token !== 'string' || token.length > 100) return 'invalid';
    const [at, signature] = token.split('.');
    if (!at || !signature || !/^\d{10,16}$/.test(at)) return 'invalid';
    const expected = createHmac('sha256', this.formSecret).update(at).digest();
    const given = Buffer.from(signature, 'hex');
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return 'invalid';
    const age = this.now().getTime() - Number(at);
    if (age < FORM_MIN_AGE_MS) return 'early';
    if (age > FORM_MAX_AGE_MS) return 'stale';
    return 'ok';
  }

  // ── Submitting ───────────────────────────────────────────────────────────

  /** Count a submission from this source; false when it has had its share for the hour. */
  private allowSource(source: string): boolean {
    const nowMs = this.now().getTime();
    const cutoff = nowMs - HOUR_MS;
    // Keep the map from growing without bound under a spray of addresses.
    if (this.bySource.size > 5_000) {
      for (const [key, times] of this.bySource) {
        if (times[times.length - 1] < cutoff) this.bySource.delete(key);
      }
      if (this.bySource.size > 5_000) this.bySource.clear();
    }
    const recent = (this.bySource.get(source) ?? []).filter((t) => t >= cutoff);
    if (recent.length >= MAX_REQUESTS_PER_SOURCE_PER_HOUR) {
      this.bySource.set(source, recent);
      return false;
    }
    recent.push(nowMs);
    this.bySource.set(source, recent);
    return true;
  }

  /**
   * Record a request. `source` is the network address it came from, used
   * only to bound how many one address can send.
   *
   * Returns 'received' whenever the request is now waiting — including when
   * this person had already asked, so the page can't be used to learn that —
   * 'busy' when a limit was hit, and 'closed' when requests are turned off.
   * Throws AccessRequestInputError when what was typed needs fixing.
   */
  async submit(raw: { name?: unknown; email?: unknown; company?: unknown }, source: string): Promise<SubmitOutcome> {
    if (!(await this.isEnabled())) return 'closed';
    const input = cleanRequestInput(raw);
    if (!this.allowSource(source || 'unknown')) return 'busy';

    // The limits come before the look-up below, so that when the page is
    // full it says so to everyone alike — never "received" to an address
    // that is already waiting and "busy" to one that is not.
    const nowMs = this.now().getTime();
    if ((await this.db.countAccessRequests({ status: 'pending' })) >= MAX_PENDING_REQUESTS) return 'busy';
    if ((await this.db.countAccessRequests({ createdSince: new Date(nowMs - HOUR_MS).toISOString() })) >= MAX_REQUESTS_PER_HOUR) return 'busy';

    // One waiting request per address, and the first one stands. A later
    // submission with the same address is answered the same way but changes
    // nothing: the form is open to anyone, so it must not let a stranger
    // rewrite the name or business a reviewer sees on someone else's request.
    if (await this.db.getPendingAccessRequestByEmail(input.emailKey)) return 'received';

    await this.db.insertAccessRequest({ ...input, at: new Date(nowMs).toISOString() });
    await this.db.purgeAccessRequests(
      new Date(nowMs - DECIDED_RETENTION_MS).toISOString(),
      new Date(nowMs - PENDING_RETENTION_MS).toISOString()
    );
    this.scheduleNotice();
    return 'received';
  }

  // ── Reviewing ────────────────────────────────────────────────────────────

  async pending(): Promise<AccessRequest[]> {
    return (await this.db.listAccessRequests('pending', MAX_PENDING_REQUESTS)).map(toRequest);
  }

  async pendingCount(): Promise<number> {
    return this.db.countAccessRequests({ status: 'pending' });
  }

  /** The most recently handled requests, newest first. */
  async recent(limit = 25): Promise<AccessRequest[]> {
    return (await this.db.listAccessRequests('decided', limit)).map(toRequest);
  }

  async get(id: number): Promise<AccessRequest | null> {
    const row = await this.db.getAccessRequest(id);
    return row ? toRequest(row) : null;
  }

  /**
   * Take a waiting request for approval. Only one caller can: returns the
   * request when this call took it, null when it was not waiting.
   */
  async claim(id: number, by: string): Promise<AccessRequest | null> {
    const took = await this.db.decideAccessRequest(id, 'approved', by, this.now().toISOString());
    return took ? this.get(id) : null;
  }

  /** Put a claimed request back when the approval could not be carried out. */
  async release(id: number): Promise<void> {
    await this.db.reopenAccessRequest(id);
  }

  /** Record what an approved request turned into. */
  async complete(id: number, userId: number, realmId: string): Promise<void> {
    await this.db.completeAccessRequest(id, userId, realmId);
  }

  /** Close a waiting request without giving access. Nothing is sent to the requester. */
  async decline(id: number, by: string): Promise<boolean> {
    return this.db.decideAccessRequest(id, 'declined', by, this.now().toISOString());
  }

  /** Close every waiting request — for clearing out junk. Returns how many. */
  async declineAll(by: string): Promise<number> {
    return this.db.declineAllPendingAccessRequests(by, this.now().toISOString());
  }

  // ── Telling the firm ─────────────────────────────────────────────────────

  /**
   * Arrange for the firm to be told about requests it has not heard about
   * yet: at once if no notice has gone out lately, otherwise when the
   * interval since the last one is up, as one email covering all of them.
   */
  scheduleNotice(): void {
    if (this.sending) {
      this.sendAgain = true;
      return;
    }
    if (this.noticeTimer) return;
    const wait = this.lastNoticeAt + NOTICE_INTERVAL_MS - this.now().getTime();
    if (wait <= 0) {
      this.startSending();
      return;
    }
    this.noticeTimer = setTimeout(() => {
      this.noticeTimer = null;
      this.startSending();
    }, wait);
    this.noticeTimer.unref?.();
  }

  private startSending(): void {
    this.sending = this.sendNotice()
      .catch((error) => {
        this.lastNoticeError = error instanceof Error ? error.message : String(error);
      })
      .finally(() => {
        this.sending = null;
        if (this.sendAgain) {
          this.sendAgain = false;
          this.scheduleNotice();
        }
      });
  }

  /** Resolves when no notice is being sent. For tests and shutdown. */
  async idle(): Promise<void> {
    while (this.sending) await this.sending;
  }

  /** Stop any pending timer. */
  stop(): void {
    if (this.noticeTimer) clearTimeout(this.noticeTimer);
    this.noticeTimer = null;
  }

  private async sendNotice(): Promise<void> {
    const status = await this.noticeStatus();
    if (!status.available) return;
    const rows = await this.db.listUnnotifiedAccessRequests(NOTICE_BATCH);
    if (rows.length === 0) return;

    const email = renderAccessRequestNotice(
      rows.map((row) => ({ name: row.name, email: row.email, company: row.company, createdAt: new Date(row.created_at) })),
      { dashboardUrl: this.opts.dashboardUrl?.() ?? null, waiting: await this.pendingCount() }
    );
    // Whether it works or not, the next attempt waits out the interval: a
    // failing transport must not be retried on every submission.
    this.lastNoticeAt = this.now().getTime();
    try {
      await this.opts.sender!.send({ from: this.opts.from!, to: status.recipients, ...email });
    } catch (error) {
      this.lastNoticeError = `${this.now().toISOString()} — ${error instanceof Error ? error.message : String(error)}`;
      console.error(`[access-requests] Could not send the notice email: ${this.lastNoticeError}`);
      this.sendAgain = true; // try again once the interval is up
      return;
    }
    this.lastNoticeError = null;
    await this.db.markAccessRequestsNotified(rows.map((row) => row.id), this.now().toISOString());
    console.log(`[access-requests] Told ${status.recipients.join(', ')} about ${rows.length} request(s) for access`);
    // More than one batch waiting: carry on after the interval.
    if (rows.length === NOTICE_BATCH) this.sendAgain = true;
  }
}

/** Letters and digits only, lowercased, with company suffixes dropped — for comparing business names. */
function nameKey(value: string): string {
  return value
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\b(llc|inc|incorporated|corp|corporation|co|company|ltd|limited|pllc|pc|llp|lp|the)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The connected company a typed business name most plausibly means, when
 * exactly one fits. A convenience for the reviewer — who still chooses — and
 * never a basis for giving access on its own.
 */
export function suggestCompany<T extends { realmId: string; clientName: string }>(typed: string, companies: T[]): T | null {
  const wanted = nameKey(typed);
  if (wanted.length < 3) return null;
  const exact = companies.filter((c) => nameKey(c.clientName) === wanted);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) return null;
  const partial = companies.filter((c) => {
    const key = nameKey(c.clientName);
    return key.length >= 3 && (key.includes(wanted) || wanted.includes(key));
  });
  return partial.length === 1 ? partial[0] : null;
}
