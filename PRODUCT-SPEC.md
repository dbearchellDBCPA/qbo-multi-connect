# QBO Multi-Client Connection Tool — Project Spec

> **Status:** Draft — awaiting David's review before scaffolding.
> **Date:** 2026-03-22

---

## Problem

CPA firms managing dozens of QBO companies need programmatic API access across all of them. Current options:

- **Maton** — requires QBO Payments active on each company. Most bookkeeping clients don't have it. Dead end.
- **Manual OAuth per company** — tedious, no centralized token management, no refresh automation.
- **Intuit's own tools** — designed for single-company SaaS apps, not multi-tenant accounting firms.

## Solution

A self-hosted tool that:
1. Registers as a single Intuit Developer App (accounting scopes only)
2. Generates per-company OAuth authorization links
3. Handles callbacks, stores tokens securely, and auto-refreshes them
4. Provides a clean API layer for common QBO operations
5. Scales to 90+ client companies

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────┐
│                    CLI / Web UI                       │
│            (generate auth links, manage              │
│             connections, trigger operations)          │
└──────────────┬──────────────────────┬────────────────┘
               │                      │
       ┌───────▼───────┐    ┌────────▼────────┐
       │  Auth Service  │    │  API Service     │
       │                │    │                  │
       │ • OAuth flow   │    │ • Query txns     │
       │ • Token store  │    │ • Pull reports   │
       │ • Auto-refresh │    │ • Post JEs       │
       │ • Callback     │    │ • CRUD operations│
       └───────┬───────┘    └────────┬────────┘
               │                      │
       ┌───────▼──────────────────────▼────────┐
       │         Connection Registry            │
       │                                        │
       │  client_name | realm_id | tokens |     │
       │  last_refresh | status | scopes        │
       └───────────────────┬───────────────────┘
                           │
                    ┌──────▼──────┐
                    │   Intuit    │
                    │  QBO API    │
                    │  (OAuth 2)  │
                    └─────────────┘
```

## Design Principle

**The programmatic API is the primary interface.** The `QBOManager` class is the main export — AI agents import it and call methods directly. The CLI is a thin convenience wrapper built on top of the same API. Every feature is API-first, CLI-second.

## Components

### 1. Intuit Developer App (Manual Setup)
- Register at developer.intuit.com
- Scopes: `com.intuit.quickbooks.accounting` (NO payments scope)
- Redirect URI: `http://localhost:{PORT}/callback` (dev) / production URL later
- Environment: Sandbox first, then production keys

### 2. Auth Service
- **Generate auth link** — builds the Intuit OAuth URL for a specific company connection
- **Handle callback** — receives the auth code, exchanges for access + refresh tokens
- **Store tokens** — encrypted at rest (AES-256 or system keychain)
- **Auto-refresh** — access tokens expire every 60 min; refresh tokens every 100 days
- **Refresh daemon** — proactively refreshes tokens before expiry (not just on-demand)

### 3. Connection Registry
- SQLite database (simple, portable, no server dependency)
- Schema:
  ```sql
  CREATE TABLE connections (
    id            INTEGER PRIMARY KEY,
    client_name   TEXT NOT NULL,
    realm_id      TEXT NOT NULL UNIQUE,
    access_token  TEXT NOT NULL,  -- encrypted
    refresh_token TEXT NOT NULL,  -- encrypted
    token_expiry  DATETIME NOT NULL,
    refresh_expiry DATETIME NOT NULL,
    scopes        TEXT NOT NULL,
    status        TEXT DEFAULT 'active',  -- active | expired | revoked
    created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at    DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  ```

### 4. API Service
Common operations wrapped in clean functions:
- **Reports** — P&L, Balance Sheet, Trial Balance, AR/AP Aging
- **Transactions** — query invoices, bills, payments, expenses
- **Journal Entries** — create, read (key for intercompany work)
- **Accounts** — chart of accounts, account balances
- **Company Info** — metadata, fiscal year, preferences

### 5. CLI Interface
```bash
qbo auth connect "Client Name"    # Opens browser for OAuth
qbo auth list                      # Show all connections + status
qbo auth refresh "Client Name"    # Force token refresh
qbo auth revoke "Client Name"     # Disconnect

qbo query "Client Name" invoices --since 2026-01-01
qbo report "Client Name" profit-and-loss --period "Jan 2026"
qbo je create "Client Name" --file journal-entry.json
```

### 6. Web UI (Phase 2)
- Dashboard showing all connected companies + token health
- One-click auth link generation
- Operation triggers with previews
- Could serve as the productized frontend later

---

## Tech Stack

