// The shell's content locale switch (#66 PR 4): a native form posts the chosen locale here, the
// choice is stored for this site's admin (`content-locale.ts`) and the operator lands back on the
// screen they came from, which then follows it. Any member may choose: it only changes what the
// admin shows. SvelteKit's origin check refuses a cross-site post. Rejected: a GET link per locale
// (a state change behind a link a crawler or prefetch may follow).
import { error, redirect } from '@sveltejs/kit';
import { requireTenantPrincipal } from '#lib/server/admin/admin.js';
import { chooseContentLocale, returnPath } from '#lib/server/content-locale.js';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ locals, url, params, request, cookies }) => {
  const { tenant } = await requireTenantPrincipal(locals, url, params.tenant);
  const data = await request.formData();
  const to = String(data.get('to') ?? '');
  if (!tenant.locales.includes(to)) error(400, 'Unknown locale');
  chooseContentLocale(cookies, tenant.slug, to);
  redirect(
    303,
    returnPath(String(data.get('return') ?? ''), tenant.slug) ?? `/admin/${tenant.slug}`
  );
};
