# Handoff: Command Center Dashboard Redesign (qbo-multi-connect)

## Overview
A redesign of the qbo-multi-connect web dashboard (`src/server/public/`) in a **"command center"** style: a three-column split view replacing the current tabbed card grid. Left rail lists all connected QuickBooks companies with live status; center pane shows the selected company's detail (token health, team access, MCP connector); right rail shows a firm-wide activity feed. Chosen by the product owner from 10 explored directions (option "1j").

## About the Design Files
The file in this bundle (`command-center-reference.html`) is a **design reference created in HTML** — a static prototype showing intended look and layout, not production code to copy directly. The task is to **recreate this design in the existing codebase's environment**: a vanilla HTML + CSS + JS dashboard served from `src/server/public/` (`index.html`, `style.css`, `app.js`), with data from the existing REST API (`/api/connections`, `/api/users`, `/api/me`, etc.). Keep the existing patterns: CSS custom properties for tokens, `escapeHtml()` for all interpolated content, delegated `data-action` click handling, the modal engine, and toasts.

## Brand
This bundle was rethemed to the David Bearchell CPA brand (navy + teal, Inter +
Fraunces) so it matches what ships in `src/server/public/`. The palette and type
stack are in **Design Tokens** below; the reference HTML files and the
screenshots in `screenshots/` were regenerated from it.

Two places where the shipped app has since moved on from this reference, left
as-is here because they are structure rather than colour:
- The MCP connector card renders on the standard light card shell in the app, not
  the dark panel shown here.
- The app's rail footer carries a whoami line, a settings button and a
  light/dark theme toggle that this reference predates.

## Fidelity
**High-fidelity.** Colors, typography, spacing, and radii below are final. Recreate pixel-perfectly, adapting only where live data requires (list lengths, names, times).

## Layout (top level)
CSS grid, full viewport height: `grid-template-columns: 280px 1fr 270px; min-height: 100vh`.
- Page background `#ffffff`, text `#102a43`.
- Left rail: `border-right: 1px solid #d9e2ec`, flex column.
- Center pane: `padding: 26px 30px`.
- Right rail: `border-left: 1px solid #d9e2ec; padding: 22px 20px; background: #f0f4f8`.
- Responsive: below ~1100px collapse the activity rail (hide or move behind a toggle); below ~800px the client rail becomes a top drawer/select. (Prototype is desktop-only; use judgment.)

## Screens / Views

### 1. Left rail — client list
The rail is the app's **dark chrome**: `background: #102a43` (navy-900), white primary text, navy-200/300 for supporting copy, `#243b53` (navy-800) dividers, and accent-400 for anything interactive. A faint three-bar brand motif (accent-400 at 5% opacity) is anchored bottom-right.

- **Header** (`padding: 18px 18px 12px; border-bottom: 1px solid #243b53`): logo mark 28×28, `border-radius: 8px`, background `#4fd1c5`, "QB" 700 11px in `#0a1929`; wordmark "Multi-Connect" in Fraunces 700 14px, white; gap 10px.
- **Search input** (`margin: 12px 14px 8px`): `border: 1px solid #334e68; border-radius: 8px; padding: 7px 11px; font-size: 12.5px; background: #243b53; color: #fff`; placeholder `#9fb3c8`, "Find a client…". On focus the border goes transparent and a 2px `#4fd1c5` ring appears. Filters the list as you type.
- **Client rows** (column, gap 2px, `padding: 4px 10px`): each row is flex, gap 10px, `padding: 9px 10px; border-radius: 9px`:
  - Status dot 8×8 circle: active `#4fd1c5`, expired/warning `#e6b271`, revoked `#f4a3a3` (amber and red are lifted here so they read on navy).
  - Name: 13px; selected row weight 650 color `#4fd1c5`, others weight 500 color `#bcccdc`.
  - Right meta: token countdown in mono 10.5px `#9fb3c8` (e.g. "42m"); expired rows show a bold "!" in `#e6b271` instead.
  - **Selected row**: background `#243b53`, `border: 1px solid #334e68` (others have transparent border to avoid layout shift).
  - Hover (non-selected): background `#243b53`, name to `#7edce2`.
