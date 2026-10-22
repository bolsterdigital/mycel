// Caddy's on-demand TLS `ask` endpoint (ADR 014 rule 3, brief #14 decision 7): 200 with an empty
// body when `domain` may get a certificate, 404 otherwise. Allowed: the platform origin itself,
// a platform hostname, a verified custom hostname. Never a list and no authentication: the
// answer is one bit that the certificate itself would reveal. Host-agnostic (hooks.server.ts);
// Caddy reaches it on the internal name, and docker/caddy/Caddyfile does not route `/internal/*`
// from outside.
import { normalizeHostname } from '@mycel/core';
import { runtime } from '#lib/server/runtime.js';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ url }) => {
  const rt = runtime();
  const raw = (url.searchParams.get('domain') ?? '').trim().toLowerCase();
  // The platform origin as configured, before normalisation: in development it is an IP.
  if (raw && raw === new URL(rt.config.PUBLIC_BASE_URL).hostname)
    return new Response(null, { status: 200 });
  let hostname: string;
  try {
    hostname = normalizeHostname(raw);
  } catch {
    return new Response(null, { status: 404 });
  }
  return new Response(null, { status: (await rt.sites.allowed(hostname)) ? 200 : 404 });
};
