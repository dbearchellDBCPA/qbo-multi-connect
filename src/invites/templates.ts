/**
 * The invitation email a new client login receives.
 *
 * It carries no password. It carries a link — single-use, expiring — to a
 * page on this server where the person chooses their own. Until they do, the
 * link is the only credential in the message; once they have, nothing in it
 * grants access any more. The rest is what they will need afterwards: the
 * connector address, their username, and how to connect an assistant.
 *
 * Plain text is the source of truth (every client renders it); the HTML is
 * the same content with structure. Everything from the database or the
 * environment is escaped before it reaches HTML.
 */
import type { RenderedEmail } from '../alerts/templates.js';
import {
  CHATGPT_NOTE,
  CHATGPT_STEPS,
  CLAUDE_NOTE,
  CLAUDE_STEPS,
  GOOD_TO_KNOW,
  TRY_ASKING,
  companyPhrase,
  escapeHtml,
  plain,
  rich,
} from './setup-steps.js';

export interface InvitationDetails {
  firmName: string;
  /** The person the login belongs to. */
  name: string;
  /** What they sign in with — normally their email address. */
  username: string;
  /** The one-time link to the page where they choose their password. */
  acceptUrl: string;
  /** When that link stops working. */
  expiresAt: Date;
  /** The MCP endpoint they paste into their assistant. */
  connectorUrl: string;
  /** The QuickBooks companies the login can read (normally one). */
  companyNames: string[];
  /** Whether replying to the email reaches someone. */
  canReply: boolean;
}

// These strings are dropped into style="…" attributes: no double quotes inside.
const STYLE = {
  body: 'margin:0;padding:24px;background:#f0f4f8;font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Helvetica,Arial,sans-serif;color:#102a43;',
  card: 'max-width:600px;margin:0 auto;background:#ffffff;border:1px solid #d9e2ec;border-radius:10px;padding:28px 32px;',
  h1: 'margin:0 0 14px;font-size:20px;font-weight:600;line-height:1.3;color:#102a43;',
  h2: 'margin:26px 0 10px;font-size:15px;font-weight:600;line-height:1.3;color:#102a43;',
  p: 'margin:0 0 14px;font-size:14.5px;line-height:1.55;color:#243b53;',
  li: 'margin:0 0 8px;font-size:14.5px;line-height:1.55;color:#243b53;',
  list: 'padding-left:20px;margin:0 0 14px;',
  table: 'border-collapse:collapse;margin:0 0 16px;width:100%;',
  th: 'text-align:left;vertical-align:top;padding:6px 14px 6px 0;font-size:13px;font-weight:600;color:#486581;white-space:nowrap;',
  td: 'padding:6px 0;font-size:14.5px;color:#102a43;word-break:break-all;',
  code: 'font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:13.5px;background:#f0f4f8;padding:2px 6px;border-radius:4px;color:#0e6f68;',
  button:
    'display:inline-block;padding:12px 22px;border-radius:8px;background:#117c75;color:#ffffff !important;text-decoration:none;font-size:15px;font-weight:600;',
  small: 'margin:0 0 14px;font-size:12.5px;line-height:1.5;color:#627d98;word-break:break-all;',
  muted: 'margin:22px 0 0;font-size:12px;line-height:1.5;color:#627d98;',
};

function formatDay(date: Date): string {
  return date.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' });
}

