/**
 * The pages a client sees when they follow an invitation link: choose a
 * password, then how to connect their assistant. Server-rendered and
 * self-contained, like the connector sign-in page — no scripts, no outside
 * resources, so the link in the address bar is never sent anywhere else.
 */
import { BRAND_BASE, BRAND_FONT_FACES, BRAND_MARK, BRAND_TOKENS } from './brand-css.js';
import {
  CHATGPT_NOTE,
  CHATGPT_STEPS,
  CLAUDE_NOTE,
  CLAUDE_STEPS,
  TRY_ASKING,
  companyPhrase,
  escapeHtml,
  rich,
} from '../invites/setup-steps.js';

const STYLES = `
${BRAND_FONT_FACES}
${BRAND_TOKENS}
${BRAND_BASE}
  body { align-items:flex-start; padding:32px 16px; }
  .card {
    background:var(--surface); border:1px solid var(--border); border-radius:16px;
    box-shadow:var(--shadow); max-width:560px; width:100%; padding:36px 32px; margin:0 auto;
  }
  .brand { margin-bottom:22px; }
  h1 { font-size:20px; margin-bottom:8px; }
  h2 { font-size:15px; margin:26px 0 10px; }
  p, li { color:var(--text-secondary); font-size:14px; line-height:1.6; }
  .lead { margin-bottom:22px; }
  .lead strong, li strong { color:var(--text); }
  label { display:block; font-size:13px; font-weight:600; color:var(--text-secondary); margin-bottom:6px; }
  input[type=password], input[type=text] {
    width:100%; padding:10px 12px; border:1px solid var(--border-input); border-radius:8px;
    background:var(--surface-2); color:var(--text); font-size:14px; margin-bottom:16px; font-family:inherit;
  }
  input[readonly] { color:var(--text-secondary); }
  input:focus-visible { outline:none; border-color:transparent; box-shadow:0 0 0 2px var(--primary); }
  button {
    width:100%; background:var(--primary); color:var(--on-primary); border:none; border-radius:8px;
    padding:12px; font-size:14.5px; font-weight:600; cursor:pointer; font-family:inherit; transition:background .15s;
  }
  button:hover { background:var(--primary-hover); }
  .err {
    background:var(--err-soft); border:1px solid var(--err-border); color:var(--err);
    border-radius:8px; padding:10px 12px; font-size:13.5px; font-weight:500; margin-bottom:16px;
  }
  .ok {
    background:var(--ok-soft); border:1px solid var(--primary); color:var(--text);
    border-radius:8px; padding:12px 14px; font-size:14px; margin-bottom:6px;
  }
  .hint { font-size:12.5px; color:var(--text-faint); margin:-8px 0 16px; }
  .note { margin-top:18px; font-size:12.5px; color:var(--text-faint); line-height:1.6; }
  dl { margin:0 0 6px; }
  dt { font-size:12px; font-weight:600; color:var(--text-faint); text-transform:uppercase; letter-spacing:.05em; margin-top:12px; }
  dd {
    margin:4px 0 0; padding:9px 12px; background:var(--surface-2); border:1px solid var(--border);
    border-radius:8px; font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; font-size:13.5px;
    color:var(--text); word-break:break-all; user-select:all;
  }
  ol, ul { padding-left:20px; margin-bottom:12px; }
  li { margin-bottom:6px; }
`;

function page(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="robots" content="noindex, nofollow">
<meta name="referrer" content="no-referrer">
<title>${escapeHtml(title)}</title>
<style>${STYLES}</style>
</head>
<body>
  <div class="card">
    <div class="brand">${BRAND_MARK}<span class="brand-name">QBO Multi-Connect</span></div>
    ${body}
  </div>
</body>
</html>`;
}

export interface AcceptPageDetails {
  firmName: string;
  name: string;
  username: string;
  companyNames: string[];
  minPasswordLength: number;
  /** Shown above the form when a submission was refused. */
  error?: string;
}

/** Step 1: the invited person chooses their password. */
export function acceptInvitePage(details: AcceptPageDetails): string {
  const { firmName, name, username, companyNames, minPasswordLength, error } = details;
  return page(
    'Choose your password',
    `<h1>Welcome, ${escapeHtml(name)}</h1>
    <p class="lead"><strong>${escapeHtml(firmName)}</strong> has invited you to connect your AI assistant to the QuickBooks books for <strong>${escapeHtml(companyPhrase(companyNames))}</strong>. It is read-only: your assistant can look things up and run reports, and cannot change anything. Choose a password to get started.</p>
    ${error ? `<div class="err">${escapeHtml(error)}</div>` : ''}
    <form method="POST">
      <label for="username">Your username</label>
      <input type="text" id="username" name="username" value="${escapeHtml(username)}" autocomplete="username" readonly>
      <label for="password">Choose a password</label>
      <input type="password" id="password" name="password" autocomplete="new-password" minlength="${minPasswordLength}" required autofocus>
      <p class="hint">At least ${minPasswordLength} characters. A few unrelated words make a strong password that is easy to remember. Don't reuse one from somewhere else.</p>
      <label for="confirm">Type it again</label>
      <input type="password" id="confirm" name="confirm" autocomplete="new-password" minlength="${minPasswordLength}" required>
      <button type="submit">Set password and continue</button>
    </form>
    <p class="note">Only you will know this password. You'll type it once, on a sign-in page like this one, when you add the connector to your assistant.</p>`
  );
}

export interface AcceptedPageDetails {
  firmName: string;
  username: string;
  connectorUrl: string;
  signInUrl: string;
}

/** Step 2: the password is set — here is how to connect. */
export function inviteAcceptedPage(details: AcceptedPageDetails): string {
  const { firmName, username, connectorUrl, signInUrl } = details;
  const ol = (steps: string[]) => `<ol>${steps.map((s) => `<li>${rich(s)}</li>`).join('')}</ol>`;
  return page(
    'You are set up',
    `<h1>Your password is set</h1>
    <div class="ok">One step left: add the connector to your AI assistant. You'll sign in there with the username and password below — that is the only place the password is used.</div>
    <dl>
      <dt>Connector address</dt><dd>${escapeHtml(connectorUrl)}</dd>
      <dt>Your username</dt><dd>${escapeHtml(username)}</dd>
      <dt>Your password</dt><dd style="font-family:inherit;user-select:auto">The one you just chose</dd>
    </dl>
    <h2>In Claude</h2>
    ${ol(CLAUDE_STEPS)}
    <p>${escapeHtml(CLAUDE_NOTE)}</p>
    <h2>In ChatGPT</h2>
    ${ol(CHATGPT_STEPS)}
    <p>${escapeHtml(CHATGPT_NOTE)}</p>
    <h2>Then try asking</h2>
    <ul>${TRY_ASKING.map((q) => `<li>${escapeHtml(q)}</li>`).join('')}</ul>
    <p class="note">These steps are also in your invitation email. To change your password later, sign in at ${escapeHtml(signInUrl)} and open Settings. Questions? Contact ${escapeHtml(firmName)}.</p>`
  );
}

/** The link is used, replaced, expired, or was never real. */
export function inviteInvalidPage(firmName: string): string {
  return page(
    'Invitation link no longer valid',
    `<h1>This invitation link can't be used</h1>
    <p class="lead">It may have expired, already been used to set a password, or been replaced by a newer invitation. Check your inbox for a more recent one, or ask <strong>${escapeHtml(firmName)}</strong> to send a new invitation.</p>
    <p class="note">If you have already chosen a password, you don't need this link — add the connector to your assistant and sign in with your email address and that password.</p>`
  );
}
