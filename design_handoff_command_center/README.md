# Handoff: Command Center Dashboard Redesign (qbo-multi-connect)

## Overview
A redesign of the qbo-multi-connect web dashboard (`src/server/public/`) in a **"command center"** style: a three-column split view replacing the current tabbed card grid. Left rail lists all connected QuickBooks companies with live status; center pane shows the selected company's detail (token health, team access, MCP connector); right rail shows a firm-wide activity feed. Chosen by the product owner from 10 explored directions (option "1j").

## About the Design Files
The file in this bundle (`command-center-reference.html`) is a **design reference created in HTML** — a static prototype showing intended look and layout, not production code to copy directly. The task is to **recreate this design in the existing codebase's environment**: a vanilla HTML + CSS + JS dashboard served from `src/server/public/` (`index.html`, `style.css`, `app.js`), with data from the existing REST API (`/api/connections`, `/api/users`, `/api/me`, etc.). Keep the existing patterns: CSS custom properties for tokens, `escapeHtml()` for all interpolated content, delegated `data-action` click handling, the modal engine, and toasts.

## Fidelity
**High-fidelity.** Colors, typography, spacing, and radii below are final. Recreate pixel-perfectly, adapting only where live data requires (list lengths, names, times).

## Layout (top level)
CSS grid, full viewport height: `grid-template-columns: 280px 1fr 270px; min-height: 100vh`.
- Page background `#fbfbfa`, text `#20241f`.
- Left rail: `border-right: 1px solid #e8e8e4`, flex column.
- Center pane: `padding: 26px 30px`.
- Right rail: `border-left: 1px solid #e8e8e4; padding: 22px 20px; background: #f6f6f3`.
- Responsive: below ~1100px collapse the activity rail (hide or move behind a toggle); below ~800px the client rail becomes a top drawer/select. (Prototype is desktop-only; use judgment.)

## Screens / Views

### 1. Left rail — client list
- **Header** (`padding: 18px 18px 12px; border-bottom: 1px solid #eeeeea`): logo mark 28×28, `border-radius: 8px`, background `#256d47`, white "QB" 700 11px; wordmark "Multi-Connect" 700 14px; gap 10px.
- **Search input** (`margin: 12px 14px 8px`): `border: 1px solid #e3e3de; border-radius: 8px; padding: 7px 11px; font-size: 12.5px; background: #fff`; placeholder "Find a client…". Filters the list as you type.
- **Client rows** (column, gap 2px, `padding: 4px 10px`): each row is flex, gap 10px, `padding: 9px 10px; border-radius: 9px`:
  - Status dot 8×8 circle: active `#2a9560`, expired/warning `#dd9432`, revoked `#c0564f`.
  - Name: 13px; selected row weight 650 color `#20241f`, others weight 500 color `#4b544d`.
  - Right meta: token countdown in IBM Plex Mono 10.5px `#7d8a80` (e.g. "42m"); expired rows show a bold "!" in `#b9812e` instead.
  - **Selected row**: background `#eaf2ed`, `border: 1px solid #d6e6dc` (others have transparent border to avoid layout shift).
  - Hover (non-selected): background `#f1f1ed`.
- **Add client button** pinned to bottom (`margin: auto 14px 16px`): `border: 1.5px dashed #d4d4cd; border-radius: 9px; padding: 10px; font-size: 12.5px; font-weight: 600; color: #6d766f; background: transparent`. Label "+ Connect a client". Opens the existing add-company modal.

### 2. Center pane — company detail
- **Header row** (flex, space-between, margin-bottom 20px):
  - Company name: 23px, weight 700, `letter-spacing: -0.02em`.
  - Status pill next to name: `font-size: 10.5px; font-weight: 700; letter-spacing: 0.06em; border-radius: 999px; padding: 4px 11px`; uppercase label with 6px dot. Active: bg `#e5f2ea`, text `#22754c`, dot `#2a9560`. Expired: bg `#fbf1de`, text `#96631c`, dot `#dd9432`.
  - Subline: IBM Plex Mono 12.5px `#7d8a80` — "realm {realmId} · production".
  - Actions right (gap 8px): ghost buttons `border: 1px solid #e3e3de; border-radius: 8px; padding: 8px 15px; font-size: 12.5px; font-weight: 600; background: #fff; color: #3f463f` — "Test connection", "Edit name"; danger variant `border-color: #d99a9a; color: #b04343` — "Disconnect". Expired companies additionally get a primary "Reconnect" button (bg `#256d47`, white).
