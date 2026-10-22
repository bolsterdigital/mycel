// The request or job a log line belongs to, without passing it through every call: a front opens
// a context per request (Hono middleware, SvelteKit `handle`), the worker per job and per outbox
// event, and the logger reads it when it writes. AsyncLocalStorage over an explicit parameter,
// because the core's use cases and the db adapters log too and must not learn about requests.

import { AsyncLocalStorage } from 'node:async_hooks';

export interface LogContext {
  requestId?: string;
  tenantId?: string;
  job?: string;
  eventId?: string;
}

const storage = new AsyncLocalStorage<LogContext>();

/** Run `fn` with `context` added to the surrounding one. */
export function runWithContext<T>(context: LogContext, fn: () => T): T {
  return storage.run({ ...storage.getStore(), ...context }, fn);
}

export function currentContext(): LogContext {
  return storage.getStore() ?? {};
}

/** Add to the current context in place: the tenant is known only after authentication. */
export function setContext(fields: LogContext): void {
  const store = storage.getStore();
  if (store) Object.assign(store, fields);
}

/** Caddy may set one; anything else (too long, odd characters) is replaced, never trusted. */
const REQUEST_ID = /^[A-Za-z0-9-]{8,64}$/;

export function requestIdFrom(header: string | null | undefined, fresh: () => string): string {
  return header && REQUEST_ID.test(header) ? header : fresh();
}
