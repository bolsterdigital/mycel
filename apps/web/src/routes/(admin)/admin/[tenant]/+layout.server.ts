// /admin/[tenant]/*: no session redirects to login, no membership is a 403, otherwise
// `locals.principal` is the operator's principal for this tenant (one membership query). The
// admin's time zone and the operator's date display reach every page from here (#88), and so
// does the content locale every list and edit screen follows (#66 PR 4).
// What asks for attention is read here once per page load, through `attention.list`:
// the bell's count, the dot on Manage, the notifications page and the dashboard card all come
// from that one read, so they cannot disagree. A member without `content:read` has no list (the
// use case would refuse) and sees no count. A failing read leaves the admin usable: the bell
// shows no count, the notifications page says the list could not be read, and the error is
// captured as any other.
// Rejected: `attention.summary.get` here plus `attention.list` on the two pages that list (two
// reads of the same sources on those pages, for a list of at most a few hundred short rows).
import { DEFAULT_OPERATOR_PREFERENCES, can, useCases } from '@mycel/core';
import { adminTimeZone, requireTenantPrincipal } from '#lib/server/admin/admin.js';
import { contentLocale } from '#lib/server/content/content-locale.js';
import { runtime } from '#lib/server/runtime.js';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = async ({ locals, url, params, cookies }) => {
  const { tenant, principal, session } = await requireTenantPrincipal(locals, url, params.tenant);
  const attention = can(principal, 'content:read')
    ? await runtime()
        .invoker.run(useCases.listAttention, principal, {})
        .catch((e: unknown) => {
          runtime().errors.capture(e);
          return 'unknown' as const;
        })
    : null;
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
    attention,
  };
};
