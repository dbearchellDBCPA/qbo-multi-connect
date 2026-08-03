// ── State ────────────────────────────────────────────────────────────────────
// Bearer credential for API calls: a session token (qbos_…) from a
// username/password sign-in, or an API key from the fallback key sign-in.
let authToken = '';
// The caller's own API key, fetched from /api/me/key after sign-in — used to
// display the MCP connector URL. Null when not retrievable (legacy key).
let myApiKey = null;
let myKeyPrefix = null;
let me = null; // { kind, userId, name, role, allClients, canWrite, username, hasPassword, clients }
// Admin-only: what address this deployment reports for itself, and how it
// worked that out. Drives the "Server address" panel and its warnings when a
// custom domain is in play. Null until loaded (or for non-admins).
let serverUrl = null;
let connections = [];
let users = [];
let connectionsLoaded = false;
let usersLoaded = false;
let connectionsError = '';
let usersError = '';
let view = 'clients'; // 'clients' | 'team'
let selectedRealmId = null; // persisted in localStorage
let selectedUserId = null;
let searchQuery = '';
let refreshTimer = null;
let tickTimer = null;

// Intuit token lifetimes: access ~60 minutes, refresh ~100 days. Used to size
// the token-health bars and to approximate activity timestamps client-side.
const ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000;
const REFRESH_TOKEN_TTL_MS = 100 * 24 * 60 * 60 * 1000;

const $ = (id) => document.getElementById(id);

// ── Theme (light/dark) ───────────────────────────────────────────────────────
const MOON_ICON =
  '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>';
const SUN_ICON =
  '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>';

function effectiveTheme() {
  const attr = document.documentElement.getAttribute('data-theme');
  if (attr === 'light' || attr === 'dark') return attr;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function updateThemeIcon() {
  const isDark = effectiveTheme() === 'dark';
  // Show the icon for what a click switches TO.
  document.querySelectorAll('.theme-toggle').forEach((btn) => {
    btn.innerHTML = isDark ? SUN_ICON : MOON_ICON;
    btn.setAttribute('aria-label', isDark ? 'Switch to light theme' : 'Switch to dark theme');
  });
}

function toggleTheme() {
  const next = effectiveTheme() === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem('qbo_theme', next);
  updateThemeIcon();
}

function initTheme() {
  // The inline <head> script already applied any saved preference before paint;
  // here we just sync the toggle icons to the current effective theme.
  updateThemeIcon();
  window
    .matchMedia('(prefers-color-scheme: dark)')
    .addEventListener('change', updateThemeIcon);
}

// ── Helpers ──────────────────────────────────────────────────────────────────
// Escapes for BOTH element and attribute contexts — quotes must be covered
// because callers interpolate into data-* and value="" attributes.
function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function toast(message, type = 'info') {
  const el = document.createElement('div');
  el.className = `toast${type === 'error' ? ' toast-error' : ''}`;
  el.textContent = message;
  $('toast-container').appendChild(el);
  setTimeout(() => el.remove(), 4200);
}

async function copyText(text, label = 'Copied to clipboard') {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
    } else {
      // navigator.clipboard is unavailable over plain HTTP (e.g. a LAN
      // deployment) — fall back to the legacy selection-based copy.
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      const ok = document.execCommand('copy');
      textarea.remove();
      if (!ok) throw new Error('copy rejected');
    }
    toast(label);
  } catch {
    toast('Could not copy automatically — select the text and copy manually', 'error');
  }
}

function relativeTime(date) {
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return '—';
  const diffMs = d.getTime() - Date.now();
  const abs = Math.abs(diffMs);
  const minutes = Math.round(abs / 60000);
  const hours = Math.round(minutes / 60);
  const days = Math.round(hours / 24);
  let span;
  if (minutes < 1) span = 'moments';
  else if (minutes < 60) span = `${minutes} min`;
  else if (hours < 24) span = `${hours} hr`;
  else span = `${days} day${days === 1 ? '' : 's'}`;
  return diffMs >= 0 ? `in ${span}` : `${span} ago`;
}

function monthYear(date) {
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
}

function initials(name) {
  const parts = String(name ?? '').trim().split(/\s+/).filter(Boolean);
  return (parts.slice(0, 2).map((p) => p[0]).join('') || '?').toUpperCase();
}

function firstName(name) {
  return String(name ?? '').trim().split(/\s+/)[0] || '';
}

function clamp01(n) {
  return Math.min(1, Math.max(0, Number.isFinite(n) ? n : 0));
}

// A connection whose access token lapsed counts as expired for display even
// if the stored status is still "active" (the refresh daemon should have
// renewed it — if it didn't, something needs attention).
function derivedStatus(conn) {
  let status = conn.status;
  if (status === 'active' && new Date(conn.tokenExpiry) < new Date()) status = 'expired';
  return status;
}

