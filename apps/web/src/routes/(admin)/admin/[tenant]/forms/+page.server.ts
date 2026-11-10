// Form inventory calls the shared registry; native creation immediately opens the editor.
import { useCases } from '@mycel/core';
import { redirect } from '@sveltejs/kit';
import { act, loaded, text } from '#lib/server/admin/admin-actions.js';
import { runtime } from '#lib/server/runtime.js';
import type { Actions, PageServerLoad } from './$types';
const copy = { conflict: 'admin.forms.conflict', invalid: 'admin.forms.invalid' } as const;
export const load: PageServerLoad = async ({ parent, locals }) => {
  await parent();
  return loaded(runtime().invoker.run(useCases.listForms, locals.principal!, {}));
};
export const actions: Actions = {
  create: (event) =>
    act(event, 'create', copy, async (principal, data) => {
      const form = await runtime().invoker.run(useCases.createForm, principal, {
        kind: text(data, 'kind') as 'contact',
      });
      redirect(303, `/admin/${event.params.tenant}/forms/${form.id}`);
    }),
};
