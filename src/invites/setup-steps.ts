/**
 * How a client connects their assistant, written once and shown in two
 * places: the invitation email and the page they land on after choosing
 * their password. Each step is plain text; **double asterisks** mark the menu
 * names and buttons to look for (bold in HTML, dropped in plain text).
 */
export const CLAUDE_STEPS = [
  'Sign in at claude.ai on a computer and open **Customize → Connectors**.',
  'Click **+ Add**, then **Add custom connector**.',
  'Give it a name you will recognize, paste the connector address, and click **Continue**.',
  'Keep the suggested sign-in settings and click **Add**. If you are asked which OAuth client to use, choose **Register automatically**.',
  'A **Sign in to connect** page opens. Enter your email address and the password you chose.',
  'In a new chat, click **+** by the message box, choose **Connectors**, and switch this one on.',
];
export const CLAUDE_NOTE =
  'Works on any Claude plan (free accounts can add one custom connector). On a Claude Team or Enterprise plan, a workspace Owner adds it once under Organization settings → Connectors; you then click Connect and sign in.';

export const CHATGPT_STEPS = [
  'Sign in at chatgpt.com on a computer and open **Plugins**.',
  'Select the **+** button, then **Add custom MCP server**.',
  'Give it a name. Under **Connection**, paste the connector address.',
  'For authentication choose **OAuth**. Review the warning, tick **I understand and want to continue**, and select **Create as a plugin**.',
  'When the sign-in page opens, enter your email address and the password you chose.',
  'Install the new plugin from your plugins list, then turn it on in a chat.',
];
export const CHATGPT_NOTE =
  'Custom connections in ChatGPT depend on your plan: they are offered on ChatGPT Business and Enterprise/Edu, on the web, and on Business a workspace admin or owner has to add it. Menu names change from time to time — if yours look different, tell us and we will walk you through it.';

export const TRY_ASKING = [
  'What QuickBooks company am I connected to?',
  'Show me my profit and loss for last month next to the same month last year.',
  'Who owes me money right now, and which invoices are more than 60 days overdue?',
  'What bills are due in the next two weeks?',
];

export const GOOD_TO_KNOW = [
  'It is read-only. Your assistant can look things up and run reports; it cannot create, change, or delete anything in QuickBooks.',
  'Recent months can change until we finish closing them. If a decision depends on a number, ask us whether that period is closed.',
  'Your login is yours alone. If someone else at your company needs access, ask us for a separate one.',
  'A login can see everything in the file, including payroll and owner transactions.',
];

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** `**bold**` markers → plain text. */
export function plain(text: string): string {
  return text.replace(/\*\*(.+?)\*\*/g, '$1');
}

/** Escape, then turn `**bold**` markers into <strong>. */
export function rich(text: string): string {
  return escapeHtml(text).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
}

/** "Acme", "Acme and Beta", "Acme, Beta and Gamma" — or a neutral phrase for none. */
export function companyPhrase(companyNames: string[]): string {
  if (companyNames.length === 0) return 'your QuickBooks Online company';
  if (companyNames.length === 1) return companyNames[0];
  return `${companyNames.slice(0, -1).join(', ')} and ${companyNames[companyNames.length - 1]}`;
}