// Compact countdown for the rail: "42m", "<1m", "2h".
function railCountdown(conn) {
  const ms = new Date(conn.tokenExpiry).getTime() - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const minutes = Math.floor(ms / 60000);
  if (minutes < 1) return '<1m';
  if (minutes < 100) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h`;
}

function ownConnectorUrl() {
  return myApiKey ? `${window.location.origin}/mcp?key=${encodeURIComponent(myApiKey)}` : null;
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      Authorization: `Bearer ${authToken}`,
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {}),
    },
  });
  if (response.status === 401) {
    signOut(true);
    throw new Error('Your API key is no longer valid. Please sign in again.');
  }
  if (response.status === 403) {
    // Role may have changed since sign-in (e.g. admin demoted) — re-fetch
    // identity so view gating catches up.
    refreshIdentity();
  }
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(data?.message || `Request failed (HTTP ${response.status})`);
  }
  return data;
}

// ── Auth / boot ──────────────────────────────────────────────────────────────
function showAuthScreen(errorMessage) {
  $('auth-screen').hidden = false;
  $('app').hidden = true;
  const errorEl = $('auth-error');
  errorEl.hidden = !errorMessage;
  errorEl.textContent = errorMessage || '';
}

function applyIdentity() {
  const isAdmin = me.role === 'admin';
  document.querySelectorAll('.admin-only').forEach((el) => {
    el.hidden = !isAdmin;
  });
  // If the caller just lost admin (demoted mid-session), leave the Team view.
  if (!isAdmin && view === 'team') view = 'clients';
}

async function refreshIdentity() {
  try {
    me = await api('/api/me');
    applyIdentity();
    renderAll();
  } catch {
    // 401 inside api() already routes to signOut; anything else is transient
  }
}

// Fetch the caller's own API key so the connector URL can render. Null when
// the key predates retrievable storage (it backfills on its next key auth).
async function loadMyKey() {
  const sessionToken = authToken;
  try {
    const data = await api('/api/me/key');
    if (sessionToken !== authToken) return;
    myApiKey = data.apiKey || null;
    myKeyPrefix = data.keyPrefix || null;
  } catch {
    if (sessionToken !== authToken) return;
    myApiKey = null;
  }
  renderAll();
}

// Admin-only: the deployment's own view of its public address. Used so the
// connector URL and Intuit callback shown here are the ones the server will
// actually hand out, even when QBO_PUBLIC_URL pins them elsewhere.
async function loadServerUrl() {
  const sessionToken = authToken;
  try {
    const data = await api('/api/server-url');
    if (sessionToken !== authToken) return;
    serverUrl = data;
  } catch {
    if (sessionToken !== authToken) return;
    serverUrl = null; // non-admin or older server — fall back to the browsed origin
  }
  renderAll();
}

async function initApp() {
  me = await api('/api/me');
  $('auth-screen').hidden = true;
  $('app').hidden = false;

  applyIdentity();
  selectedRealmId = localStorage.getItem('qbo_selected_realm') || null;
  renderAll();
  await Promise.all([
    loadData(false),
    loadMyKey(),
    ...(me.role === 'admin' ? [loadServerUrl()] : []),
  ]);

  clearInterval(refreshTimer);
  refreshTimer = setInterval(() => loadData(true).catch(() => {}), 60000);
  // Token countdowns tick client-side between data polls.
  clearInterval(tickTimer);
  tickTimer = setInterval(() => {
    if (!document.hidden && me) renderAll();
  }, 30000);
}

// Username/password sign-in → server-issued session token.
async function handleSignIn(event) {
  event.preventDefault();
  const data = new FormData(event.target);
  const username = data.get('username')?.trim();
  const password = data.get('password');
  if (!username || !password) return;
  try {
    const response = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const result = await response.json().catch(() => null);
    if (!response.ok) throw new Error(result?.message || 'Sign-in failed');
    authToken = result.token;
    await initApp();
    localStorage.setItem('qbo_auth', authToken);
    event.target.reset();
  } catch (err) {
    authToken = '';
    showAuthScreen(err.message || 'Sign-in failed');
  }
}

// Fallback: sign in directly with an API key (first-time setup with the
// master key, or recovery when no password is set yet).
async function handleKeySignIn(event) {
  event.preventDefault();
  const candidate = new FormData(event.target).get('apiKey')?.trim();
  if (!candidate) return;
  authToken = candidate;
  try {
    await initApp();
    localStorage.setItem('qbo_auth', authToken);
    event.target.reset();
  } catch (err) {
    authToken = '';
    showAuthScreen(err.message || 'Sign-in failed');
  }
}

function toggleAuthMode() {
  const keyForm = $('auth-key-form');
  const passwordForm = $('auth-form');
  const showKeyForm = keyForm.hidden;
  keyForm.hidden = !showKeyForm;
  passwordForm.hidden = showKeyForm;
  $('auth-mode-toggle').textContent = showKeyForm
    ? 'Sign in with username & password instead'
    : 'Sign in with an API key instead';
  const errorEl = $('auth-error');
  errorEl.hidden = true;
  errorEl.textContent = '';
}

function signOut(expired = false) {
  // Server-side sessions are revoked best-effort; API-key bearers have no
  // server-side session to end.
  if (authToken.startsWith('qbos_')) {
    fetch('/api/auth/logout', {
      method: 'POST',
      headers: { Authorization: `Bearer ${authToken}` },
    }).catch(() => {});
  }
  authToken = '';
  myApiKey = null;
  myKeyPrefix = null;
  me = null;
  serverUrl = null;
  users = [];
  connections = [];
  connectionsLoaded = false;
  usersLoaded = false;
  connectionsError = '';
  usersError = '';
  view = 'clients';
  selectedRealmId = null;
  selectedUserId = null;
  searchQuery = '';
  localStorage.removeItem('qbo_auth');
  localStorage.removeItem('qbo_api_key'); // pre-password-login storage slot
  localStorage.removeItem('qbo_selected_realm');
  clearInterval(refreshTimer);
  clearInterval(tickTimer);
  // Scrub everything the previous session rendered — the next sign-in on a
  // shared machine must not be able to read the old key or team roster.
  $('rail-list').innerHTML = '';
  $('detail').innerHTML = '';
  $('activity-list').innerHTML = '';
  $('whoami').textContent = '';
  $('search-input').value = '';
  closeModal();
  showAuthScreen(expired ? 'Your session expired. Sign in again.' : undefined);
}

// ── Data loading ─────────────────────────────────────────────────────────────
async function loadData(silent) {
  const jobs = [loadConnections(silent)];
  if (me?.role === 'admin') jobs.push(loadUsers(silent));
  await Promise.all(jobs);
}

async function loadConnections(silent = false) {
  const sessionToken = authToken;
  try {
    const data = await api('/api/connections');
    // Discard responses from a session that ended while the request was in
    // flight — the old credential may still be valid server-side, so a stale
    // poll would otherwise repopulate state the next sign-in could render.
    if (sessionToken !== authToken) return;
    connections = data;
    connectionsLoaded = true;
    connectionsError = '';
  } catch (err) {
    if (sessionToken !== authToken) return;
    connectionsLoaded = true;
    if (!silent) connectionsError = err.message;
  }
  renderAll();
}

async function loadUsers(silent = false) {
  const sessionToken = authToken;
  try {
    const data = await api('/api/users');
    if (sessionToken !== authToken) return;
    users = data;
    usersLoaded = true;
    usersError = '';
  } catch (err) {
    if (sessionToken !== authToken) return;
    usersLoaded = true;
    if (!silent) usersError = err.message;
  }
  renderAll();
}

// ── Selection ────────────────────────────────────────────────────────────────
function currentConnection() {
  if (connections.length === 0) return null;
  let conn = connections.find((c) => c.realmId === selectedRealmId);
  if (!conn) {
    // Default to the first company needing attention, else the first one.
    conn = connections.find((c) => derivedStatus(c) !== 'active') || connections[0];
    selectedRealmId = conn.realmId;
    localStorage.setItem('qbo_selected_realm', selectedRealmId);
  }
  return conn;
}

function currentUser() {
  if (users.length === 0) return null;
  let user = users.find((u) => u.id === selectedUserId);
  if (!user) {
    user = users[0];
    selectedUserId = user.id;
  }
  return user;
}

function selectClient(realmId) {
  selectedRealmId = realmId;
  localStorage.setItem('qbo_selected_realm', realmId);
  renderAll();
}

function switchView(next) {
  if (next !== 'clients' && next !== 'team') return;
  if (next === 'team' && me?.role !== 'admin') return;
  if (view === next) return;
  view = next;
  searchQuery = '';
  $('search-input').value = '';
  renderAll();
}

// ── Rendering ────────────────────────────────────────────────────────────────
function renderAll() {
  if (!me) return;
  updateRailChrome();
  renderRail();
  renderDetail();
  renderActivity();
}

function updateRailChrome() {
  document.querySelectorAll('.seg-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.view === view);
  });
  // Search only exists on the Clients screen (per the design reference).
  $('rail-search').hidden = view !== 'clients';
  const add = $('rail-add');
  if (view === 'clients') {
    add.textContent = '+ Connect a client';
    add.dataset.action = 'add-company';
    add.hidden = me.role !== 'admin';
  } else {
    add.textContent = '+ Add a member';
    add.dataset.action = 'add-user';
    add.hidden = false;
  }
  $('whoami').textContent =
    me.kind === 'master' ? 'Master key' : `${me.name} · ${me.role}`;
}

function renderRail() {
  const list = $('rail-list');
  const q = searchQuery.trim().toLowerCase();

  if (view === 'clients') {
    if (!connectionsLoaded) {
      list.innerHTML = '<div class="rail-note">Loading…</div>';
      return;
    }
    const selected = currentConnection();
    const rows = connections.filter(
      (c) =>
        !q ||
        c.clientName.toLowerCase().includes(q) ||
        c.realmId.toLowerCase().includes(q)
    );
    if (rows.length === 0) {
      list.innerHTML = `<div class="rail-note">${connections.length ? 'No matching clients' : 'No clients connected yet'}</div>`;
      return;
    }
    list.innerHTML = rows
      .map((conn) => {
        const status = derivedStatus(conn);
        const isSelected = conn.realmId === selected?.realmId;
        const dot = status === 'active' ? 'ok' : status === 'expired' ? 'warn' : 'bad';
        let meta = '';
        if (status === 'active') {
          const countdown = railCountdown(conn);
          if (countdown) meta = `<span class="row-meta mono">${escapeHtml(countdown)}</span>`;
        } else if (status === 'expired') {
          meta = '<span class="row-meta bang">!</span>';
        } else {
          meta = '<span class="row-meta bad">!</span>';
        }
        return `
          <button type="button" class="rail-row${isSelected ? ' selected' : ''}" data-action="select-client" data-realm="${escapeHtml(conn.realmId)}">
            <span class="row-dot ${dot}"></span>
            <span class="row-name">${escapeHtml(conn.clientName)}</span>
            ${meta}
          </button>`;
      })
      .join('');
  } else {
    if (!usersLoaded) {
      list.innerHTML = '<div class="rail-note">Loading…</div>';
      return;
    }
    if (users.length === 0) {
      list.innerHTML = '<div class="rail-note">No team members yet</div>';
      return;
    }
    const selected = currentUser();
    list.innerHTML = users
      .map((user) => {
        const isSelected = user.id === selected?.id;
        const avatarClass =
          user.status === 'disabled' ? 'avatar-disabled' : user.role === 'admin' ? 'avatar-admin' : 'avatar-member';
        let meta;
        if (user.status === 'disabled') meta = '<span class="row-meta bad">disabled</span>';
        else if (user.role === 'admin') meta = '<span class="row-meta">admin</span>';
        else meta = `<span class="row-meta">${user.realmIds.length} client${user.realmIds.length === 1 ? '' : 's'}</span>`;
        return `
          <button type="button" class="rail-row${isSelected ? ' selected' : ''}" data-action="select-user" data-id="${user.id}">
            <span class="avatar ${avatarClass}">${escapeHtml(initials(user.name))}</span>
            <span class="row-name">${escapeHtml(user.name)}</span>
            ${meta}
          </button>`;
      })
      .join('');
  }
}

function renderDetail() {
  $('detail').innerHTML = view === 'clients' ? clientDetailHtml() : teamDetailHtml();
}

function statusPillHtml(status) {
  const map = {
    active: ['pill-active', 'Active'],
    expired: ['pill-expired', 'Expired'],
    revoked: ['pill-revoked', 'Revoked'],
  };
  const [cls, label] = map[status] || map.active;
  return `<span class="pill ${cls}"><span class="pill-dot"></span>${label}</span>`;
}

function clientDetailHtml() {
  if (connectionsError) return `<div class="error-box">${escapeHtml(connectionsError)}</div>`;
  if (!connectionsLoaded) return '<div class="loading">Loading clients…</div>';

  const conn = currentConnection();
  const isAdmin = me.role === 'admin';
  if (!conn) {
    return `
      <div class="empty-state">
        <h3>${isAdmin ? 'No clients connected yet' : 'No clients assigned'}</h3>
        <p>${
          isAdmin
            ? 'Connect your first QuickBooks Online company to get started.'
            : 'Your API key has no assigned clients yet — ask your admin to grant access.'
        }</p>
        ${isAdmin ? '<button type="button" class="btn btn-primary" data-action="add-company">+ Connect a client</button>' : ''}
      </div>
      ${
        // Reachable before the first client exists on purpose: the Intuit
        // callback URL has to be registered BEFORE anyone can connect one.
        isAdmin && serverUrl ? `<div class="card">${serverUrlPanelHtml()}</div>` : ''
      }`;
  }

  const status = derivedStatus(conn);
  const now = Date.now();
  const accessMs = new Date(conn.tokenExpiry).getTime() - now;
  const refreshMs = new Date(conn.refreshExpiry).getTime() - now;
  const accessFrac = clamp01(accessMs / ACCESS_TOKEN_TTL_MS);
  const refreshFrac = clamp01(refreshMs / REFRESH_TOKEN_TTL_MS);
  const accessText = accessMs > 0 ? `renews ${relativeTime(conn.tokenExpiry)}` : 'expired';
  const refreshDays = Math.floor(refreshMs / 86400000);
  const refreshText =
    refreshMs <= 0
      ? 'expired'
      : refreshDays >= 1
        ? `${refreshDays} day${refreshDays === 1 ? '' : 's'} left`
        : `${Math.max(1, Math.floor(refreshMs / 3600000))} hr left`;

  const realmAttr = escapeHtml(conn.realmId);
  const nameAttr = escapeHtml(conn.clientName);
  const actions = [
    `<button type="button" class="btn btn-ghost" data-action="test" data-realm="${realmAttr}">Test connection</button>`,
  ];
  if (isAdmin) {
    actions.push(
      `<button type="button" class="btn btn-ghost" data-action="rename" data-realm="${realmAttr}" data-name="${nameAttr}">Edit name</button>`,
      `<button type="button" class="btn ${status === 'active' ? 'btn-ghost' : 'btn-primary'}" data-action="reconnect" data-realm="${realmAttr}" data-name="${nameAttr}">Reconnect</button>`,
      `<button type="button" class="btn btn-danger" data-action="disconnect" data-realm="${realmAttr}" data-name="${nameAttr}">Disconnect</button>`
    );
  }

  let teamCard = '';
  if (isAdmin) {
    let rows;
    if (!usersLoaded) {
      rows = '<p class="field-hint">Loading team…</p>';
    } else {
      const withAccess = users
        .filter((u) => u.role === 'admin' || u.realmIds.includes(conn.realmId))
        .sort((a, b) =>
          a.role === b.role ? a.name.localeCompare(b.name) : a.role === 'member' ? -1 : 1
        );
      rows = withAccess
        .map(
          (u) => `
            <div class="team-row">
              <span class="avatar ${u.role === 'admin' ? 'avatar-admin' : 'avatar-member'}">${escapeHtml(initials(u.name))}</span>
              <span class="team-name">${escapeHtml(u.name)}</span>
              <span class="team-meta">${
                u.role === 'admin' ? 'admin · all clients' : `member · ${escapeHtml(u.keyPrefix)}…`
              }</span>
            </div>`
        )
        .join('');
      if (!rows) rows = '<p class="field-hint">No members have access yet.</p>';
    }
    teamCard = `
      <div class="card">
        <div class="card-label">Team access</div>
        <div class="team-rows">
          ${rows}
          <button type="button" class="btn-dashed" data-action="manage-access" data-realm="${realmAttr}" data-name="${nameAttr}">Manage access</button>
        </div>
      </div>`;
  }

  const clientCount = isAdmin ? connections.length : (me.clients?.length ?? 0);
  const scopeNote = isAdmin
    ? `every connected client (${clientCount})`
    : `your ${clientCount} assigned client${clientCount === 1 ? '' : 's'}${
        me.canWrite === false ? ', read-only' : ''
      }`;

  return `
    <div class="detail-header">
      <div>
        <div class="detail-title-row">
          <h2 class="detail-title">${escapeHtml(conn.clientName)}</h2>
          ${statusPillHtml(status)}
        </div>
        <div class="detail-sub mono">realm ${escapeHtml(conn.realmId)}</div>
      </div>
      <div class="detail-actions">${actions.join('')}</div>
    </div>
    <div class="detail-cards${teamCard ? '' : ' single'}">
      <div class="card">
        <div class="card-label">Token health</div>
        <div class="stat-rows">
          <div class="stat-row"><span class="stat-label">Access token</span><span class="stat-value">${escapeHtml(accessText)}</span></div>
          <div class="bar"><div class="bar-fill${accessFrac < 0.15 ? ' warn' : ''}" style="width:${(accessFrac * 100).toFixed(1)}%"></div></div>
          <div class="stat-row"><span class="stat-label">Refresh token</span><span class="stat-value">${escapeHtml(refreshText)}</span></div>
          <div class="bar"><div class="bar-fill${refreshFrac < 0.15 ? ' warn' : ''}" style="width:${(refreshFrac * 100).toFixed(1)}%"></div></div>
        </div>
      </div>
      ${teamCard}
    </div>
    ${connectorCardHtml(scopeNote)}`;
}

// Connector setup card. Leads with the shared OAuth URL — one connector for
// the whole workspace, where each person signs in as themselves — and keeps
// the personal API-key URL as a fallback for tools that can't do OAuth.
function connectorCardHtml(scopeNote) {
  // Prefer the address the SERVER reports: if QBO_PUBLIC_URL pins it, that's
  // the origin Claude will be redirected to, which may not be the one being
  // browsed. Falls back to the browsed origin for non-admins.
  const sharedUrl = serverUrl?.connectorUrl || `${window.location.origin}/mcp`;
  const isAdmin = me?.role === 'admin';
  const personal = ownConnectorUrl();

  return `
    <div class="card">
      <div class="card-label">Connect to Claude</div>
      <div class="connector-url-row">
        <code class="connector-url">${escapeHtml(sharedUrl)}</code>
        <button type="button" class="connector-copy" data-action="copy-shared-connector">Copy</button>
      </div>
      <div class="connector-caption">
        This one URL serves your whole team. Add it in Claude once; everyone who uses it
        signs in with their own dashboard username and password and reaches only
        ${isAdmin ? 'the clients assigned to them' : escapeHtml(scopeNote)}.
      </div>

      <details class="connector-help"${isAdmin ? ' open' : ''}>
        <summary>${isAdmin ? 'Set it up for your workspace (admin)' : 'How to connect'}</summary>
        ${isAdmin ? `
        <ol class="help-steps">
          <li>In Claude, open <strong>Settings → Connectors</strong>. On a Team plan use
              <strong>Organization settings → Connectors</strong> so it's available to everyone.</li>
          <li>Choose <strong>Add custom connector</strong> and paste the URL above. No API key, no <code>?key=</code>.</li>
          <li>Save. Each teammate then enables the connector and clicks <strong>Connect</strong>,
              which opens a sign-in page from this dashboard.</li>
          <li>Create an account for each person on the <strong>Team</strong> tab with a username,
              password, and their assigned clients — that's what they'll sign in with.</li>
        </ol>` : `
        <ol class="help-steps">
          <li>In Claude, open <strong>Settings → Connectors</strong> and find the QuickBooks connector
              your administrator added.</li>
          <li>Click <strong>Connect</strong>. A sign-in page from this dashboard opens.</li>
          <li>Enter the same username and password you use here, and approve access.</li>
          <li>You're done — Claude will reach ${escapeHtml(scopeNote)}. Your session renews
              automatically; you'll only sign in again if access is revoked.</li>
        </ol>`}
      </details>

      ${serverUrlPanelHtml()}

      <details class="connector-help">
        <summary>Personal API-key URL (alternative)</summary>
        <div class="connector-url-row">
          <code class="connector-url">${escapeHtml(
            personal ?? `${window.location.origin}/mcp?key=${myKeyPrefix ?? 'qbo_'}••••••••`
          )}</code>
          ${personal ? '<button type="button" class="connector-copy" data-action="copy-own-connector">Copy</button>' : ''}
        </div>
        <div class="connector-caption">${
          personal
            ? 'Embeds your key in the URL — use it for scripts, or clients that can\'t do OAuth sign-in. Treat it like a password.'
            : 'Your key predates retrievable storage — sign in with the key once, or ask your admin to rotate it, to see the full URL here.'
        }</div>
      </details>
    </div>`;
}

// Admin-only panel: what address this deployment hands out, and what to do
// when you point a domain of your own at it. The two URLs here are the ones
// that must be registered elsewhere — Intuit needs the callback, Claude needs
// the connector — so they're copyable rather than something to retype.
function serverUrlPanelHtml() {
  if (me?.role !== 'admin' || !serverUrl) return '';

  const base = serverUrl.baseUrl || window.location.origin;
  const redirect = serverUrl.intuitRedirectUri;
  const pinned = serverUrl.mode === 'pinned';

  const warnings = (serverUrl.warnings || [])
    .map((w) => `<div class="warn-box">${escapeHtml(w)}</div>`)
    .join('');

  const modeLine = pinned
    ? `Pinned by <code>QBO_PUBLIC_URL</code>. Every link this server hands out uses <strong>${escapeHtml(base)}</strong>,
       whichever domain you browse. Remove that variable to let the address follow the domain in use.`
    : `Following the domain each request arrives on — this deployment answers to
       <strong>${escapeHtml(base)}</strong> right now, and to any other domain you point at it. No redeploy needed to add one.`;

  // The allowlist only has an effect in dynamic mode — don't advertise it as
  // a next step to someone whose address is pinned.
  const hosts = serverUrl.allowedHosts || [];
  let allowNote = '';
  if (hosts.length) {
    allowNote = `Hostnames accepted: ${hosts.map((h) => `<code>${escapeHtml(h)}</code>`).join(', ')} (<code>QBO_ALLOWED_HOSTS</code>).`;
  } else if (!pinned) {
    allowNote = `Any hostname pointed at this deployment is honoured. Set <code>QBO_ALLOWED_HOSTS</code> to your domains to lock that down.`;
  }

  return `
    ${warnings}
    <details class="connector-help">
      <summary>Server address &amp; custom domain (admin)</summary>
      <div class="url-facts">
        <div class="url-fact">
          <span class="url-fact-label">This server's address</span>
          <div class="connector-url-row">
            <code class="connector-url">${escapeHtml(base)}</code>
            <button type="button" class="connector-copy" data-action="copy-server-url">Copy</button>
          </div>
        </div>
        <div class="url-fact">
          <span class="url-fact-label">QuickBooks callback — must be registered on your Intuit app</span>
          <div class="connector-url-row">
            <code class="connector-url">${escapeHtml(redirect)}</code>
            <button type="button" class="connector-copy" data-action="copy-redirect-uri">Copy</button>
          </div>
        </div>
      </div>
      <div class="connector-caption">${modeLine}</div>
      ${allowNote ? `<div class="connector-caption">${allowNote}</div>` : ''}

      <ol class="help-steps">
        <li>Point the domain at this deployment: in Railway, <strong>Settings → Networking →
            Custom Domain</strong>, then add the CNAME it gives you at your DNS provider. Wait for the
            certificate to go green.</li>
        <li>Add <code>https://your-domain/callback</code> to <strong>Redirect URIs</strong> on your app at
            developer.intuit.com. Keep the old one listed too — existing connections keep working either way,
            and only new connect/reconnect round-trips use the new address.</li>
        <li>Reload this dashboard on the new domain and confirm the two URLs above show it.</li>
        <li>Update the connector URL in Claude (<strong>Organization settings → Connectors</strong>) to the
            new address. Teammates sign in once more on the new domain.</li>
        <li>Optional: set <code>QBO_ALLOWED_HOSTS</code> to your domains, comma-separated, so only hostnames
            you own are ever echoed back.</li>
      </ol>
    </details>`;
}

function teamDetailHtml() {
  if (usersError) return `<div class="error-box">${escapeHtml(usersError)}</div>`;
  if (!usersLoaded) return '<div class="loading">Loading team…</div>';

  const user = currentUser();
  if (!user) {
    return `
      <div class="empty-state">
        <h3>No team members yet</h3>
        <p>Each member gets their own API key, limited to the clients you assign.</p>
        <button type="button" class="btn btn-primary" data-action="add-user">+ Add a member</button>
      </div>`;
  }

  const isDisabled = user.status === 'disabled';
  const isReadOnly = user.role !== 'admin' && user.accessLevel === 'read';
  let pill = isDisabled
    ? '<span class="pill pill-disabled">Disabled</span>'
    : `<span class="pill pill-role">${escapeHtml(user.role)}</span>`;
  if (isReadOnly) pill += ' <span class="pill pill-muted">Read-only</span>';
  const subParts = [];
  if (user.email) subParts.push(escapeHtml(user.email));
  subParts.push(`added ${escapeHtml(monthYear(user.createdAt))}`);

  const idAttr = escapeHtml(String(user.id));
  const lastUsed = user.lastUsedAt ? relativeTime(user.lastUsedAt) : 'Never';

  const assignedCount = user.realmIds.length;
  const assignedLabel =
    user.role === 'admin'
      ? 'Assigned clients'
      : `Assigned clients — ${assignedCount} of ${connections.length}`;
  const chips =
    user.role === 'admin'
      ? '<span class="chip"><span class="chip-dot"></span>All clients</span>'
      : user.clients
          .map((c) => `<span class="chip"><span class="chip-dot"></span>${escapeHtml(c.clientName)}</span>`)
          .join('') || '<p class="field-hint">No clients assigned yet.</p>';

  return `
    <div class="detail-header">
      <div>
        <div class="detail-title-row">
          <h2 class="detail-title">${escapeHtml(user.name)}</h2>
          ${pill}
        </div>
        <div class="detail-sub">${subParts.join(' · ')}</div>
      </div>
      <div class="detail-actions">
        <button type="button" class="btn btn-ghost" data-action="edit-user" data-id="${idAttr}">Edit</button>
        <button type="button" class="btn btn-ghost" data-action="toggle-status" data-id="${idAttr}">${isDisabled ? 'Enable' : 'Disable'}</button>
        <button type="button" class="btn btn-danger" data-action="delete-user" data-id="${idAttr}">Remove</button>
      </div>
    </div>
    <div class="detail-cards">
      <div class="card">
        <div class="card-label">Sign-in &amp; API key</div>
        <div class="stat-rows">
          <div class="stat-row"><span class="stat-label">Username</span><span class="stat-value">${user.username ? escapeHtml(user.username) : '<span class="team-meta">not set</span>'}</span></div>
          <div class="stat-row"><span class="stat-label">Password</span><span class="stat-value">${user.hasPassword ? 'Set' : '<span class="team-meta">not set</span>'}</span></div>
          <div class="stat-row"><span class="stat-label">Key</span><span class="key-chip">${escapeHtml(user.keyPrefix)}…</span></div>
          <div class="stat-row"><span class="stat-label">Last used</span><span class="stat-value">${escapeHtml(lastUsed)}</span></div>
          <div class="stat-row"><span class="stat-label">Status</span><span class="stat-value ${isDisabled ? 'status-bad' : 'status-ok'}"><span class="status-dot"></span>${isDisabled ? 'Disabled' : 'Active'}</span></div>
          <div class="stat-row"><span class="stat-label">QuickBooks access</span><span class="stat-value">${isReadOnly ? 'Read-only' : 'Read & write'}</span></div>
          <button type="button" class="btn btn-ghost btn-card" data-action="set-password" data-id="${idAttr}">${user.hasPassword ? 'Reset password' : 'Set up sign-in'}</button>
          <button type="button" class="btn btn-ghost btn-card" data-action="rotate-key" data-id="${idAttr}">Rotate key</button>
        </div>
      </div>
      <div class="card">
        <div class="card-label">${escapeHtml(assignedLabel)}</div>
        <div class="chips">${chips}</div>
        ${
          user.role === 'admin'
            ? ''
            : `<button type="button" class="btn-dashed block" style="margin-top:12px" data-action="edit-assignments" data-id="${idAttr}">Edit assignments</button>`
        }
      </div>
    </div>`;
}

// ── Activity feed ────────────────────────────────────────────────────────────
// The server has no activity endpoint yet, so this derives an approximate feed
// from data already on hand (token timestamps + member usage).
// TODO: replace with a real GET /api/activity once the server records events —
// refresh-daemon token renewals, MCP tool calls, connects/disconnects and key
// rotations all already pass through the server.
function buildActivity() {
  const events = [];
  const now = Date.now();

  for (const conn of connections) {
    const status = derivedStatus(conn);
    // The refresh token was issued at authorization time, ~100 days before it
    // expires — a good approximation of when the company was connected.
    const authorizedAt = new Date(conn.refreshExpiry).getTime() - REFRESH_TOKEN_TTL_MS;
    if (Number.isFinite(authorizedAt) && authorizedAt <= now) {
      events.push({
        ts: authorizedAt,
        tone: 'green',
        title: 'Company connected',
        meta: `${conn.clientName} · ${relativeTime(authorizedAt)}`,
      });
    }
    // Access tokens live ~60 minutes, so expiry − 60 min ≈ the last refresh.
    const refreshedAt = new Date(conn.tokenExpiry).getTime() - ACCESS_TOKEN_TTL_MS;
    if (
      status === 'active' &&
      Number.isFinite(refreshedAt) &&
      refreshedAt <= now &&
      refreshedAt - authorizedAt > 60000
    ) {
      events.push({
        ts: refreshedAt,
        tone: 'green',
        title: 'Token refreshed',
        meta: `${conn.clientName} · ${relativeTime(refreshedAt)}`,
      });
    }
    if (status === 'expired') {
      const tokenTs = new Date(conn.tokenExpiry).getTime();
      const refreshTs = new Date(conn.refreshExpiry).getTime();
      const expiredAt = Math.min(
        Number.isFinite(tokenTs) ? tokenTs : now,
        Number.isFinite(refreshTs) ? refreshTs : now
      );
      events.push({
        ts: expiredAt,
        tone: 'amber',
        title: 'Authorization expired',
        meta: `${conn.clientName} · ${relativeTime(expiredAt)}`,
      });
    }
    if (conn.status === 'revoked') {
      const ts = new Date(conn.updatedAt ?? conn.tokenExpiry).getTime();
      events.push({
        ts: Number.isFinite(ts) ? ts : now,
        tone: 'amber',
        title: 'Connection revoked',
        meta: `${conn.clientName} · ${relativeTime(Number.isFinite(ts) ? ts : now)}`,
      });
    }
  }

  if (me?.role === 'admin') {
    for (const user of users) {
      if (user.createdAt) {
        events.push({
          ts: new Date(user.createdAt).getTime(),
          tone: 'green',
          title: 'Member added',
          meta: `${user.name} · ${relativeTime(user.createdAt)}`,
          userId: user.id,
        });
      }
      if (user.lastUsedAt) {
        events.push({
          ts: new Date(user.lastUsedAt).getTime(),
          tone: 'blue',
          title: 'API key used',
          meta: `${user.name} · ${relativeTime(user.lastUsedAt)}`,
          userId: user.id,
        });
      }
    }
  }

  return events.filter((e) => Number.isFinite(e.ts)).sort((a, b) => b.ts - a.ts);
}

function renderActivity() {
  const label = $('activity-label');
  const list = $('activity-list');
  let events = buildActivity();

  if (view === 'team') {
    const user = currentUser();
    label.textContent = user ? `${firstName(user.name)}’s activity` : 'Activity';
    events = user ? events.filter((e) => e.userId === user.id) : [];
  } else {
    label.textContent = 'Activity';
  }

  events = events.slice(0, 12);
  if (events.length === 0) {
    list.innerHTML = '<div class="rail-note">No recent activity.</div>';
    return;
  }
  list.innerHTML = events
    .map(
      (e) => `
        <div class="activity-item">
          <span class="act-dot ${e.tone}"></span>
          <div>
            <div class="act-title">${escapeHtml(e.title)}</div>
            <div class="act-meta">${escapeHtml(e.meta)}</div>
          </div>
        </div>`
    )
    .join('');
}

// ── Company actions ──────────────────────────────────────────────────────────
async function testConnection(realmId) {
  openModal('Company info', '<div class="loading">Contacting QuickBooks…</div>', { wide: true });
  try {
    const info = await api(`/api/company/${encodeURIComponent(realmId)}/info`);
    const body = document.createElement('pre');
    body.className = 'json-view';
    body.textContent = JSON.stringify(info, null, 2);
    setModalBody(body);
  } catch (err) {
    setModalBody(errorBox(err.message));
  }
}

function disconnectCompany(realmId, clientName) {
  confirmModal(
    'Disconnect client',
    `This revokes access to “${clientName}” and deletes its stored tokens. Team members assigned to it will lose access. You can reconnect later by authorizing again.`,
    'Disconnect',
    async () => {
      await api(`/api/connections/${encodeURIComponent(realmId)}`, { method: 'DELETE' });
      toast(`${clientName} disconnected`);
      await loadConnections();
      if (me?.role === 'admin') await loadUsers();
    }
  );
}

function renameCompany(realmId, currentName) {
  const body = document.createElement('form');
  body.className = 'form-stack';
  body.innerHTML = `
    <label class="field">
      <span class="field-label">Company name</span>
      <input type="text" name="clientName" required value="${escapeHtml(currentName)}">
      <span class="field-hint">This is a display label only — it doesn't change anything in QuickBooks.</span>
    </label>
    <div class="modal-footer">
      <button type="button" class="btn btn-ghost" data-action="close-modal">Cancel</button>
      <button type="submit" class="btn btn-primary">Save name</button>
    </div>
  `;
  body.addEventListener('submit', async (event) => {
    event.preventDefault();
    const clientName = new FormData(event.target).get('clientName')?.trim();
    if (!clientName) return;
    try {
      await api(`/api/connections/${encodeURIComponent(realmId)}`, {
        method: 'PATCH',
        body: JSON.stringify({ clientName }),
      });
      toast('Name updated');
      closeModal();
      await loadConnections();
      if (me?.role === 'admin') await loadUsers();
    } catch (err) {
      toast(err.message, 'error');
    }
  });
  openModal('Edit company name', body);
}

function reconnectCompany(realmId, clientName) {
  // Re-authorization can't happen inside the dashboard — it's an Intuit OAuth
  // round-trip. Generate a fresh auth URL for this same company and send the
  // admin to QuickBooks; the callback refreshes tokens in place (same realm),
  // so member assignments and the current name are preserved.
  confirmModal(
    'Reconnect client',
    `To restore access to “${clientName}”, you'll re-authorize it in QuickBooks. This opens QuickBooks in a new tab — sign in to that company's account and approve. Existing team assignments are kept; the list updates automatically once you're back.`,
    'Open QuickBooks',
    async () => {
      const data = await api('/api/connections/auth-url', {
        method: 'POST',
        body: JSON.stringify({ clientName }),
      });
      window.open(data.authUrl, '_blank', 'noopener');
      toast('Approve access in the new tab — this list refreshes automatically');
    },
    { variant: 'primary' }
  );
}

