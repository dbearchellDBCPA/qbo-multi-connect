# qbo-multi-connect

Connect Claude (or any AI assistant, script, or tool) to **many QuickBooks
Online companies at once** — with one login per team member, and each member
limited to exactly the client companies you assign them.

It's a small self-hosted web app. You run one copy for your firm (Railway
makes this a ~30-minute, no-code setup — walkthrough below). It gives you:

- **A dashboard** where you connect each QuickBooks company (a normal
  "sign in to QuickBooks and approve" flow — no data entry), watch connection
  health, and manage your team.
- **Team accounts** — each staff member gets their own username/password and
  sees only their assigned clients. Read-only mode available per member.
- **A Claude connector** — add one URL in Claude's settings and Claude can
  pull reports, look up transactions, post journal entries, fix coding, and
  attach documents across every company a person is allowed to touch. Each
  member signs in as themselves; permissions are enforced server-side.
- **Automatic token care** — QuickBooks logins are refreshed in the
  background and self-heal after outages; the dashboard flags anything that
  truly needs a re-authorization.

Built for CPA and bookkeeping firms. Works with a single, free Intuit
developer app — no QuickBooks Payments requirement, no third-party
middleware, and your data never touches anyone's servers but your own.

## How it works

```
 Your team, in Claude ──────────┐
                                ▼
                     ┌─────────────────────┐        ┌────────────────┐
 Your browser ─────► │  qbo-multi-connect  │ ─────► │ QuickBooks     │
 (dashboard)         │  (your Railway app) │  API   │ Online         │
                     └─────────────────────┘        │ (all clients)  │
                        one app, one URL,           └────────────────┘
                        its own database
```

You deploy this app once. It holds the (encrypted) QuickBooks authorizations
for all your client companies, and everything else — Claude, your browser,
scripts — talks to it, never to QuickBooks directly.

---

## Set it up on Railway (from scratch, no coding)

