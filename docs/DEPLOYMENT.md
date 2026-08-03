# Deployment & Operations (Model 1: one instance per customer)

This app is single-tenant by design: one deployment = one customer, with its
own database, its own Intuit app, and its own admin key. To serve multiple
customers you run a **separate instance per customer** — never multiple
customers on one instance (there's no tenant isolation inside a single DB).

This guide covers packaging (Docker), provisioning a new customer, and
rolling out updates across the fleet.

---

## What each customer instance needs

| Thing | Who provides it | Notes |
|---|---|---|
| A deployment (Railway service / container host) | You | One per customer |
| A **persistent volume** mounted at `/data` | You | Holds the SQLite DB + secrets. **Without it, data is lost on redeploy.** |
| Their own **Intuit app** (`INTUIT_CLIENT_ID` / `SECRET`) | The customer (or you, on their Intuit account) | Cannot be shared across customers |
| A redirect URI registered on the Intuit app | You | `https://<their-deployment-url>/callback`. The app derives this from the domain in use — you don't configure it, you just register it with Intuit. |
| Admin API key + encryption key | **Auto-generated on first boot** | Printed once in logs; stored on the volume |

Environment variables: see `.env.example`. Only the Intuit credentials and the
environment are required — the two secrets self-provision, and the public URL
is derived per request.

**Addresses are dynamic.** Nothing hard-codes the deployment's hostname: the
OAuth issuer, connector metadata, QuickBooks callback and upload endpoints all
follow whichever domain a request arrives on. That means a custom domain works
by pointing DNS at the service — no config change, no redeploy. See
[CUSTOM-DOMAIN.md](CUSTOM-DOMAIN.md). Leave `QBO_PUBLIC_URL` and
`QBO_REDIRECT_URI` unset unless you specifically want to pin one address.

---

## Packaging: Docker image

The repo ships a multi-stage Dockerfile at `deploy/Dockerfile`. It is kept
out of the repo root on purpose: Railway auto-builds a root `Dockerfile`,
and the main development deployment should keep using Railway's default
(Nixpacks) build. Build a versioned image:

```bash
docker build -f deploy/Dockerfile -t qbo-multi-connect:v0.1.0 .
```

Run it locally against a data volume:

```bash
docker run -d --name qbo-demo \
  -p 3456:3456 \
  -v qbo-demo-data:/data \
  -e INTUIT_CLIENT_ID=... \
  -e INTUIT_CLIENT_SECRET=... \
  -e QBO_REDIRECT_URI=http://localhost:3456/callback \
  -e QBO_ENVIRONMENT=sandbox \
  qbo-multi-connect:v0.1.0

docker logs qbo-demo | grep -A1 "Admin API key"   # grab the generated key
```

The image stores the SQLite DB and the auto-generated secrets under `/data`,
so the named volume is what makes the instance durable.

---

## Provisioning a new customer (runbook)

1. **Register their Intuit app** at developer.intuit.com (Accounting scope
   only). Take it through Intuit's production review when going live. Note the
   Client ID and Secret.
2. **Create the deployment.** On Railway: New Project → Deploy from the repo
   (or the image). For a repo deploy, set `RAILWAY_DOCKERFILE_PATH=deploy/Dockerfile`
   in the service variables so Railway builds the image; without it, Railway
   uses its default Nixpacks build (which also works — it runs the repo's
   npm scripts directly).
3. **Add a volume** mounted at `/data` (Railway: service → Volumes).
4. **Set env vars** on the service:
   - `INTUIT_CLIENT_ID`, `INTUIT_CLIENT_SECRET`
   - `QBO_ENVIRONMENT=production` (or `sandbox` for testing)
   - Leave `QBO_API_KEY` and `QBO_ENCRYPTION_KEY` **unset** — they generate.
   - Leave `QBO_PUBLIC_URL` / `QBO_REDIRECT_URI` **unset** — addresses follow
     the domain in use. Optionally set `QBO_ALLOWED_HOSTS` to the domains this
     instance answers on.
5. **Add the redirect URI** to the Intuit app's list of redirect URIs:
   `https://<the-service-url>/callback`, plus the same for any custom domain.
   The dashboard shows the exact value under **Connect to Claude → Server
   address & custom domain**, and the connect dialog prints the one it used.
6. **Deploy, then read the admin key** from the logs:
   `railway logs` → find the "FIRST-RUN SETUP → Admin API key" banner. It's
   also recoverable later from `/data/.qbo-secrets.json`.
7. **Hand off:** give the customer their dashboard URL and admin key. They sign
   in, connect their QBO companies (Companies → + Add company), and create
   team members.

Time per customer once you've done it once: ~30 minutes, most of it waiting on
Intuit app review.

---

## Updating the fleet (release & roll-out runbook)

Keep **one codebase / one image** for all customers. Never fork per customer.

**Additive schema changes** (new tables/columns) apply themselves on boot via
`CREATE TABLE IF NOT EXISTS`, so most updates need no migration step.
**Destructive changes** (renames, constraint changes, backfills) are NOT
automatic and must be treated as a deliberate, tested migration — test on a
copy of real data first.

Recommended flow:

1. **Build & tag** a new image: `docker build -f deploy/Dockerfile -t qbo-multi-connect:vX.Y.Z .`
2. **Test on your own instance first** (or a staging instance). Verify sign-in,
   an existing connection still reads, and any new feature works.
3. **Roll out in waves** — point a few customer services at the new tag,
   confirm they're healthy (`/health` + a real request), then the rest. Don't
   update everyone simultaneously.
4. **Roll back** if needed by re-pinning the previous tag and redeploying.

If instead you connect every customer service to auto-deploy from `main`, a
push updates everyone at once with no staging — fine for the first couple of
friendly customers, risky as you grow. Prefer versioned tags once you have real
customers depending on it.

---

## Backups

The whole state of an instance is the `/data` volume (SQLite DB + secrets).
Snapshot it on a schedule (Railway volume backups, or a cron that copies
`qbo-connections.db`). Losing the volume means re-authorizing every company and
losing the admin/encryption keys.

For higher durability or many instances, migrating from SQLite to Postgres is
the natural next step (out of scope here).

---

## Security notes

- Each instance's data is physically isolated (separate DB, separate volume).
- The encryption key never leaves the instance's volume.
- Per-member API keys are stored hashed; the master key lives only in the
  volume's secrets file (or env if you set it).
- Serve over HTTPS (Railway domains are HTTPS by default).
