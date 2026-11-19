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

## Invite a client

All it takes is their name and their email address.

1. On the dashboard, open the client's company under **Clients** and click
   **Invite the client**.
2. Enter their **name** and **email address**, and click **Send invitation**.

That's it. Their email address is their username. They receive one email with
a link; on the page it opens they choose their own password, and the page
then shows them how to connect Claude or ChatGPT.

You can also invite from **Team → Client logins → + Add**, which lets you
assign more than one company.

Create one login per person. If two people at the client need access, invite
each of them, so you can switch one off without affecting the other and the
activity log shows who did what.

### What the client does

1. Opens the email and clicks **Accept invitation**.
2. Chooses a password on a page served by your server. Nobody else ever sees
   it — not you, and it is never emailed.
3. Follows the steps shown to add the connector to their assistant. When the
   connector's sign-in page opens, they enter their email address and that
   password. That is the only place the password is used; after that their
   assistant stays connected.

### How the link behaves

- It works **once**, and for **7 days**. After that, send a new invitation.
- Opening it does nothing by itself, so a mail scanner that fetches links
  doesn't use it up. Only submitting a password does.
- Until it is used, the link *is* the credential: whoever opens it can set
  the password. So check the address before you send. If an invitation goes
  to the wrong person, **Disable** the login at once, correct the address,
  enable it, and send a new invitation — changing the email address also
  kills the old link.
- A login's row under **Team** shows where things stand: *waiting for them to
  accept*, *accepted*, or *expired*.

### Sending a new invitation

**Send a new invitation** on a client login emails a fresh link. Use it when
they've lost the email, the link has expired, or they've forgotten their
password — it is the password-reset flow too.

The earlier link stops working immediately. Their **current password keeps
working** until they accept the new invitation; when they do, the old
password and anything connected with it are switched off. If you need to cut
someone off right now, use **Disable** instead.

### Turning on email

Invitations are sent through [Resend](https://resend.com). Set these on the
server (the same place as the other settings), then restart:

| Variable | Required | What it is |
|---|---|---|
| `RESEND_API_KEY` | Yes | A Resend API key with *Sending access*. The same key the connection alerts use. |
| `QBO_INVITE_FROM` | Yes | What clients see in their inbox: `Your Firm <hello@yourfirm.com>`, on a domain you have verified in Resend. The alert sender is never used in its place — client email only goes out once you have chosen who it comes from. |
| `QBO_INVITE_REPLY_TO` | No | Where a client's reply goes — your real inbox — when the sender address isn't one you read. |
| `QBO_FIRM_NAME` | No | How the email and the accept page name the firm. Defaults to the display name in the sender. |

**You don't need email to invite someone.** Until it is set up — or if an
email is rejected — the dashboard gives you the invitation link itself to
send however you like. It is the same link, and behaves the same way. The
link is only ever shown to you in that case; when the email goes out, the
link exists in the client's inbox and nowhere else.

### Choosing the password yourself

If you'd rather not invite — a client without email, say — untick **Invite
them to choose their own password** under **Team → Client logins → + Add**,
type a username and password, and pass them on yourself. A client login needs
both, since it has no API key to fall back on.

### Things to know

- **The ChatGPT steps are the least certain part.** OpenAI limits custom
  connections to certain plans (Business and Enterprise/Edu at the time of
  writing, set up by a workspace admin) and changes its menus often. Try it
  once with your own ChatGPT account before telling a client it will work.
- **Deliverability is Resend's and your domain's.** A first email from a new
  sending domain can land in spam; ask the client to look there.
- **Passwords are the client's own.** The minimum is 8 characters; the page
  encourages a longer phrase. You can't see or recover it — only replace it,
  with a new invitation or **Reset password**.

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
- Each client login shows whether its invitation is waiting, accepted, or
  expired.

Things worth a look: a login that has never connected (they may be stuck), a
burst of activity at odd hours, blocked or "not found" calls, or a "Locked out
after failed sign-ins" entry.

## Sign-in protection

After five wrong passwords in a row a username is locked for a minute. Each
further failure doubles the wait, up to fifteen minutes. The lock is shared
between the dashboard and the connector sign-in page.

If a client locks themselves out, **Send a new invitation** lets them choose
a new password and clears the lock when they do; **Reset password** clears it
at once with a password you choose.

The lock is on the username, not on where the attempts come from (network
addresses are too easy to fake for that to be a real lock). The trade-off:
someone who knows a client's username could keep it locked by failing on
purpose. You would see it in the activity log as repeated lockouts; the fix is
to give that login a new username. Your own way in is never at risk — the
master key does not go through this lock.

**Reset password** also signs out any assistant that is already connected,
as does the client changing their own password or accepting a new invitation.
They sign in to the connector again with the new one. So if a client thinks
someone else has their password, **Disable** the login to cut access off at
once, then enable it and send a new invitation.

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
