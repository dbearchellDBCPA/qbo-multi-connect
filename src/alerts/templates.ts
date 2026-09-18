/**
 * The emails the server sends. Plain text is the source of truth (every
 * client renders it); the HTML version is the same content with a little
 * structure. Values from the database are escaped before they reach HTML.
 */
import type { BrokenConnection } from './connection-alerts.js';

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatWhen(date: Date): string {
  return `${date.toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' })} UTC`;
}

function formatDay(date: Date): string {
  return date.toLocaleDateString('en-US', { dateStyle: 'medium', timeZone: 'UTC' });
}

function reasonText(item: BrokenConnection, now: Date): string {
  switch (item.reason) {
    case 'refresh_window_lapsed':
      return `Its 100-day QuickBooks authorization window closed on ${formatDay(item.refreshExpiry)} before it could be renewed.`;
    case 'invalid_grant':
    default:
      return (
        `QuickBooks rejected its stored authorization (Intuit error: invalid_grant) — detected ${formatWhen(now)}. ` +
        'This usually means the app was disconnected from the QuickBooks side, or the authorization was revoked.'
      );
  }
}

const STYLE = {
  body: 'margin:0;padding:24px;background:#f4f4f2;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;color:#1f1f1d;',
  card: 'max-width:600px;margin:0 auto;background:#ffffff;border:1px solid #e3e2dd;border-radius:10px;padding:28px 32px;',
  h1: 'margin:0 0 14px;font-size:20px;font-weight:600;line-height:1.3;',
  p: 'margin:0 0 14px;font-size:14.5px;line-height:1.55;',
  li: 'margin:0 0 10px;font-size:14.5px;line-height:1.55;',
  code: 'font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;background:#f1f0ec;padding:1px 5px;border-radius:4px;',
  button:
    'display:inline-block;padding:10px 18px;border-radius:7px;background:#1f1f1d;color:#ffffff !important;text-decoration:none;font-size:14px;font-weight:600;',
  muted: 'margin:22px 0 0;font-size:12px;line-height:1.5;color:#75736c;',
};

function fixSteps(dashboardUrl: string | null): string[] {
  return [
    dashboardUrl ? `Open the dashboard: ${dashboardUrl}` : 'Open the QBO Multi-Connect dashboard.',
    'Select the client in the left-hand list.',
    'Click Reconnect and approve access in the QuickBooks window that opens.',
  ];
}

export function renderBrokenConnectionsEmail(
  items: BrokenConnection[],
  opts: { dashboardUrl: string | null; now: Date }
): RenderedEmail {
  const { dashboardUrl, now } = opts;
  const count = items.length;
  const subject =
    count === 1
      ? `QuickBooks connection needs reconnecting: ${items[0].clientName}`
      : `${count} QuickBooks connections need reconnecting`;

  const intro =
    count === 1
      ? 'A QuickBooks Online connection stopped working and needs to be re-authorized.'
      : `${count} QuickBooks Online connections stopped working and need to be re-authorized.`;
  const impact =
    'Until it is reconnected, team members will not see this client in Claude and every request to it fails.';
  const steps = fixSteps(dashboardUrl);
  const footer =
    'You get one email per break. A client that is reconnected and later breaks again is reported again. ' +
    'Sent by qbo-multi-connect.';

  const textItems = items
    .map((item) => `• ${item.clientName} (company ID ${item.realmId})\n  ${reasonText(item, now)}`)
    .join('\n\n');
  const text = [
    intro,
    '',
    textItems,
    '',
    count === 1 ? impact : impact.replace('this client', 'these clients').replace('it is reconnected', 'they are reconnected'),
    '',
    'How to fix it:',
    ...steps.map((step, i) => `${i + 1}. ${step}`),
    '',
    footer,
  ].join('\n');

  const htmlItems = items
    .map(
      (item) =>
        `<li style="${STYLE.li}"><strong>${escapeHtml(item.clientName)}</strong> ` +
        `<span style="${STYLE.code}">${escapeHtml(item.realmId)}</span><br>${escapeHtml(reasonText(item, now))}</li>`
    )
    .join('');
  const htmlSteps = steps
    .map((step, i) =>
      i === 0 && dashboardUrl
        ? `<li style="${STYLE.li}">Open the dashboard: <a href="${escapeHtml(dashboardUrl)}">${escapeHtml(dashboardUrl)}</a></li>`
        : `<li style="${STYLE.li}">${escapeHtml(step)}</li>`
    )
    .join('');
  const html = `<!doctype html><html><body style="${STYLE.body}"><div style="${STYLE.card}">
<h1 style="${STYLE.h1}">${escapeHtml(subject)}</h1>
<p style="${STYLE.p}">${escapeHtml(intro)}</p>
<ul style="padding-left:20px;margin:0 0 14px;">${htmlItems}</ul>
<p style="${STYLE.p}">${escapeHtml(count === 1 ? impact : impact.replace('this client', 'these clients').replace('it is reconnected', 'they are reconnected'))}</p>
<p style="${STYLE.p}"><strong>How to fix it</strong></p>
<ol style="padding-left:20px;margin:0 0 18px;">${htmlSteps}</ol>
${dashboardUrl ? `<p style="${STYLE.p}"><a href="${escapeHtml(dashboardUrl)}" style="${STYLE.button}">Open the dashboard</a></p>` : ''}
<p style="${STYLE.muted}">${escapeHtml(footer)}</p>
</div></body></html>`;

  return { subject, text, html };
}

export function renderTestEmail(opts: { dashboardUrl: string | null; recipients: string[]; now: Date }): RenderedEmail {
  const { dashboardUrl, recipients, now } = opts;
  const subject = 'Test: QuickBooks connection alerts are working';
  const where = dashboardUrl ? ` (${dashboardUrl})` : '';
  const lines = [
    `This is a test message from qbo-multi-connect${where}, sent ${formatWhen(now)}.`,
    '',
    `When a QuickBooks Online connection breaks and needs to be reconnected, an alert like this one will be sent to: ${recipients.join(', ')}.`,
    '',
    'Nothing is wrong right now — no action needed.',
  ];
  const text = lines.join('\n');
  const html = `<!doctype html><html><body style="${STYLE.body}"><div style="${STYLE.card}">
<h1 style="${STYLE.h1}">${escapeHtml(subject)}</h1>
<p style="${STYLE.p}">${escapeHtml(lines[0])}</p>
<p style="${STYLE.p}">${escapeHtml(lines[2])}</p>
<p style="${STYLE.p}">${escapeHtml(lines[4])}</p>
${dashboardUrl ? `<p style="${STYLE.p}"><a href="${escapeHtml(dashboardUrl)}" style="${STYLE.button}">Open the dashboard</a></p>` : ''}
</div></body></html>`;
  return { subject, text, html };
}
