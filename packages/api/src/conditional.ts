// The If-None-Match rule, shared by every front that answers a 304 (TODO #74): the Hono apps
// through `http-shape.ts`, and the public site through `apps/web/src/lib/server/http/http-cache.ts`,
// which imports this file as `@mycel/api/conditional`. Each had its own copy. A file of its own,
// not part of `http-shape.ts`, so the web front reaches this rule and nothing else of the API.
// Rejected: a package for one function, and core, which owns no HTTP.

/** RFC 9110 § 13.1.2: weak comparison for If-None-Match; `*` matches any current representation. */
export function ifNoneMatch(header: string | null | undefined, etag: string): boolean {
  if (!header) return false;
  const opaque = (tag: string) => tag.trim().replace(/^W\//, '');
  return header.split(',').some((tag) => tag.trim() === '*' || opaque(tag) === opaque(etag));
}