// Edit which team members can access one company (the reverse of the
// per-user assignment picker).
async function manageClientAccess(realmId, clientName) {
  openModal(`Access — ${clientName}`, '<div class="loading">Loading team…</div>', { wide: true });

  let roster;
  try {
    roster = await api('/api/users');
  } catch (err) {
    setModalBody(errorBox(err.message));
    return;
  }

  const members = roster.filter((u) => u.role === 'member');
  const admins = roster.filter((u) => u.role === 'admin');

  const body = document.createElement('div');
  const memberRows = members.length
    ? `${checkboxToolbar()}
      <div class="checkbox-grid">
        ${members
          .map(
            (u) => `
          <label class="checkbox-item">
            <input type="checkbox" name="userIds" value="${u.id}" ${u.realmIds.includes(realmId) ? 'checked' : ''}>
            <span>${escapeHtml(u.name)}</span>
          </label>`
          )
          .join('')}
      </div>`
    : '<p class="field-hint">No member accounts yet. Add members from the Team view first.</p>';

  const adminNote = admins.length
    ? `<p class="field-hint" style="margin-top:12px">Admins always have access: ${admins
        .map((a) => escapeHtml(a.name))
        .join(', ')}.</p>`
    : '';

  body.innerHTML = `
    <p class="field-hint" style="margin-bottom:14px;font-size:12.5px">Choose which members can access <strong>${escapeHtml(clientName)}</strong>. Changes take effect immediately.</p>
    <form id="access-form" class="form-stack">
      <div class="field">${memberRows}${adminNote}</div>
      <div class="modal-footer">
        <button type="button" class="btn btn-ghost" data-action="close-modal">Cancel</button>
        <button type="submit" class="btn btn-primary"${members.length ? '' : ' disabled'}>Save access</button>
      </div>
    </form>
  `;

  body.querySelector('#access-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const userIds = [...event.target.querySelectorAll('input[name="userIds"]:checked')].map((cb) => Number(cb.value));
    try {
      await api(`/api/connections/${encodeURIComponent(realmId)}/users`, {
        method: 'PUT',
        body: JSON.stringify({ userIds }),
      });
      toast('Access updated');
      closeModal();
      await loadUsers();
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  openModal(`Access — ${clientName}`, body, { wide: true });
}

// ── Team actions ─────────────────────────────────────────────────────────────
function checkboxToolbar() {
  return `
    <div class="checkbox-toolbar">
      <button type="button" class="btn-link" data-action="check-all">Select all</button>
      <span class="toolbar-sep">·</span>
      <button type="button" class="btn-link" data-action="check-none">Select none</button>
    </div>
  `;
}

function clientCheckboxes(selectedRealms) {
  const selected = new Set(selectedRealms || []);
  if (connections.length === 0) {
    return '<p class="field-hint">No clients connected yet — connect one first, then assign it here.</p>';
  }
  return `
    ${checkboxToolbar()}
    <div class="checkbox-grid">
      ${connections
        .map(
          (c) => `
        <label class="checkbox-item">
          <input type="checkbox" name="realmIds" value="${escapeHtml(c.realmId)}" ${selected.has(c.realmId) ? 'checked' : ''}>
          <span>${escapeHtml(c.clientName)}</span>
        </label>`
        )
        .join('')}
    </div>
  `;
}

function userFormHtml(user) {
  return `
    <form id="user-form" class="form-stack">
      <label class="field">
        <span class="field-label">Name</span>
        <input type="text" name="name" required value="${user ? escapeHtml(user.name) : ''}" placeholder="e.g. Jane Smith">
      </label>
      <label class="field">
        <span class="field-label">Email <span class="field-hint">(optional)</span></span>
        <input type="email" name="email" value="${user?.email ? escapeHtml(user.email) : ''}" placeholder="jane@example.com">
      </label>
      <label class="field">
        <span class="field-label">Username <span class="field-hint">(for dashboard sign-in)</span></span>
        <input type="text" name="username" value="${user?.username ? escapeHtml(user.username) : ''}" placeholder="e.g. jane.smith" autocomplete="off">
      </label>
      ${
        user
          ? ''
          : `
      <label class="field">
        <span class="field-label">Password <span class="field-hint">(optional — can be set later)</span></span>
        <input type="password" name="password" minlength="8" placeholder="At least 8 characters" autocomplete="new-password">
        <span class="field-hint">Give it to the member privately — they can change it after signing in.</span>
      </label>`
      }
      <div class="field">
        <span class="field-label">Role</span>
        <div class="radio-row">
          <label><input type="radio" name="role" value="member" ${!user || user.role === 'member' ? 'checked' : ''}> Member — assigned clients only</label>
          <label><input type="radio" name="role" value="admin" ${user?.role === 'admin' ? 'checked' : ''}> Admin — all clients + team management</label>
        </div>
      </div>
      <div class="field">
        <span class="field-label">QuickBooks access</span>
        <div class="radio-row">
          <label><input type="radio" name="accessLevel" value="read_write" ${!user || user.accessLevel !== 'read' ? 'checked' : ''}> Read &amp; write — can create, edit, and delete transactions</label>
          <label><input type="radio" name="accessLevel" value="read" ${user?.accessLevel === 'read' ? 'checked' : ''}> Read-only — reports and lookups; write tools are hidden from their connector</label>
        </div>
        <span class="field-hint">Applies to this member's API key and MCP connector. Admins always have full access.</span>
      </div>
      <div class="field" id="client-assign-field">
        <span class="field-label">Assigned clients</span>
        ${clientCheckboxes(user?.realmIds)}
        <span class="field-hint">Only checked clients are visible to this member's API key. Ignored for admins.</span>
      </div>
      <div class="modal-footer">
        <button type="button" class="btn btn-ghost" data-action="close-modal">Cancel</button>
        <button type="submit" class="btn btn-primary">${user ? 'Save changes' : 'Create member'}</button>
      </div>
    </form>
  `;
}

function readUserForm(form) {
  const data = new FormData(form);
  return {
    name: data.get('name')?.trim(),
    email: data.get('email')?.trim() || null,
    role: data.get('role'),
    accessLevel: data.get('accessLevel'),
    username: data.get('username')?.trim() || null,
    password: data.get('password') || null,
    realmIds: data.getAll('realmIds'),
  };
}

function showCreateUserModal() {
  openModal('Add a member', userFormHtml(null), { wide: true });
  $('modal-body').querySelector('#user-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      const payload = readUserForm(event.target);
      const { user, apiKey: newKey } = await api('/api/users', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      selectedUserId = user.id;
      await loadUsers();
      showKeyModal(user, newKey, 'created');
    } catch (err) {
      toast(err.message, 'error');
    }
  });
}

function showEditUserModal(user) {
  openModal(`Edit ${user.name}`, userFormHtml(user), { wide: true });
  $('modal-body').querySelector('#user-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      const payload = readUserForm(event.target);
      delete payload.password; // passwords change via the dedicated reset flow
      await api(`/api/users/${user.id}`, { method: 'PATCH', body: JSON.stringify(payload) });
      toast('Member updated');
      closeModal();
      await loadUsers();
    } catch (err) {
      toast(err.message, 'error');
    }
  });
}

