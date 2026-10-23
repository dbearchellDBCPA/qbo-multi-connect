import { describe, it, expect } from 'vitest';
import { buildCommit, serverVersion } from '../../src/server/build-info.js';

describe('build-info', () => {
  it('includes short commit sha in server version', () => {
    const env = { RAILWAY_GIT_COMMIT_SHA: '5b45492abcdef0123' };
    expect(buildCommit(env)).toBe('5b45492');
    expect(serverVersion(env)).toBe('1.0.0+5b45492');
  });
  it('falls back to package version when no sha', () => {
    expect(buildCommit({})).toBeNull();
    expect(serverVersion({})).toMatch(/^(\d+\.\d+\.\d+|dev)$/);
  });
});
