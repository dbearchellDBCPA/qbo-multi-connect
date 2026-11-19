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

1. On the dashboard, open **Team**. Under **Client logins**, click **+ Add**.
2. Enter their name, a **username**, and a **password** (both required — a
   client login has no API key to fall back on).
3. Check **their company**. Usually exactly one.
4. Click **Create client login**. The confirmation shows the connector
   address to send them.
5. Send the client the handout, the connector address, and their username.
   Send the password separately.

Create one login per person. If two people at the client need access, give
each their own, so you can switch one off without affecting the other and the
activity log shows who did what.

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
whether it worked or was blocked. What was asked and what came back are
**not** recorded — that is the client's financial data.

- **Team → select a login** shows that login's recent activity.
- **Clients** shows recent activity across everyone.
- `GET /api/activity?accountType=client` returns everything client logins
  have done, for export or review. Entries are kept for 180 days.

Things worth a look: a login that has never connected (they may be stuck), a
burst of activity at odd hours, or a "Locked out after failed sign-ins" entry.

## Sign-in protection

After five wrong passwords in a row a username is locked for a minute. Each
further failure doubles the wait, up to fifteen minutes. The lock is shared
between the dashboard and the connector sign-in page.

If a client locks themselves out, **Reset password** on their login clears
the lock immediately.

## Turn it off

- **Disable** on the login stops it on the next request — including an
  assistant that is already connected. Their assignments are kept, so
  **Enable** restores it.
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