function showAssignmentsModal(user) {
  const body = document.createElement('form');
  body.className = 'form-stack';
  body.innerHTML = `
    <div class="field">
      <span class="field-label">Assigned clients</span>
      ${clientCheckboxes(user.realmIds)}
      <span class="field-hint">Only checked clients are visible to ${escapeHtml(user.name)}'s API key.</span>
    </div>
    <div class="modal-footer">
      <button type="button" class="btn btn-ghost" data-action="close-modal">Cancel</button>
      <button type="submit" class="btn btn-primary">Save assignments</button>
    </div>
  `;
  body.addEventListener('submit', async (event) => {
    event.preventDefault();
    const realmIds = [...event.target.querySelectorAll('input[name="realmIds"]:checked')].map((cb) => cb.value);
    try {
      await api(`/api/users/${user.id}`, { method: 'PATCH', body: JSON.stringify({ realmIds }) });
      toast('Assignments updated');
      closeModal();
      await loadUsers();
    } catch (err) {
      toast(err.message, 'error');
    }
  });
  openModal(`Assignments — ${user.name}`, body, { wide: true });
}

// Set or reset a member's dashboard credentials (username + password).
function showSetPasswordModal(user) {
  const body = document.createElement('form');
  body.className = 'form-stack';
  body.innerHTML = `
    <label class="field">
      <span class="field-label">Username</span>
      <input type="text" name="username" required value="${user.username ? escapeHtml(user.username) : ''}" placeholder="e.g. jane.smith" autocomplete="off">
      <span class="field-hint">They'll sign in to this dashboard with it.</span>
    </label>
    <label class="field">
      <span class="field-label">${user.hasPassword ? 'New password' : 'Password'}</span>
      <input type="password" name="password" required minlength="8" placeholder="At least 8 characters" autocomplete="new-password">
      <span class="field-hint">${
        user.hasPassword
          ? 'Replaces their current password and signs out their existing sessions.'
          : 'Give it to the member privately — they can change it after signing in.'
      }</span>
    </label>
    <div class="modal-footer">
      <button type="button" class="btn btn-ghost" data-action="close-modal">Cancel</button>
      <button type="submit" class="btn btn-primary">${user.hasPassword ? 'Reset password' : 'Set up sign-in'}</button>
    </div>
  `;
  body.addEventListener('submit', async (event) => {
    event.preventDefault();
    const data = new FormData(event.target);
    const username = data.get('username')?.trim();
    const password = data.get('password');
    if (!username || !password) return;
    try {
      if (username !== (user.username ?? '')) {
        await api(`/api/users/${user.id}`, { method: 'PATCH', body: JSON.stringify({ username }) });
      }
      await api(`/api/users/${user.id}/password`, { method: 'POST', body: JSON.stringify({ password }) });
      toast(`${user.name} can now sign in as “${username}”`);
      closeModal();
      await loadUsers();
    } catch (err) {
      toast(err.message, 'error');
    }
  });
  openModal(`Sign-in credentials — ${user.name}`, body);
}

