// Consent binds the displayed provider to the current configuration and is checked again in core.
// Rejected: substituting the current provider, which consents to a processor never shown.
import { can, useCases } from '@mycel/core';
import { error, fail, redirect } from '@sveltejs/kit';
import { requireTenantPrincipal } from '#lib/server/admin.js';
import { saveAssistSettings } from '#lib/server/assist-settings.js';
import { runtime } from '#lib/server/runtime.js';
import type { Actions, PageServerLoad } from './$types';
import { ui } from '../../../../../i18n/index.js';

export const load: PageServerLoad = async ({ parent, locals, url }) => {
  await parent();
  const principal = locals.principal!;
  if (!can(principal, 'tenant:admin'))
    error(403, ui(locals.lang ?? 'en')('admin.assist.error.forbidden'));
  const settings = await runtime().invoker.run(useCases.getAssistSettings, principal, {});
  return {
    settings,
    allowed: principal.entitlements['ai.assist'] && !!settings.provider,
    saved: url.searchParams.has('saved'),
  };
};

export const actions: Actions = {
  save: async ({ request, locals, url, params }) => {
    const { principal, tenant } = await requireTenantPrincipal(locals, url, params.tenant);
    if (!can(principal, 'tenant:admin'))
      error(403, ui(locals.lang ?? 'en')('admin.assist.error.forbidden'));
    const data = await request.formData();
    const failure = await saveAssistSettings(runtime().invoker, principal, data);
    if (failure) {
      const { status, ...values } = failure;
      return fail(status, values);
    }
    redirect(303, `/admin/${tenant.slug}/assist?saved=1`);
  },
};