- **Two cards** side by side (grid 1fr 1fr, gap 12px, margin-bottom 14px). Card shell: `background: #fff; border: 1px solid #e8e8e4; border-radius: 12px; padding: 18px 20px`. Card label: 11.5px, 700, uppercase, `letter-spacing: 0.06em`, color `#7d8a80`, margin-bottom 10px.
  - **Token health card**: two labeled rows ("Access token" / "Refresh token"), label `#5a635b` 13px left, value 650 right (e.g. "renews in 42 min", "88 days left"); under each a progress bar `height: 5px; border-radius: 3px; background: #eef0ec` with fill `#2a9560` sized to remaining lifetime (access: fraction of 60 min; refresh: fraction of 100 days). Fill turns `#dd9432` under ~15% remaining.
  - **Team access card**: one row per user with access — avatar 26×26 circle (bg `#e5f2ea` text `#22754c` for members; bg `#e7ebf3` text `#40587e` for admins; initials 10px 700), name 13px 600, right meta 11px `#7d8a80` ("member · qbo_k7Jw…" / "admin · all clients"). Bottom: dashed "Manage access" button (`border: 1px dashed #d4d4cd; border-radius: 8px; padding: 7px; font-size: 12px; font-weight: 600; color: #6d766f`) opening the existing manage-access modal.
- **MCP connector card** (dark): `background: #20241f; color: #e8ebe6; border-radius: 12px; padding: 18px 20px`. Label as above but `#9aa59b`. URL row: `background: #2b302a; border-radius: 8px; padding: 9px 13px`, URL in IBM Plex Mono 12px `#c4dcc9`, ellipsized, with a "Copy" button (`background: #3c443b; color: #e8ebe6; border-radius: 6px; padding: 5px 12px; font-size: 11.5px; font-weight: 600`). Caption 11.5px `#9aa59b` beneath. Only show a key-bearing URL to the signed-in user's own key context (never render other members' plaintext keys — those remain one-time reveals).

### 3. Right rail — activity feed
- Label styled like card labels (11.5px 700 uppercase `#7d8a80`), margin-bottom 14px.
- Entries: column gap 14px; each is flex gap 10px — a 7×7 dot (top-margin 5px; green `#2a9560` = token/connection events, blue `#40587e` = data access events, amber `#dd9432` = expiry warnings) beside title 12.5px 600 and meta line 11.5px `#7d8a80` ("{who} · {company} · {relative time}").
- Data source: no activity endpoint exists yet. Either add a lightweight `/api/activity` (token refreshes from the refresh daemon, MCP tool calls, connect/disconnect, key rotations — most already pass through the server) or derive a partial feed client-side from `lastUsedAt`/token timestamps as a first pass.

