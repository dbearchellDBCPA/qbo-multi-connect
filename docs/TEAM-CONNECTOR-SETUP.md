# Connecting to the QuickBooks MCP Server (Team Setup)

This guide explains how to get access to our QuickBooks Online tools inside
Claude. Once connected, Claude can pull reports, look up transactions, and make
corrections — but **only for the client companies assigned to you**.

> **One connector, individual sign-ins.** The workspace adds this connector
> **once**, with no key in the URL. Each person who uses it signs in with their
> own QBO Multi-Connect username and password, and Claude then reaches only
> that person's assigned clients. A Claude Team workspace can only hold one
> copy of a given connector, which is exactly why it works this way.

---

## Part 1 — Create each member's account (admin)

1. Open the QBO Multi-Connect dashboard and sign in with your username and
   password. (First-time setup only: sign in with the master key via
   "Sign in with an API key instead", then create your own admin account.)
2. Switch the left rail to **Team** and click **+ Add a member**.
3. Enter their name, a **username and password** (this is what they'll use to
   authorize the connector), pick the **Member** role, choose their
   **QuickBooks access** (Read & write, or Read-only — read-only members never
   even see the write tools), and check the client companies they should
   access.
4. Click **Create member**, then give them their username and password.

You can change a member's client assignments, access level, or credentials, or
disable them entirely, at any time from the same view — changes take effect on
their next request.

## Part 2 — Add the connector once (workspace Owner)

1. In [claude.ai](https://claude.ai), open **Settings → Organization
   settings → Connectors** (org-level so the whole team can use it).
2. Click **Add connector → Custom** and paste the **shared connector URL**:

   ```
   https://<your-deployment>/mcp
   ```

   No API key. No `?key=`. The exact URL is shown on the dashboard's
   **Connect to Claude** card, with a Copy button.
3. Save. That's the only setup — you do not add one connector per person.

> **If you later move to your own domain** (e.g. `qbo.yourfirm.com`), update
> this connector URL to match and have each member reconnect once. The server
> follows whichever domain it's reached on, so both addresses work during the
> switchover. See [CUSTOM-DOMAIN.md](CUSTOM-DOMAIN.md).

## Part 3 — What each team member does (and sees)

1. In **Settings → Connectors**, find the QuickBooks connector and click
   **Connect**.
2. A **"Sign in to connect"** page from our dashboard opens. It shows which
   application is requesting access and asks for a username and password.
3. Enter the credentials your admin gave you and click **Sign in and allow
   access**. Claude returns to the connector, now showing as connected.
4. In any chat, make sure the connector's tools are toggled on, then ask
   *"List the QuickBooks clients we have connected"* — you should see exactly
   the companies assigned to you, and no others.

Sessions renew automatically in the background; you'll only be asked to sign in
again if an admin disables your account or revokes access. The connector also
works in Claude Desktop, Cowork, and Claude Code sessions tied to your
claude.ai account.

> **Why this is safe to share:** everyone uses the same connector, but the
> server decides what each signed-in person can reach. Enabling the connector
> gives you nothing until you sign in as yourself.

## Alternative — personal API-key URL

For scripts, or tools that can't do interactive sign-in, each member can also
use a personal URL with their key embedded (`…/mcp?key=…`), visible on their
dashboard under **Connect to Claude → Personal API-key URL**. Treat that URL
like a password. The shared OAuth connector above is preferred for people.

## Part 4 — The `/qbo` skill (recommended)

The connector provides the tools; the **qbo skill** teaches Claude our
workflows for using them (report formats, bulk corrections, round-trip
edits). If an admin has published the skill to the workspace, type `/qbo` at
the start of a bookkeeping session.

## Troubleshooting

| Problem | Fix |
|---|---|
| Connector tools don't appear in chat | Check the connector is enabled in Settings → Connectors and toggled on in the chat's tools menu. |
| `401 Unauthorized` on tool calls | Your session expired or your account was disabled. Click **Connect** on the connector again to sign in. |
| A client you work on isn't listed | It isn't assigned to your account yet — ask the admin to add it on the Team tab. |
| A client company errors out | Its QuickBooks authorization may have expired — the admin can reconnect it from the dashboard. |

## Questions

Contact your administrator.
