import { describe, it, expect } from 'vitest';
import { generateAuthUrl } from '../../src/auth/oauth.js';

describe('OAuth', () => {
  const config = {
    clientId: 'test_client_id',
    clientSecret: 'test_client_secret',
    redirectUri: 'http://localhost:3456/callback',
  };

  it('should generate valid auth URL', () => {
    const url = generateAuthUrl(config);
    
    expect(url).toContain('appcenter.intuit.com/connect/oauth2');
    expect(url).toContain('client_id=test_client_id');
    expect(url).toContain('redirect_uri=http%3A%2F%2Flocalhost%3A3456%2Fcallback');
    expect(url).toContain('response_type=code');
    expect(url).toContain('scope=com.intuit.quickbooks.accounting');
  });

  it('should include state parameter when provided', () => {
    const url = generateAuthUrl(config, 'test_state');
    expect(url).toContain('state=test_state');
  });
});
