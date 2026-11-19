import { createHash } from 'node:crypto';
import type { ConnectionDatabase } from './db/index.js';
import type { InvitesConfig } from './invites/config.js';

/** The software's own name — what is shown when no firm name has been set. */
export const APP_NAME = 'QBO Multi-Connect';

export const MAX_FIRM_NAME_LENGTH = 100;

const FIRM_NAME_SETTING = 'firm_name';
const SETUP_VIDEO_SETTING = 'setup_video_url';
const LOGO_SETTING = 'firm_logo';

/** Where the firm's logo is served from. Public: it appears on pages and in emails. */
export const LOGO_PATH = '/brand/logo';
export const MAX_LOGO_BYTES = 256 * 1024;
/** Wider than this (width ÷ height) and a logo is a wordmark that already spells the name. */
const WIDE_LOGO_RATIO = 2.2;

/** The image formats a logo may be, each recognised by how its bytes begin — never by what the upload claims. */
const LOGO_FORMATS: Array<{ type: string; matches: (bytes: Buffer) => boolean }> = [
  { type: 'image/png', matches: (b) => b.length > 24 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { type: 'image/jpeg', matches: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { type: 'image/gif', matches: (b) => b.length > 10 && ['GIF87a', 'GIF89a'].includes(b.subarray(0, 6).toString('latin1')) },
  { type: 'image/webp', matches: (b) => b.length > 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP' },
];

/** The firm's logo as stored. */
export interface FirmLogo {
  type: string;
  bytes: Buffer;
  /** Changes whenever the image does, so browsers and mail clients fetch the new one. */
  version: string;
  /** A wordmark: shown on its own rather than beside the firm's name. */
  wide: boolean;
}

/**
 * Check an uploaded logo: a data: URL holding a PNG, JPEG, GIF or WebP of a
 * sensible size. SVG is refused — it can carry script. Throws with a message
 * for the admin.
 */
export function parseLogoUpload(dataUrl: unknown): { type: string; bytes: Buffer } {
  if (typeof dataUrl !== 'string') throw new Error('Choose an image file for the logo');
  const match = dataUrl.match(/^data:([a-z0-9.+/-]+);base64,([A-Za-z0-9+/=\s]+)$/i);
  if (!match) throw new Error('The logo must be an image file (PNG, JPEG, GIF or WebP)');
  const bytes = Buffer.from(match[2], 'base64');
  if (bytes.length === 0) throw new Error('That image file is empty');
  if (bytes.length > MAX_LOGO_BYTES) throw new Error(`The logo must be ${MAX_LOGO_BYTES / 1024} KB or smaller — save a smaller version and try again`);
  const format = LOGO_FORMATS.find((f) => f.matches(bytes));
  if (!format) throw new Error('The logo must be a PNG, JPEG, GIF or WebP image. (Save an SVG as PNG first.)');
  return { type: format.type, bytes };
}

/** The pixel size of a PNG or GIF, read from its header; null for other formats. */
function imageSize(type: string, bytes: Buffer): { width: number; height: number } | null {
  if (type === 'image/png') return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  if (type === 'image/gif') return { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) };
  return null;
}

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
  /** The firm's logo, when one has been uploaded: its address on this server, and whether it is a wordmark. */
  logo?: { path: string; wide: boolean } | null;
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
    const image = await this.logo();
    const logo = image ? { path: `${LOGO_PATH}?v=${image.version}`, wide: image.wide } : null;
    const stored = (await this.db.getSetting(FIRM_NAME_SETTING))?.trim();
    if (stored) return { name: stored, configured: true, source: 'dashboard', displayName: stored, logo };
    const { firmName, firmNameSource } = this.invitesConfig;
    const configured = firmNameSource !== 'default';
    return { name: firmName, configured, source: firmNameSource, displayName: configured ? firmName : APP_NAME, logo };
  }

  /** The firm's logo, if one has been uploaded. */
  async logo(): Promise<FirmLogo | null> {
    const raw = await this.db.getSetting(LOGO_SETTING);
    if (!raw) return null;
    try {
      const stored = JSON.parse(raw) as { type: string; data: string; version: string; wide: boolean };
      const bytes = Buffer.from(stored.data, 'base64');
      // Re-checked on the way out: only ever serve what is recognisably one of the allowed image formats.
      if (!LOGO_FORMATS.some((f) => f.type === stored.type && f.matches(bytes))) return null;
      return { type: stored.type, bytes, version: String(stored.version), wide: Boolean(stored.wide) };
    } catch {
      return null;
    }
  }

  /**
   * Store an uploaded logo (a data: URL). `size` is the image's pixel size as
   * the browser measured it, used only to tell a wordmark from a square mark.
   */
  async setLogo(dataUrl: unknown, size?: { width?: unknown; height?: unknown }): Promise<FirmLogo> {
    const { type, bytes } = parseLogoUpload(dataUrl);
    const measured = imageSize(type, bytes);
    const width = measured?.width ?? Number(size?.width);
    const height = measured?.height ?? Number(size?.height);
    const wide = Number.isFinite(width) && Number.isFinite(height) && height > 0 && width / height >= WIDE_LOGO_RATIO;
    const version = createHash('sha256').update(bytes).digest('hex').slice(0, 12);
    await this.db.setSetting(LOGO_SETTING, JSON.stringify({ type, data: bytes.toString('base64'), version, wide }));
    return { type, bytes, version, wide };
  }

  async removeLogo(): Promise<void> {
    await this.db.setSetting(LOGO_SETTING, null);
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
