/**
 * Brand CSS shared by the two server-rendered pages — the OAuth callback
 * result (`callback-page.ts`) and the MCP connector sign-in (`routes/oauth.ts`).
 *
 * Both are standalone documents that can't reach the dashboard's stylesheet
 * without an extra round trip, so they inline their own copy. Keeping that copy
 * here means the David Bearchell CPA palette is defined once for the server
 * pages instead of drifting between two hand-maintained blocks.
 *
 * The two brand scales — a desaturated navy for structure and text, a teal
 * accent for calls to action — are the whole palette. The accent contrast rule
 * holds here as it does in the dashboard: accent-600/700 carry text on light
 * surfaces, accent-300/400 carry text on navy ones.
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
    --navy-50:#f0f4f8; --navy-100:#d9e2ec; --navy-200:#bcccdc; --navy-300:#9fb3c8;
    --navy-400:#829ab1; --navy-500:#627d98; --navy-600:#486581; --navy-700:#334e68;
    --navy-800:#243b53; --navy-900:#102a43; --navy-950:#0a1929;
    --accent-300:#7edce2; --accent-400:#4fd1c5; --accent-500:#38b2ac;
    --accent-600:#117c75; --accent-700:#0e6f68; --accent-800:#115e59;

    --bg:#ffffff; --surface:#ffffff; --surface-2:var(--navy-50);
    --border:var(--navy-100); --border-input:var(--navy-500); --border-control:var(--navy-300);
    --text:var(--navy-900); --text-secondary:var(--navy-700); --text-faint:var(--navy-500);
    --primary:var(--accent-600); --primary-hover:var(--accent-700); --on-primary:#ffffff;
    --primary-soft:rgba(17,124,117,0.1);
    --ok:var(--accent-600); --ok-soft:rgba(17,124,117,0.1);
    --err:#991b1b; --err-strong:#b91c1c; --err-soft:#fef2f2; --err-border:#fecaca;
    --shadow:0 4px 16px rgba(16,42,67,.08);
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg:var(--navy-950); --surface:var(--navy-900); --surface-2:var(--navy-800);
      --border:var(--navy-800); --border-input:var(--navy-600); --border-control:var(--navy-600);
      --text:#ffffff; --text-secondary:var(--navy-200); --text-faint:var(--navy-300);
      --primary:var(--accent-400); --primary-hover:var(--accent-300); --on-primary:var(--navy-950);
      --primary-soft:rgba(79,209,197,0.14);
      --ok:var(--accent-400); --ok-soft:rgba(79,209,197,0.14);
      --err:#fca5a5; --err-strong:#f87171; --err-soft:#3f1d1d; --err-border:#7f3535;
      --shadow:0 4px 16px rgba(0,0,0,.5);
    }
  }
`;

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
  /* The mark from the favicon: navy tile, three rising accent bars. */
  .brand-logo {
    width:34px; height:34px; border-radius:9px; background:var(--navy-900);
    display:inline-flex; align-items:flex-end; justify-content:center; gap:2.5px; padding:8px 0 9px;
    flex-shrink:0;
  }
  .brand-logo i { display:block; width:4px; border-radius:1.5px; }
  .brand-logo i:nth-child(1) { height:7px; background:var(--accent-500); }
  .brand-logo i:nth-child(2) { height:12px; background:var(--accent-400); }
  .brand-logo i:nth-child(3) { height:17px; background:#ffffff; }
  .brand-name { font-weight:650; font-size:15px; color:var(--text); }
`;

/** The three-bar brand mark, as markup for the `.brand-logo` rules above. */
export const BRAND_MARK = '<span class="brand-logo"><i></i><i></i><i></i></span>';