- **Add client button** pinned to bottom (`margin: auto 14px 16px`): `border: 1.5px dashed #486581; border-radius: 9px; padding: 10px; font-size: 12.5px; font-weight: 600; color: #bcccdc; background: transparent`. On hover the border and label go `#4fd1c5` over a `#243b53` fill. Label "+ Connect a client". Opens the existing add-company modal.

### 2. Center pane — company detail
- **Header row** (flex, space-between, margin-bottom 20px):
  - Company name: 23px, weight 700, `letter-spacing: -0.02em`.
  - Status pill next to name: `font-size: 10.5px; font-weight: 700; letter-spacing: 0.06em; border-radius: 999px; padding: 4px 11px`; uppercase label with 6px dot. Active: bg `#e7f2f1`, text `#0e6f68`, dot `#117c75`. Expired: bg `#fdf3e3`, text `#8a5a12`, dot `#b7791f`.
  - Subline: mono 12.5px `#486581` — "realm {realmId} · production".
  - Actions right (gap 8px): ghost buttons `border: 1px solid #9fb3c8; border-radius: 8px; padding: 8px 15px; font-size: 12.5px; font-weight: 600; background: #fff; color: #334e68` — "Test connection", "Edit name"; danger variant `border-color: #fecaca; color: #991b1b` — "Disconnect". Expired companies additionally get a primary "Reconnect" button (bg `#117c75`, white).
- **Two cards** side by side (grid 1fr 1fr, gap 12px, margin-bottom 14px). Card shell: `background: #fff; border: 1px solid #d9e2ec; border-radius: 12px; box-shadow: 0 1px 2px rgba(16,42,67,.06); padding: 18px 20px`. Card label (the eyebrow): 11.5px, 700, uppercase, `letter-spacing: 0.1em`, color `#117c75`, margin-bottom 10px.
  - **Token health card**: two labeled rows ("Access token" / "Refresh token"), label `#486581` 13px left, value 650 right (e.g. "renews in 42 min", "88 days left"); under each a progress bar `height: 5px; border-radius: 3px; background: #d9e2ec` with fill `#117c75` sized to remaining lifetime (access: fraction of 60 min; refresh: fraction of 100 days). Fill turns `#b7791f` under ~15% remaining.
  - **Team access card**: one row per user with access — avatar 26×26 circle (bg `#e7f2f1` text `#0e6f68` for members; bg `#d9e2ec` text `#243b53` for admins; initials 10px 700), name 13px 600, right meta 11px `#486581` ("member · qbo_k7Jw…" / "admin · all clients"). Bottom: dashed "Manage access" button (`border: 1px dashed #9fb3c8; border-radius: 8px; padding: 7px; font-size: 12px; font-weight: 600; color: #486581`) opening the existing manage-access modal.
- **MCP connector card** (dark): `background: #102a43; color: #ffffff; border-radius: 12px; padding: 18px 20px`. Label as above but `#4fd1c5` (the eyebrow takes the light end of the accent on navy). URL row: `background: #243b53; border-radius: 8px; padding: 9px 13px`, URL in mono 12px `#4fd1c5`, ellipsized, with a "Copy" button (`background: #334e68; color: #ffffff; border-radius: 6px; padding: 5px 12px; font-size: 11.5px; font-weight: 600`). Caption 11.5px `#9fb3c8` beneath. Only show a key-bearing URL to the signed-in user's own key context (never render other members' plaintext keys — those remain one-time reveals).

