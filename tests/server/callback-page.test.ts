import { describe, it, expect } from 'vitest';
import { renderCallbackPage } from '../../src/server/callback-page.js';

describe('renderCallbackPage', () => {
  it('declares a UTF-8 charset so text never mojibakes', () => {
    const html = renderCallbackPage({ variant: 'success', heading: 'Connection successful', message: 'Done' });
    expect(html).toContain('<meta charset="UTF-8">');
  });

  it('uses SVG icons, not emoji', () => {
    const html = renderCallbackPage({ variant: 'success', heading: 'ok', message: 'm' });
    expect(html).toContain('<svg');
    // No stray emoji bytes that would garble without a charset
    expect(html).not.toMatch(/[✅❌←]/); // ✅ ❌ ←
  });

  it('renders a success page with company and details', () => {
    const html = renderCallbackPage({
      variant: 'success',
      heading: 'Connection successful',
      message: 'You’ve authorized',
      company: 'Acme Corp',
      details: [
        { label: 'Company ID', value: '9130351557663796', mono: true },
        { label: 'Authorization valid until', value: 'October 20, 2026' },
      ],
      autoRedirect: true,
    });
    expect(html).toContain('Connection successful');
    expect(html).toContain('<strong>Acme Corp</strong>');
    expect(html).toContain('9130351557663796');
    expect(html).toContain('October 20, 2026');
    expect(html).toContain('status-ok');
    expect(html).toContain('window.location.href="/"'); // auto-redirect
  });

  it('renders an error page without redirect and with a ghost button', () => {
    const html = renderCallbackPage({ variant: 'error', heading: 'Authorization failed', message: 'nope' });
    expect(html).toContain('status-err');
    expect(html).toContain('btn-ghost');
    expect(html).not.toContain('window.location.href="/"');
  });

  it('escapes HTML in the company name (no injection via QuickBooks state)', () => {
    const html = renderCallbackPage({
      variant: 'success',
      heading: 'ok',
      message: 'connected',
      company: '<img src=x onerror=alert(1)>"',
    });
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;&quot;');
  });

  it('escapes HTML in error messages (reflected from query params)', () => {
    const html = renderCallbackPage({
      variant: 'error',
      heading: 'Authorization failed',
      message: 'QuickBooks reported an error: <script>alert(1)</script>',
    });
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });
});