| Layer | Choice | Rationale |
|-------|--------|-----------|
| Language | **TypeScript (Node.js)** | David's stack, OpenClaw ecosystem, npm packaging |
| HTTP Server | **Fastify** | Lightweight, fast, good for OAuth callback handling |
| Database | **SQLite (via better-sqlite3)** | Zero-config, portable, sufficient for token registry |
| Encryption | **Node crypto (AES-256-GCM)** | Tokens encrypted at rest, key from env var or keychain |
| QBO SDK | **node-quickbooks** or raw REST | SDK is dated; raw REST with typed wrappers may be cleaner |
| CLI | **Commander.js** | Standard Node CLI framework |
| Auth | **Intuit OAuth 2.0** | Standard flow, well-documented |

## Security

- **Tokens encrypted at rest** — never stored in plaintext
- **Encryption key** — environment variable or macOS Keychain
- **No tokens in logs** — redacted in all output
- **HTTPS in production** — OAuth callback must be HTTPS for production Intuit apps
- **Scopes minimized** — accounting only, no payments, no payroll
- **.env excluded from git** — secrets never committed

## OAuth Flow (per company)

```
1. David runs: qbo auth connect "Smith Corp"
2. Tool builds Intuit auth URL with state=smith-corp
3. Browser opens → David (or client) logs into QBO, authorizes
4. Intuit redirects to localhost callback with auth code
5. Tool exchanges code for access_token + refresh_token
6. Tokens encrypted and stored in SQLite with realm_id
7. Connection confirmed, ready for API calls
```

**Key detail:** The person authorizing must be an admin on the QBO company. For David's clients, David is typically added as an accountant user, which has sufficient permissions.

## Token Lifecycle

| Token | Lifespan | Strategy |
|-------|----------|----------|
| Access Token | 60 minutes | Refresh proactively at 50 min; refresh on-demand if expired |
| Refresh Token | 100 days | Alert at 90 days; re-auth required if expired |

A background job (or cron) checks token health and refreshes proactively. If a refresh token expires, the connection status flips to `expired` and David gets notified.

---

## Phases

### Phase 1 — Core (MVP)
- [ ] Intuit Developer App registration
- [ ] OAuth flow (connect, callback, token exchange)
- [ ] SQLite connection registry with encryption
- [ ] Token auto-refresh
- [ ] CLI: `connect`, `list`, `refresh`, `revoke`
- [ ] Basic API wrapper: company info, P&L, balance sheet

### Phase 2 — Operations
- [ ] Full report suite (TB, AR/AP aging, GL)
- [ ] Journal entry creation
- [ ] Transaction queries with filters
- [ ] Batch operations across multiple companies
- [ ] Export to CSV/JSON

### Phase 3 — Productization
- [ ] Web dashboard UI
- [ ] Multi-user support (not just David)
- [ ] Hosted OAuth callback (not localhost)
- [ ] API key management for external consumers
- [ ] Documentation + onboarding flow
- [ ] npm package or Docker deployment

---

## Repo Structure (Proposed)

```
qbo-multi-connect/
├── src/
│   ├── auth/
│   │   ├── oauth.ts          # OAuth URL generation, token exchange
│   │   ├── callback.ts       # HTTP callback handler
│   │   ├── token-store.ts    # Encrypted token storage
│   │   └── refresh.ts        # Token refresh logic
│   ├── api/
│   │   ├── client.ts         # QBO API client (handles auth headers)
│   │   ├── reports.ts        # Report endpoints
│   │   ├── journal-entries.ts
│   │   ├── transactions.ts
│   │   └── accounts.ts
│   ├── db/
│   │   ├── schema.sql
│   │   ├── connection.ts     # DB connection + migrations
│   │   └── models.ts         # TypeScript types for DB records
│   ├── cli/
│   │   ├── index.ts          # CLI entry point
│   │   ├── auth-commands.ts
│   │   └── query-commands.ts
│   ├── crypto/
│   │   └── encrypt.ts        # AES-256-GCM encrypt/decrypt
│   └── config.ts             # App configuration
├── tests/
├── .env.example
├── .gitignore
├── package.json
├── tsconfig.json
└── README.md
```

---

## Open Questions

1. **QBO SDK vs raw REST?** — The `node-quickbooks` npm package exists but is dated (last major update 2023). Raw REST with typed wrappers gives more control. Leaning raw REST.

2. **Localhost vs hosted callback?** — Localhost works for Phase 1 (David connecting his own clients). Production/productization needs a hosted endpoint. Could use a simple Cloudflare tunnel for interim.

3. **How to handle client authorization?** — David can auth most clients himself (he's added as accountant). For clients who want to self-serve, we'd need a hosted auth flow (Phase 3).

4. **Integration with OpenClaw?** — Should this expose an API that Dwight can call directly? Or CLI-only with Dwight shelling out? CLI-first is simpler; API server can come in Phase 2.

5. **Intuit app review?** — Production apps with >50 connections may need Intuit review. Worth checking their current thresholds.

---

## Notes

- This replaces the Maton dependency entirely
- Same Intuit app can be used for the intercompany JE tool (different repo, shared auth)
- The intercompany app (`qbo-intercompany`) could become a consumer of this tool's connection registry
