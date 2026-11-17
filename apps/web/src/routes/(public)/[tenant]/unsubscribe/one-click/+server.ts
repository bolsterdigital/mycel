// The `List-Unsubscribe` address of a bulk message (RFC 8058, ADR 010 rule 8). A mail provider
// that shows its own unsubscribe button POSTs `List-Unsubscribe=One-Click` here, from its own
// servers: no page, no Origin of this site, no cookie. That POST unsubscribes, with the token in
// the query as the only authority, so this route alone is exempt from the CSRF origin check
// (lib/server/http/csrf.ts): forging the request needs the token, and the token can only remove
// the permission of the person it was sent to.
//
// A GET is a person whose mail client opened the header's address in a browser: it leads to the
// page with one button (`../`), so a scanner that fetches this address changes nothing either.
// A POST without the RFC 8058 body is refused, so nothing but a one-click request writes here.
// Rejected: the provider's POST on the page route, which would exempt the person's own form too.

import { redirect } from '@sveltejs/kit';
import { ONE_CLICK_VALUE, anonymousPrincipal, useCases, type OptOutResult } from '@mycel/core';
import { refusalOf, refuse } from '#lib/server/http/refuse.js';
import { NO_STORE } from '#lib/server/http/http-cache.js';
import { runtime } from '#lib/server/runtime.js';
import { requireSite, sitePath, siteTenant } from '#lib/server/site.js';
import type { RequestHandler } from './$types';

const HEADERS = { 'cache-control': NO_STORE, 'referrer-policy': 'strict-origin' };

export const GET: RequestHandler = ({ url, locals, setHeaders }) => {
  setHeaders(HEADERS);
  const site = requireSite(locals);
  const token = url.searchParams.get('token');
  const query = token ? `?token=${encodeURIComponent(token)}` : '';
  redirect(303, `${sitePath(site, '/unsubscribe')}${query}`);
};

export const POST: RequestHandler = async ({ url, request, locals }) => {
  const site = requireSite(locals);
  const token = url.searchParams.get('token');
  let body: FormData | null = null;
  try {
    body = await request.formData();
  } catch {
    // Not a form body at all: refused below like a form without the field.
  }
  const [key, value] = ONE_CLICK_VALUE.split('=');
  if (!token || body?.get(key!) !== value) refuse(400);
  let status: OptOutResult['status'];
  try {
    ({ status } = await runtime().invoker.run(
      useCases.confirmOptOut,
      anonymousPrincipal(siteTenant(site), ['supporters:write']),
      { token, via: 'one_click' }
    ));
  } catch (e) {
    if (refusalOf(e).code !== 'suspended') throw e;
    refuse(403);
  }
  // The provider only needs to know whether it worked; why a token is worth nothing stays as
  // neutral as on the page. A second click is a success: the person is unsubscribed.
  if (status === 'invalid') refuse(400);
  return new Response(null, { status: 204, headers: HEADERS });
};
