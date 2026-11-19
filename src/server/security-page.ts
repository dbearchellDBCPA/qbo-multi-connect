/**
 * The public page that explains, in plain words, how a client's data is
 * protected here and what is theirs to manage when they connect an AI
 * assistant. Linked from the request page, the invitation flow and the
 * client's dashboard. Firm-branded, static, no scripts.
 */
import type { FirmBrand } from '../branding.js';
import { CLIENT_TERMS_POINTS } from '../client-terms.js';
import { clientPage } from './invite-pages.js';
import { escapeHtml } from '../invites/setup-steps.js';

export function securityPage(firm: FirmBrand): string {
  const us = escapeHtml(firm.name);
  return clientPage(
    'Security and what to keep in mind',
    `<h1>Using AI with your books: what to know</h1>
    <p class="lead">${us} can connect your AI assistant to your QuickBooks Online books. This page explains how that connection is protected, and the things that are yours to manage.</p>

    <h2>How the connection is protected</h2>
    <ul>
      <li><strong>Read-only.</strong> Your assistant can look things up and run reports. It cannot create, change or delete anything in QuickBooks — that is enforced on our side, not left to the assistant.</li>
      <li><strong>Only your company.</strong> Your login reaches the books we assigned to it and nothing else.</li>
      <li><strong>Your own login.</strong> You choose your password; nobody here can see it. Repeated wrong guesses lock the login for a while.</li>
      <li><strong>Encrypted in transit.</strong> Everything between your assistant and this service travels over an encrypted (HTTPS) connection.</li>
      <li><strong>We can switch it off.</strong> If a device is lost or someone leaves, tell us and the login stops working at once.</li>
      <li><strong>A record is kept</strong> of when your login is used and which reports or lookups were run — not of your conversation, which we never see.</li>
    </ul>

    <h2>What is yours to manage</h2>
    <ul>
      ${CLIENT_TERMS_POINTS.map((point) => `<li><strong>${escapeHtml(point.title)}</strong> ${escapeHtml(point.text)}</li>`).join('\n      ')}
    </ul>

    <h2>AI providers and training on your data</h2>
    <p>Once an answer leaves our service it is in your AI provider's hands, under the terms you agreed with them. The main thing to check is whether your conversations may be used to train their AI.</p>
    <ul>
      <li><strong>Free and personal plans</strong> often allow this by default, with a setting to turn it off. Look in the app's privacy or data settings for an option about using your chats to improve or train the model — in Claude it is under Settings → Privacy; in ChatGPT under Settings → Data controls. Names change, so look for that wording.</li>
      <li><strong>Business plans</strong> (such as Claude Team or Enterprise, ChatGPT Business or Enterprise) generally do not train on your conversations by default. Confirm it in your plan's terms.</li>
      <li>Whatever the plan, your provider stores your conversations for a time, and anyone with access to your AI account can read them. Protect that account as you would your bank login: a strong password and two-step sign-in.</li>
    </ul>

    <h2>Good habits</h2>
    <ul>
      <li>Connect only from an AI account that is yours, on a computer or phone you control. Avoid shared or public machines.</li>
      <li>Be careful with other connectors, plugins or files in the same conversation as your books: an assistant can be steered by text it reads elsewhere. Keep financial questions in their own chat.</li>
      <li>Think before pasting an answer into email, a shared document or another tool — once it is there, it is out of this connection's protection.</li>
      <li>When you no longer need it, remove the connector from your assistant and let us know so we can close the login.</li>
    </ul>

    <p class="note">Questions, or something does not look right? Contact ${us}. We will never ask for your password by email or phone.</p>`,
    firm
  );
}
