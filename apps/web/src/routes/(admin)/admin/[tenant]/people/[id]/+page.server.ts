// New and existing profiles share a native form. The original timestamp survives a failed save;
// rejected: refreshing it after a conflict, which would silently authorize an overwrite.
import { can, useCases } from '@mycel/core';
import { fail, redirect } from '@sveltejs/kit';
import { loaded, failureOf } from '#lib/server/admin/admin-actions.js';
import { requireTenantPrincipal } from '#lib/server/admin/admin.js';
import { refusalOf, refuse } from '#lib/server/http/refuse.js';
import { runtime } from '#lib/server/runtime.js';
import { contentLocale } from '#lib/server/content/content-locale.js';
import { mediaChoices } from '#lib/server/content/content-blocks.js';
import { fields, personFields, personSlug } from '#lib/server/people/form.js';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ parent, locals, params }) => {
  await parent();
  const principal = locals.principal!;
  if (!can(principal, 'content:write')) refuse(403);
  const person =
    params.id === 'new'
      ? null
      : await loaded(runtime().invoker.run(useCases.getPerson, principal, { personId: params.id }));
  return {
    person,
    media: can(principal, 'media:read')
      ? await mediaChoices(principal, person?.imageId ? [person.imageId] : [])
      : null,
    upload: can(principal, 'media:write'),
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
          : await runtime().invoker.run(useCases.getPerson, principal, { personId: params.id });
      const input = personFields(
        data,
        contentLocale(cookies, tenant, String(data.get('contentLocale') ?? '')),
        current
      );
      const saved = current
        ? await runtime().invoker.run(useCases.updatePerson, principal, {
            ...input,
            personId: current.id,
            baseUpdatedAt: String(data.get('baseUpdatedAt') ?? ''),
          })
        : await runtime().invoker.run(useCases.createPerson, principal, {
            ...input,
            slug: personSlug(data),
          });
      redirect(303, `/admin/${tenant.slug}/people/${saved.id}?saved=1`);
    } catch (e) {
      const { status, body } = failureOf(refusalOf(e), 'save', {
        conflict: 'admin.people.conflict',
      });
      return fail(status, { ...body, values: fields(data) });
    }
  },
};
