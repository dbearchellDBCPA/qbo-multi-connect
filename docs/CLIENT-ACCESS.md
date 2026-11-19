# Giving a Client Read-Only Access to Their Own Books

A **client login** lets a client connect their own AI assistant to their own
QuickBooks company through your server. They can ask questions and run
reports. They cannot change anything.

This page is for the firm. The handout you send the client is
[CLIENT-CONNECTOR-SETUP.md](CLIENT-CONNECTOR-SETUP.md).

## What a client login is

It is a separate kind of account from a team member, with rules that can't be
switched off:

| | Team member | Client login |
|---|---|---|
| Access level | Read & write or read-only, per client | **Always read-only** |
| Can be an admin | Yes | **Never** |
| API key | Yes | **None** — signs in through the connector only |
| REST API | Yes | **None** — the connector is the only way to the data |
| Tools | All tools their access allows | A fixed list of 46 read-only tools about their own books |
| Sees | Assigned clients | Assigned clients (normally just their own) |

"Always read-only" is enforced in the same places as read-only for staff —
the tool list, each tool call, the REST API, and the QuickBooks request layer
— and it is checked before anything else stored on the account, so no
combination of settings can widen it.

The tool list is explicit (`src/server/client-tools.ts`). A tool added to the
server later is **not** available to clients until someone adds it to that
list; a test fails until that decision is made.

## Set up a client

