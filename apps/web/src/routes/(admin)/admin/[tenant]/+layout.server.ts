// /admin/[tenant]/*: no session redirects to login, no membership is a 403, otherwise
// `locals.principal` is the operator's principal for this tenant (one membership query).
import { requireTenantPrincipal } from '#lib/server/admin.js';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = async ({ locals, url, params }) => {
  const { tenant, principal, session } = await requireTenantPrincipal(locals, url, params.tenant);
  return {
    tenant: { slug: tenant.slug, name: tenant.name },
    capabilities: principal.capabilities,
    email: session.email,
  };
};
