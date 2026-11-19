import type { ConnectionDatabase } from './db/index.js';
import type { InvitesConfig } from './invites/config.js';

/** The software's own name — what is shown when no firm name has been set. */
export const APP_NAME = 'QBO Multi-Connect';

export const MAX_FIRM_NAME_LENGTH = 100;

const FIRM_NAME_SETTING = 'firm_name';
const SETUP_VIDEO_SETTING = 'setup_video_url';

export const MAX_VIDEO_URL_LENGTH = 500;

/**
 * A walkthrough video the firm recorded for its clients. It is linked from
 * the invitation email and shown on the page a client lands on after
 * choosing their password — embedded when it is a kind we know how to embed
 * safely, linked otherwise.
 */
export interface SetupVideo {
  /** The link as the admin pasted it. */
  url: string;
  /** The player address to put in an iframe, or null when it should only be linked. */
  embedUrl: string | null;
}

/**
 * A video link fit to hand to clients: an https address, nothing else.
 * Throws with a message for the admin when it isn't.
 */
export function cleanVideoUrl(raw: unknown): string {
  if (typeof raw !== 'string') throw new Error('Video link must be text');
  const value = raw.trim();
  const tooLong = new Error(`Video link must be at most ${MAX_VIDEO_URL_LENGTH} characters`);
  if (value.length > MAX_VIDEO_URL_LENGTH) throw tooLong;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Video link must be a full web address, like https://www.loom.com/share/…');
  }
  if (url.protocol !== 'https:') throw new Error('Video link must start with https://');
  if (url.username || url.password) throw new Error('Video link cannot contain a username or password');
  // The normalised link is what is stored and sent, so it is what must fit.
  if (url.href.length > MAX_VIDEO_URL_LENGTH) throw tooLong;
  return url.href;
}

/**
 * The embeddable player address for a video link, or null. Only Loom is
 * embedded: a share link (`/share/<id>`) or an embed link (`/embed/<id>`)
 * becomes `https://www.loom.com/embed/<id>`. Anything else is shown as a
 * link — a page that sets passwords does not frame arbitrary sites.
 */
export function videoEmbedUrl(videoUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(videoUrl);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || !/^(www\.)?loom\.com$/i.test(url.hostname)) return null;
  const match = url.pathname.match(/^\/(?:share|embed)\/([A-Za-z0-9]{8,64})\/?$/);
  return match ? `https://www.loom.com/embed/${match[1]}` : null;
}

/**
 * Who clients are dealing with. The app is the tool; the firm is the one
 * giving a client access to their books, so everything a client sees — the
 * invitation email, the page where they choose a password, the sign-in page —
 * is in the firm's name once one is set.
 */
export interface FirmBrand {
  /** The firm's name, or a neutral phrase ("Your accounting firm") when none is set. */
  name: string;
  /** Whether a real name has been set anywhere. */
  configured: boolean;
  /** Where the name came from, most specific first. */
  source: 'dashboard' | 'environment' | 'sender' | 'default';
  /** What to put where a brand goes: the firm's name, or the app's when there isn't one. */
  displayName: string;
}

/**
 * A firm name fit to appear in an email subject and a From header: trimmed,
 * single-line, bounded. Throws with a message for the admin when it isn't.
 */
export function cleanFirmName(raw: unknown): string {
  if (typeof raw !== 'string') throw new Error('Firm name must be text');
  const name = raw.replace(/\s+/g, ' ').trim();
  if (!name) throw new Error('Firm name cannot be empty');
  if (name.length > MAX_FIRM_NAME_LENGTH) throw new Error(`Firm name must be at most ${MAX_FIRM_NAME_LENGTH} characters`);
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f<>]/.test(name)) throw new Error('Firm name cannot contain < > or control characters');
  return name;
}

/**
 * The From value for mail sent in the firm's name, so the client's inbox
 * shows who the message is from.
 *
 * - A bare address gets the firm's name in front.
 * - A sender that already carries a display name (`Your Firm <a@b.com>`) is
 *   left as the admin wrote it — unless the firm's name was set in the
 *   dashboard. That is the later, deliberate choice of "what clients see",
 *   so it replaces the display name and the inbox agrees with the subject.
 */
export function senderWithFirmName(from: string, firm: FirmBrand): string {
  const sender = from.trim();
  if (!firm.configured) return sender;
  const named = sender.match(/^(.*)<([^<>]+)>\s*$/);
  const address = named ? named[2].trim() : sender;
  const ownName = named ? named[1].trim().replace(/^"+|"+$/g, '').trim() : '';
  // Already says the right thing, or was written alongside the name itself.
  if (ownName && (ownName === firm.name || firm.source !== 'dashboard')) return sender;
  return `"${firm.name.replace(/["\\]/g, '')}" <${address}>`;
}

export class Branding {
  constructor(
    private db: ConnectionDatabase,
    private invitesConfig: InvitesConfig
  ) {}

  /**
   * The firm's name: what an admin set in the dashboard, else QBO_FIRM_NAME,
   * else the display name of the invitation sender, else a neutral phrase.
   */
  async firm(): Promise<FirmBrand> {
    const stored = (await this.db.getSetting(FIRM_NAME_SETTING))?.trim();
    if (stored) return { name: stored, configured: true, source: 'dashboard', displayName: stored };
    const { firmName, firmNameSource } = this.invitesConfig;
    const configured = firmNameSource !== 'default';
    return { name: firmName, configured, source: firmNameSource, displayName: configured ? firmName : APP_NAME };
  }

  /** The firm's setup walkthrough video, if one has been set. */
  async setupVideo(): Promise<SetupVideo | null> {
    const url = (await this.db.getSetting(SETUP_VIDEO_SETTING))?.trim();
    return url ? { url, embedUrl: videoEmbedUrl(url) } : null;
  }

  /** Set the setup video link, or clear it (null / blank). */
  async setSetupVideoUrl(raw: string | null): Promise<SetupVideo | null> {
    if (raw == null || (typeof raw === 'string' && !raw.trim())) {
      await this.db.setSetting(SETUP_VIDEO_SETTING, null);
    } else {
      await this.db.setSetting(SETUP_VIDEO_SETTING, cleanVideoUrl(raw));
    }
    return this.setupVideo();
  }

  /** Set the firm's name from the dashboard, or clear it (null / blank) to fall back. */
  async setFirmName(raw: string | null): Promise<FirmBrand> {
    if (raw == null || (typeof raw === 'string' && !raw.trim())) {
      await this.db.setSetting(FIRM_NAME_SETTING, null);
    } else {
      await this.db.setSetting(FIRM_NAME_SETTING, cleanFirmName(raw));
    }
    return this.firm();
  }
}
