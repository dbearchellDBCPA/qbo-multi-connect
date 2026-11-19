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
// Admin-only: whether the server emails anyone when a QuickBooks connection
// breaks, who it tells, and the last alert it sent. Null until loaded (or for
// non-admins / a server without the feature).
let alertsInfo = null;
let invitesInfo = null; // { enabled, from, firmName, replyTo, usingAlertSender, missing, problems } — admins only
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

/** Signed in with a client login (someone outside the firm, read-only). */
function isClientAccount() {
  return me?.accountType === 'client';
}

function applyIdentity() {
  const isAdmin = me.role === 'admin';
  document.querySelectorAll('.admin-only').forEach((el) => {
    el.hidden = !isAdmin;
  });
  // A client login gets a pared-down dashboard: their company and how to
  // connect, without the firm-facing panels.
  document.body.classList.toggle('client-account', isClientAccount());
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

async function loadAlerts() {
  const sessionToken = authToken;
  try {
    const data = await api('/api/alerts');
    if (sessionToken !== authToken) return;
    alertsInfo = data;
  } catch {
    if (sessionToken !== authToken) return;
    alertsInfo = null; // non-admin or older server — panel stays hidden
  }
  renderAll();
}

// Whether the server can email client logins their invitation and password.
async function loadInvites() {
  const sessionToken = authToken;
  try {
    const data = await api('/api/invites');
    if (sessionToken !== authToken) return;
    invitesInfo = data;
  } catch {
    if (sessionToken !== authToken) return;
    invitesInfo = null; // non-admin or older server — the option stays hidden
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
    ...(me.role === 'admin' ? [loadServerUrl(), loadAlerts(), loadInvites()] : []),
  ]);

  clearInterval(refreshTimer);
  refreshTimer = setInterval(() => {
    loadData(true).catch(() => {});
    refreshActivity(true); // keep the feed live while the page is open
  }, 60000);
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
  alertsInfo = null;
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
  activityEntries = [];
  activityKey = null;
  document.body.classList.remove('client-account');
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
    me.kind === 'master' ? 'Master key' : isClientAccount() ? me.name : `${me.name} · ${me.role}`;
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
    const rowHtml = (user) => {
      const isSelected = user.id === selected?.id;
      const avatarClass =
        user.status === 'disabled' ? 'avatar-disabled' : user.role === 'admin' ? 'avatar-admin' : 'avatar-member';
      let meta;
      if (user.status === 'disabled') meta = '<span class="row-meta bad">disabled</span>';
      else if (user.role === 'admin') meta = '<span class="row-meta">admin</span>';
      else if (user.accountType === 'client') {
        meta = `<span class="row-meta row-meta-long">${user.clients.length === 1 ? escapeHtml(user.clients[0].clientName) : `${user.clients.length} clients`}</span>`;
      } else meta = `<span class="row-meta">${user.realmIds.length} client${user.realmIds.length === 1 ? '' : 's'}</span>`;
      return `
          <button type="button" class="rail-row${isSelected ? ' selected' : ''}" data-action="select-user" data-id="${user.id}">
            <span class="avatar ${avatarClass}">${escapeHtml(initials(user.name))}</span>
            <span class="row-name">${escapeHtml(user.name)}</span>
            ${meta}
          </button>`;
    };
    // Team first; logins held by people outside the firm sit under their own
    // heading so the two are never confused.
    const staff = users.filter((u) => u.accountType !== 'client');
    const clientLogins = users.filter((u) => u.accountType === 'client');
    list.innerHTML = `
      ${staff.map(rowHtml).join('')}
      <div class="rail-divider">
        <span>Client logins</span>
        <button type="button" class="btn-link" data-action="add-client-login">+ Add</button>
      </div>
      ${clientLogins.map(rowHtml).join('') || '<div class="rail-note rail-note-left">None yet. A client login lets a client read their own books through their AI assistant.</div>'}`;
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
  if (isClientAccount()) return clientAccountDetailHtml(conn);
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
                u.role === 'admin'
                  ? 'admin · all clients'
                  : `${u.accountType === 'client' ? 'client login' : 'member'} · ${
                      u.clients.find((c) => c.realmId === conn.realmId)?.effectiveAccessLevel === 'read'
                        ? 'read-only'
                        : 'read & write'
                    }`
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
        me.canWrite === false && clientCount > 0
          ? ', read-only'
          : me.clients?.some((c) => c.canWrite === false)
            ? ', some read-only'
            : ''
      }`;

  return `
    <div class="detail-header">
      <div>
        <div class="detail-title-row">
          <h2 class="detail-title">${escapeHtml(conn.clientName)}</h2>
          ${statusPillHtml(status)}
          ${
            // Members see their own level for this client; admins write everywhere.
            !isAdmin && me.clients?.find((c) => c.realmId === conn.realmId)?.canWrite === false
              ? '<span class="pill pill-muted">Read-only</span>'
              : ''
          }
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

