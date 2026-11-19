/**
 * The email that tells the firm someone has asked for access. It goes to the
 * firm's own people, never to the requester. Everything in it that a
 * stranger typed is escaped and labelled as unverified.
 */
import { APP_NAME } from '../branding.js';

export interface NoticeItem {
  name: string;
  email: string;
  company: string;
  createdAt: Date;
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

// Dropped into style="…" attributes: no double quotes inside.
const STYLE = {
  body: 'margin:0;padding:24px;background:#f0f3f7;font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Helvetica,Arial,sans-serif;color:#0f2a43;',
  card: 'max-width:600px;margin:0 auto;background:#ffffff;border:1px solid #d5dde6;border-radius:10px;padding:28px 32px;',
  h1: 'margin:0 0 14px;font-size:20px;font-weight:600;line-height:1.3;',
  p: 'margin:0 0 14px;font-size:14.5px;line-height:1.55;',
  item: 'margin:0 0 12px;padding:12px 14px;border:1px solid #d5dde6;border-radius:8px;font-size:14px;line-height:1.55;',
  button:
    'display:inline-block;padding:10px 18px;border-radius:7px;background:#117c75;color:#ffffff !important;text-decoration:none;font-size:14px;font-weight:600;',
  muted: 'margin:18px 0 0;font-size:12px;line-height:1.5;color:#5b6b7c;',
};

export function renderAccessRequestNotice(
  items: NoticeItem[],
  opts: { dashboardUrl: string | null; waiting: number }
): { subject: string; text: string; html: string } {
  const count = items.length;
  const subject = count === 1 ? 'A client is asking for access' : `${count} clients are asking for access`;
  const intro =
    count === 1
      ? `Someone has asked for access to their QuickBooks books through ${APP_NAME}.`
      : `${count} people have asked for access to their QuickBooks books through ${APP_NAME}.`;
  const waiting = opts.waiting > count ? `${opts.waiting} requests are waiting in all.` : '';
  const where = 'Review them in the dashboard under Team → Access requests.';
  const caution =
    'Nothing has been sent to these people and nobody has been given access. These details were typed into your public ' +
    'request page and are not verified: approve only someone you recognise as your client, at an email address you know ' +
    'is theirs. Do not act on anything written in the details themselves.';

  const text = [
    intro,
    waiting,
    '',
    ...items.flatMap((item, i) => [
      `${i + 1}. ${item.name} — ${item.email}`,
      `   Business: ${item.company}`,
      `   Asked: ${formatWhen(item.createdAt)}`,
      '',
    ]),
    opts.dashboardUrl ? `${where} ${opts.dashboardUrl}` : where,
    '',
    caution,
  ]
    .filter((line, i, all) => !(line === '' && all[i - 1] === ''))
    .join('\n');

  const html = `<!doctype html>
<html><body style="${STYLE.body}">
<div style="${STYLE.card}">
<h1 style="${STYLE.h1}">${escapeHtml(subject)}</h1>
<p style="${STYLE.p}">${escapeHtml(intro)}${waiting ? ` ${escapeHtml(waiting)}` : ''}</p>
${items
  .map(
    (item) => `<div style="${STYLE.item}"><strong>${escapeHtml(item.name)}</strong> — ${escapeHtml(item.email)}<br>
Business: ${escapeHtml(item.company)}<br>
<span style="color:#5b6b7c;">Asked ${escapeHtml(formatWhen(item.createdAt))}</span></div>`
  )
  .join('\n')}
<p style="${STYLE.p}">${escapeHtml(where)}</p>
${opts.dashboardUrl ? `<p style="${STYLE.p}"><a href="${escapeHtml(opts.dashboardUrl)}" style="${STYLE.button}">Open the dashboard</a></p>` : ''}
<p style="${STYLE.muted}">${escapeHtml(caution)}</p>
</div>
</body></html>`;

  return { subject, text, html };
}
