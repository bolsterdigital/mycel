// One form creates or changes an access tier through `content.access_tier.create|update`; the
// use cases hold the authorization (`content:publish`) and the tenant boundary, this route only
// refuses the form early so a member without the capability does not fill it in for nothing.
// Rejected: a separate create route (the two forms differ by two fields, slug and kind, which
// core fixes at create).
import { can, useCases } from '@mycel/core';
import { fail, redirect } from '@sveltejs/kit';
import { loaded, failureOf } from '#lib/server/admin/admin-actions.js';
import { requireTenantPrincipal } from '#lib/server/admin/admin.js';
import { refusalOf, refuse } from '#lib/server/http/refuse.js';
import { runtime } from '#lib/server/runtime.js';
import { contentLocale } from '#lib/server/content/content-locale.js';
import { newTierFields, tierFields } from '#lib/server/access/tiers.js';
import { fields } from '#lib/server/people/form.js';
import type { Actions, PageServerLoad } from './$types';
export const load: PageServerLoad = async ({ parent, locals, params }) => {
  await parent();
  const principal = locals.principal!;
  if (!can(principal, 'content:publish')) refuse(403);
  return {
    tier:
      params.id === 'new'
        ? null
        : await loaded(
            runtime().invoker.run(useCases.getAccessTier, principal, { tierId: params.id })
          ),
  };
};
export const actions: Actions = {
  default: async ({ request, locals, url, params, cookies }) => {
    const { principal, tenant } = await requireTenantPrincipal(locals, url, params.tenant);
    const data = await request.formData();
    try {
      const current =
        params.id === 'new'
          ? undefined
          : await runtime().invoker.run(useCases.getAccessTier, principal, { tierId: params.id });
      const input = tierFields(
        data,
        contentLocale(cookies, tenant, String(data.get('contentLocale') ?? '')),
        current
      );
      const saved = current
        ? await runtime().invoker.run(useCases.updateAccessTier, principal, {
            ...input,
            tierId: current.id,
            baseUpdatedAt: String(data.get('baseUpdatedAt') ?? ''),
          })
        : await runtime().invoker.run(useCases.createAccessTier, principal, {
            ...input,
            ...newTierFields(data),
          });
      redirect(303, `/admin/${tenant.slug}/access/${saved.id}?saved=1`);
    } catch (e) {
      const { status, body } = failureOf(refusalOf(e), 'save', {
        conflict: 'admin.tiers.conflict',
      });
      return fail(status, { ...body, values: fields(data) });
    }
  },
};