// What a client sees after signing in: their company, the address to give
// their AI assistant, and how to connect it. Nothing about the firm's server.
function clientAccountDetailHtml(conn) {
  if (!conn) {
    return `
      <div class="empty-state">
        <h3>No company assigned yet</h3>
        <p>Your login is set up, but it hasn't been linked to your QuickBooks company. Contact the firm that gave you this login.</p>
      </div>`;
  }
  const url = `${window.location.origin}/mcp`;
  return `
    <div class="detail-header">
      <div>
        <div class="detail-title-row">
          <h2 class="detail-title">${escapeHtml(conn.clientName)}</h2>
          <span class="pill pill-muted">Read-only</span>
        </div>
        <div class="detail-sub">Your AI assistant can look things up and run reports from these books. It cannot create, change, or delete anything in QuickBooks.</div>
      </div>
    </div>
    <div class="card">
      <div class="card-label">Connect your AI assistant</div>
      <div class="connector-url-row">
        <code class="connector-url">${escapeHtml(url)}</code>
        <button type="button" class="connector-copy" data-action="copy-shared-connector">Copy</button>
      </div>
      <ol class="help-steps">
        <li>In Claude, open <strong>Customize → Connectors</strong>, then <strong>+ Add → Add custom connector</strong>.</li>
        <li>Paste the address above, keep the suggested settings, and add it.</li>
        <li>When the sign-in page opens, enter the same username and password you used here.</li>
        <li>In a chat, switch the connector on and ask: <em>“What QuickBooks company am I connected to?”</em></li>
      </ol>
      <div class="connector-caption">Using a different assistant? Look for “add custom connector” or “add MCP server” and use the same address and sign-in. To change your password, open Settings (the gear, bottom left).</div>
    </div>`;
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
      ${alertsPanelHtml()}

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

// Admin-only panel: does this server email anyone when a QuickBooks
// connection breaks? The configuration itself is three server environment
// variables; this shows what's in effect and can prove it with a test send.
function alertsPanelHtml() {
  if (me?.role !== 'admin' || !alertsInfo) return '';
  const info = alertsInfo;

  const notices = [
    ...(info.problems || []).map((p) => `<div class="warn-box">${escapeHtml(p)}</div>`),
    ...(info.lastError ? [`<div class="warn-box">The last alert could not be sent — ${escapeHtml(info.lastError)}</div>`] : []),
  ].join('');

  let body;
  if (info.enabled) {
    const recipients = (info.recipients || []).map((r) => `<strong>${escapeHtml(r)}</strong>`).join(', ');
    const last = info.lastAlert
      ? `Last alert: ${escapeHtml(info.lastAlert.clientName)} · ${relativeTime(info.lastAlert.sentAt)}.`
      : 'No alert has been needed yet.';
    const linkNote = info.dashboardUrl
      ? ''
      : ` The email can't link back here until the server knows its own address — set <code>QBO_PUBLIC_URL</code> or <code>QBO_ALLOWED_HOSTS</code>.`;
    body = `
      <div class="connector-caption">
        <strong>On.</strong> When a company's QuickBooks connection breaks and needs reconnecting, an email goes to
        ${recipients} from <code>${escapeHtml(info.from || '')}</code> — once per break. ${last}${linkNote}
      </div>
      <div class="connector-caption" style="margin-top:12px">
        <button type="button" class="btn btn-ghost btn-small" data-action="send-test-alert">Send a test email</button>
      </div>`;
  } else {
    const missing = new Set(info.missing || []);
    const row = (name, what) =>
      `<li${missing.has(name) ? '' : ' style="opacity:.6"'}><code>${name}</code> — ${what}${
        missing.has(name) ? '' : ' <em>(already set)</em>'
      }</li>`;
    body = `
      <div class="connector-caption">
        <strong>Off.</strong> Nobody is told when a connection breaks — team members simply stop seeing that client
        in Claude until someone notices and clicks Reconnect. To be emailed instead, add these variables to the
        server environment (Railway → service → <strong>Variables</strong>) and redeploy:
      </div>
      <ol class="help-steps">
        ${row('RESEND_API_KEY', 'an API key from resend.com ("sending access" is enough)')}
        ${row('QBO_ALERT_EMAIL', 'who to notify — one address, or several separated by commas')}
        ${row('QBO_ALERT_FROM', 'the sender, on a domain verified in Resend, e.g. <code>QBO Alerts &lt;alerts@yourfirm.com&gt;</code>')}
      </ol>`;
  }

  return `
    <details class="connector-help">
      <summary>Email alerts when a connection breaks (admin)</summary>
      ${notices}
      ${body}
    </details>`;
}

async function sendTestAlert(button) {
  if (button) button.disabled = true;
  try {
    const result = await api('/api/alerts/test', { method: 'POST', body: JSON.stringify({}) });
    toast(`Test email sent to ${(result.recipients || []).join(', ')}`);
    loadAlerts();
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    if (button) button.disabled = false;
  }
}

// Under a client login's sign-in card: the button that emails them a new
// invitation and password, or the reason there isn't one.
function clientInviteControlsHtml(user, idAttr) {
  const note = '<p class="field-hint" style="margin-top:6px">Client logins connect by signing in. They have no API key.</p>';
  if (!invitesInfo?.enabled) {
    return `${note}<p class="field-hint">Email invitations are off on this server — see docs/CLIENT-ACCESS.md to turn them on.</p>`;
  }
  if (!user.email) {
    return `${note}<p class="field-hint">Add an email address under Edit to send them an invitation.</p>`;
  }
  if (user.status === 'disabled') {
    return `${note}<p class="field-hint">Enable this login to send an invitation.</p>`;
  }
  return `<button type="button" class="btn btn-ghost btn-card" data-action="send-invite" data-id="${idAttr}">${
    user.inviteSentAt ? 'Send a new invitation' : 'Send invitation'
  }</button>${note}`;
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
  const isClientLogin = user.accountType === 'client';
  const isReadOnly = user.role !== 'admin' && user.accessLevel === 'read';
  const readOnlyCount = user.role === 'admin' ? 0 : user.clients.filter((c) => c.effectiveAccessLevel === 'read').length;
  const accessSummary = isClientLogin
    ? 'Read-only (client login)'
    : isReadOnly
    ? 'Read-only everywhere'
    : readOnlyCount === 0
      ? 'Read & write'
      : readOnlyCount === user.clients.length
        ? 'Read-only'
        : `Read & write on ${user.clients.length - readOnlyCount}, read-only on ${readOnlyCount}`;
  let pill = isDisabled
    ? '<span class="pill pill-disabled">Disabled</span>'
    : `<span class="pill pill-role">${isClientLogin ? 'client login' : escapeHtml(user.role)}</span>`;
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
          .map((c) =>
            c.effectiveAccessLevel === 'read'
              ? `<span class="chip chip-read" title="Read-only: reports and lookups"><span class="chip-dot"></span>${escapeHtml(c.clientName)}<span class="chip-note">read-only</span></span>`
              : `<span class="chip" title="Read &amp; write"><span class="chip-dot"></span>${escapeHtml(c.clientName)}</span>`
          )
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
        <div class="card-label">${isClientLogin ? 'Sign-in' : 'Sign-in &amp; API key'}</div>
        <div class="stat-rows">
          <div class="stat-row"><span class="stat-label">Username</span><span class="stat-value">${user.username ? escapeHtml(user.username) : '<span class="team-meta">not set</span>'}</span></div>
          <div class="stat-row"><span class="stat-label">Password</span><span class="stat-value">${user.hasPassword ? 'Set' : '<span class="team-meta">not set</span>'}</span></div>
          ${isClientLogin ? '' : `<div class="stat-row"><span class="stat-label">Key</span><span class="key-chip">${escapeHtml(user.keyPrefix)}…</span></div>`}
          <div class="stat-row"><span class="stat-label">Last used</span><span class="stat-value">${escapeHtml(lastUsed)}</span></div>
          <div class="stat-row"><span class="stat-label">Status</span><span class="stat-value ${isDisabled ? 'status-bad' : 'status-ok'}"><span class="status-dot"></span>${isDisabled ? 'Disabled' : 'Active'}</span></div>
          <div class="stat-row"><span class="stat-label">QuickBooks access</span><span class="stat-value">${escapeHtml(accessSummary)}</span></div>
          ${isClientLogin ? `<div class="stat-row"><span class="stat-label">Invitation</span><span class="stat-value">${user.inviteSentAt ? `Sent ${escapeHtml(relativeTime(user.inviteSentAt))}` : '<span class="team-meta">not sent</span>'}</span></div>` : ''}
          <button type="button" class="btn btn-ghost btn-card" data-action="set-password" data-id="${idAttr}">${user.hasPassword ? 'Reset password' : 'Set up sign-in'}</button>
          ${isClientLogin ? clientInviteControlsHtml(user, idAttr) : `<button type="button" class="btn btn-ghost btn-card" data-action="rotate-key" data-id="${idAttr}">Rotate key</button>`}
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
// Two sources, merged by time. Admins get the server's activity log (GET
// /api/activity): every tool call and sign-in, who made it, on which company,
// and whether it was blocked. Connection events (connected, token refreshed,
// expired) aren't logged server-side, so those are still derived from data
// already on hand.
let activityEntries = []; // newest first, for the selection in activityKey
let activityKey = null; // which selection activityEntries belongs to
let activityLoadingKey = null;

// What to ask the log for: one member in the Team view, everything otherwise.
// null means "nothing to fetch" (not an admin, or no member selected).
function activitySelectionKey() {
  if (me?.role !== 'admin') return null;
  if (view !== 'team') return 'all';
  const user = currentUser();
  return user ? `userId=${user.id}` : null;
}

async function refreshActivity(force = false) {
  const key = activitySelectionKey();
  if (key === null) {
    activityEntries = [];
    activityKey = null;
    return;
  }
  if (!force && (key === activityKey || key === activityLoadingKey)) return;
  activityLoadingKey = key;
  try {
    const entries = await api(`/api/activity?limit=60${key === 'all' ? '' : `&${key}`}`);
    if (key !== activitySelectionKey()) return; // the selection moved on while loading
    activityEntries = entries;
    activityKey = key;
    renderActivity();
  } catch {
    // The feed is a convenience; the derived events still render without it.
  } finally {
    if (activityLoadingKey === key) activityLoadingKey = null;
  }
}

// One log entry → one feed row. Consecutive identical calls (a bulk job, or an
// assistant paging through a report) collapse into a single row with a count.
function loggedActivityEvents() {
  const events = [];
  for (const entry of activityKey === activitySelectionKey() ? activityEntries : []) {
    const who = entry.accountType === 'client' ? `${entry.userName} (client)` : entry.userName;
    const where = entry.clientName ? ` · ${entry.clientName}` : '';
    let tone;
    let title;
    let mono = false;
    if (entry.event === 'tool_call') {
      mono = true;
      title = entry.tool;
      if (entry.outcome === 'denied') tone = 'warn';
      else if (entry.outcome === 'error') tone = 'warn';
      else tone = entry.writes ? 'ok' : 'info';
    } else if (entry.event === 'sign_in') {
      tone = 'ok';
      title = entry.tool === 'connector' ? 'Connected an AI assistant' : 'Signed in to the dashboard';
    } else if (entry.event === 'locked_out') {
      tone = 'warn';
      title = 'Locked out after failed sign-ins';
    } else {
      tone = 'warn';
      title = 'Failed sign-in';
    }
    const note = entry.event === 'tool_call' && entry.outcome === 'denied' ? ' · blocked (read-only)' : entry.event === 'tool_call' && entry.outcome === 'error' ? ' · failed' : '';
    const signature = `${entry.userId}|${entry.userName}|${entry.event}|${entry.tool}|${entry.realmId}|${entry.outcome}`;
    const previous = events[events.length - 1];
    if (previous && previous.signature === signature) {
      previous.count += 1;
      continue;
    }
    events.push({ ts: new Date(entry.at).getTime(), tone, title, mono, who, where, note, signature, count: 1, userId: entry.userId });
  }
  return events.map((e) => ({
    ts: e.ts,
    tone: e.tone,
    title: e.count > 1 ? `${e.title} ×${e.count}` : e.title,
    mono: e.mono,
    meta: `${e.who}${e.where}${e.note} · ${relativeTime(e.ts)}`,
    userId: e.userId,
  }));
}

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
        tone: 'ok',
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
        tone: 'ok',
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
        tone: 'warn',
        title: 'Authorization expired',
        meta: `${conn.clientName} · ${relativeTime(expiredAt)}`,
      });
    }
    if (conn.status === 'revoked') {
      const ts = new Date(conn.updatedAt ?? conn.tokenExpiry).getTime();
      events.push({
        ts: Number.isFinite(ts) ? ts : now,
        tone: 'warn',
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
          tone: 'ok',
          title: user.accountType === 'client' ? 'Client login added' : 'Member added',
          meta: `${user.name} · ${relativeTime(user.createdAt)}`,
          userId: user.id,
        });
      }
      // "API key used" is superseded by the log, which says what it was used for.
      if (user.lastUsedAt && activityKey === null) {
        events.push({
          ts: new Date(user.lastUsedAt).getTime(),
          tone: 'info',
          title: 'API key used',
          meta: `${user.name} · ${relativeTime(user.lastUsedAt)}`,
          userId: user.id,
        });
      }
    }
  }

  events.push(...loggedActivityEvents());
  return events.filter((e) => Number.isFinite(e.ts)).sort((a, b) => b.ts - a.ts);
}