function showKeyModal(user, plaintextKey, verb) {
  const connectorUrl = `${window.location.origin}/mcp?key=${encodeURIComponent(plaintextKey)}`;
  const body = document.createElement('div');
  body.innerHTML = `
    <div class="callout-warning">
      <div class="callout-title">Keep this key private</div>
      <div class="callout-body">It grants access to the member's assigned clients. Once they have a username &amp; password, they can view it themselves under Settings after signing in.</div>
    </div>
    <div class="field" style="margin-top:16px">
      <span class="field-label">API key for ${escapeHtml(user.name)}</span>
      <div class="key-row">
        <code class="key-display">${escapeHtml(plaintextKey)}</code>
        <button type="button" class="btn btn-ghost btn-small" data-copy-key>Copy</button>
      </div>
    </div>
    <div class="field" style="margin-top:14px">
      <span class="field-label">Claude connector URL</span>
      <div class="connector-url-row">
        <code class="connector-url">${escapeHtml(connectorUrl)}</code>
        <button type="button" class="connector-copy" data-copy-url>Copy</button>
      </div>
      <span class="field-hint">Add as a custom connector in Claude — it signs requests with ${escapeHtml(user.name)}'s key automatically.</span>
    </div>
    <div class="modal-footer">
      <button type="button" class="btn btn-primary" data-action="close-modal">Done</button>
    </div>
  `;
  body.querySelector('[data-copy-key]').addEventListener('click', () => copyText(plaintextKey, 'API key copied'));
  body.querySelector('[data-copy-url]').addEventListener('click', () => copyText(connectorUrl, 'Connector URL copied'));
  openModal(verb === 'created' ? 'Member created' : 'New key generated', body, { wide: true });
}

