import type { ConnectionDatabase } from './db/index.js';
import type { InvitesConfig } from './invites/config.js';

/** The software's own name — what is shown when no firm name has been set. */
export const APP_NAME = 'QBO Multi-Connect';

export const MAX_FIRM_NAME_LENGTH = 100;

const FIRM_NAME_SETTING = 'firm_name';

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
 * The From value for mail sent in the firm's name. An address that already
 * carries a display name (`Your Firm <a@b.com>`) is left exactly as the admin
 * wrote it; a bare address gets the firm's name in front, so the client's
 * inbox shows who the message is from rather than just an address.
 */
export function senderWithFirmName(from: string, firm: FirmBrand): string {
  const address = from.trim();
  if (!firm.configured || /<[^<>]+>\s*$/.test(address)) return address;
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
