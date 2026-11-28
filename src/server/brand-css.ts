/**
 * Brand CSS shared by the two server-rendered pages — the OAuth callback
 * result (`callback-page.ts`) and the MCP connector sign-in (`routes/oauth.ts`).
 *
 * Both are standalone documents that can't reach the dashboard's stylesheet
 * without an extra round trip, so they inline their own copy. Keeping that copy
 * here means the David Bearchell CPA palette is defined once for the server
 * pages instead of drifting between two hand-maintained blocks.
 *
 * The palette matches dbcpallc.com — white paper, near-black ink, Mets blue as
 * the one accent. Two scales carry it: a neutral ink scale for structure and
 * text, a blue accent for calls to action. The accent contrast rule holds here
 * as it does in the dashboard: accent-600/700 carry text on light surfaces,
 * accent-300/400 carry text on ink ones.
 */

/** Self-hosted Inter + Fraunces, served from the static `public/fonts` dir. */
export const BRAND_FONT_FACES = `
  @font-face {
    font-family:'Inter Variable'; font-style:normal; font-display:swap; font-weight:100 900;
    src:url(/fonts/inter-latin-wght-normal.woff2) format('woff2-variations');
    unicode-range:U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD;
  }
  @font-face {
    font-family:'Inter Variable'; font-style:normal; font-display:swap; font-weight:100 900;
    src:url(/fonts/inter-latin-ext-wght-normal.woff2) format('woff2-variations');
    unicode-range:U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF;
  }
  @font-face {
    font-family:'Fraunces Variable'; font-style:normal; font-display:swap; font-weight:100 900;
    src:url(/fonts/fraunces-latin-full-normal.woff2) format('woff2-variations');
    unicode-range:U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD;
  }
  @font-face {
    font-family:'Fraunces Variable'; font-style:normal; font-display:swap; font-weight:100 900;
    src:url(/fonts/fraunces-latin-ext-full-normal.woff2) format('woff2-variations');
    unicode-range:U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF;
  }
`;

/** Brand scales plus the semantic aliases both server pages draw on. */
export const BRAND_TOKENS = `
  :root {
    --ink-50:#f6f6f7; --ink-100:#ececee; --ink-200:#d6d7db; --ink-300:#b4b6bd;
    --ink-400:#8a8d96; --ink-500:#6b7280; --ink-600:#5b606b; --ink-700:#3f434b;
    --ink-800:#26282d; --ink-900:#17181b; --ink-950:#0b0b0c;
    --accent-300:#a9c4f7; --accent-400:#7ea6f2; --accent-500:#2a5db8;
    --accent-600:#002d72; --accent-700:#001f52; --accent-800:#00163b;

    --bg:#ffffff; --surface:#ffffff; --surface-2:var(--ink-50);
    --border:var(--ink-100); --border-input:var(--ink-500); --border-control:var(--ink-300);
    --text:var(--ink-900); --text-secondary:var(--ink-700); --text-faint:var(--ink-500);
    --primary:var(--accent-600); --primary-hover:var(--accent-700); --on-primary:#ffffff;
    --primary-soft:rgba(0,45,114,0.1);
    --ok:var(--accent-600); --ok-soft:rgba(0,45,114,0.1);
    --err:#991b1b; --err-strong:#b91c1c; --err-soft:#fef2f2; --err-border:#fecaca;
    --shadow:0 4px 16px rgba(11,11,12,.08);
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg:var(--ink-950); --surface:var(--ink-900); --surface-2:var(--ink-800);
      --border:var(--ink-800); --border-input:var(--ink-600); --border-control:var(--ink-600);
      --text:#ffffff; --text-secondary:var(--ink-200); --text-faint:var(--ink-300);
      --primary:var(--accent-400); --primary-hover:var(--accent-300); --on-primary:var(--ink-950);
      --primary-soft:rgba(126,166,242,0.14);
      --ok:var(--accent-400); --ok-soft:rgba(126,166,242,0.14);
      --err:#fca5a5; --err-strong:#f87171; --err-soft:#3f1d1d; --err-border:#7f3535;
      --shadow:0 4px 16px rgba(0,0,0,.5);
    }
  }
`;

/** Favicon for every server-rendered page: the bar graphic from the DBCPA logo, black on white. */
export const BRAND_FAVICON = '<link rel="icon" type="image/svg+xml" href="/favicon.svg">\n<link rel="icon" type="image/png" href="/favicon.png">\n<link rel="apple-touch-icon" href="/apple-touch-icon.png">';

/**
 * Base rules both pages share: the type stack (Inter for UI, Fraunces for the
 * page title), the centred card shell and the brand mark. Page-specific rules
 * are appended by each caller.
 */
export const BRAND_BASE = `
  * { box-sizing:border-box; margin:0; padding:0; }
  body {
    font-family:'Inter Variable', Inter, system-ui, -apple-system, sans-serif;
    background:var(--bg); color:var(--text); min-height:100vh; display:flex;
    align-items:center; justify-content:center; padding:24px; line-height:1.5;
  }
  h1 {
    font-family:'Fraunces Variable', Fraunces, Georgia, 'Times New Roman', serif;
    font-variation-settings:'opsz' 72, 'SOFT' 0, 'WONK' 0;
    font-weight:700; letter-spacing:-0.02em;
  }
  a:focus-visible, button:focus-visible, input:focus-visible {
    outline:2px solid var(--primary); outline-offset:2px;
  }
  .brand { display:flex; align-items:center; gap:10px; }
  /* The app's mark: three rising bars, black and white. It follows the page:
     a black tile with white bars on a light page, the reverse on a dark one. */
  .brand-logo {
    width:34px; height:34px; border-radius:9px; background:var(--text);
    display:inline-flex; align-items:flex-end; justify-content:center; gap:2.5px; padding:8px 0 9px;
    flex-shrink:0;
  }
  .brand-logo i { display:block; width:4px; border-radius:1.5px; background:var(--bg); }
  .brand-logo i:nth-child(1) { height:7px; }
  .brand-logo i:nth-child(2) { height:12px; }
  .brand-logo i:nth-child(3) { height:17px; }
  .brand-name { font-weight:650; font-size:15px; color:var(--text); }
  /* A firm's own logo, in place of the mark. On a dark page it sits on a
     white plate, since most logos are drawn for a light background. */
  .brand-img { display:block; height:40px; width:auto; max-width:240px; object-fit:contain; flex-shrink:0; }
  @media (prefers-color-scheme: dark) {
    .brand-img { background:#ffffff; border-radius:8px; padding:4px 8px; box-sizing:content-box; }
  }
`;

/** The three-bar brand mark, as markup for the `.brand-logo` rules above. */
export const BRAND_MARK = '<span class="brand-logo"><i></i><i></i><i></i></span>';

function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/**
 * The brand line at the top of a client-facing page: the firm's logo when it
 * has uploaded one (alone if it is a wordmark, beside the name otherwise),
 * else the app's mark beside the name.
 */
export function brandLine(firm: { displayName: string; logo?: { path: string; wide: boolean } | null }): string {
  const name = `<span class="brand-name">${escapeAttr(firm.displayName)}</span>`;
  if (!firm.logo) return `${BRAND_MARK}${name}`;
  const image = `<img class="brand-img" src="${escapeAttr(firm.logo.path)}" alt="${firm.logo.wide ? escapeAttr(firm.displayName) : ''}">`;
  return firm.logo.wide ? image : `${image}${name}`;
}
