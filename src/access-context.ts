import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Who a QuickBooks request is being made for. Set by the scoped manager (and
 * the REST write routes) around every call made on behalf of an API key, so
 * the lowest layer — QBOClient.request — can refuse a write the caller is not
 * entitled to, no matter which tool or route asked for it.
 */
export interface AccessContext {
  /** The company this call was authorized for. */
  realmId: string;
  /** Whether the caller may change data in that company. */
  canWrite: boolean;
  /** Display name of the caller, for the error message. */
  who: string;
}

const storage = new AsyncLocalStorage<AccessContext>();

/** Thrown when a read-only caller reaches a request that would change QuickBooks. */
export class ReadOnlyAccessError extends Error {
  readonly statusCode = 403;

  constructor(message = 'Read-only access: your login can view this company but not change it. Ask an administrator for read & write access.') {
    super(message);
    this.name = 'ReadOnlyAccessError';
  }
}

/** Run `fn` with `context` attached to every QuickBooks request it makes. */
export function runWithAccess<T>(context: AccessContext, fn: () => T): T {
  return storage.run(context, fn);
}

/** The access context of the call in progress, if any. */
export function currentAccess(): AccessContext | undefined {
  return storage.getStore();
}

/**
 * Backstop for read-only access. Every QuickBooks read is a GET; everything
 * else (create, update, delete, void, batch, upload, send) changes data or
 * acts on the company's behalf. So a caller who is read-only for the company
 * is refused any non-GET request here — which holds even if a tool was
 * mislabelled as read-only or a route forgot its own check.
 *
 * Calls made outside any access context (token refresh, the CLI, startup
 * jobs) are the server acting for itself and are not restricted.
 */
export function assertRequestAllowed(method: string, realmId: string): void {
  const context = storage.getStore();
  if (!context) return;
  if (method.toUpperCase() === 'GET') return;
  if (context.canWrite && context.realmId === realmId) return;
  throw new ReadOnlyAccessError();
}
