/**
 * The two emails a new client login receives. They are deliberately split:
 *
 *   1. The invitation — connector address, username, and how to set it up.
 *      No password.
 *   2. The password — and nothing that says where to use it. No address, no
 *      username.
 *
 * So neither message is enough to sign in by itself if it is forwarded,
 * screenshotted, or read over a shoulder. Plain text is the source of truth
 * (every client renders it); the HTML is the same content with structure.
 * Everything from the database or the environment is escaped before it
 * reaches HTML.
 */
import type { RenderedEmail } from '../alerts/templates.js';

export interface InvitationDetails {
  firmName: string;
  /** The person the login belongs to. */
  name: string;
  username: string;
  /** The MCP endpoint they paste into their assistant. */
  connectorUrl: string;
  /** The dashboard address, where they can change their password. */
  signInUrl: string;
  /** The QuickBooks companies the login can read (normally one). */
  companyNames: string[];
  /** Whether replying to the email reaches someone. */
  canReply: boolean;
}

export interface PasswordDetails {
  firmName: string;
  name: string;
  password: string;
  canReply: boolean;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// These strings are dropped into style="…" attributes: no double quotes inside.
const STYLE = {
  body: 'margin:0;padding:24px;background:#f0f4f8;font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Helvetica,Arial,sans-serif;color:#102a43;',
  card: 'max-width:600px;margin:0 auto;background:#ffffff;border:1px solid #d9e2ec;border-radius:10px;padding:28px 32px;',
  h1: 'margin:0 0 14px;font-size:20px;font-weight:600;line-height:1.3;color:#102a43;',
  h2: 'margin:24px 0 10px;font-size:15px;font-weight:600;line-height:1.3;color:#102a43;',
  p: 'margin:0 0 14px;font-size:14.5px;line-height:1.55;color:#243b53;',
  li: 'margin:0 0 8px;font-size:14.5px;line-height:1.55;color:#243b53;',
  list: 'padding-left:20px;margin:0 0 14px;',
  table: 'border-collapse:collapse;margin:0 0 16px;width:100%;',
  th: 'text-align:left;vertical-align:top;padding:6px 14px 6px 0;font-size:13px;font-weight:600;color:#486581;white-space:nowrap;',
  td: 'padding:6px 0;font-size:14.5px;color:#102a43;word-break:break-all;',
  code: 'font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:13.5px;background:#f0f4f8;padding:2px 6px;border-radius:4px;color:#0e6f68;',
  secret:
    'margin:0 0 16px;padding:16px 18px;background:#f0f4f8;border:1px solid #bcccdc;border-radius:8px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:20px;letter-spacing:0.5px;color:#102a43;text-align:center;',
  muted: 'margin:22px 0 0;font-size:12px;line-height:1.5;color:#627d98;',
};

function companyPhrase(companyNames: string[]): string {
  if (companyNames.length === 0) return 'your QuickBooks Online company';
  if (companyNames.length === 1) return companyNames[0];
  return `${companyNames.slice(0, -1).join(', ')} and ${companyNames[companyNames.length - 1]}`;
}

function contactLine(firmName: string, canReply: boolean): string {
  return canReply ? `Questions? Just reply to this email.` : `Questions? Contact ${firmName}.`;
}

// Setup steps, per assistant. Each step is plain text; **double asterisks**
// mark the menu names and buttons to look for, rendered bold in HTML.
const CLAUDE_STEPS = [
  'Sign in at claude.ai on a computer and open **Customize → Connectors**.',
  'Click **+ Add**, then **Add custom connector**.',
  'Give it a name you will recognize, paste the connector address above, and click **Continue**.',
  'Keep the suggested sign-in settings and click **Add**. If you are asked which OAuth client to use, choose **Register automatically**.',
  'A **Sign in to connect** page opens. Enter your username and the password from the other email.',
  'In a new chat, click **+** by the message box, choose **Connectors**, and switch this one on.',
];
const CLAUDE_NOTE =
  'Works on any Claude plan (free accounts can add one custom connector). On a Claude Team or Enterprise plan, a workspace Owner adds it once under Organization settings → Connectors; you then click Connect and sign in.';

const CHATGPT_STEPS = [
  'Sign in at chatgpt.com on a computer and open **Plugins**.',
  'Select the **+** button, then **Add custom MCP server**.',
  'Give it a name. Under **Connection**, paste the connector address above.',
  'For authentication choose **OAuth**. Review the warning, tick **I understand and want to continue**, and select **Create as a plugin**.',
  'When the sign-in page opens, enter your username and the password from the other email.',
  'Install the new plugin from your plugins list, then turn it on in a chat.',
];
const CHATGPT_NOTE =
  'Custom connections in ChatGPT depend on your plan: they are offered on ChatGPT Business and Enterprise/Edu, on the web, and on Business a workspace admin or owner has to add it. Menu names change from time to time — if yours look different, tell us and we will walk you through it.';

const TRY_ASKING = [
  'What QuickBooks company am I connected to?',
  'Show me my profit and loss for last month next to the same month last year.',
  'Who owes me money right now, and which invoices are more than 60 days overdue?',
  'What bills are due in the next two weeks?',
];

const GOOD_TO_KNOW = [
  'It is read-only. Your assistant can look things up and run reports; it cannot create, change, or delete anything in QuickBooks.',
  'Recent months can change until we finish closing them. If a decision depends on a number, ask us whether that period is closed.',
  'Your login is yours alone. If someone else at your company needs access, ask us for a separate one.',
  'A login can see everything in the file, including payroll and owner transactions.',
];

// Changing a password signs out anything connected with the old one — worth
// saying, since the password email asks them to change it.
const CHANGE_PASSWORD_NOTE =
  'It is easiest to do this before you connect your assistant: changing it later signs the assistant out, and you connect again with the new password.';

/** `**bold**` markers → plain text for the text part. */
function plain(text: string): string {
  return text.replace(/\*\*(.+?)\*\*/g, '$1');
}

/** Escape, then turn `**bold**` markers into <strong>. */
function rich(text: string): string {
  return escapeHtml(text).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
}

export function renderClientInvitationEmail(details: InvitationDetails): RenderedEmail {
  const { firmName, name, username, connectorUrl, signInUrl, companyNames, canReply } = details;
  const company = companyPhrase(companyNames);
  const subject = `Connect your AI assistant to your QuickBooks data — ${firmName}`;
  const intro =
    `${firmName} has set up a secure, read-only connection so your AI assistant can answer questions ` +
    `straight from the QuickBooks Online books for ${company}. Ask in plain English — "Who owes me money?" — ` +
    `and it pulls the answer from your books.`;
  const passwordNote = 'Your password is arriving in a separate email.';
  const changePassword = `To change your password, sign in at ${signInUrl} with the same username and password, open Settings, and choose Change password. ${CHANGE_PASSWORD_NOTE}`;
  const contact = contactLine(firmName, canReply);

  const numbered = (steps: string[]) => steps.map((step, i) => `${i + 1}. ${plain(step)}`);
  const text = [
    `Hello ${name},`,
    '',
    intro,
    '',
    'WHAT YOU NEED',
    `Connector address: ${connectorUrl}`,
    `Username: ${username}`,
    `Password: ${passwordNote}`,
    '',
    'SET IT UP IN CLAUDE',
    ...numbered(CLAUDE_STEPS),
    CLAUDE_NOTE,
    '',
    'SET IT UP IN CHATGPT',
    ...numbered(CHATGPT_STEPS),
    CHATGPT_NOTE,
    '',
    'TRY ASKING',
    ...TRY_ASKING.map((q) => `- ${q}`),
    '',
    'GOOD TO KNOW',
    ...GOOD_TO_KNOW.map((line) => `- ${line}`),
    '',
    changePassword,
    '',
    contact,
  ].join('\n');

  const ol = (steps: string[]) =>
    `<ol style="${STYLE.list}">${steps.map((s) => `<li style="${STYLE.li}">${rich(s)}</li>`).join('')}</ol>`;
  const ul = (items: string[]) =>
    `<ul style="${STYLE.list}">${items.map((s) => `<li style="${STYLE.li}">${escapeHtml(s)}</li>`).join('')}</ul>`;
  const html = `<!doctype html><html><body style="${STYLE.body}"><div style="${STYLE.card}">
<h1 style="${STYLE.h1}">Connect your AI assistant to your QuickBooks data</h1>
<p style="${STYLE.p}">Hello ${escapeHtml(name)},</p>
<p style="${STYLE.p}">${escapeHtml(intro)}</p>
<h2 style="${STYLE.h2}">What you need</h2>
<table style="${STYLE.table}">
<tr><th style="${STYLE.th}">Connector address</th><td style="${STYLE.td}"><span style="${STYLE.code}">${escapeHtml(connectorUrl)}</span></td></tr>
<tr><th style="${STYLE.th}">Username</th><td style="${STYLE.td}"><span style="${STYLE.code}">${escapeHtml(username)}</span></td></tr>
<tr><th style="${STYLE.th}">Password</th><td style="${STYLE.td}">${escapeHtml(passwordNote)}</td></tr>
</table>
<h2 style="${STYLE.h2}">Set it up in Claude</h2>
${ol(CLAUDE_STEPS)}
<p style="${STYLE.p}">${escapeHtml(CLAUDE_NOTE)}</p>
<h2 style="${STYLE.h2}">Set it up in ChatGPT</h2>
${ol(CHATGPT_STEPS)}
<p style="${STYLE.p}">${escapeHtml(CHATGPT_NOTE)}</p>
<h2 style="${STYLE.h2}">Try asking</h2>
${ul(TRY_ASKING)}
<h2 style="${STYLE.h2}">Good to know</h2>
${ul(GOOD_TO_KNOW)}
<p style="${STYLE.p}">To change your password, sign in at <a href="${escapeHtml(signInUrl)}" style="color:#117c75;">${escapeHtml(signInUrl)}</a> with the same username and password, open Settings, and choose Change password. ${escapeHtml(CHANGE_PASSWORD_NOTE)}</p>
<p style="${STYLE.muted}">${escapeHtml(contact)} Sent by ${escapeHtml(firmName)}.</p>
</div></body></html>`;

  return { subject, text, html };
}

export function renderClientPasswordEmail(details: PasswordDetails): RenderedEmail {
  const { firmName, name, password, canReply } = details;
  const subject = `Your password for the QuickBooks connector — ${firmName}`;
  const intro = `Here is the password for the QuickBooks connector ${firmName} set up for you. Your username and the setup steps are in a separate email.`;
  const howTo = 'Copy it exactly as shown, including the hyphens.';
  const advice = [
    'Change it to one of your own — the other email says how, and when is easiest.',
    'Do not forward this email. We will never ask you for this password.',
    `If you were not expecting this, delete it and let ${firmName} know.`,
  ];
  const contact = contactLine(firmName, canReply);

  const text = [
    `Hello ${name},`,
    '',
    intro,
    '',
    `    ${password}`,
    '',
    howTo,
    '',
    ...advice.map((line) => `- ${line}`),
    '',
    contact,
  ].join('\n');

  const html = `<!doctype html><html><body style="${STYLE.body}"><div style="${STYLE.card}">
<h1 style="${STYLE.h1}">Your password for the QuickBooks connector</h1>
<p style="${STYLE.p}">Hello ${escapeHtml(name)},</p>
<p style="${STYLE.p}">${escapeHtml(intro)}</p>
<p style="${STYLE.secret}">${escapeHtml(password)}</p>
<p style="${STYLE.p}">${escapeHtml(howTo)}</p>
<ul style="${STYLE.list}">${advice.map((line) => `<li style="${STYLE.li}">${escapeHtml(line)}</li>`).join('')}</ul>
<p style="${STYLE.muted}">${escapeHtml(contact)} Sent by ${escapeHtml(firmName)}.</p>
</div></body></html>`;

  return { subject, text, html };
}
