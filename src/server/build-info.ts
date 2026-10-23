import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

function packageVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    for (const rel of ['../../package.json', '../package.json']) {
      try {
        const pkg = JSON.parse(readFileSync(join(here, rel), 'utf8'));
        if (pkg?.name === 'qbo-multi-connect' && typeof pkg.version === 'string') return pkg.version;
      } catch { /* try next */ }
    }
  } catch { /* ignore */ }
  return 'dev';
}

/** Short build commit (Railway injects RAILWAY_GIT_COMMIT_SHA), or null. */
export function buildCommit(env: NodeJS.ProcessEnv = process.env): string | null {
  const sha = (env.RAILWAY_GIT_COMMIT_SHA ?? '').trim();
  return sha ? sha.slice(0, 7) : null;
}

/**
 * MCP server version. Includes the commit so clients that key their tool-list
 * cache on name+version refetch after every deploy.
 */
export function serverVersion(env: NodeJS.ProcessEnv = process.env): string {
  const sha = buildCommit(env);
  return sha ? `1.0.0+${sha}` : packageVersion();
}
