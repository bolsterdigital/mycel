// /admin/[tenant]/*: no session redirects to login, no membership is a 403, otherwise
// `locals.principal` is the operator's principal for this tenant (one membership query). The
// admin's time zone and the operator's date display reach every page from here (#88), and so
// does the content locale every list and edit screen follows (#66 PR 4).
import { DEFAULT_OPERATOR_PREFERENCES } from '@mycel/core';
import { adminTimeZone, requireTenantPrincipal } from '#lib/server/admin/admin.js';
import { contentLocale } from '#lib/server/content-locale.js';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = async ({ locals, url, params, cookies }) => {
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
    contentLocale: contentLocale(cookies, tenant),
  };
};