### 3. Right rail — activity feed
- Label styled like card labels (11.5px 700 uppercase `#486581`), margin-bottom 14px.
- Entries: column gap 14px; each is flex gap 10px — a 7×7 dot (top-margin 5px; green `#117c75` = token/connection events, blue `#243b53` = data access events, amber `#b7791f` = expiry warnings) beside title 12.5px 600 and meta line 11.5px `#486581` ("{who} · {company} · {relative time}").
- Data source: no activity endpoint exists yet. Either add a lightweight `/api/activity` (token refreshes from the refresh daemon, MCP tool calls, connect/disconnect, key rotations — most already pass through the server) or derive a partial feed client-side from `lastUsedAt`/token timestamps as a first pass.

### 4. Sign-in (see `signin-reference.html`)
Centered card on `#ffffff`: `background: #fff; border: 1px solid #d9e2ec; border-radius: 12px; padding: 40px 36px; max-width: 400px; text-align: center`.
- Logo 40×40, `border-radius: 10px`, bg `#117c75`, "QB" white 700 14px; margin-bottom 16px.
- Title "Multi-Connect" 20px 700 `letter-spacing: -0.02em`; subtitle 13.5px `#486581` ("Sign in with your API key to manage QuickBooks connections").
- Key input: full-width password field, `padding: 10px 13px; border: 1px solid #9fb3c8; border-radius: 8px; background: #f0f4f8; font-size: 13.5px`, **mono** (it's a key). Placeholder "Paste your API key".
- Primary button full-width: bg `#117c75`, white, `border-radius: 8px; padding: 10px 16px; font-size: 13.5px; font-weight: 600`.
- Hint: 11.5px `#486581`, line-height 1.7; inline `code` gets `background: #f0f4f8; padding: 1px 5px; border-radius: 4px` in Plex Mono. Error message (invalid key): 12.5px `#991b1b` below the button.

### 5. Team view (see `team-reference.html`)
Same three-column shell — **members replace clients in the left rail**, keeping one consistent select-in-rail / detail-in-center pattern. Admin-only.
- **Rail segmented toggle** under the logo header (`margin: 12px 14px 6px`): container `background: #243b53; border-radius: 8px; padding: 3px`; two equal segments "Clients" / "Team", 12.5px; active segment `background: #334e68; color: #4fd1c5; font-weight: 650; box-shadow: 0 1px 2px rgba(10,25,41,.35); border-radius: 6px`; inactive `color: #bcccdc; font-weight: 500`, hover `#7edce2`. This toggle also exists on the Clients screen. Hide the Team segment for non-admin members.
- **Member rows**: same geometry as client rows but with a 26×26 avatar circle (initials 10px 700; on the navy rail: member bg `#334e68`/`#4fd1c5`, admin bg `#d9e2ec`/`#243b53`, disabled bg `#243b53`/`#9fb3c8`); right meta 10.5px: "N clients" / "admin" in `#9fb3c8`, or "disabled" in `#f4a3a3` 700. Selected state identical to client rows. Bottom dashed button "+ Add a member".
- **Detail header**: member name 23px/700 + role pill (MEMBER: bg `#d9e2ec` text `#243b53`; ADMIN same palette; DISABLED: bg `#fef2f2` text `#b91c1c`); subline 12.5px `#486581` "email · added {month year}". Actions: ghost "Edit", "Disable"/"Enable"; danger "Remove".
- **API key card** (white card shell as before): rows "Key" → prefix chip in Plex Mono 12px on `#f0f4f8` `border-radius: 5px; padding: 2px 8px`; "Last used" → relative time 650; "Status" → dot + "Active" `#0e6f68` (or "Disabled" `#b91c1c`). Full-width ghost "Rotate key" button (opens confirm modal, then the one-time key modal).
- **Assigned clients card**: label "Assigned clients — N of M". Accent chips per client: `background: #e7f2f1; border: 1px solid #c0dedb; color: #0e6f68; font-size: 12px; font-weight: 600; border-radius: 999px; padding: 4px 12px` with 6px status dot. Full-width dashed "Edit assignments" button → existing checkbox-grid picker in a modal. Admins show a single "All clients" chip.
- **Member MCP connector card**: same dark card as the company screen, key masked after prefix (`qbo_k7Jw••••••••`) since plaintext is unrecoverable; caption notes the scope ("Scoped to her 3 assigned clients — she can't see or reach the other 7.").
- **Right rail**: activity filtered to this member.

### 6. Modals (see `modals-reference.html`)
Keep the existing modal engine; restyle. Backdrop `rgba(10,25,41,.55)`. Modal: `background: #fff; border: 1px solid #d9e2ec; border-radius: 12px`; widths ~440px (forms) to ~520px (key reveal). Header `padding: 16px 22px; border-bottom: 1px solid #d9e2ec`, title 15px 700, × close in `#486581` 20px. Body padding 22px. Footer buttons right-aligned, gap 10px (ghost Cancel + primary).
- **Connect a client**: label 12.5px 650; input styled like sign-in input; hint 11.5px `#486581`; primary CTA "Continue to QuickBooks →".
- **Member created / key rotated**: warning callout `background: #fdf3e3; border: 1px solid #f0dcb8; border-radius: 10px; padding: 14px 16px` — title 13px 700 `#8a5a12`, body 12.5px `#8a6a41` ("Save this key now…"). Key row: Plex Mono 12px on `#f0f4f8` bordered `#9fb3c8` r8, `word-break: break-all`, + ghost Copy. Connector URL row reuses the dark treatment: `background: #102a43; border-radius: 8px; padding: 9px 13px`, URL `#4fd1c5` Plex Mono ellipsized, Copy button `#334e68`. Primary "Done".
- **Settings**: no dedicated screen in this direction — keep the existing "your API key + sign out" content in a small modal (or a rail footer popover) using these modal styles. Toasts: white surface, `border: 1px solid #d9e2ec; border-left: 3px solid #117c75` (error: `#b91c1c`), `border-radius: 8px`.

## Interactions & Behavior
- Clicking a client row selects it → center pane re-renders for that company. Persist last-selected realmId in `localStorage`; default to first company (or the first expired one, to surface problems).
- Search filters rows by name/realmId substring, case-insensitive.
- Existing behaviors carry over: Test connection (company info modal), Edit name, Manage access, Reconnect (auth-url + new tab), Disconnect (confirm modal), 60s silent refresh poll, admin-only gating via `.admin-only` pattern (members see only assigned clients; hide Disconnect/Edit/Manage for them).
- Token countdowns in the rail and detail should tick client-side (re-render every 30–60s is fine).
- Hover states: rows `#f0f4f8`; ghost buttons darken border to `#9fb3c8` and text to `#102a43`; Copy button bg `#243b53`.
- Expired company: rail row shows amber dot + "!", detail header shows EXPIRED pill + Reconnect primary button; token bars empty/amber.

## State Management
- `connections` (existing) + `selectedRealmId` (new, persisted).
- `searchQuery` (new, transient).
- `users`/`me` (existing) — used to render the Team access card per company (`user.realmIds.includes(realm)`).
- Activity entries (new; see above).

## Design Tokens
The palette is the David Bearchell CPA brand: two scales, a desaturated **navy**
for structure, text and dark chrome, and a **teal accent** for calls to action,
links and highlights. Everything below is an alias onto them.

```
navy-50  #f0f4f8   navy-500 #627d98   navy-900 #102a43
navy-100 #d9e2ec   navy-600 #486581   navy-950 #0a1929
navy-200 #bcccdc   navy-700 #334e68
navy-300 #9fb3c8   navy-800 #243b53
navy-400 #829ab1

accent-300 #7edce2   accent-500 #38b2ac   accent-700 #0e6f68
accent-400 #4fd1c5   accent-600 #117c75   accent-800 #115e59
```

**Accent contrast rule — do not break this.** On light surfaces only
accent-600 and darker may carry text, icons or button fills; accent-500 and
lighter are decoration. On navy surfaces it inverts: accent-300/400 carry,
accent-600 is too dark to read.

Colors:
- Background page `#ffffff`; secondary panels and recessed fills `#f0f4f8`; surface `#ffffff`
- Borders: `#d9e2ec` (cards and dividers), `#627d98` (form fields), `#9fb3c8` (secondary controls, dashed)
- Text on light: primary `#102a43`, secondary `#334e68` / `#486581`, muted `#486581`
- Accent: primary `#117c75`, hover `#0e6f68`; tint `#117c75` @10% + border @22%; badge text `#0e6f68`
- Dark chrome (rail, dark cards): bg `#102a43`, inner `#243b53`, button `#334e68`, text `#ffffff`, muted `#9fb3c8`, accent `#4fd1c5`
- Warning amber: `#b7791f`; text `#8a5a12`; tint `#fdf3e3` + border `#f0dcb8`; on navy `#e6b271`
- Danger red (the only non-brand hue): text `#991b1b`, border `#fecaca`, fill `#b91c1c`, tint `#fef2f2`; on navy `#f4a3a3`
- Neutral badges (roles, disabled): `#243b53` on `#d9e2ec`; quiet variant `#486581` on `#f0f4f8`
- Data: primary series `#117c75` on light / `#4fd1c5` on dark; secondary `#627d98`, then `#9fb3c8`

Typography:
- UI font: **Inter Variable**, self-hosted, fallback `'Inter Variable', Inter, system-ui, -apple-system, sans-serif`
- Display: **Fraunces Variable**, `font-variation-settings: 'opsz' 72, 'SOFT' 0, 'WONK' 0`, bold, fallback `'Fraunces Variable', Fraunces, Georgia, 'Times New Roman', serif`. Page titles and section headings (h1/h2) only — h3 and smaller, buttons, labels, tables and nav are Inter.
- Mono: system stack (`ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`) for realm IDs, countdowns, connector URLs
- Scale: 23px/700 page title · 15px card titles · 13px body/rows · 12.5px buttons/meta · 11.5px captions/labels · 10.5px pills
- Eyebrow / small-caps section label: 11.5px 700 uppercase, `letter-spacing: 0.1em`, color `#117c75` on light, `#4fd1c5` on dark

Spacing & shape:
- Radii: 12px cards · 9px rail rows · 8px buttons/inputs · 999px pills · 50% avatars/dots
- Card padding 18–20px; pane padding 26–30px; row padding 9–10px; common gaps 8/10/12/14px
- Shadows: `0 1px 2px rgba(16,42,67,.06)` on cards; otherwise border-defined

## Assets
No image assets. The rail logo mark is a rounded square with "QB" text (28×28, `#4fd1c5` tile, `#0a1929` label); the favicon and the server-rendered pages use the brand mark proper — a `#102a43` rounded square with three rising bars in `#38b2ac`, `#4fd1c5` and `#ffffff`. Browser theme-color is `#102a43`. Fonts are self-hosted (see below). All dots/bars are plain CSS.

## Screenshots
PNG previews of each reference file are in `screenshots/` (`command-center.png`, `signin.png`, `team.png`, `modals.png`). The HTML files are the source of truth for exact values; screenshots are captured slightly scaled-down to fit.

## Files
- `command-center-reference.html` — main dashboard screen (client rail + company detail + activity).
- `signin-reference.html` — sign-in screen.
- `team-reference.html` — team view (member rail + member detail).
- `modals-reference.html` — connect-a-client and one-time key modals on backdrop.
- `screenshots/` — PNG previews of the above.
All HTML references use inline styles and load Inter/Fraunces from the app's own font directory (`../src/server/public/fonts/`), so they render correctly when opened from inside the repo; opened elsewhere they fall back to the system stacks. No Google Fonts request.
- Target files in the repo: `src/server/public/index.html`, `src/server/public/style.css`, `src/server/public/app.js`.
