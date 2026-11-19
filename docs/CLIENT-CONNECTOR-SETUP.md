# Connecting Your AI Assistant to Your QuickBooks Data

<!--
  FIRM NOTE — delete this block before sending.
  Create the client's login first: dashboard → Team → Client logins → + Add
  (see CLIENT-ACCESS.md). Then fill in the four placeholders: [FIRM NAME],
  [CONNECTOR ADDRESS] (your deployment's URL ending in /mcp — shown when you
  create the login), [SIGN-IN ADDRESS] (the same URL without /mcp), and
  [SUPPORT CONTACT]. Send the username and password separately from this
  document. Do a dry run with a test client login before the first real one —
  menu names in Claude change from time to time.
-->

[FIRM NAME] can give your AI assistant a secure, **read-only** window into your
QuickBooks Online books. Once it's connected, you can ask questions in plain
English — "Who owes me money?", "How did last month compare to a year ago?" —
and your assistant pulls the answer straight from your books instead of you
exporting reports.

**Read-only means read-only.** Your assistant can look things up and run
reports. It cannot create, change, or delete anything in QuickBooks.

---

## What you'll need

- **An AI assistant that supports custom connectors.** These instructions are
  written for [Claude](https://claude.ai) (any plan — free accounts can add one
  custom connector). See [Other AI assistants](#other-ai-assistants) if you use
  something else.
- **The connector address:** `[CONNECTOR ADDRESS]`
- **Your username and password**, which we send you separately.

Set this up from a computer (the Claude website or desktop app). It takes
about five minutes.

## Set up in Claude

1. Sign in to Claude and open **Customize → Connectors**.
2. Click **+ Add**, then **Add custom connector**.
3. Give it a name you'll recognize, such as **QuickBooks – [FIRM NAME]**.
4. Paste the connector address exactly as shown above and click **Continue**.
5. Claude detects how to sign in. Leave the suggested settings as they are and
   click **Continue**, then **Add**. If you're asked which *OAuth client* to
   use, choose **Register automatically**.
6. A page titled **Sign in to connect** opens. Enter the username and password
   we gave you and click **Sign in and allow access**.
7. Claude returns to the connector list, now showing the connector as
   connected.

**On a Claude Team or Enterprise plan?** Individual members can't add custom
connectors — a workspace Owner adds it once under **Organization settings →
Connectors**, using the same address. After that, each person who should have
access opens **Customize → Connectors**, finds the connector, clicks
**Connect**, and signs in with their own username and password from us.

## Try it

In a new chat, click the **+** button at the bottom of the message box, choose
**Connectors**, and make sure the QuickBooks connector is switched on. Then ask:

> What QuickBooks company am I connected to?

You should see your company — and only your company. From there, try things
like:

- "Show me my profit and loss for last month next to the same month last year."
- "Who owes me money right now? Which invoices are more than 60 days overdue?"
- "What bills are due in the next two weeks?"
- "Who were my ten largest vendors by spend this quarter?"
- "What's the balance in each of my bank and credit card accounts?"
- "How are we doing against budget so far this year?"
- "Find the invoice we sent [customer] in March. Has it been paid?"

The first time your assistant uses the connector it may ask your permission.
Because the connection is read-only, it's fine to choose **Allow always**.

## What it can and can't do

| It can | It can't |
|---|---|
| Run reports: profit and loss, balance sheet, cash flow, trial balance, general ledger, budget vs. actual | Create, edit, or delete invoices, bills, payments, journal entries, or anything else |
| Show who owes you and who you owe (A/R and A/P aging) | Send invoices or emails from QuickBooks |
| Look up invoices, bills, expenses, deposits, payments, and journal entries | Change customers, vendors, items, or your chart of accounts |
| List customers, vendors, items, and accounts | See any company other than yours |

Need something changed in your books? Send it to us the way you always have —
or ask your assistant to draft the request and forward it.

## Getting good answers

- **Be specific about dates and basis.** "Profit and loss for January through
  June 2026, cash basis" beats "how are we doing?" Always say whether you want
  cash or accrual basis — the two can tell very different stories.
- **Recent numbers may be preliminary.** Until we finish reconciling and
  closing a month, that month's figures can change. If a decision depends on
  the number, ask us whether the period is closed.
- **Book balances aren't bank balances.** An account balance from QuickBooks
  reflects what's been recorded, which can differ from what your bank shows
  today.
- **AI assistants can misread or miscalculate.** Ask yours to show the report
  and date range it used. For anything going to a lender, an investor, or a
  tax authority, get the figures from us.
- **Keep requests reasonably sized.** A full year of line-by-line transaction
  detail can be slow or get cut off. Ask for a summary first, then drill into
  the month or account you care about.

## Keeping your data safe

- **Your login is yours alone.** Don't share it. If a partner, manager, or
  bookkeeper should also have access, ask us and we'll give them their own.
- **A login sees the whole file** — including payroll, owner draws, and
  anything else recorded in QuickBooks. Keep that in mind when deciding who
  should have one.
- **Tell us when someone leaves** or a laptop goes missing. We can switch off
  a login immediately.
- **Your questions and the answers pass through your AI provider** under your
  agreement with them. Review their privacy settings — particularly whether
  your conversations may be used to train their models — and choose what suits
  your business.
- **Only add the connector using the address above.** We will never ask for
  your password by email or phone.

To change your password, sign in at `[SIGN-IN ADDRESS]` with the same username
and password, open **Settings**, and choose **Change password** — or ask us to
reset it.

## Other AI assistants

The same connector address works with other assistants that support remote
MCP connectors with sign-in. Look for an option like **Add custom connector**
or **Add custom MCP server**, paste the connector address, choose **OAuth** if
asked how to authenticate, and sign in with the username and password from us.
Availability depends on the product and your plan — tell us which assistant
you use and we'll help you get connected.

## Troubleshooting

| Problem | What to do |
|---|---|
| The assistant says it has no QuickBooks tools | In the chat, click **+ → Connectors** and switch the connector on. |
| "Incorrect username or password" | Check for typos and make sure you're using the login we sent for this connector. Still stuck? Ask us to reset your password. |
| "Too many failed sign-ins" | For your protection the login pauses after several wrong passwords. Wait the time shown and try again, or ask us to reset your password — that clears it right away. |
| Sign-in page says "Unknown or missing client_id" | Remove the connector and add it again. When asked about the OAuth client, choose **Register automatically**. |
| It worked before and now asks you to sign in | Normal after a long gap. Click **Connect** on the connector and sign in again. |
| "Unauthorized" or "access denied" errors | Your login may have been switched off, or your company isn't assigned to it. Contact us. |
| Your company can't be reached, or errors mention QuickBooks authorization | Our link to your QuickBooks file needs renewing. Contact us — it takes a minute to fix. |
| A report is slow or cut off | Ask for a shorter date range or a summary. |
| You want to stop using it | Go to **Customize → Connectors** and remove the connector. Let us know and we'll close the login too. |

## Questions

Contact [SUPPORT CONTACT].
