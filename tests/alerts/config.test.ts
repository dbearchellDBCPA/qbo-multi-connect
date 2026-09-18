import { describe, it, expect } from 'vitest';
import { bareAddress, parseAlertsConfig, parseRecipients } from '../../src/alerts/config.js';

describe('parseAlertsConfig', () => {
  it('is off with nothing set and names every missing variable', () => {
    const c = parseAlertsConfig({});
    expect(c.enabled).toBe(false);
    expect(c.missing).toEqual(['RESEND_API_KEY', 'QBO_ALERT_EMAIL', 'QBO_ALERT_FROM']);
    expect(c.problems).toEqual([]);
  });

  it('turns on when all three are set', () => {
    const c = parseAlertsConfig({
      RESEND_API_KEY: ' re_123 ',
      QBO_ALERT_EMAIL: 'ops@example.com',
      QBO_ALERT_FROM: 'QBO <alerts@example.com>',
    });
    expect(c.enabled).toBe(true);
    expect(c.resendApiKey).toBe('re_123');
    expect(c.recipients).toEqual(['ops@example.com']);
    expect(c.from).toBe('QBO <alerts@example.com>');
    expect(c.missing).toEqual([]);
    expect(c.problems).toEqual([]);
  });

  it('reports a partial configuration instead of silently staying off', () => {
    const c = parseAlertsConfig({ RESEND_API_KEY: 're_123', QBO_ALERT_EMAIL: 'ops@example.com' });
    expect(c.enabled).toBe(false);
    expect(c.missing).toEqual(['QBO_ALERT_FROM']);
  });

  it('accepts several recipients, with display names', () => {
    const c = parseAlertsConfig({
      RESEND_API_KEY: 'k',
      QBO_ALERT_EMAIL: 'David <david@example.com>, ops@example.com;  jane@example.com ',
      QBO_ALERT_FROM: 'alerts@example.com',
    });
    expect(c.enabled).toBe(true);
    expect(c.recipients).toEqual(['David <david@example.com>', 'ops@example.com', 'jane@example.com']);
  });

  it('flags malformed addresses as problems', () => {
    const c = parseAlertsConfig({ RESEND_API_KEY: 'k', QBO_ALERT_EMAIL: 'not-an-address', QBO_ALERT_FROM: 'alerts@' });
    expect(c.enabled).toBe(false);
    expect(c.missing).toEqual([]);
    expect(c.problems).toHaveLength(2);
    expect(c.problems[0]).toMatch(/QBO_ALERT_EMAIL/);
    expect(c.problems[1]).toMatch(/QBO_ALERT_FROM/);
  });
});

describe('address helpers', () => {
  it('bareAddress strips a display name and rejects junk', () => {
    expect(bareAddress('QBO Alerts <alerts@example.com>')).toBe('alerts@example.com');
    expect(bareAddress('  alerts@example.com ')).toBe('alerts@example.com');
    expect(bareAddress('alerts@example')).toBeNull();
    expect(bareAddress('<>')).toBeNull();
  });

  it('parseRecipients splits on commas and semicolons only', () => {
    expect(parseRecipients(undefined)).toEqual([]);
    expect(parseRecipients('a@x.com,b@x.com; C D <c@x.com>')).toEqual(['a@x.com', 'b@x.com', 'C D <c@x.com>']);
  });
});