This app is designed to run on [Railway](https://railway.com), a hosting
service that builds and runs it straight from GitHub. You click through
their website; there is no command line involved.

**What you need before starting** (~30–45 minutes total):

1. A **GitHub account** (free — you're probably reading this on GitHub).
2. A **Railway account** (railway.com — the Hobby plan, ~$5/month, is plenty).
3. An **Intuit developer account** (developer.intuit.com — free; sign in
   with the same Intuit login you use for QuickBooks).

### Step 1 — Get your own copy of this code

On this GitHub page, click **Fork** (top right) and accept the defaults.
That gives you your own copy that Railway can deploy — and lets you pull in
future updates whenever you choose.

### Step 2 — Create your Intuit app

QuickBooks requires every integration to register as an "app". Yours is
private to your firm:

1. Go to [developer.intuit.com](https://developer.intuit.com), sign in, and
   choose **Create an app** → **QuickBooks Online and Payments**.
2. Name it anything (e.g. "Firm QBO Connect"). Under scopes, tick only
   **Accounting**.
3. Open the app's **Keys & credentials** page. You'll see a **Client ID**
   and **Client Secret** — keep this tab open, you'll paste both into
   Railway in Step 4.

Intuit gives you two sets of keys: **Development** (works against fake
"sandbox" companies — good for a trial run) and **Production** (real books;
Intuit asks a few compliance questions before enabling them). Start with
whichever you prefer — switching later is just swapping the two values.

### Step 3 — Deploy on Railway

1. On [railway.com](https://railway.com): **New Project → Deploy from GitHub
   repo**, connect your GitHub account, and pick your fork.
2. Railway detects how to build it automatically. The first build starts on
   its own — let it run.

### Step 4 — Add storage and settings

Your QuickBooks connections must survive restarts, so give the app a disk:

1. In your Railway project, right-click the service → **Attach Volume**
   (or Settings → Volumes) and set the **mount path** to `/data`.
2. Open the service's **Variables** tab and add:

   | Variable | Value |
   |---|---|
   | `INTUIT_CLIENT_ID` | from your Intuit app (Step 2) |
   | `INTUIT_CLIENT_SECRET` | from your Intuit app (Step 2) |
   | `QBO_ENVIRONMENT` | `sandbox` for a trial, `production` for real books |
   | `QBO_DB_PATH` | `/data/qbo-connections.db` |

   That's all. Don't set any API keys — the app generates its own secrets
   on first boot (next step).

### Step 5 — Get your web address and admin key

1. Service → **Settings → Networking → Generate Domain**. Railway gives you
   an address like `your-app.up.railway.app` — that's your dashboard URL.
   (You can attach your own domain later with zero reconfiguration — see
   [docs/CUSTOM-DOMAIN.md](docs/CUSTOM-DOMAIN.md).)
2. Back on **developer.intuit.com**, open your app → **Keys & credentials →
   Redirect URIs** and add exactly:

   ```
   https://your-app.up.railway.app/callback
   ```

   (your real Railway address + `/callback`). QuickBooks refuses to connect
   companies without this.
3. In Railway, open the service's **Deploy Logs**. After the first
   successful boot you'll find a banner reading **`FIRST-RUN SETUP`**
   followed by your **Admin API key**. Copy it somewhere safe — it's shown
   once, and it is the master key to your instance.

### Step 6 — Sign in and connect your first company

1. Open `https://your-app.up.railway.app` in your browser.
2. Choose **"Sign in with an API key instead"** and paste the admin key.
3. Click **+ Connect a client**, name the company, and approve it in the
   QuickBooks window that opens. Repeat for each client company.
4. On the **Team** tab, create an account for yourself (username +
   password) with the **Admin** role — from then on you sign in normally,
   and the API key goes back in the drawer as a break-glass credential.
5. Add each staff member the same way, checking off the client companies
   they're allowed to reach (and Read-only if appropriate).

### Step 7 — Connect Claude

1. In Claude, open **Settings → Connectors** (on a Team plan:
   **Organization settings → Connectors**, so the whole workspace gets it).
2. **Add custom connector**, and paste:

   ```
   https://your-app.up.railway.app/mcp
   ```

   No key in the URL — each person clicks **Connect** and signs in with the
   username/password you created for them, and Claude reaches only their
   assigned companies.
3. Ask Claude: *"List the QuickBooks clients we have connected."*

Full team instructions (written for your staff, shareable as-is):
[docs/TEAM-CONNECTOR-SETUP.md](docs/TEAM-CONNECTOR-SETUP.md). The dashboard
also shows these steps on its **Connect to Claude** card.

### Ongoing care

- **Updates:** your fork doesn't change until you sync it. On GitHub, click
  **Sync fork** when you want the latest; Railway redeploys automatically.
- **Backups:** everything lives on the `/data` volume — use Railway's volume
  backups. Losing it means re-authorizing every company.
- **QuickBooks re-authorization:** roughly every 100 days per company (an
  Intuit rule). The dashboard shows a countdown and a one-click
  **Reconnect** when it's due.

---

## Running it elsewhere (Docker)

Railway is the happy path, but it's a standard Node.js app with a Dockerfile
(`deploy/Dockerfile`), so any host that runs containers works:

```bash
docker build -f deploy/Dockerfile -t qbo-multi-connect .
docker run -d -p 3456:3456 -v qbo-data:/data \
  -e INTUIT_CLIENT_ID=... -e INTUIT_CLIENT_SECRET=... \
  qbo-multi-connect
docker logs <container> | grep -A2 "FIRST-RUN"   # grab the admin key
```

Each deployment is single-tenant (its own database, Intuit app, and keys) —
to serve multiple firms, run one instance per firm. See
[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) for provisioning and update
runbooks.

---

# For developers

Everything below is reference material for people working on or against the
code. If you just wanted the app running, you're done — the sections above
covered it.

## Local development

```bash
npm install
cp .env.example .env    # fill in Intuit credentials
npm run build
npm run server          # dashboard + API + MCP on http://localhost:3456
npm test                # vitest suite
```

For local QuickBooks connects, register `http://localhost:3456/callback` as
a redirect URI on your Intuit app (sandbox keys allow localhost).

### Programmatic Usage

```typescript
import { QBOManager } from 'qbo-multi-connect';

const qbo = new QBOManager({
  dbPath: './qbo-connections.db',
  encryptionKey: process.env.QBO_ENCRYPTION_KEY!,
  clientId: process.env.INTUIT_CLIENT_ID!,
  clientSecret: process.env.INTUIT_CLIENT_SECRET!,
  redirectUri: 'http://localhost:3456/callback',
  environment: 'sandbox', // or 'production'
});

// Connect a new client (opens OAuth flow)
const { authUrl } = await qbo.connect('Smith Corp');
// → Authorize in browser, tokens stored automatically

// List all connections
const connections = qbo.listConnections();

// Pull reports (auto-handles token refresh)
const pnl = await qbo.reports.profitAndLoss('realm_id', {
  startDate: '2026-01-01',
  endDate: '2026-03-31',
});

const bs = await qbo.reports.balanceSheet('realm_id', {
  asOfDate: '2026-03-31',
});

// Create journal entries
const je = await qbo.journalEntries.create('realm_id', {
  TxnDate: '2026-03-22',
  Line: [
    { Amount: 1000, DetailType: 'JournalEntryLineDetail', JournalEntryLineDetail: { PostingType: 'Debit', AccountRef: { value: '1' } } },
    { Amount: 1000, DetailType: 'JournalEntryLineDetail', JournalEntryLineDetail: { PostingType: 'Credit', AccountRef: { value: '2' } } },
  ],
});

// Query transactions
const invoices = await qbo.transactions.queryInvoices('realm_id', {
  since: '2026-01-01',
  limit: 100,
});

// Start proactive token refresh (checks every 5 min)
qbo.startRefreshDaemon();

// Cleanup
qbo.close();
```

### The server

`npm run server` starts everything on one port: the web dashboard, the REST
API, the OAuth callback handler, the MCP endpoint (`/mcp`), and the token
refresh daemon (every 5 minutes). Sign in at `http://localhost:3456` with a
username/password created on the Team tab, or with an API key via "Sign in
with an API key instead".

### CLI Usage

```bash
# Auth commands
npx qbo auth connect "Client Name"   # Opens OAuth flow in browser
npx qbo auth list                     # Show all connections + status
npx qbo auth refresh "Client Name"   # Force token refresh
npx qbo auth revoke "Client Name"    # Disconnect a client

# Query commands
npx qbo report "Client Name" pnl --start 2026-01-01 --end 2026-03-31
npx qbo report "Client Name" balance-sheet --as-of 2026-03-31
npx qbo query "Client Name" "SELECT * FROM Invoice WHERE TxnDate > '2026-01-01'"
npx qbo je create "Client Name" --file journal-entry.json
```

## Multi-User Access (Per-Member API Keys)

The server supports team members with their own API keys, each limited to an
assigned subset of connected companies. Authorization is enforced server-side
on every MCP tool call and REST request.

### How it works

- **Master key** (`QBO_API_KEY` in `.env`) — full access to every company plus
  team management. This is the admin key; existing setups keep working
  unchanged.
- **Member keys** — created from the dashboard's **Team** tab (or
  `POST /api/users`). Each member gets a `qbo_…` key and a checklist of
  assigned companies. Their key:
  - only lists and reaches assigned companies (MCP `list_clients`, all tools,
    and all `/api/company/...` routes);
  - returns *not found* for unassigned companies, so members can't discover
    client names or realm IDs they weren't given;
  - cannot manage users or connect/disconnect companies.
- **Admin-role members** — behave like the master key (all companies + team
  management) but with their own revocable key.

Keys are stored as SHA-256 hashes — the plaintext is shown exactly once at
creation (with a ready-made Claude connector URL) and can be rotated at any
time. Disabling a member stops their key immediately without deleting their
assignments.

### User management endpoints (admin key required)

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/me` | Who am I — role and visible companies for the presented key |
| `GET` | `/api/users` | List team members and their assignments |
| `POST` | `/api/users` | Create member (`{name, email?, role?, realmIds?}`); returns key once |
| `PATCH` | `/api/users/:id` | Update name/email/role/status and/or `realmIds` |
| `POST` | `/api/users/:id/rotate-key` | Invalidate old key, return new key once |
| `DELETE` | `/api/users/:id` | Remove member and revoke key |

### Migration

Existing databases are migrated automatically on startup (the new `users` and
`user_clients` tables are created if missing). Nothing changes for
single-user setups: the master key behaves exactly as before.

## REST API Endpoints

All API endpoints require authentication via the `Authorization` header with your API key:

```bash
Authorization: Bearer YOUR_API_KEY
```

Company data routes accept the master key or any member key assigned to that
company. Connection management (`auth-url`, `DELETE`) and `/api/users` routes
require an admin key.

### Connection Management

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/connections` | List all connected companies |
| `POST` | `/api/connections/auth-url` | Generate OAuth URL for new connection |
| `DELETE` | `/api/connections/:realmId` | Disconnect and revoke a company |

### Company Data

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/company/:realmId/info` | Get company information |
| `GET` | `/api/company/:realmId/accounts` | Get chart of accounts |
| `GET` | `/api/company/:realmId/invoices` | Query invoices |
| `GET` | `/api/company/:realmId/bills` | Query bills |
| `GET` | `/api/company/:realmId/vendors` | Query vendors |
| `GET` | `/api/company/:realmId/customers` | Query customers |
| `GET` | `/api/company/:realmId/query` | Execute custom QBO query |

### Reports

| Method | Endpoint | Description | Query Params |
|--------|----------|-------------|--------------|
| `GET` | `/api/company/:realmId/reports/pnl` | Profit & Loss | `startDate`, `endDate` |
| `GET` | `/api/company/:realmId/reports/balance-sheet` | Balance Sheet | `asOfDate` |
| `GET` | `/api/company/:realmId/reports/trial-balance` | Trial Balance | — |
| `GET` | `/api/company/:realmId/reports/ar-aging` | AR Aging | `asOfDate` (optional) |
| `GET` | `/api/company/:realmId/reports/ap-aging` | AP Aging | `asOfDate` (optional) |
| `GET` | `/api/company/:realmId/reports/general-ledger` | General Ledger | `startDate`, `endDate` (optional) |

### Journal Entries

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/company/:realmId/journal-entries` | Create a journal entry |

## MCP Tools — Bulk Corrections

The MCP server exposes two tool patterns for bulk editing that eliminate
manual reshaping round-trips.

### `get_<entity>` — fetch in update-ready shape

Nine tools return a record already shaped to pass directly to the
corresponding `update_<entity>` tool. No conversion of `ItemRef.value`,
no filtering subtotal lines — just fetch, modify one field, and push.

**Available:** `get_sales_receipt`, `get_invoice`, `get_bill`,
`get_journal_entry`, `get_expense`, `get_deposit`, `get_credit_memo`,
`get_estimate`, `get_purchase_order`

```jsonc
// get_sales_receipt returns:
{
  "id": "456",
  "sync_token": "3",
  "customer_id": "42",
  "txn_date": "2026-03-15",
  "deposit_account_id": "acct-checking",
  "payment_method_id": "pmt-method-1",
  "lines": [
    {
      "amount": 500,
      "description": "Consulting fee",
      "detail_type": "SalesItemLineDetail",
      "item_id": "svc-001",
      "item_name": "Advisory Services",
      "quantity": 1,
      "unit_price": 500
    }
  ]
}
```

Round-trip example — swap the item on one line:

```python
record = get_sales_receipt(client_name="Acme Corp", sales_receipt_id="456")
record["lines"][0]["item_id"] = "svc-002"
record["lines"][0]["item_name"] = "Consulting Services"
update_sales_receipt(client_name="Acme Corp", sales_receipt_id="456", lines=record["lines"])
```

`get_deposit` returns both `linked_payment_ids` (payments from Undeposited
Funds) and `deposit_lines` (direct income lines). Both must be passed on
round-trip to avoid accidentally returning payments to Undeposited Funds.

`get_deposit` pairs with `update_deposit`, which follows the same
read-modify-write pattern: header fields are sparse-merged, and when
`linked_payment_ids` and/or `deposit_lines` is provided the two arrays
together **replace all** existing lines — the deposit ends up with exactly
the submitted lines, never the submitted lines appended to the old ones.
(Appending would silently inflate a posted deposit, and QBO has no API to
remove a deposit line afterwards.) When neither array is passed, existing
lines are preserved untouched. Every write is verified against QBO after the
fact (line count + line total); on mismatch the tool rolls the deposit back
to its pre-update state, reports exactly what QBO shows, and warns not to
retry.

`get_expense` pairs with `update_expense`, which edits the original Purchase
in place (same ID, incremented SyncToken) rather than creating a correcting
entry. It auto-fetches the current record + SyncToken by ID, applies sparse
header changes, and replaces ALL lines when `lines` is provided:

```python
record = get_expense(client_name="Acme Corp", expense_id="789")
record["lines"][0]["expense_account_id"] = "63"   # reclassify the account
record["lines"][0]["amount"] = 250.00              # correct the amount
update_expense(
    client_name="Acme Corp",
    expense_id="789",
    private_note="Corrected account, amount, and class",
    lines=record["lines"],
)
```

### `swap_item_or_account` — bulk swap across many transactions

Swaps an item or account reference on every matching line across a list of
transactions in one call. Supports dry-run preview before committing.

```jsonc
// Dry-run: preview which of 60 sales receipts have the old item
swap_item_or_account(
  client_name="Acme Corp",
  old_id="OLD-FEE-ITEM-ID",
  new_id="NEW-FEE-ITEM-ID",
  id_type="item",
  transaction_ids=["sr-1", "sr-2", ..., "sr-60"],
  entity_types=["SalesReceipt"],
  dry_run=true,
  stop_on_error=true
)
// Returns per-transaction results with status="would_update" and lines_changed

// Commit after reviewing dry-run output
swap_item_or_account(... dry_run=false ...)
```

**Supported entity types:** `SalesReceipt`, `Invoice`, `Bill`, `Expense`,
`JournalEntry`, `CreditMemo`, `Deposit`

**Invalid combos (rejected up front):**
- `id_type="item"` + `JournalEntry` or `Deposit` — these use accounts, not items

**`stop_on_error` guidance:**
- `true` (default): halt on first failure — use when partial state is worse
  than total failure (reclassifications that feed reports, all-or-nothing sets)
- `false`: continue through all transactions — use when fixes are independent
  and making partial progress is acceptable

**Per-transaction result statuses:**
- `updated` — write succeeded
- `would_update` — dry-run match (no write)
- `no_match` — old_id not found in any line (no write)
- `failed` — error during fetch or update (includes `error` field)

### Example API Calls

```bash
# List all connections
curl -H "Authorization: Bearer YOUR_API_KEY" \
  http://localhost:3456/api/connections

# Get P&L for a company
curl -H "Authorization: Bearer YOUR_API_KEY" \
  "http://localhost:3456/api/company/REALM_ID/reports/pnl?startDate=2026-01-01&endDate=2026-03-31"

# Get chart of accounts
curl -H "Authorization: Bearer YOUR_API_KEY" \
  http://localhost:3456/api/company/REALM_ID/accounts

# Query invoices
curl -H "Authorization: Bearer YOUR_API_KEY" \
  "http://localhost:3456/api/company/REALM_ID/invoices?maxResults=100"

# Create journal entry
curl -X POST \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d @journal-entry.json \
  http://localhost:3456/api/company/REALM_ID/journal-entries

# Custom QBO query
curl -H "Authorization: Bearer YOUR_API_KEY" \
  "http://localhost:3456/api/company/REALM_ID/query?q=SELECT%20*%20FROM%20Invoice%20WHERE%20TxnDate%20%3E%20%272026-01-01%27"
```

## Configuration

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `INTUIT_CLIENT_ID` | Yes | — | Intuit Developer App client ID |
| `INTUIT_CLIENT_SECRET` | Yes | — | Intuit Developer App client secret |
| `QBO_DB_PATH` | No | `./qbo-connections.db` | SQLite database path |
| `QBO_ENCRYPTION_KEY` | No | auto-generated | 64-char hex key for token encryption (generated + persisted on first boot if unset) |
| `QBO_API_KEY` | No | auto-generated | Admin API key (generated + printed once in logs on first boot if unset) |
| `QBO_ENVIRONMENT` | No | `sandbox` | `sandbox` or `production` |
| `QBO_PORT` | No | `3456` | Server port |
| `QBO_PUBLIC_URL` | No | — | Pins the public origin. Unset = follow the domain each request uses |
| `QBO_ALLOWED_HOSTS` | No | — | Comma-separated hostnames this deployment answers on (`*.` wildcards ok) |
| `QBO_REDIRECT_URI` | No | derived | Pins the QuickBooks callback. Unset = `https://<domain in use>/callback` |

### Public URL & custom domains

The server has no hard-coded address. The OAuth issuer, the metadata Claude
discovers, the QuickBooks callback, and the upload endpoints are all derived
from the hostname each request arrives on — so pointing your own domain at the
deployment is a DNS change plus one redirect URI registered with Intuit, with
no redeploy and no downtime. The Railway address keeps working alongside it.
Full walkthrough: [`docs/CUSTOM-DOMAIN.md`](docs/CUSTOM-DOMAIN.md).

### Generating keys yourself (optional)

Both secrets self-provision on first boot, so most deployments never set
them. To manage them yourself (e.g. via a secret manager):

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Run it twice and set `QBO_ENCRYPTION_KEY` and `QBO_API_KEY`. **Never change
`QBO_ENCRYPTION_KEY` once companies are connected** — it decrypts the stored
QuickBooks tokens; changing it orphans every connection.

## Architecture

```
┌──────────────────────────────────────────┐
│         QBOManager (main export)         │
│  The primary interface for AI agents     │
├──────────┬───────────┬───────────────────┤
│ Auth     │ API       │ Connection        │
│ Service  │ Service   │ Registry          │
│          │           │                   │
│ • OAuth  │ • Reports │ • SQLite DB       │
│ • Tokens │ • JEs     │ • Encrypted store │
│ • Refresh│ • Queries │ • Status tracking │
└────┬─────┴─────┬─────┴──────┬────────────┘
     │           │            │
     └───────────┼────────────┘
                 │
          Intuit QBO API
```

**Design principle:** The programmatic API (`QBOManager`) is the primary interface. AI agents import it and call methods directly. The CLI is a thin convenience wrapper on top.

## Deployment notes

Deployment itself is covered up top ([Railway](#set-it-up-on-railway-from-scratch-no-coding)
and [Docker](#running-it-elsewhere-docker)). Details worth knowing:

- **Secrets self-provision.** If `QBO_API_KEY` and `QBO_ENCRYPTION_KEY` are
  unset, the server generates them on first boot, persists them next to the
  SQLite DB, and prints the admin key once in the logs. Set them explicitly
  only if you manage secrets yourself.
- **The Dockerfile lives at `deploy/Dockerfile`** — kept out of the repo root
  on purpose, so Railway's auto-detection uses its default Nixpacks build for
  repo deploys. To make Railway build the image instead, set
  `RAILWAY_DOCKERFILE_PATH=deploy/Dockerfile`.
- **Single-tenant by design.** One deployment = one firm (its own DB, Intuit
  app, and keys). To serve multiple firms, run one instance each — see
  [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) for provisioning and fleet-update
  runbooks.

## Security

- Tokens encrypted at rest with AES-256-GCM
- Encryption key from environment variable (never committed)
- Dashboard sign-in with per-user username/password (scrypt-hashed) and
  expiring server-side sessions; the master key remains a break-glass sign-in
- Member API keys authenticated by SHA-256 hash; an AES-256-GCM encrypted copy
  (same key that protects the OAuth tokens) lets each signed-in user view
  their own key and connector URL
- Per-client authorization enforced at name resolution *and* on every QBO API
  call (defense in depth)
- Per-member access level: read-only keys never expose the MCP write tools
  (create/update/delete never even appear in their tool list)
- Master key compared with a timing-safe equality check
- No tokens in log output
- Scopes limited to `com.intuit.quickbooks.accounting` (no payments, no payroll)
- `.env` excluded from git

## Token Lifecycle

| Token | Lifespan | Strategy |
|-------|----------|----------|
| Access Token | 60 minutes | Auto-refresh at 50 min or on-demand |
| Refresh Token | 100 days | Alert at 90 days; re-auth if expired |

The refresh daemon proactively refreshes tokens before expiry. If a refresh token expires, the connection status flips to `expired`. Use **Reconnect** on the company card (or generate a fresh auth URL for it) to re-authorize — this refreshes the tokens in place, keeping the same realm ID, so existing team-member assignments and any edited name are preserved. A company's display name can be changed anytime with **Edit name** (it's a local label, not pulled from QuickBooks).

## Intuit Developer App Setup

1. Go to [developer.intuit.com](https://developer.intuit.com)
2. Create a new app → Select "QuickBooks Online and Payments"
3. Under scopes, enable only **Accounting** (not Payments)
4. Add a redirect URI for every address the app runs on:
   `https://<your-deployment>/callback` for hosted instances,
   `http://localhost:3456/callback` for local development
5. Copy Client ID and Client Secret into your deployment's variables (or `.env` locally)
6. Start with Development (sandbox) keys; switch to Production keys — after
   Intuit's short production-approval questionnaire — when ready for real books

## License

**[PolyForm Noncommercial 1.0.0](LICENSE)** — this project is
source-available, not open source:

- **Free** for personal use, study, hobby projects, evaluation, and use by
  nonprofits, schools, and government bodies.
- **Commercial use requires a license** from the copyright holder — that
  includes running it for a business (yours or a client's), offering it to
  customers, or selling/hosting it as a product or service.

Want to use it commercially? Open a GitHub issue or contact the author —
commercial licensing is available.

Copyright © David Bearchell CPA, LLC
