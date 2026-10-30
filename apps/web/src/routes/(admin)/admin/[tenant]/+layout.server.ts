// /admin/[tenant]/*: no session redirects to login, no membership is a 403, otherwise
// `locals.principal` is the operator's principal for this tenant (one membership query). The
// admin's time zone and the operator's date display reach every page from here (#88).
import { DEFAULT_OPERATOR_PREFERENCES } from '@mycel/core';
import { adminTimeZone, requireTenantPrincipal } from '#lib/server/admin.js';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = async ({ locals, url, params }) => {
  const { tenant, principal, session } = await requireTenantPrincipal(locals, url, params.tenant);
  return {
    tenant: {
      slug: tenant.slug,
      name: tenant.name,
      locales: tenant.locales,
      defaultLocale: tenant.defaultLocale,
    },
    capabilities: principal.capabilities,
    email: session.email,
    timeZone: (await adminTimeZone(locals)).zone,
    dateFormat: (locals.preferences ?? DEFAULT_OPERATOR_PREFERENCES).dateFormat,
  };
};
