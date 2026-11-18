// Form inventory calls the shared registry; native creation immediately opens the editor.
import { can, pickAny, useCases } from '@mycel/core';
import { tierDirectory } from '#lib/server/access/tiers.js';
import { redirect } from '@sveltejs/kit';
import { act, loaded, text } from '#lib/server/admin/admin-actions.js';
import { runtime } from '#lib/server/runtime.js';
import type { Actions, PageServerLoad } from './$types';
const copy = { conflict: 'admin.forms.conflict', invalid: 'admin.forms.invalid' } as const;
export const load: PageServerLoad = async ({ parent, locals }) => {
  const { locale } = await parent();
  const principal = locals.principal!;
  return {
    ...(await loaded(runtime().invoker.run(useCases.listForms, principal, {}))),
    // A membership form sells one paid tier (MY-254 PR 4): one choice per paid tier.
    paidTiers: can(principal, 'content:read')
      ? (await tierDirectory(principal))
          .filter((tier) => tier.kind === 'paid')
          .map((tier) => ({ id: tier.id, name: pickAny(tier.name, locale) ?? tier.slug }))
      : [],
  };
};
export const actions: Actions = {
  create: (event) =>
    act(event, 'create', copy, async (principal, data) => {
      const [kind, tierId] = text(data, 'kind').split(':');
      const form = await runtime().invoker.run(useCases.createForm, principal, {
        kind: kind as 'contact',
        ...(tierId ? { tierId } : {}),
      });
      redirect(303, `/admin/${event.params.tenant}/forms/${form.id}`);
    }),
};
