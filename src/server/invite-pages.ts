/**
 * The pages a client sees when they follow an invitation link: choose a
 * password, then how to connect their assistant. Server-rendered, no
 * scripts, and no referrer is ever sent.
 *
 * The page with the password form loads nothing from anywhere else — the
 * link in its address bar is still a live credential. The page after it,
 * shown once that link has been used up, may embed the firm's walkthrough
 * video.
 */
import { BRAND_BASE, BRAND_FONT_FACES, BRAND_TOKENS, brandLine } from './brand-css.js';
import { APP_NAME, type FirmBrand, type SetupVideo } from '../branding.js';
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
  input[type=password], input[type=text], input[type=email] {
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
  .powered { max-width:560px; margin:14px auto 0; text-align:center; font-size:11.5px; color:var(--text-faint); }
  .video {
    position:relative; height:0; padding-bottom:56.25%; margin:4px 0 8px;
    border:1px solid var(--border); border-radius:10px; overflow:hidden; background:var(--surface-2);
  }
  .video iframe { position:absolute; top:0; left:0; width:100%; height:100%; border:0; }
  .watch {
    display:inline-block; margin:4px 0 8px; padding:10px 16px; border-radius:8px; background:var(--primary);
    color:var(--on-primary); font-size:14px; font-weight:600; text-decoration:none;
  }
  a { color:var(--primary); }
  /* A field people never see; anything typed in it marks an automated submission. */
  .extra { position:absolute; left:-9999px; top:auto; width:1px; height:1px; overflow:hidden; }
`;

/**
 * The firm's walkthrough video: its player when it is a kind we embed, a
 * plain link otherwise — and always a link as well, for when the player is
 * blocked. The frame is sandboxed and is sent no referrer.
 */
function videoSection(video: SetupVideo | null | undefined): string {
  if (!video) return '';
  const link = `<a href="${escapeHtml(video.url)}" target="_blank" rel="noopener noreferrer">`;
  if (!video.embedUrl) {
    return `<h2>Watch how to connect</h2>
    <p>${link.replace('<a ', '<a class="watch" ')}Watch the walkthrough video</a></p>`;
  }
  return `<h2>Watch how to connect</h2>
    <div class="video"><iframe src="${escapeHtml(video.embedUrl)}" title="How to connect your AI assistant" loading="lazy" allowfullscreen referrerpolicy="no-referrer" sandbox="allow-scripts allow-same-origin allow-presentation allow-popups"></iframe></div>
    <p class="hint" style="margin:0 0 4px">Video not showing? ${link}Open it in a new tab</a>.</p>`;
}

/**
 * The page shell. The firm's name is the brand — it is the firm, not the
 * software, giving this person access — with the app credited in small print
 * underneath. Until a firm name has been set, the app's own name stands in.
 */
export function clientPage(title: string, body: string, firm: FirmBrand): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="robots" content="noindex, nofollow">
<meta name="referrer" content="no-referrer">
<title>${escapeHtml(title)} — ${escapeHtml(firm.displayName)}</title>
<style>${STYLES}</style>
</head>
<body>
  <div>
    <div class="card">
      <div class="brand">${brandLine(firm)}</div>
      ${body}
    </div>
    ${firm.configured ? `<p class="powered">Secure access from ${escapeHtml(firm.name)}, provided through ${APP_NAME}.</p>` : ''}
  </div>
</body>
</html>`;
}

export interface AcceptPageDetails {
  firm: FirmBrand;
  name: string;
  username: string;
  companyNames: string[];
  minPasswordLength: number;
  /** Shown above the form when a submission was refused. */
  error?: string;
}

/** Step 1: the invited person chooses their password. */
export function acceptInvitePage(details: AcceptPageDetails): string {
  const { firm, name, username, companyNames, minPasswordLength, error } = details;
  const firmName = firm.name;
  return clientPage(
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
    <p class="note">Only you will know this password. You'll type it once, on a sign-in page like this one, when you add the connector to your assistant.</p>`,
    firm
  );
}

export interface AcceptedPageDetails {
  firm: FirmBrand;
  username: string;
  connectorUrl: string;
  signInUrl: string;
  /** The firm's walkthrough video, when it has recorded one. */
  video?: SetupVideo | null;
}

/** Step 2: the password is set — here is how to connect. */
export function inviteAcceptedPage(details: AcceptedPageDetails): string {
  const { firm, username, connectorUrl, signInUrl, video } = details;
  const firmName = firm.name;
  const ol = (steps: string[]) => `<ol>${steps.map((s) => `<li>${rich(s)}</li>`).join('')}</ol>`;
  return clientPage(
    'You are set up',
    `<h1>Your password is set</h1>
    <div class="ok">One step left: add the connector to your AI assistant. You'll sign in there with the username and password below — that is the only place the password is used.</div>
    <dl>
      <dt>Connector address</dt><dd>${escapeHtml(connectorUrl)}</dd>
      <dt>Your username</dt><dd>${escapeHtml(username)}</dd>
      <dt>Your password</dt><dd style="font-family:inherit;user-select:auto">The one you just chose</dd>
    </dl>
    ${videoSection(video)}
    <h2>In Claude</h2>
    ${ol(CLAUDE_STEPS)}
    <p>${escapeHtml(CLAUDE_NOTE)}</p>
    <h2>In ChatGPT</h2>
    ${ol(CHATGPT_STEPS)}
    <p>${escapeHtml(CHATGPT_NOTE)}</p>
    <h2>Then try asking</h2>
    <ul>${TRY_ASKING.map((q) => `<li>${escapeHtml(q)}</li>`).join('')}</ul>
    <p class="note">These steps are also in your invitation email. To change your password later, sign in at ${escapeHtml(signInUrl)} and open Settings. Questions? Contact ${escapeHtml(firmName)}.</p>`,
    firm
  );
}

/** The link is used, replaced, expired, or was never real. */
export function inviteInvalidPage(firm: FirmBrand): string {
  const firmName = firm.name;
  return clientPage(
    'Invitation link no longer valid',
    `<h1>This invitation link can't be used</h1>
    <p class="lead">It may have expired, already been used to set a password, or been replaced by a newer invitation. Check your inbox for a more recent one, or ask <strong>${escapeHtml(firmName)}</strong> to send a new invitation.</p>
    <p class="note">If you have already chosen a password, you don't need this link — add the connector to your assistant and sign in with your email address and that password.</p>`,
    firm
  );
}