function rotateUserKey(user) {
  confirmModal(
    'Rotate API key',
    `Generate a new key for “${user.name}”? Their current key stops working immediately, including any Claude connector using it.`,
    'Rotate key',
    async () => {
      const { user: updated, apiKey: newKey } = await api(`/api/users/${user.id}/rotate-key`, { method: 'POST' });
      await loadUsers();
      showKeyModal(updated, newKey, 'rotated');
    }
  );
}

async function toggleUserStatus(user) {
  const next = user.status === 'active' ? 'disabled' : 'active';
  try {
    await api(`/api/users/${user.id}`, { method: 'PATCH', body: JSON.stringify({ status: next }) });
    toast(next === 'disabled' ? `${user.name}'s key disabled` : `${user.name}'s key re-enabled`);
    await loadUsers();
  } catch (err) {
    toast(err.message, 'error');
  }
}

function deleteUser(user) {
  confirmModal(
    'Remove team member',
    `Remove “${user.name}” and permanently revoke their API key? This cannot be undone.`,
    'Remove',
    async () => {
      await api(`/api/users/${user.id}`, { method: 'DELETE' });
      toast(`${user.name} removed`);
      if (selectedUserId === user.id) selectedUserId = null;
      await loadUsers();
    }
  );
}

// ── Add company ──────────────────────────────────────────────────────────────
function showAddCompanyModal() {
  const body = document.createElement('div');
  body.innerHTML = `
    <form id="add-company-form" class="form-stack">
      <label class="field">
        <span class="field-label">Company name</span>
        <input type="text" name="clientName" required autofocus placeholder="e.g. Acme Corp">
        <span class="field-hint">A friendly label to identify this company in tools and reports.</span>
      </label>
      <div class="modal-footer">
        <button type="button" class="btn btn-ghost" data-action="close-modal">Cancel</button>
        <button type="submit" class="btn btn-primary">Continue to QuickBooks →</button>
      </div>
    </form>
  `;
  body.querySelector('#add-company-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const clientName = new FormData(event.target).get('clientName')?.trim();
    if (!clientName) return;
    try {
      const data = await api('/api/connections/auth-url', {
        method: 'POST',
        body: JSON.stringify({ clientName }),
      });
      const done = document.createElement('div');
      done.innerHTML = `
        <p class="field-hint" style="margin-bottom:12px;font-size:12.5px">Authorize <strong>${escapeHtml(clientName)}</strong> in QuickBooks, then come back — it'll appear in the client rail automatically.</p>
        <div class="url-row">
          <a href="${escapeHtml(data.authUrl)}" target="_blank" rel="noopener">${escapeHtml(data.authUrl)}</a>
          <button type="button" class="btn btn-ghost btn-small" data-copy-url>Copy</button>
        </div>
        <p class="field-hint" style="margin-top:8px">If the QuickBooks tab didn't open automatically, use the button below or the link above.</p>
        ${data.redirectUri ? `<p class="field-hint" style="margin-top:8px">QuickBooks will return to <code>${escapeHtml(data.redirectUri)}</code>. That exact URL has to be listed under <strong>Redirect URIs</strong> on your Intuit app, or authorization will be refused.</p>` : ''}
        <div class="modal-footer">
          <button type="button" class="btn btn-ghost" data-action="close-modal">Done</button>
          <button type="button" class="btn btn-primary" data-open-url>Open QuickBooks</button>
        </div>
      `;
      done.querySelector('[data-copy-url]').addEventListener('click', () => copyText(data.authUrl, 'Authorization link copied'));
      done.querySelector('[data-open-url]').addEventListener('click', () => window.open(data.authUrl, '_blank', 'noopener'));
      setModalBody(done);
      window.open(data.authUrl, '_blank', 'noopener');
    } catch (err) {
      toast(err.message, 'error');
    }
  });
  openModal('Connect a client', body);
}

