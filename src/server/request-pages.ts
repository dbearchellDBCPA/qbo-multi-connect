/**
 * The public page where a firm's client asks for access, and what they see
 * afterwards. Same shell as the invitation pages: the firm's name, no
 * scripts, nothing loaded from anywhere else.
 */
import type { FirmBrand } from '../branding.js';
import type { RequestField } from '../access-requests/service.js';
import { MAX_REQUEST_COMPANY_LENGTH, MAX_REQUEST_NAME_LENGTH } from '../access-requests/service.js';
import { clientPage } from './invite-pages.js';
import { escapeHtml } from '../invites/setup-steps.js';
import { SECURITY_PAGE_PATH } from '../client-terms.js';

export interface RequestFormDetails {
  firm: FirmBrand;
  /** The signed timestamp the form carries back. */
  token: string;
  /** What they typed, when the form is shown again. */
  values?: { name?: string; email?: string; company?: string };
  error?: { field?: RequestField; message: string };
}

/** The form: who are you, and which business. */
export function requestAccessPage(details: RequestFormDetails): string {
  const { firm, token, values = {}, error } = details;
  const value = (v: string | undefined) => escapeHtml(v ?? '');
  const focus = (field: RequestField) => ((error?.field ?? 'name') === field ? ' autofocus' : '');
  return clientPage(
    'Request access',
    `<h1>Ask your AI assistant about your books</h1>
    <p class="lead"><strong>${escapeHtml(firm.name)}</strong> can give your AI assistant — Claude or ChatGPT — a secure, <strong>read-only</strong> connection to your QuickBooks Online books, so you can ask questions like “Who owes me money?” in plain English. Tell us who you are and we will email you an invitation once we have confirmed your request.</p>
    ${error ? `<div class="err" role="alert">${escapeHtml(error.message)}</div>` : ''}
    <form method="POST" novalidate>
      <label for="name">Your name</label>
      <input type="text" id="name" name="name" value="${value(values.name)}" maxlength="${MAX_REQUEST_NAME_LENGTH}" autocomplete="name" required${focus('name')}>
      <label for="email">Your email address</label>
      <input type="email" id="email" name="email" value="${value(values.email)}" maxlength="254" autocomplete="email" required${focus('email')}>
      <p class="hint">Use the address we already have for you — it is how we will recognise you, and where the invitation goes.</p>
      <label for="company">Your business name</label>
      <input type="text" id="company" name="company" value="${value(values.company)}" maxlength="${MAX_REQUEST_COMPANY_LENGTH}" autocomplete="organization" required${focus('company')}>
      <p class="hint">As it appears on your QuickBooks account, if you know it.</p>
      <div class="extra" aria-hidden="true">
        <label for="website">Leave this empty</label>
        <input type="text" id="website" name="website" tabindex="-1" autocomplete="off">
      </div>
      <input type="hidden" name="t" value="${escapeHtml(token)}">
      <button type="submit">Request access</button>
    </form>
    <p class="note">We review every request before anything is sent. Access is read-only: your assistant can look things up and run reports, and cannot create, change, or delete anything in QuickBooks. <a href="${SECURITY_PAGE_PATH}" target="_blank" rel="noopener">How it is protected, and what to keep in mind</a>.</p>`,
    firm
  );
}

/** Shown to everyone who submits, whatever happens to the request. */
export function requestReceivedPage(details: { firm: FirmBrand; name: string; email: string }): string {
  const { firm, name, email } = details;
  return clientPage(
    'Request received',
    `<h1>Thanks, ${escapeHtml(name)}</h1>
    <div class="ok">Your request is with ${escapeHtml(firm.name)}.</div>
    <p class="lead" style="margin-top:16px">Once we have confirmed it, we will email an invitation to <strong>${escapeHtml(email)}</strong> with a link to choose your password and steps to connect your assistant. There is nothing else you need to do for now.</p>
    <p class="note">We review requests by hand, so it is not instant. If you don't hear from us, or you used a different email address than the one we have for you, get in touch with ${escapeHtml(firm.name)} directly.</p>`,
    firm
  );
}

/** Requests are turned off. */
export function requestClosedPage(firm: FirmBrand): string {
  return clientPage(
    'Requests are not open',
    `<h1>Requests aren't open right now</h1>
    <p class="lead">This page isn't taking requests at the moment. To ask about connecting your AI assistant to your books, contact <strong>${escapeHtml(firm.name)}</strong> directly.</p>`,
    firm
  );
}

/** A limit was reached. */
export function requestBusyPage(firm: FirmBrand): string {
  return clientPage(
    'Please try again later',
    `<h1>We can't take your request just now</h1>
    <p class="lead">We have received a lot of requests in a short time. Please try again in an hour or so, or contact <strong>${escapeHtml(firm.name)}</strong> directly and we will set you up.</p>`,
    firm
  );
}