### 4. Sign-in (see `signin-reference.html`)
Centered card on `#fbfbfa`: `background: #fff; border: 1px solid #e8e8e4; border-radius: 12px; padding: 40px 36px; max-width: 400px; text-align: center`.
- Logo 40×40, `border-radius: 10px`, bg `#256d47`, "QB" white 700 14px; margin-bottom 16px.
- Title "Multi-Connect" 20px 700 `letter-spacing: -0.02em`; subtitle 13.5px `#6d766f` ("Sign in with your API key to manage QuickBooks connections").
- Key input: full-width password field, `padding: 10px 13px; border: 1px solid #e3e3de; border-radius: 8px; background: #f6f6f3; font-size: 13.5px`, **IBM Plex Mono** (it's a key). Placeholder "Paste your API key".
- Primary button full-width: bg `#256d47`, white, `border-radius: 8px; padding: 10px 16px; font-size: 13.5px; font-weight: 600`.
- Hint: 11.5px `#7d8a80`, line-height 1.7; inline `code` gets `background: #f6f6f3; padding: 1px 5px; border-radius: 4px` in Plex Mono. Error message (invalid key): 12.5px `#b04343` below the button.

### 5. Team view (see `team-reference.html`)
Same three-column shell — **members replace clients in the left rail**, keeping one consistent select-in-rail / detail-in-center pattern. Admin-only.
- **Rail segmented toggle** under the logo header (`margin: 12px 14px 6px`): container `background: #efefeb; border-radius: 8px; padding: 3px`; two equal segments "Clients" / "Team", 12.5px; active segment `background: #fff; font-weight: 650; box-shadow: 0 1px 2px rgba(32,36,31,.08); border-radius: 6px`; inactive `color: #6d766f; font-weight: 500`. This toggle also exists on the Clients screen. Hide the Team segment for non-admin members.
- **Member rows**: same geometry as client rows but with a 26×26 avatar circle (initials 10px 700; member bg `#e5f2ea`/`#22754c`, admin bg `#e7ebf3`/`#40587e`); right meta 10.5px: "N clients" / "admin" in `#7d8a80`, or "disabled" in `#c0564f` 700. Selected state identical to client rows. Bottom dashed button "+ Add a member".
- **Detail header**: member name 23px/700 + role pill (MEMBER: bg `#e7ebf3` text `#40587e`; ADMIN same palette; DISABLED: bg `#f7e7e5` text `#c0564f`); subline 12.5px `#7d8a80` "email · added {month year}". Actions: ghost "Edit", "Disable"/"Enable"; danger "Remove".
- **API key card** (white card shell as before): rows "Key" → prefix chip in Plex Mono 12px on `#f6f6f3` `border-radius: 5px; padding: 2px 8px`; "Last used" → relative time 650; "Status" → dot + "Active" `#22754c` (or "Disabled" `#c0564f`). Full-width ghost "Rotate key" button (opens confirm modal, then the one-time key modal).
- **Assigned clients card**: label "Assigned clients — N of M". Green chips per client: `background: #eaf2ed; border: 1px solid #d6e6dc; color: #22754c; font-size: 12px; font-weight: 600; border-radius: 999px; padding: 4px 12px` with 6px status dot. Full-width dashed "Edit assignments" button → existing checkbox-grid picker in a modal. Admins show a single "All clients" chip.
- **Member MCP connector card**: same dark card as the company screen, key masked after prefix (`qbo_k7Jw••••••••`) since plaintext is unrecoverable; caption notes the scope ("Scoped to her 3 assigned clients — she can't see or reach the other 7.").
- **Right rail**: activity filtered to this member.

### 6. Modals (see `modals-reference.html`)
Keep the existing modal engine; restyle. Backdrop `rgba(28,32,27,.55)`. Modal: `background: #fff; border: 1px solid #e8e8e4; border-radius: 12px`; widths ~440px (forms) to ~520px (key reveal). Header `padding: 16px 22px; border-bottom: 1px solid #eeeeea`, title 15px 700, × close in `#7d8a80` 20px. Body padding 22px. Footer buttons right-aligned, gap 10px (ghost Cancel + primary).
- **Connect a client**: label 12.5px 650; input styled like sign-in input; hint 11.5px `#7d8a80`; primary CTA "Continue to QuickBooks →".
- **Member created / key rotated**: warning callout `background: #fbf5e8; border: 1px solid #f0dfc0; border-radius: 10px; padding: 14px 16px` — title 13px 700 `#8a6420`, body 12.5px `#8a7548` ("Save this key now…"). Key row: Plex Mono 12px on `#f6f6f3` bordered `#e3e3de` r8, `word-break: break-all`, + ghost Copy. Connector URL row reuses the dark treatment: `background: #20241f; border-radius: 8px; padding: 9px 13px`, URL `#c4dcc9` Plex Mono ellipsized, Copy button `#3c443b`. Primary "Done".
- **Settings**: no dedicated screen in this direction — keep the existing "your API key + sign out" content in a small modal (or a rail footer popover) using these modal styles. Toasts: white surface, `border: 1px solid #e8e8e4; border-left: 3px solid #2a9560` (error: `#c0564f`), `border-radius: 8px`.

## Interactions & Behavior
- Clicking a client row selects it → center pane re-renders for that company. Persist last-selected realmId in `localStorage`; default to first company (or the first expired one, to surface problems).
- Search filters rows by name/realmId substring, case-insensitive.
- Existing behaviors carry over: Test connection (company info modal), Edit name, Manage access, Reconnect (auth-url + new tab), Disconnect (confirm modal), 60s silent refresh poll, admin-only gating via `.admin-only` pattern (members see only assigned clients; hide Disconnect/Edit/Manage for them).
- Token countdowns in the rail and detail should tick client-side (re-render every 30–60s is fine).
- Hover states: rows `#f1f1ed`; ghost buttons darken border to `#d4d4cd` and text to `#20241f`; Copy button bg `#4a534a`.
- Expired company: rail row shows amber dot + "!", detail header shows EXPIRED pill + Reconnect primary button; token bars empty/amber.

## State Management
- `connections` (existing) + `selectedRealmId` (new, persisted).
- `searchQuery` (new, transient).
- `users`/`me` (existing) — used to render the Team access card per company (`user.realmIds.includes(realm)`).
- Activity entries (new; see above).

## Design Tokens
Colors:
- Background page `#fbfbfa`; rail tint `#f6f6f3`; surface `#ffffff`
- Borders: `#e8e8e4` (main), `#eeeeea` (subtle), `#e3e3de` (inputs)
- Text: primary `#20241f`, secondary `#4b544d` / `#5a635b`, muted `#6d766f` / `#7d8a80`
- Brand green: primary `#256d47`; status green `#2a9560`; selected tint `#eaf2ed` + border `#d6e6dc`; pill tint `#e5f2ea` + text `#22754c`
- Warning amber: `#dd9432`; text `#96631c` / `#b9812e`; tint `#fbf1de`
- Danger: text `#b04343`, border `#d99a9a`
- Admin blue: `#40587e` on `#e7ebf3`
- Dark card: bg `#20241f`, inner `#2b302a`, button `#3c443b`, text `#e8ebe6`, muted `#9aa59b`, mono accent `#c4dcc9`

Typography:
- UI font: **Instrument Sans** (Google Fonts; weights 400/500/600/700), fallback `-apple-system, sans-serif`
- Mono: **IBM Plex Mono** (400/500/600) for realm IDs, countdowns, connector URLs
- Scale: 23px/700 page title · 15px card titles · 13px body/rows · 12.5px buttons/meta · 11.5px captions/labels · 10.5px pills

Spacing & shape:
- Radii: 12px cards · 9px rail rows · 8px buttons/inputs · 999px pills · 50% avatars/dots
- Card padding 18–20px; pane padding 26–30px; row padding 9–10px; common gaps 8/10/12/14px
- Shadows: none (flat, border-defined)

## Assets
No image assets. Logo mark is a rounded square with "QB" text (28×28, `#256d47`). Fonts loaded from Google Fonts. All dots/bars are plain CSS.

## Screenshots
PNG previews of each reference file are in `screenshots/` (`command-center.png`, `signin.png`, `team.png`, `modals.png`). The HTML files are the source of truth for exact values; screenshots are captured slightly scaled-down to fit.

## Files
- `command-center-reference.html` — main dashboard screen (client rail + company detail + activity).
- `signin-reference.html` — sign-in screen.
- `team-reference.html` — team view (member rail + member detail).
- `modals-reference.html` — connect-a-client and one-time key modals on backdrop.
- `screenshots/` — PNG previews of the above.
All HTML references are self-contained (Google Fonts + inline styles) — open directly in any browser.
- Target files in the repo: `src/server/public/index.html`, `src/server/public/style.css`, `src/server/public/app.js`.