function renderActivity() {
  const label = $('activity-label');
  const list = $('activity-list');
  refreshActivity(); // no-op unless the selection changed; re-renders when it lands
  let events = buildActivity();

  if (view === 'team') {
    const user = currentUser();
    label.textContent = user ? `${firstName(user.name)}’s activity` : 'Activity';
    events = user ? events.filter((e) => e.userId === user.id) : [];
  } else {
    label.textContent = 'Activity';
  }

  events = events.slice(0, 16);
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
            <div class="act-title${e.mono ? ' mono' : ''}">${escapeHtml(e.title)}</div>
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
      <div class="access-list">
        ${members
          .map((u) => {
            const assignment = u.clients.find((c) => c.realmId === realmId);
            const capped = u.accessLevel === 'read';
            return accessRowHtml({
              inputName: 'userIds',
              value: u.id,
              label: u.accountType === 'client' ? `${u.name} (client login)` : capped ? `${u.name} (read-only member)` : u.name,
              checked: Boolean(assignment),
              level: assignment?.accessLevel,
              locked: capped,
            });
          })
          .join('')}
      </div>`
    : '<p class="field-hint">No member accounts yet. Add members from the Team view first.</p>';

  const adminNote = admins.length
    ? `<p class="field-hint" style="margin-top:12px">Admins always have access: ${admins
        .map((a) => escapeHtml(a.name))
        .join(', ')}.</p>`
    : '';

  body.innerHTML = `
    <p class="field-hint" style="margin-bottom:14px;font-size:12.5px">Choose which members can access <strong>${escapeHtml(clientName)}</strong>, and whether each can change its books or only read them. Changes take effect immediately.</p>
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
    const assigned = readAccessRows(event.target, 'userIds').map((row) => ({
      userId: Number(row.id),
      accessLevel: row.accessLevel,
    }));
    try {
      await api(`/api/connections/${encodeURIComponent(realmId)}/users`, {
        method: 'PUT',
        body: JSON.stringify({ users: assigned }),
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
const ACCESS_LEVEL_LABELS = { read_write: 'Read & write', read: 'Read-only' };

function checkboxToolbar() {
  return `
    <div class="checkbox-toolbar">
      <button type="button" class="btn-link" data-action="check-all">Select all</button>
      <span class="toolbar-sep">·</span>
      <button type="button" class="btn-link" data-action="check-none">Select none</button>
      <span class="toolbar-levels" data-staff-only>
        <span class="toolbar-sep">·</span>
        <span class="toolbar-label">Set checked to</span>
        <button type="button" class="btn-link" data-action="level-all" data-level="read_write">Read &amp; write</button>
        <span class="toolbar-sep">/</span>
        <button type="button" class="btn-link" data-action="level-all" data-level="read">Read-only</button>
      </span>
    </div>
  `;
}

// One row of an access list: a checkbox (is it assigned?) and a level picker
// (what may they do there?). `locked` shows the level as fixed read-only —
// used when the member is read-only everywhere, which overrides the picker.
function accessRowHtml({ inputName, value, label, checked, level, locked }) {
  const shown = locked ? 'read' : level || 'read_write';
  // data-assigned marks rows that already had a level before this dialog
  // opened — see readAccessRows for why that matters while locked.
  return `
    <div class="access-row"${checked ? ' data-assigned="true"' : ''}>
      <label class="checkbox-item">
        <input type="checkbox" name="${inputName}" value="${escapeHtml(String(value))}" ${checked ? 'checked' : ''}>
        <span title="${escapeHtml(label)}">${escapeHtml(label)}</span>
      </label>
      <select class="access-level" data-stored-level="${escapeHtml(level || 'read_write')}"
              aria-label="Access level for ${escapeHtml(label)}"
              ${locked ? 'data-locked="true"' : ''} ${!checked || locked ? 'disabled' : ''}>
        ${Object.entries(ACCESS_LEVEL_LABELS)
          .map(([v, text]) => `<option value="${v}" ${shown === v ? 'selected' : ''}>${escapeHtml(text)}</option>`)
          .join('')}
      </select>
    </div>`;
}

// Read an access list back as [{ id, accessLevel }] for the checked rows. A
// locked picker (member is read-only everywhere) shows "Read-only" whatever
// is stored, so: a row that was already assigned keeps its stored level —
// saving doesn't quietly rewrite it — while a row newly checked under the
// lock is saved as read-only, which is what the admin was shown. Otherwise
// lifting the member-wide lock later would hand out write access nobody chose.
function readAccessRows(root, inputName) {
  return [...root.querySelectorAll(`input[name="${inputName}"]:checked`)].map((cb) => {
    const row = cb.closest('.access-row');
    const select = row.querySelector('.access-level');
    let accessLevel = select.value;
    if (select.dataset.locked) accessLevel = row.dataset.assigned ? select.dataset.storedLevel : 'read';
    return { id: cb.value, accessLevel };
  });
}

// Keep each row's picker in step with its checkbox, and with the member-wide
// "read-only everywhere" choice when the list sits in the member form.
function syncAccessRows(root) {
  const cap = root.querySelector('input[name="accessLevel"]:checked');
  const type = root.querySelector('input[name="accountType"]:checked');
  const isClient = type?.value === 'client';
  const lockAll = isClient || cap?.value === 'read';
  // A client login has no role or access choice to make, and can't be saved
  // without a way to sign in (it has no API key to fall back on).
  root.querySelectorAll('[data-staff-only]').forEach((el) => (el.hidden = isClient));
  root.querySelectorAll('[data-client-only]').forEach((el) => (el.hidden = !isClient));
  root.querySelectorAll('[data-client-required]').forEach((el) => (el.required = isClient));
  // Emailing an invitation means the server chooses the password: the
  // password field goes away and the email address becomes the thing we need.
  const inviteBox = root.querySelector('input[name="sendInvite"]');
  const inviting = isClient && Boolean(inviteBox?.checked) && !inviteBox.disabled;
  root.querySelectorAll('[data-hidden-when-inviting]').forEach((el) => (el.hidden = inviting));
  const passwordInput = root.querySelector('input[name="password"]');
  if (passwordInput) passwordInput.required = isClient && !inviting;
  const emailInput = root.querySelector('input[name="email"]');
  if (emailInput) emailInput.required = inviting;
  root.querySelectorAll('[data-email-optional]').forEach((el) => (el.hidden = inviting));
  const createButton = root.querySelector('[data-submit-create]');
  if (createButton) {
    createButton.textContent = !isClient ? 'Create member' : inviting ? 'Create and send invitation' : 'Create client login';
  }
  root.querySelectorAll('.access-row').forEach((row) => {
    const checkbox = row.querySelector('input[type="checkbox"]');
    const select = row.querySelector('.access-level');
    if (cap || type) {
      if (lockAll && !select.dataset.locked) {
        select.dataset.storedLevel = select.value;
        select.dataset.locked = 'true';
        select.value = 'read';
      } else if (!lockAll && select.dataset.locked) {
        delete select.dataset.locked;
        select.value = select.dataset.storedLevel || 'read_write';
      }
    }
    select.disabled = !checkbox.checked || Boolean(select.dataset.locked);
  });
}

function clientCheckboxes(user) {
  const levels = new Map((user?.clients || []).map((c) => [c.realmId, c.accessLevel]));
  if (connections.length === 0) {
    return '<p class="field-hint">No clients connected yet — connect one first, then assign it here.</p>';
  }
  const locked = user?.role !== 'admin' && (user?.accessLevel === 'read' || user?.accountType === 'client');
  return `
    ${checkboxToolbar()}
    <div class="access-list">
      ${connections
        .map((c) =>
          accessRowHtml({
            inputName: 'realmIds',
            value: c.realmId,
            label: c.clientName,
            checked: levels.has(c.realmId),
            level: levels.get(c.realmId),
            locked,
          })
        )
        .join('')}
    </div>
  `;
}

// The "email them an invitation" choice on the new-client-login form. On by
// default when the server can send; when it can't, it says what is missing
// instead of quietly not being there.
function inviteOptionHtml() {
  if (!invitesInfo) return '';
  if (!invitesInfo.enabled) {
    const need = [...(invitesInfo.problems || []), ...(invitesInfo.missing || []).map((name) => `${name} is not set`)].join('; ');
    return `
      <div class="field" data-client-only hidden>
        <span class="field-hint">Email invitations are off${need ? ` — ${escapeHtml(need)}` : ''}. Choose a password below and send it to the client yourself.</span>
      </div>`;
  }
  return `
      <div class="field" data-client-only hidden>
        <label class="checkbox-item checkbox-solo">
          <input type="checkbox" name="sendInvite" checked>
          <span>Email them an invitation and a generated password</span>
        </label>
        <span class="field-hint">Two emails go to the address above from ${escapeHtml(invitesInfo.from || '')}: one with the connector address, their username, and setup steps for Claude and ChatGPT; a second with a strong password the server generates. The password is never shown here.${
          invitesInfo.usingAlertSender ? ' This is your alert sender — set QBO_INVITE_FROM for a client-facing address.' : ''
        }</span>
      </div>`;
}

function userFormHtml(user, presetType) {
  const accountType = user?.accountType || presetType || 'staff';
  return `
    <form id="user-form" class="form-stack">
      <div class="field">
        <span class="field-label">Account type</span>
        <div class="radio-row">
          <label><input type="radio" name="accountType" value="staff" ${accountType !== 'client' ? 'checked' : ''}> Team member — someone at the firm</label>
          <label><input type="radio" name="accountType" value="client" ${accountType === 'client' ? 'checked' : ''}> Client login — a client reading their own books through their AI assistant</label>
        </div>
        <span class="field-hint" data-client-only hidden>A client login is always read-only, can never be an admin, and has no API key — the client signs in to the connector with the username and password below.</span>
      </div>
      <label class="field">
        <span class="field-label">Name</span>
        <input type="text" name="name" required value="${user ? escapeHtml(user.name) : ''}" placeholder="e.g. Jane Smith">
      </label>
      <label class="field">
        <span class="field-label">Email <span class="field-hint" data-email-optional>(optional)</span></span>
        <input type="email" name="email" value="${user?.email ? escapeHtml(user.email) : ''}" placeholder="jane@example.com">
      </label>
      <label class="field">
        <span class="field-label">Username <span class="field-hint">(for signing in)</span></span>
        <input type="text" name="username" data-client-required value="${user?.username ? escapeHtml(user.username) : ''}" placeholder="e.g. jane.smith" autocomplete="off">
      </label>
      ${
        user
          ? ''
          : `
      ${inviteOptionHtml()}
      <label class="field" data-hidden-when-inviting>
        <span class="field-label">Password <span class="field-hint" data-staff-only>(optional — can be set later)</span></span>
        <input type="password" name="password" minlength="8" placeholder="At least 8 characters" autocomplete="new-password">
        <span class="field-hint">Give it to them privately, separately from the username — they can change it after signing in.</span>
      </label>`
      }
      <div class="field" data-staff-only>
        <span class="field-label">Role</span>
        <div class="radio-row">
          <label><input type="radio" name="role" value="member" ${!user || user.role === 'member' ? 'checked' : ''}> Member — assigned clients only</label>
          <label><input type="radio" name="role" value="admin" ${user?.role === 'admin' ? 'checked' : ''}> Admin — all clients + team management</label>
        </div>
      </div>
      <div class="field" data-staff-only>
        <span class="field-label">QuickBooks access</span>
        <div class="radio-row">
          <label><input type="radio" name="accessLevel" value="read_write" ${!user || user.accessLevel !== 'read' ? 'checked' : ''}> Set per client — choose Read &amp; write or Read-only for each client below</label>
          <label><input type="radio" name="accessLevel" value="read" ${user?.accessLevel === 'read' ? 'checked' : ''}> Read-only everywhere — reports and lookups only, on every assigned client</label>
        </div>
        <span class="field-hint">Applies to this member's API key and MCP connector. Admins always have full access.</span>
      </div>
      <div class="field" id="client-assign-field">
        <span class="field-label">Assigned clients</span>
        ${clientCheckboxes(user)}
        <span class="field-hint" data-staff-only>Only checked clients are visible to this member. Read-only means reports and lookups — nothing in that client's books can be created, changed, or deleted. Ignored for admins.</span>
        <span class="field-hint" data-client-only hidden>Check the client's own company — usually just one. They will see everything in that file, including payroll and owner transactions, but cannot change any of it.</span>
      </div>
      <div class="modal-footer">
        <button type="button" class="btn btn-ghost" data-action="close-modal">Cancel</button>
        <button type="submit" class="btn btn-primary"${user ? '' : ' data-submit-create'}>${user ? 'Save changes' : 'Create member'}</button>
      </div>
    </form>
  `;
}

function readUserForm(form) {
  const data = new FormData(form);
  const isClient = data.get('accountType') === 'client';
  const inviteBox = form.querySelector('input[name="sendInvite"]');
  const sendInvite = isClient && Boolean(inviteBox?.checked) && !inviteBox.disabled;
  return {
    ...(sendInvite ? { sendInvite: true } : {}),
    name: data.get('name')?.trim(),
    email: data.get('email')?.trim() || null,
    accountType: isClient ? 'client' : 'staff',
    role: isClient ? 'member' : data.get('role'),
    accessLevel: isClient ? 'read' : data.get('accessLevel'),
    username: data.get('username')?.trim() || null,
    password: sendInvite ? null : data.get('password') || null,
    clients: readAccessRows(form, 'realmIds').map((row) => ({ realmId: row.id, accessLevel: row.accessLevel })),
  };
}

function showCreateUserModal(presetType) {
  openModal(presetType === 'client' ? 'Add a client login' : 'Add a member', userFormHtml(null, presetType), { wide: true });
  syncAccessRows($('modal-body'));
  $('modal-body').querySelector('#user-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      const payload = readUserForm(event.target);
      const { user, apiKey: newKey, invite } = await api('/api/users', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      selectedUserId = user.id;
      await loadUsers();
      if (user.accountType === 'client') showClientLoginCreatedModal(user, invite);
      else showKeyModal(user, newKey, 'created');
    } catch (err) {
      toast(err.message, 'error');
    }
  });
}

function showEditUserModal(user) {
  openModal(`Edit ${user.name}`, userFormHtml(user), { wide: true });
  syncAccessRows($('modal-body'));
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
      ${clientCheckboxes(user)}
      <span class="field-hint">Only checked clients are visible to ${escapeHtml(user.name)}. ${
        user.accessLevel === 'read'
          ? 'This member is read-only everywhere — change that under Edit to set levels per client.'
          : 'Read-only means reports and lookups; nothing in that client\'s books can be changed.'
      }</span>
    </div>
    <div class="modal-footer">
      <button type="button" class="btn btn-ghost" data-action="close-modal">Cancel</button>
      <button type="submit" class="btn btn-primary">Save assignments</button>
    </div>
  `;
  body.addEventListener('submit', async (event) => {
    event.preventDefault();
    const clients = readAccessRows(event.target, 'realmIds').map((row) => ({ realmId: row.id, accessLevel: row.accessLevel }));
    try {
      await api(`/api/users/${user.id}`, { method: 'PATCH', body: JSON.stringify({ clients }) });
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

// After creating a client login: either confirm the invitation went out, or
// say what to send them by hand. There is no key to show — they connect by
// signing in — and when the server emailed a password, it is not shown either.
function showClientLoginCreatedModal(user, invite) {
  const url = serverUrl?.connectorUrl || `${window.location.origin}/mcp`;
  const company = user.clients.map((c) => c.clientName).join(', ');
  const body = document.createElement('div');
  const footer = `
    <div class="modal-footer">
      <button type="button" class="btn btn-primary" data-action="close-modal">Done</button>
    </div>`;

  if (invite?.sent) {
    body.innerHTML = `
      <p class="field-hint" style="font-size:12.5px;margin-bottom:14px">${escapeHtml(user.name)} can now connect an AI assistant to ${
        company ? `<strong>${escapeHtml(company)}</strong>` : 'their company'
      }, read-only.</p>
      <div class="callout-ok">
        <div class="callout-title">Invitation sent to ${escapeHtml(invite.to)}</div>
        <div class="callout-body">Two emails are on their way: one with the connector address, their username, and setup steps for Claude and ChatGPT; a second with their password. There is nothing else you need to send.</div>
      </div>
      <p class="field-hint" style="margin-top:14px">Their activity will show on this page once they connect. To send a fresh invitation later, use <strong>Send a new invitation</strong> on their login.</p>
      ${footer}`;
    openModal('Client login created', body, { wide: true });
    return;
  }

  const failed = invite && !invite.sent;
  body.innerHTML = `
    ${
      failed
        ? `<div class="callout-warning" style="margin-bottom:14px">
            <div class="callout-title">The login was created, but the invitation was not delivered</div>
            <div class="callout-body">${escapeHtml(invite.error || 'The email could not be sent.')} Once that is sorted out, use <strong>Send invitation</strong> on their login — it emails a new password, so nothing is lost.</div>
          </div>`
        : `<p class="field-hint" style="font-size:12.5px;margin-bottom:14px">${escapeHtml(user.name)} can now connect an AI assistant to ${
            company ? `<strong>${escapeHtml(company)}</strong>` : 'their company (none assigned yet — add one under Edit assignments)'
          }, read-only. Send them these two things, and the password separately.</p>`
    }
    <div class="field">
      <span class="field-label">Connector address</span>
      <div class="connector-url-row">
        <code class="connector-url">${escapeHtml(url)}</code>
        <button type="button" class="connector-copy" data-copy-url>Copy</button>
      </div>
    </div>
    <div class="field" style="margin-top:14px">
      <span class="field-label">Username</span>
      <div class="key-row"><code class="key-display">${escapeHtml(user.username || 'not set — use “Set up sign-in” before sending')}</code></div>
    </div>
    ${failed ? '' : '<p class="field-hint" style="margin-top:14px">A ready-to-send handout with setup steps is in <code>docs/CLIENT-CONNECTOR-SETUP.md</code>. Their activity will show on this page once they connect.</p>'}
    ${footer}`;
  body.querySelector('[data-copy-url]').addEventListener('click', () => copyText(url, 'Connector address copied'));
  openModal('Client login created', body, { wide: true });
}

// Email a client login a fresh invitation and a NEW password. The server only
// swaps the password in once both emails are accepted, so a failure here
// leaves the login exactly as it was.
function sendClientInvite(user) {
  const again = Boolean(user.inviteSentAt) || user.hasPassword;
  confirmModal(
    again ? 'Send a new invitation' : 'Send invitation',
    `Email ${user.email} an invitation and a new password for “${user.name}”?${
      again ? ' Their current password stops working, and any AI assistant they have connected is signed out until they sign in with the new one.' : ''
    }`,
    'Send invitation',
    async () => {
      const { invite } = await api(`/api/users/${user.id}/invite`, { method: 'POST' });
      await loadUsers();
      toast(`Invitation and password sent to ${invite.to}`);
    },
    { variant: 'primary' }
  );
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
      : `Signed in as ${escapeHtml(me.name)}${me.username ? ` (${escapeHtml(me.username)})` : ''}${isClientAccount() ? '' : ` · ${escapeHtml(me.role)}`}`;

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
    ${isClientAccount() ? '' : `<div class="field">
      <span class="field-label">Your API key</span>
      ${keySection}
    </div>`}
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

  // Access lists: a row's level picker follows its checkbox, and every picker
  // follows the member-wide "read-only everywhere" choice.
  document.addEventListener('change', (event) => {
    const modal = $('modal-body');
    if (!modal || !modal.contains(event.target)) return;
    if (event.target.matches('.access-row input[type="checkbox"], input[name="accessLevel"], input[name="accountType"], input[name="sendInvite"]')) {
      syncAccessRows(modal);
    }
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
      syncAccessRows($('modal-body'));
    } else if (action === 'level-all') {
      // Set the level on every checked row (locked rows keep their fixed level).
      $('modal-body')
        .querySelectorAll('.access-row')
        .forEach((row) => {
          const select = row.querySelector('.access-level');
          if (row.querySelector('input[type="checkbox"]').checked && !select.dataset.locked) {
            select.value = target.dataset.level;
          }
        });
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
    else if (action === 'send-test-alert') sendTestAlert(target);
    else if (action === 'add-company') showAddCompanyModal();
    else if (action === 'add-user') showCreateUserModal();
    else if (action === 'add-client-login') showCreateUserModal('client');
    else if (action === 'rename') renameCompany(realm, name);
    else if (action === 'manage-access') manageClientAccess(realm, name);
    else if (action === 'reconnect') reconnectCompany(realm, name);
    else if (action === 'disconnect') disconnectCompany(realm, name);
    else if (action === 'edit-user' && user) showEditUserModal(user);
    else if (action === 'edit-assignments' && user) showAssignmentsModal(user);
    else if (action === 'set-password' && user) showSetPasswordModal(user);
    else if (action === 'rotate-key' && user) rotateUserKey(user);
    else if (action === 'send-invite' && user) sendClientInvite(user);
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
