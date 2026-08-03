# Using your own domain

Out of the box this app answers on whatever address its host gives it —
on Railway that's something like `myapp.up.railway.app`.
You can put your own domain in front of it (`qbo.yourfirm.com`) without
changing any code, and without giving up the Railway address.

**The app has no hard-coded URL.** Every address it hands out — the OAuth
sign-in page, the connector metadata Claude discovers, the QuickBooks
callback, the upload endpoints in `create_upload_session` — is derived from
the hostname each request arrives on. Point a domain at the deployment and
those URLs follow it on the next request.

---

## The 10-minute version

1. **Railway → your service → Settings → Networking → Custom Domain.** Enter
   `qbo.yourfirm.com`. Railway shows you a CNAME target.
2. **At your DNS provider**, add that CNAME. Wait for Railway to show the
   domain as active with a valid certificate (usually a few minutes).
3. **developer.intuit.com → your app → Keys & OAuth → Redirect URIs.** Add
   `https://qbo.yourfirm.com/callback`. **Keep the old one in the list too.**
4. **Make sure `QBO_PUBLIC_URL` and `QBO_REDIRECT_URI` are NOT set** on the
   service (Railway → Variables). If either is set, it pins the app to the old
   address. Delete them and redeploy.
5. **Open `https://qbo.yourfirm.com`**, sign in, and on any client screen open
   **Connect to Claude → Server address & custom domain (admin)**. Both URLs
   shown there should now be on your domain.
6. **Update the connector in Claude** (Organization settings → Connectors) to
   `https://qbo.yourfirm.com/mcp`. Teammates sign in once on the new domain.

That's it. Existing QuickBooks connections keep working throughout — the
domain change affects only new authorizations, not stored tokens.

---

## How the address is decided

Two modes, chosen by whether `QBO_PUBLIC_URL` is set:

| Mode | When | Behaviour |
|---|---|---|
| **Dynamic** (recommended) | `QBO_PUBLIC_URL` unset | URLs mirror the hostname each request arrives on. The Railway address and every custom domain work simultaneously. Adding, changing, or removing a domain needs no redeploy. |
| **Pinned** | `QBO_PUBLIC_URL` set | Every URL uses that value, no matter which hostname was used to reach the server. Use when you want exactly one canonical address. |

The dashboard tells you which mode you're in, and warns you when a pinned URL
disagrees with the domain you're actually browsing.

### Environment variables

| Variable | Required | Effect |
|---|---|---|
| `QBO_PUBLIC_URL` | No | Pins the public origin, e.g. `https://qbo.yourfirm.com`. Leave unset for dynamic mode. |
| `QBO_ALLOWED_HOSTS` | No | Comma-separated allowlist of hostnames you own, e.g. `qbo.yourfirm.com,myapp.up.railway.app`. `*.yourfirm.com` wildcards work. Requests arriving on anything else are served using the first entry instead of the hostname they claimed. |
| `QBO_REDIRECT_URI` | No | Pins the QuickBooks callback. Leave unset so it follows the domain in use. |
| `RAILWAY_PUBLIC_DOMAIN` | Injected by Railway | Only used for the startup log line, when there's no request to read a hostname from. |

### Why `QBO_ALLOWED_HOSTS` exists

In dynamic mode the hostname comes from a request header, which anyone can
set. Nothing sensitive leaks — a spoofed header only affects the URLs echoed
back to that same caller — but the allowlist removes the question entirely.
Setting it is a good idea once your domains are stable; the app works fine
without it.

---

## What has to be registered where

Two URLs live outside this app, and both must name a domain you've actually
pointed at the deployment:

| URL | Registered at | What breaks if it's wrong |
|---|---|---|
| `https://<domain>/callback` | Intuit app → Redirect URIs | Connecting or reconnecting a QuickBooks company fails with a redirect_uri error. Existing connections are unaffected. |
| `https://<domain>/mcp` | Claude → Organization settings → Connectors | Teammates can't reach the server, or land on the old address. |

Both are shown, with copy buttons, under **Connect to Claude → Server address
& custom domain (admin)** in the dashboard. The connect-a-client dialog also
prints the exact callback URL it's about to use.

Intuit allows several redirect URIs per app. List every domain you use — the
Railway address and your custom domain — so a connection started on either
one completes.

---

## Running several domains at once

Dynamic mode serves any number of hostnames from one deployment, which is
useful for:

- **Cutover.** Run the Railway address and the custom domain in parallel;
  move Claude and Intuit over when you're ready, with no downtime window.
- **A vanity domain per customer** (model 1 packaging, one instance each).
  `acme.yourfirm.com` and `beta.yourfirm.com` can point at different
  deployments, each self-describing correctly, with `QBO_ALLOWED_HOSTS`
  set to `*.yourfirm.com` on all of them.

Note that a QuickBooks authorization completes on whichever domain it was
started from, because the callback is derived per-request. Mixing domains
mid-flow isn't possible, so there's nothing to keep in sync.

---

## Verifying

```bash
# What the server thinks it is (admin key or session token):
curl -s -H "Authorization: Bearer $QBO_ADMIN_KEY" https://qbo.yourfirm.com/api/server-url

# What Claude discovers when it connects — the issuer and endpoints
# should all be on your domain:
curl -s https://qbo.yourfirm.com/.well-known/oauth-authorization-server

# The 401 challenge that starts OAuth sign-in should point at your domain:
curl -si -X POST https://qbo.yourfirm.com/mcp | grep -i www-authenticate
```

`/api/server-url` also reports `mode`, the resolved `intuitRedirectUri`, and
any warnings about configuration that contradicts the domain in use.

---

## Troubleshooting

**"Invalid redirect_uri" / Intuit refuses the authorization.** The exact
`https://<domain>/callback` isn't on the Intuit app's Redirect URIs list. Copy
it from the connect dialog (it prints the value it used) and add it verbatim —
no trailing slash, matching scheme and subdomain.

**Claude sends people to the old address after the switch.** Either
`QBO_PUBLIC_URL` is still set (the dashboard warns about this), or the
connector in Claude still holds the old URL. Fix both, then have teammates
disconnect and reconnect the connector so it re-runs discovery.

**Dashboard loads on the new domain but shows the old one.** That's pinned
mode. Remove `QBO_PUBLIC_URL` from the service variables and redeploy.

**Certificate errors on the custom domain.** DNS hasn't propagated or the
CNAME is wrong — Railway's Networking page shows the domain's real status.
Nothing in the app is involved.

**MCP works but uploads point at the old host.** `create_upload_session`
derives its URLs the same way; if they're stale, the request reached the
server through the old hostname or a pinned `QBO_PUBLIC_URL`.