// ── Settings ─────────────────────────────────────────────────────────────────
function showSettingsModal() {
  let revealed = false;
  const identity =
    me.kind === 'master'
      ? 'Signed in with the master key'
      : `Signed in as ${escapeHtml(me.name)}${me.username ? ` (${escapeHtml(me.username)})` : ''} · ${escapeHtml(me.role)}`;

  const keySection = myApiKey
    ? `
      <div class="key-row">
        <code class="key-display" data-key-value>••••••••••••••••••••••••</code>
        <button type="button" class="btn btn-ghost btn-small" data-toggle-key>Show</button>
        <button type="button" class="btn btn-ghost btn-small" data-copy-key>Copy</button>
      </div>
      <span class="field-hint">Your personal key for the MCP connector and API requests.</span>`
    : '<span class="field-hint">Your key was created before retrievable storage — sign in with the key once, or ask your admin to rotate it, to view it here.</span>';

  const passwordSection =
    me.kind === 'user'
      ? `
    <form data-password-form class="form-stack" style="margin-top:18px">
      <div class="field">
        <span class="field-label">${me.hasPassword ? 'Change password' : 'Set a password'}</span>
        ${
          me.hasPassword
            ? '<input type="password" name="currentPassword" required placeholder="Current password" autocomplete="current-password">'
            : ''
        }
        <input type="password" name="newPassword" required minlength="8" placeholder="New password (at least 8 characters)" autocomplete="new-password">
        <span class="field-hint">Changing your password signs out your other sessions.</span>
      </div>
      <div><button type="submit" class="btn btn-ghost">${me.hasPassword ? 'Change password' : 'Set password'}</button></div>
    </form>`
      : '<p class="field-hint" style="margin-top:18px">The master key has no password — it lives in the server environment (<code>QBO_API_KEY</code>).</p>';

  const body = document.createElement('div');
  body.innerHTML = `
    <p class="field-hint" style="margin-bottom:14px;font-size:12.5px">${identity}</p>
    <div class="field">
      <span class="field-label">Your API key</span>
      ${keySection}
    </div>
    ${passwordSection}
    <div class="modal-footer">
      <button type="button" class="btn btn-ghost" data-action="close-modal">Close</button>
      <button type="button" class="btn btn-danger" data-sign-out>Sign out</button>
    </div>
  `;
  const keyEl = body.querySelector('[data-key-value]');
  const toggleBtn = body.querySelector('[data-toggle-key]');
  if (toggleBtn) {
    toggleBtn.addEventListener('click', () => {
      revealed = !revealed;
      keyEl.textContent = revealed ? myApiKey : '••••••••••••••••••••••••';
      toggleBtn.textContent = revealed ? 'Hide' : 'Show';
    });
    body.querySelector('[data-copy-key]').addEventListener('click', () => copyText(myApiKey, 'API key copied'));
  }
  const passwordForm = body.querySelector('[data-password-form]');
  if (passwordForm) {
    passwordForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      const data = new FormData(event.target);
      try {
        await api('/api/me/password', {
          method: 'POST',
          body: JSON.stringify({
            currentPassword: data.get('currentPassword') || undefined,
            newPassword: data.get('newPassword'),
          }),
        });
        toast('Password updated');
        closeModal();
        refreshIdentity();
      } catch (err) {
        toast(err.message, 'error');
      }
    });
  }
  body.querySelector('[data-sign-out]').addEventListener('click', () => signOut());
  openModal('Settings', body);
}