With [email invitations](#email-invitations) turned on, the server sends the
client everything they need:

1. On the dashboard, open **Team**. Under **Client logins**, click **+ Add**.
2. Enter their name, their **email address**, and a **username**.
3. Leave **Email them an invitation and a generated password** checked.
4. Check **their company**. Usually exactly one — an invitation is not sent
   for a login with no company assigned.
5. Click **Create and send invitation**. They receive two emails; there is
   nothing else for you to send.

Without email invitations — or if you untick that box — you choose the
password yourself:

1. Enter their name, a **username**, and a **password**. Both are required: a
   client login has no API key to fall back on, so the server refuses to
   create one that couldn't sign in.
2. Check their company and click **Create client login**. The confirmation
   shows the connector address.
3. Send the client the handout, the connector address, and their username.
   Send the password separately.

Create one login per person. If two people at the client need access, give
each their own, so you can switch one off without affecting the other and the
activity log shows who did what.

## Email invitations

When a client login is created with the invitation box checked, the server
generates a strong random password and sends the client two emails through
[Resend](https://resend.com):

1. **The invitation** — the connector address, their username, step-by-step
   setup for Claude and for ChatGPT, things to try asking, and what read-only
   means. No password.
2. **The password** — and nothing that says where to use it: no address, no
   username.

They are separate on purpose, so neither message is enough to sign in by
itself if it is forwarded or seen on a screen. The password is never shown in
the dashboard, returned by the API, or written to a log; only its hash is
stored.

**Send a new invitation** on a client login emails both messages again with a
**new** password. The old password stops working and any assistant they had
connected is signed out — so it is also the fix for "I lost the email" and
"I'm locked out". If the emails cannot be sent, nothing changes and the login
keeps working as it was.

### Turning it on

Set these on the server (the same place as the other settings), then restart:

| Variable | Required | What it is |
|---|---|---|
| `RESEND_API_KEY` | Yes | A Resend API key with *Sending access*. The same key the connection alerts use. |
| `QBO_INVITE_FROM` | Yes | What clients see in their inbox: `Your Firm <hello@yourfirm.com>`, on a domain you have verified in Resend. The alert sender is never used in its place — client email only goes out once you have chosen who it comes from. |
| `QBO_INVITE_REPLY_TO` | No | Where a client's reply goes — your real inbox — when the sender address isn't one you read. |
| `QBO_FIRM_NAME` | No | How the emails name the firm. Defaults to the display name in the sender. |

The startup log and the **Add a client login** form both say whether
invitations are on and, if not, which setting is missing.

### Things to know

- **A password in an email is only as private as the inbox — and the outbox.**
  Splitting the two messages helps, but both go to the same address, and
  Resend keeps a copy of what it sent, readable by anyone with access to your
  Resend account. The emails ask the client to change the password, but
  nothing forces them to. If a client's mailbox is shared, choose the password
  yourself and give it to them another way.
- **Check the address before you send.** The invitation goes to whatever is in
  the email field, and it names their company. A typo sends a working login
  to a stranger. If that happens, **Disable** the login at once.
- **The ChatGPT steps are the least certain part.** OpenAI limits custom
  connections to certain plans (Business and Enterprise/Edu at the time of
  writing, set up by a workspace admin) and changes its menus often. Try it
  once with your own ChatGPT account before telling a client it will work.
- **Deliverability is Resend's and your domain's.** A first email from a new
  sending domain can land in spam; ask the client to look there.

## Before you hand one out

- **They will see the whole file.** The connection to QuickBooks uses your
  firm's authorization, so a client login can read everything in that company
  — payroll, owner draws, memos and notes your team wrote on transactions —
  regardless of what that person's own QuickBooks user is allowed to see.
  Give logins to owners and people who should see everything.
- **Their assistant shares the company's QuickBooks API allowance with you.**
  Heavy use by a client can slow your own work on that file at the same
  moment. In practice a person asking questions makes few calls; a client who
  automates against it could make many.
- **Recent months may not be closed.** The handout tells clients that
  numbers can change until you close the period. Consider telling them your
  close schedule.

## Keep an eye on it

Every tool call and sign-in is recorded: who, which tool, which company, and
whether it worked, failed, or was blocked. That includes an assistant trying
a tool the login was never offered, and asking for a company the login can't
see (logged with the name it asked for, marked "not found"). What was asked
and what came back are **not** recorded — that is the client's financial data.

Wrong passwords and lockouts are recorded against the login they were aimed
at. Attempts on usernames that don't exist are not recorded: they are nobody's
activity, and logging whatever strangers type would let them fill the log.

- **Team → select a login** shows that login's recent activity.
- **Clients** shows recent activity across everyone.
- `GET /api/activity?accountType=client` returns everything client logins
  have done, for export or review. Entries are kept for 180 days.
- Each client login shows when its invitation was last sent.

Things worth a look: a login that has never connected (they may be stuck), a
burst of activity at odd hours, blocked or "not found" calls, or a "Locked out
after failed sign-ins" entry.

## Sign-in protection

After five wrong passwords in a row a username is locked for a minute. Each
further failure doubles the wait, up to fifteen minutes. The lock is shared
between the dashboard and the connector sign-in page.

If a client locks themselves out, **Reset password** on their login clears
the lock immediately.

The lock is on the username, not on where the attempts come from (network
addresses are too easy to fake for that to be a real lock). The trade-off:
someone who knows a client's username could keep it locked by failing on
purpose. You would see it in the activity log as repeated lockouts; the fix is
to give that login a new username. Your own way in is never at risk — the
master key does not go through this lock.

**Reset password** also signs out any assistant that is already connected,
as does the client changing their own password. They sign in to the connector
again with the new one. So a reset is the right response to "I think someone
else has my password" — it cuts off whoever connected with the old one.

## Turn it off

- **Disable** on the login stops it on the next request and signs out any
  assistant that is already connected. Their assignments are kept, so
  **Enable** restores the login — they sign in to the connector again.
- **Remove** deletes the login.
- Unchecking their company under **Edit assignments** leaves the login in
  place with nothing to read.

Do this when an engagement ends, when the person leaves the client, or when a
device with a connected assistant is lost.

## What clients can use

Reports (profit and loss, balance sheet, cash flow, trial balance, general
ledger, A/R and A/P aging, budget vs. actual, bank register, and the other
standard QuickBooks reports), lists (accounts, customers, vendors, employees,
items, classes, departments), individual transactions of every type, free-form
queries, attachments lists, and transaction PDFs.

Withheld from clients: every tool that creates, changes, deletes, sends, or
uploads, plus the three read-only tools that describe your server rather than
their books (`get_server_info`, `import_status`, `list_staging_files`).
