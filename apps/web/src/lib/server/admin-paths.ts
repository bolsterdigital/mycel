// Pure helpers for the admin's URLs, kept free of the runtime so they are unit-testable.
//
// The admin lives on the platform origin only (ADR 014 rule 4): operator cookies never travel to
// a tenant site. Until TODO #14 splits a separate platform hostname off, that origin is the one
// in PUBLIC_BASE_URL.

import type { IdentityStore } from '@mycel/core';

/** True when `url` is served on the platform origin. */
export function onPlatformOrigin(url: URL, publicBaseUrl: string): boolean {
  return url.origin === new URL(publicBaseUrl).origin;
}

/**
 * Where to go after login: a same-origin path under /admin, or /admin itself. Everything else
 * (other origins, protocol-relative `//host`, backslashes, paths outside the admin) falls back,
 * so the login flow can never be turned into an open redirect.
 */
export function safeReturn(raw: string | null | undefined): string {
  const fallback = '/admin';
  if (!raw || !raw.startsWith('/') || raw.startsWith('//') || raw.includes('\\')) return fallback;
  let parsed: URL;
  try {
    parsed = new URL(raw, 'http://platform.invalid');
  } catch {
    return fallback;
  }
  if (parsed.origin !== 'http://platform.invalid') return fallback;
  if (parsed.pathname !== '/admin' && !parsed.pathname.startsWith('/admin/')) return fallback;
  // Back into the login flow would loop.
  if (/^\/admin\/(login|callback)(\/|$)/.test(parsed.pathname)) return fallback;
  return parsed.pathname + parsed.search;
}

/** Login starts and callbacks per client address, together: 20 per 10 minutes. */
export const LOGIN_LIMIT = { max: 20, windowSeconds: 10 * 60 } as const;

/**
 * The login rate limit over the identity port, so every web process counts into one window
 * (`login_attempts`, 0018, TODO #20b). `key` is the keyed hash of the client address. Rejected:
 * the in-process window this replaced, which two processes behind Caddy doubled.
 */
export function loginLimiter(
  identity: Pick<IdentityStore, 'loginAttempt'>
): (key: string) => Promise<boolean> {
  return (key) => identity.loginAttempt(key, LOGIN_LIMIT);
}