// ── Modal engine ─────────────────────────────────────────────────────────────
function openModal(title, body, opts = {}) {
  $('modal-title').textContent = title;
  setModalBody(body);
  $('modal').classList.toggle('wide', Boolean(opts.wide));
  $('modal-backdrop').hidden = false;
}

function setModalBody(body) {
  const container = $('modal-body');
  container.innerHTML = '';
  if (typeof body === 'string') container.innerHTML = body;
  else container.appendChild(body);
}

function closeModal() {
  $('modal-backdrop').hidden = true;
  // Scrub the body, not just hide it — key-bearing modals (settings reveal,
  // one-time member keys) must not linger in the DOM after closing/sign-out.
  $('modal-body').innerHTML = '';
  $('modal-title').textContent = '';
}

function errorBox(message) {
  const div = document.createElement('div');
  div.className = 'error-box';
  div.textContent = message;
  return div;
}

function confirmModal(title, message, confirmLabel, onConfirm, opts = {}) {
  const body = document.createElement('div');
  const text = document.createElement('p');
  text.textContent = message;
  text.style.color = 'var(--text-3)';
  const footer = document.createElement('div');
  footer.className = 'modal-footer';
  footer.innerHTML = `
    <button type="button" class="btn btn-ghost" data-action="close-modal">Cancel</button>
    <button type="button" class="btn ${opts.variant === 'primary' ? 'btn-primary' : 'btn-danger'}" data-confirm>${escapeHtml(confirmLabel)}</button>
  `;
  footer.querySelector('[data-confirm]').addEventListener('click', async (event) => {
    const btn = event.currentTarget;
    btn.disabled = true;
    // Close the confirm dialog BEFORE running the action: onConfirm may open
    // its own modal (e.g. the one-time key modal after a rotation), which a
    // trailing closeModal() would immediately destroy.
    closeModal();
    try {
      await onConfirm();
    } catch (err) {
      toast(err.message, 'error');
    }
  });
  body.append(text, footer);
  openModal(title, body);
}

// ── Wiring ───────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  $('auth-form').addEventListener('submit', handleSignIn);
  $('auth-key-form').addEventListener('submit', handleKeySignIn);
  $('auth-mode-toggle').addEventListener('click', toggleAuthMode);
  $('search-input').addEventListener('input', (event) => {
    searchQuery = event.target.value;
    renderRail();
  });
  document.querySelectorAll('.theme-toggle').forEach((btn) => btn.addEventListener('click', toggleTheme));
  $('modal-close').addEventListener('click', closeModal);
  $('modal-backdrop').addEventListener('click', (event) => {
    if (event.target === $('modal-backdrop')) closeModal();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeModal();
  });
  // Coming back from the QuickBooks OAuth tab should show the new connection
  // right away rather than waiting out the 60s poll.
  window.addEventListener('focus', () => {
    if (authToken && me) loadData(true).catch(() => {});
  });

  // Delegated actions for dynamic content
  document.addEventListener('click', (event) => {
    const target = event.target.closest('[data-action]');
    if (!target) return;
    const { action, realm, name, id, view: nextView } = target.dataset;
    const user = users.find((u) => String(u.id) === id);

    if (action === 'close-modal') closeModal();
    else if (action === 'check-all' || action === 'check-none') {
      const checked = action === 'check-all';
      $('modal-body')
        .querySelectorAll('input[name="realmIds"], input[name="userIds"]')
        .forEach((cb) => (cb.checked = checked));
    } else if (action === 'switch-view') switchView(nextView);
    else if (action === 'select-client') selectClient(realm);
    else if (action === 'select-user') {
      selectedUserId = Number(id);
      renderAll();
    } else if (action === 'settings') showSettingsModal();
    else if (action === 'copy-own-connector') copyText(ownConnectorUrl(), 'Connector URL copied');
    else if (action === 'copy-shared-connector')
      copyText(serverUrl?.connectorUrl || `${window.location.origin}/mcp`, 'Connector URL copied');
    else if (action === 'copy-server-url')
      copyText(serverUrl?.baseUrl || window.location.origin, 'Server address copied');
    else if (action === 'copy-redirect-uri')
      copyText(serverUrl?.intuitRedirectUri || `${window.location.origin}/callback`, 'Callback URL copied');
    else if (action === 'test') testConnection(realm);
    else if (action === 'add-company') showAddCompanyModal();
    else if (action === 'add-user') showCreateUserModal();
    else if (action === 'rename') renameCompany(realm, name);
    else if (action === 'manage-access') manageClientAccess(realm, name);
    else if (action === 'reconnect') reconnectCompany(realm, name);
    else if (action === 'disconnect') disconnectCompany(realm, name);
    else if (action === 'edit-user' && user) showEditUserModal(user);
    else if (action === 'edit-assignments' && user) showAssignmentsModal(user);
    else if (action === 'set-password' && user) showSetPasswordModal(user);
    else if (action === 'rotate-key' && user) rotateUserKey(user);
    else if (action === 'toggle-status' && user) toggleUserStatus(user);
    else if (action === 'delete-user' && user) deleteUser(user);
  });

  // Boot. qbo_api_key is the pre-password-login storage slot — migrate it.
  initTheme();
  const stored = localStorage.getItem('qbo_auth') || localStorage.getItem('qbo_api_key');
  if (!stored) {
    showAuthScreen();
    return;
  }
  authToken = stored;
  localStorage.setItem('qbo_auth', stored);
  localStorage.removeItem('qbo_api_key');
  initApp().catch((err) => {
    authToken = '';
    localStorage.removeItem('qbo_auth');
    showAuthScreen(err.message);
  });
});
