# QBO Multi-Connect Server

Web dashboard and REST API for managing multiple QuickBooks Online company connections.

## Quick Start

```bash
# Start the server
npm run server

# Dashboard: http://localhost:3456
# API: http://localhost:3456/api
```

## Dashboard Features

### 1. **Companies Tab**
- View connected companies in a clean card layout (members see only their
  assigned companies)
- Real-time connection status (active/expired/revoked) and token expiry
- Quick actions:
  - **Test connection** - Fetch company info to verify connection
  - **Disconnect** - Revoke and remove connection (admin only)

### 2. **Team Tab** (admin only)
- Create team members with their own API keys
- Assign each member the specific client companies they may access
- Rotate, disable/enable, or revoke keys instantly
- Copy a ready-made Claude connector URL per member

### 3. **Connect Tab** (admin only)
- Generate OAuth authorization URLs
- Simple form to add new company connections
- Auto-redirect after authorization

### 4. **Settings Tab**
- View your API key (masked by default), copy to clipboard, sign out

## REST API

All API endpoints require Bearer token authentication:

```bash
Authorization: Bearer YOUR_API_KEY
```

### Endpoints

#### Connections

```bash
# List all connected companies
GET /api/connections

# Generate OAuth URL for new company
POST /api/connections/auth-url
Body: { "clientName": "Company Name" }

# Disconnect a company
DELETE /api/connections/:realmId
```

#### Company Data

```bash
# Get company info
GET /api/company/:realmId/info

# Get P&L report
GET /api/company/:realmId/reports/pnl?startDate=2026-01-01&endDate=2026-03-31

# Get balance sheet
GET /api/company/:realmId/reports/balance-sheet?asOfDate=2026-03-31

# Get trial balance
GET /api/company/:realmId/reports/trial-balance

# Get chart of accounts
GET /api/company/:realmId/accounts

# Raw QBO query
GET /api/company/:realmId/query?q=SELECT * FROM Account

# Create journal entry
POST /api/company/:realmId/journal-entries
Body: { JournalEntry object }

# Upload an attachment (multipart/form-data), optionally linked to an entity
POST /api/company/:realmId/attachments
Parts: file (the binary), entity_type + entity_id (optional, both or neither),
       note (optional), include_on_send (optional, "true")

# Health check
GET /health
```

### Bulk attachment upload (the file boundary)

The server runs remotely and shares no filesystem with callers — file bytes
reach it over HTTPS. An agent working with local files should:

1. Call the **`create_upload_session`** MCP tool → returns a one-hour,
   single-company upload token (`uplt_…`) plus ready-to-run curl commands.
   No API key needed — the token only works for uploading attachments to
   that one company.
2. Loop/parallelize the curl upload from the machine holding the files. One
   file per request; each returns a per-file JSON result, so failures are
   individually retryable.
3. Verify with `query_transactions` (`SELECT * FROM Attachable`).

The `get_server_info` MCP tool describes the boundary, limits, and endpoint;
`list_staging_files` shows what's staged server-side.

```bash
# Attach one scanned check image to Purchase 756 (token from create_upload_session)
curl -s -H "Authorization: Bearer $UPLOAD_TOKEN" \
  -F "file=@check-10259.png" \
  -F "entity_type=Purchase" -F "entity_id=756" \
  "$BASE/api/company/$REALM/attachments"
# → {"attachableId":"9001","fileName":"check-10259.png","size":148213,...}

# Batch: manifest.csv maps filepath,entity_type,entity_id — 8 parallel uploads
while IFS=, read -r f etype eid; do printf '%s\0%s\0%s\0' "$f" "$etype" "$eid"; done < manifest.csv | \
  xargs -0 -n 3 -P 8 sh -c 'curl -sS -H "Authorization: Bearer $UPLOAD_TOKEN" \
    -F "file=@$0" -F "entity_type=$1" -F "entity_id=$2" "$BASE/api/company/$REALM/attachments"; echo " <- $0"'
```

A write-capable API key also works in place of the upload token. MCP tools
`create_attachment` / `create_attachments_batch` handle server-reachable
sources directly (an https `file_url`, small inline base64, or a path inside
the server's staging directory `<data dir>/attachments`);
`delete_attachment` is the undo.

## Configuration

Add to your `.env` file:

```bash
QBO_API_KEY=your_generated_api_key
QBO_SERVER_PORT=3456
```

Generate a secure API key:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

## Example Usage

### List Connections

```bash
curl -H "Authorization: Bearer YOUR_API_KEY" \
  http://localhost:3456/api/connections
```

### Get Company Info

```bash
curl -H "Authorization: Bearer YOUR_API_KEY" \
  http://localhost:3456/api/company/REALM_ID/info
```

### Get P&L Report

```bash
curl -H "Authorization: Bearer YOUR_API_KEY" \
  "http://localhost:3456/api/company/REALM_ID/reports/pnl?startDate=2026-01-01&endDate=2026-03-31"
```

### Create Journal Entry

```bash
curl -X POST \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "Line": [
      {
        "Amount": 100,
        "DetailType": "JournalEntryLineDetail",
        "JournalEntryLineDetail": {
          "PostingType": "Debit",
          "AccountRef": { "value": "35" }
        }
      },
      {
        "Amount": 100,
        "DetailType": "JournalEntryLineDetail",
        "JournalEntryLineDetail": {
          "PostingType": "Credit",
          "AccountRef": { "value": "82" }
        }
      }
    ]
  }' \
  http://localhost:3456/api/company/REALM_ID/journal-entries
```

## Architecture

```
src/server/
├── index.ts              # Main server setup, OAuth callback
├── middleware.ts         # API key authentication
├── routes/
│   ├── connections.ts    # Connection management routes
│   └── company.ts        # Company data/report routes
└── public/
    ├── index.html        # Dashboard SPA
    ├── style.css         # Styles
    └── app.js            # Client-side JavaScript
```

## Features

✅ Single API key for agent authentication  
✅ Access any connected company with one key  
✅ Web dashboard for visual management  
✅ OAuth callback integrated into server  
✅ Clean, responsive UI with dark mode support  
✅ Auto-refresh connection status  
✅ Real-time token expiry tracking  
✅ Comprehensive error handling  
✅ CORS enabled for localhost development  

## Security Notes

- API key is stored in `.env` (never commit to git)
- Dashboard prompts for API key if not in localStorage
- All API requests require Bearer token
- OAuth tokens are encrypted in SQLite database
- HTTPS recommended for production deployments

## Production Deployment

1. Set `QBO_ENVIRONMENT=production` in `.env`
2. Use HTTPS reverse proxy (nginx, Caddy)
3. Set strong API key (64+ hex characters)
4. Restrict CORS origins
5. Consider rate limiting
6. Monitor token expiry and refresh

## Troubleshooting

**Dashboard shows "Please set your API key"**
- Enter your API key from `.env` when prompted
- Or add `?apiKey=YOUR_KEY` to URL (not recommended for production)

**API returns 401 Unauthorized**
- Check `Authorization: Bearer YOUR_API_KEY` header
- Verify API key matches `QBO_API_KEY` in `.env`

**Connection shows expired**
- Tokens auto-refresh when used (if refresh token valid)
- Disconnect and reconnect if refresh token expired

**Server won't start**
- Check port 3456 is available
- Verify all required env vars are set
- Run `npm install` to ensure dependencies installed
