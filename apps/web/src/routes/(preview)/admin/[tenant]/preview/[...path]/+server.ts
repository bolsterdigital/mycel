// A link inside the admin preview (lib/server/preview.ts): the render model prefixes every
// site-relative link with the preview's base, and this sends the operator on to the public URL
// of that path on the site. Only for an operator of this site, so the route says nothing about
// which sites exist.
import { error, redirect } from '@sveltejs/kit';
import { adminMediaPrincipal } from '#lib/server/admin/admin.js';
import { previewSite } from '#lib/server/preview.js';
import { runtime } from '#lib/server/runtime.js';
import { absoluteSiteUrl } from '#lib/server/site.js';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ params, locals, url }) => {
  if (!(await adminMediaPrincipal(locals, params.tenant))) error(403, 'Forbidden');
  const tenant = await runtime().tenants.findBySlug(params.tenant);
  if (!tenant) error(404, 'Not found');
  const site = await previewSite(tenant);
  redirect(303, await absoluteSiteUrl(site, `/${params.path}${url.search}`));
};
