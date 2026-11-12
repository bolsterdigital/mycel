// A new petition or signup: kind, a title per locale, the locales, an optional slug and
// goal. One `campaign.landing.create` makes the form, the draft landing page with that form on it
// and the campaign, in one transaction; the answer is a 303 to the page's editor, where the
// campaign panel opens participation once the page is written and published. A refusal re-renders
// the form with what was typed.
import { fail, redirect } from '@sveltejs/kit';
import { ComposableKind, useCases } from '@mycel/core';
import { failureOf } from '#lib/server/admin/admin-actions.js';
import { requireTenantPrincipal } from '#lib/server/admin/admin.js';
import { refusalOf } from '#lib/server/http/refuse.js';
import { valuesFromForm } from '#lib/server/content/content-admin.js';
import { runtime } from '#lib/server/runtime.js';
import type { UiKey } from '../../../../../../i18n/index.js';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ parent, url }) => {
  await parent();
  return { kind: ComposableKind.safeParse(url.searchParams.get('kind')).data ?? 'petition' };
};

/** Core's issue keys on a create, as admin copy. */
const ISSUES: Record<string, UiKey> = {
  'content.slug.invalid': 'admin.content.error.slugInvalid',
  'content.slug.reserved': 'admin.content.error.slugReserved',
  'i18n.default-not-in-locales': 'admin.content.error.defaultLocale',
  'content.title.required': 'admin.campaign.error.title',
};

export const actions: Actions = {
  default: async ({ locals, url, params, request }) => {
    const { tenant, principal } = await requireTenantPrincipal(locals, url, params.tenant);
    const values = valuesFromForm(await request.formData());
    const one = (k: string) => (typeof values[k] === 'string' ? (values[k] as string).trim() : '');
    const chosen = Array.isArray(values.locales) ? (values.locales as string[]) : [];
    const locales = tenant.locales.filter((l) => chosen.includes(l));
    const title = Object.fromEntries(
      locales.flatMap((l) => (one(`title.${l}`) ? [[l, one(`title.${l}`)]] : []))
    );
    const target = one('target') ? Number(one('target')) : null;
    let landing: string;
    try {
      const campaign = await runtime().invoker.run(useCases.composeCampaign, principal, {
        kind: ComposableKind.safeParse(one('kind')).data ?? 'petition',
        title,
        defaultLocale: tenant.defaultLocale,
        locales,
        ...(one('slug') ? { slug: one('slug') } : {}),
        goal: target === null ? null : { target, milestones: [] },
      });
      landing = campaign.landingItemId;
    } catch (e) {
      const { status, body } = failureOf(refusalOf(e), 'create', {
        conflict: 'admin.content.error.slugTaken',
        invalid: 'admin.campaign.error.create',
        issues: ISSUES,
      });
      return fail(status, { ...body, values });
    }
    redirect(303, `/admin/${tenant.slug}/content/${landing}?campaign=created#campaign`);
  },
};
