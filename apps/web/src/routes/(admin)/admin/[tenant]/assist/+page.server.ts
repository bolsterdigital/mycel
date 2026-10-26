// Consent is set through the tenant use case on every POST. Rejected: trusting a hidden provider
// field or client state, which could silently consent to a changed processor.
import { can, useCases, UseCaseError } from '@mycel/core';
import { error, fail, redirect } from '@sveltejs/kit';
import { requireTenantPrincipal } from '#lib/server/admin.js';
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
    const current = await runtime().invoker.run(useCases.getAssistSettings, principal, {});
    const enabled = data.get('enabled') === 'on';
    const allowRestricted = data.get('allowRestricted') === 'on';
    if (enabled && (!principal.entitlements['ai.assist'] || !current.provider))
      return fail(403, { problem: 'unavailable', enabled, allowRestricted });
    if (enabled && data.get('consent') !== 'on')
      return fail(400, { problem: 'consent', enabled, allowRestricted });
    try {
      await runtime().invoker.run(useCases.updateAssistSettings, principal, {
        enabled,
        allowRestricted: enabled && allowRestricted,
        consentedProvider: enabled ? current.provider : null,
      });
    } catch (e) {
      if (!(e instanceof UseCaseError)) throw e;
      return fail(e.code === 'forbidden' ? 403 : 400, {
        problem: 'invalid',
        enabled,
        allowRestricted,
      });
    }
    redirect(303, `/admin/${tenant.slug}/assist?saved=1`);
  },
};
