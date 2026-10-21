// Pure helpers for the admin's URLs, kept free of the runtime so they are unit-testable.
//
// The admin lives on the platform origin only (ADR 014 rule 4): operator cookies never travel to
// a tenant site. Until TODO #14 splits a separate platform hostname off, that origin is the one
// in PUBLIC_BASE_URL.

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

/**
 * A small fixed-window limiter per key, in this process. Enough to keep the login endpoints from
 * being hammered by one address; shared counters across processes are hardening for TODO #20.
 */
export function windowLimiter(max: number, windowMs: number, now: () => number = Date.now) {
  const hits = new Map<string, { start: number; n: number }>();
  return (key: string): boolean => {
    const t = now();
    const entry = hits.get(key);
    if (!entry || t - entry.start >= windowMs) {
      if (hits.size > 10_000) hits.clear();
      hits.set(key, { start: t, n: 1 });
      return true;
    }
    entry.n += 1;
    return entry.n <= max;
  };
}
