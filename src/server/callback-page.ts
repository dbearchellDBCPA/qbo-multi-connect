export function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const CHECK_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';
const ALERT_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 8v5"/><path d="M12 16h.01"/></svg>';

export interface CallbackPageOptions {
  variant: 'success' | 'error';
  heading: string;
  message: string;
  company?: string;
  details?: Array<{ label: string; value: string; mono?: boolean }>;
  autoRedirect?: boolean;
}

/**
 * Render a polished OAuth-callback result page (success or error) styled to
 * match the dashboard, with a UTF-8 charset declaration and SVG icons (no
 * emoji, which render as mojibake without an explicit charset). All
 * caller-supplied values are HTML-escaped.
 */
export function renderCallbackPage(opts: CallbackPageOptions): string {
  const isOk = opts.variant === 'success';
  const lead = opts.company
    ? `${escapeHtml(opts.message)} <strong>${escapeHtml(opts.company)}</strong>`
    : escapeHtml(opts.message);
  const details = opts.details?.length
    ? `<div class="details">${opts.details
        .map(
          (d) =>
            `<div class="detail-row"><span class="k">${escapeHtml(d.label)}</span><span class="v${
              d.mono ? ' mono' : ''
            }">${escapeHtml(d.value)}</span></div>`
        )
        .join('')}</div>`
    : '';
  const redirect = opts.autoRedirect
    ? '<p class="note">Taking you back to the dashboard…</p><script>setTimeout(function(){window.location.href="/";},3500);</script>'
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(opts.heading)} — QBO Multi-Connect</title>
<style>
  :root {
    --bg:#f6f7f9; --surface:#fff; --surface-2:#f1f3f5; --border:#e3e6ea;
    --text:#1d2530; --text-secondary:#5b6672; --text-faint:#8a93a0;
    --primary:#2a7d4f; --primary-hover:#236b43;
    --ok:#2a7d4f; --ok-soft:#e6f2ec; --err:#c23b3b; --err-soft:#fbeaea;
    --shadow:0 10px 30px rgba(16,24,40,.12);
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg:#12161c; --surface:#1a2027; --surface-2:#232a33; --border:#2e3742;
      --text:#e8ecf1; --text-secondary:#a7b0bb; --text-faint:#6f7a86;
      --primary:#3fa26c; --primary-hover:#4cb37a;
      --ok:#3fa26c; --ok-soft:#1d3328; --err:#e06c6c; --err-soft:#3a2222;
      --shadow:0 10px 30px rgba(0,0,0,.5);
    }
  }
  * { box-sizing:border-box; margin:0; padding:0; }
  body {
    font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
    background:var(--bg); color:var(--text); min-height:100vh; display:flex;
    align-items:center; justify-content:center; padding:24px; line-height:1.5;
  }
  .card {
    background:var(--surface); border:1px solid var(--border); border-radius:16px;
    box-shadow:var(--shadow); max-width:440px; width:100%; padding:40px 36px; text-align:center;
  }
  .brand { display:inline-flex; align-items:center; gap:8px; margin-bottom:28px; }
  .brand-logo {
    width:32px; height:32px; border-radius:9px; background:var(--primary); color:#fff;
    font-weight:700; font-size:13px; display:inline-flex; align-items:center; justify-content:center;
  }
  .brand-name { font-weight:650; font-size:15px; color:var(--text); }
  .status-icon {
    width:60px; height:60px; border-radius:50%; margin:0 auto 20px;
    display:flex; align-items:center; justify-content:center;
  }
  .status-icon svg { width:30px; height:30px; }
  .status-ok { background:var(--ok-soft); color:var(--ok); }
  .status-err { background:var(--err-soft); color:var(--err); }
  h1 { font-size:20px; margin-bottom:8px; }
  .lead { color:var(--text-secondary); font-size:14.5px; margin-bottom:24px; }
  .lead strong { color:var(--text); }
  .details {
    background:var(--surface-2); border:1px solid var(--border); border-radius:10px;
    padding:14px 16px; text-align:left; margin-bottom:24px; display:grid; gap:9px;
  }
  .detail-row { display:flex; justify-content:space-between; gap:14px; font-size:13px; }
  .detail-row .k { color:var(--text-faint); white-space:nowrap; }
  .detail-row .v { color:var(--text); font-weight:550; text-align:right; word-break:break-all; }
  .detail-row .v.mono { font-family:ui-monospace,Menlo,Consolas,monospace; font-weight:400; font-size:12px; }
  .btn {
    display:inline-block; background:var(--primary); color:#fff; text-decoration:none;
    padding:10px 24px; border-radius:8px; font-size:14px; font-weight:550;
  }
  .btn:hover { background:var(--primary-hover); }
  .btn-ghost { background:transparent; color:var(--text-secondary); border:1px solid var(--border); }
  .note { margin-top:16px; font-size:12.5px; color:var(--text-faint); }
</style>
</head>
<body>
  <div class="card">
    <div class="brand"><span class="brand-logo">QB</span><span class="brand-name">QBO Multi-Connect</span></div>
    <div class="status-icon ${isOk ? 'status-ok' : 'status-err'}">${isOk ? CHECK_ICON : ALERT_ICON}</div>
    <h1>${escapeHtml(opts.heading)}</h1>
    <p class="lead">${lead}</p>
    ${details}
    <a class="btn ${isOk ? '' : 'btn-ghost'}" href="/">Return to dashboard</a>
    ${redirect}
  </div>
</body>
</html>`;
}
