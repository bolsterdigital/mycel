// The rendered newsletter of one item and locale, for the frame on its e-mail preview page
// (lib/server/mail/email-preview.ts), or with `edition` a sent edition as it went out: only for
// an operator of this site who may read content, never cached, with a policy of its own.
import { isUuid } from '@mycel/core';
import { adminMediaPrincipal } from '#lib/server/admin/admin.js';
import { loaded } from '#lib/server/admin/admin-actions.js';
import { PREVIEW_HEADERS } from '#lib/server/content/preview.js';
import { EMAIL_FRAME_POLICY, framed, renderItemEmail } from '#lib/server/mail/email-preview.js';
import { runtime } from '#lib/server/runtime.js';
import type { RequestHandler } from './$types';

const refused = (status: number) => new Response(null, { status, headers: PREVIEW_HEADERS });

export const GET: RequestHandler = async ({ params, locals, url }) => {
  const principal = await adminMediaPrincipal(locals, params.tenant);
  const tenant = principal && (await runtime().tenants.findBySlug(params.tenant));
  if (!principal || !tenant) return refused(403);
  const locale = url.searchParams.get('locale') ?? tenant.defaultLocale;
  const edition = url.searchParams.get('edition');
  if (!isUuid(params.itemId) || !tenant.locales.includes(locale)) return refused(404);
  if (edition !== null && !isUuid(edition)) return refused(404);
  const { html } = await loaded(renderItemEmail(principal, tenant, params.itemId, locale, edition));
  return new Response(framed(html), {
    headers: {
      ...PREVIEW_HEADERS,
      'content-type': 'text/html; charset=utf-8',
      'content-security-policy': EMAIL_FRAME_POLICY,
    },
  });
};
