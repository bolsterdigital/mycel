// Universal hooks. `reroute` lets the `(public)/[tenant]/...` route files serve both address
// forms of ADR 014: on a tenant hostname the slug is put in front of the path internally
// (`probe.localhost/signup` runs the `[tenant]=probe, [slug]=signup` handlers), on a development
// host the path already carries it. One set of handlers, two forms; the visible URL never changes.
//
// This hook is universal (it would run in the browser on client-side navigation, which no page
// here does), so it may not import the server runtime: it reads the composition root the server
// put on globalThis (lib/runtime-key.ts) and asks its cached site directory, the same one
// hooks.server.ts asks, so the two lookups per request cost one query per cache window.
// Rejected: an internal endpoint fetched from here (a sub-request per page view), and an
// optional `[[tenant]]` segment (ambiguous: `/x/signup` on a hostname would read `x` as a tenant).

import type { Reroute } from '@sveltejs/kit/hooks';
import type { Runtime } from '@mycel/api/compose';
import { RUNTIME_KEY } from '#lib/runtime-key.js';

const hostAgnostic = (path: string) =>
  path === '/healthz' ||
  path.startsWith('/internal/') ||
  path === '/admin' ||
  path.startsWith('/admin/');

export const reroute: Reroute = async ({ url }) => {
  if (!import.meta.env.SSR || hostAgnostic(url.pathname)) return;
  const rt = (globalThis as typeof globalThis & { [RUNTIME_KEY]?: Runtime })[RUNTIME_KEY];
  if (!rt) return;
  const found = await rt.sites.resolve(url.hostname);
  if (!found) return;
  return `/${found.tenant.slug}${url.pathname === '/' ? '' : url.pathname}`;
};
