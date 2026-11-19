/**
 * What a client is asked to read and accept before their AI assistant is
 * connected to their books. Kept short on purpose: four things that are
 * actually theirs to manage, in plain words. The fuller explanation lives on
 * the public /security page.
 *
 * Bump CLIENT_TERMS_VERSION when the meaning changes; a client login that
 * accepted an older version is asked again the next time it signs in.
 */
export const CLIENT_TERMS_VERSION = '1';

/** Where the fuller explanation is served. */
export const SECURITY_PAGE_PATH = '/security';

export interface TermsPoint {
  title: string;
  text: string;
}

export const CLIENT_TERMS_POINTS: TermsPoint[] = [
  {
    title: 'Your AI provider sees what you ask and what comes back.',
    text: 'Your questions, and the answers from your books, pass through the AI service you choose under your own agreement with it. On free and some personal plans, conversations may be used to train its AI unless you switch that off. Check your privacy settings before you connect.',
  },
  {
    title: 'Your assistant can read the whole QuickBooks file.',
    text: 'That includes payroll, owner transactions and notes. Connect only an AI account that is yours alone, on a device you trust.',
  },
  {
    title: 'AI can be wrong.',
    text: 'It can misread a report or get the arithmetic wrong. Check with us before relying on a number for a loan, an investor or a tax filing.',
  },
  {
    title: 'Your login is yours alone.',
    text: 'Do not share it. Tell us straight away if a device is lost or someone who had access leaves, and we will switch it off.',
  },
];

/** The sentence beside the checkbox. */
export const CLIENT_TERMS_CONSENT =
  'I have read these points and understand that I am responsible for how I use my AI assistant with my data.';

/** Whether a form came back with the box ticked. */
export function agreed(value: unknown): boolean {
  return value === 'on' || value === 'yes' || value === 'true' || value === '1';
}

/** Whether this login still has to accept the current points before connecting. Only client logins are asked. */
export function needsAcknowledgment(user: { accountType: string; acknowledgedVersion: string | null }): boolean {
  return user.accountType === 'client' && user.acknowledgedVersion !== CLIENT_TERMS_VERSION;
}