export function renderClientInvitationEmail(details: InvitationDetails): RenderedEmail {
  const { firmName, name, username, acceptUrl, expiresAt, connectorUrl, companyNames, canReply } = details;
  const company = companyPhrase(companyNames);
  const subject = `${firmName} invited you to connect your AI assistant to QuickBooks`;
  const intro =
    `${firmName} has set up a secure, read-only connection so your AI assistant can answer questions ` +
    `straight from the QuickBooks Online books for ${company}. Ask in plain English — "Who owes me money?" — ` +
    `and it pulls the answer from your books.`;
  const stepOne = 'Accept the invitation and choose your password. Nobody else will know it — not even us.';
  const linkNote = `This link is for you alone, works once, and expires on ${formatDay(expiresAt)}. If it has expired, ask us for a new one.`;
  const stepTwoIntro = 'Once your password is set, add the connector to your assistant. The page you land on shows these same steps.';
  const contact = canReply ? 'Questions? Just reply to this email.' : `Questions? Contact ${firmName}.`;
  const unexpected = `If you were not expecting this, ignore it — nothing happens unless the link is used — and let ${firmName} know.`;

  const numbered = (steps: string[]) => steps.map((step, i) => `${i + 1}. ${plain(step)}`);
  const text = [
    `Hello ${name},`,
    '',
    intro,
    '',
    'STEP 1 — ACCEPT AND CHOOSE YOUR PASSWORD',
    stepOne,
    acceptUrl,
    linkNote,
    '',
    'STEP 2 — CONNECT YOUR ASSISTANT',
    stepTwoIntro,
    `Connector address: ${connectorUrl}`,
    `Your username: ${username}`,
    '',
    'In Claude',
    ...numbered(CLAUDE_STEPS),
    CLAUDE_NOTE,
    '',
    'In ChatGPT',
    ...numbered(CHATGPT_STEPS),
    CHATGPT_NOTE,
    '',
    'TRY ASKING',
    ...TRY_ASKING.map((q) => `- ${q}`),
    '',
    'GOOD TO KNOW',
    ...GOOD_TO_KNOW.map((line) => `- ${line}`),
    '',
    contact,
    unexpected,
  ].join('\n');

  const ol = (steps: string[]) =>
    `<ol style="${STYLE.list}">${steps.map((s) => `<li style="${STYLE.li}">${rich(s)}</li>`).join('')}</ol>`;
  const ul = (items: string[]) =>
    `<ul style="${STYLE.list}">${items.map((s) => `<li style="${STYLE.li}">${escapeHtml(s)}</li>`).join('')}</ul>`;
  const html = `<!doctype html><html><body style="${STYLE.body}"><div style="${STYLE.card}">
<h1 style="${STYLE.h1}">Connect your AI assistant to your QuickBooks data</h1>
<p style="${STYLE.p}">Hello ${escapeHtml(name)},</p>
<p style="${STYLE.p}">${escapeHtml(intro)}</p>
<h2 style="${STYLE.h2}">Step 1 — Accept and choose your password</h2>
<p style="${STYLE.p}">${escapeHtml(stepOne)}</p>
<p style="${STYLE.p}"><a href="${escapeHtml(acceptUrl)}" style="${STYLE.button}">Accept invitation</a></p>
<p style="${STYLE.small}">Or paste this into your browser: ${escapeHtml(acceptUrl)}</p>
<p style="${STYLE.p}">${escapeHtml(linkNote)}</p>
<h2 style="${STYLE.h2}">Step 2 — Connect your assistant</h2>
<p style="${STYLE.p}">${escapeHtml(stepTwoIntro)}</p>
<table style="${STYLE.table}">
<tr><th style="${STYLE.th}">Connector address</th><td style="${STYLE.td}"><span style="${STYLE.code}">${escapeHtml(connectorUrl)}</span></td></tr>
<tr><th style="${STYLE.th}">Your username</th><td style="${STYLE.td}"><span style="${STYLE.code}">${escapeHtml(username)}</span></td></tr>
</table>
<p style="${STYLE.p}"><strong>In Claude</strong></p>
${ol(CLAUDE_STEPS)}
<p style="${STYLE.p}">${escapeHtml(CLAUDE_NOTE)}</p>
<p style="${STYLE.p}"><strong>In ChatGPT</strong></p>
${ol(CHATGPT_STEPS)}
<p style="${STYLE.p}">${escapeHtml(CHATGPT_NOTE)}</p>
<h2 style="${STYLE.h2}">Try asking</h2>
${ul(TRY_ASKING)}
<h2 style="${STYLE.h2}">Good to know</h2>
${ul(GOOD_TO_KNOW)}
<p style="${STYLE.muted}">${escapeHtml(contact)} ${escapeHtml(unexpected)} Sent by ${escapeHtml(firmName)}.</p>
</div></body></html>`;

  return { subject, text, html };
}
