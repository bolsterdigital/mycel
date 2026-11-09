// A membership replacement is one use case, keeping its original timestamp on conflict.
// Rejected: posting each checkbox separately and leaving a half-written group.
import { can, useCases } from '@mycel/core';
import { fail, redirect } from '@sveltejs/kit';
import { loaded, failureOf } from '#lib/server/admin/admin-actions.js';
import { requireTenantPrincipal } from '#lib/server/admin/admin.js';
import { refusalOf, refuse } from '#lib/server/http/refuse.js';
import { runtime } from '#lib/server/runtime.js';
import { contentLocale } from '#lib/server/content/content-locale.js';
import { peopleDirectory } from '#lib/server/people/directory.js';
import { fields, groupFields } from '#lib/server/people/form.js';
import type { Actions, PageServerLoad } from './$types';
export const load: PageServerLoad = async ({ parent, locals, params }) => {
  await parent();
  const principal = locals.principal!;
  if (!can(principal, 'content:write')) refuse(403);
  return {
    group:
      params.id === 'new'
        ? null
        : await loaded(
            runtime().invoker.run(useCases.getPersonGroup, principal, { groupId: params.id })
          ),
    people: await loaded(peopleDirectory(principal)),
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
          : await runtime().invoker.run(useCases.getPersonGroup, principal, { groupId: params.id });
      const input = groupFields(
        data,
        contentLocale(cookies, tenant, String(data.get('contentLocale') ?? '')),
        current
      );
      const saved = current
        ? await runtime().invoker.run(useCases.updatePersonGroup, principal, {
            ...input,
            groupId: current.id,
            baseUpdatedAt: String(data.get('baseUpdatedAt') ?? ''),
          })
        : await runtime().invoker.run(useCases.createPersonGroup, principal, input);
      redirect(303, `/admin/${tenant.slug}/people/groups/${saved.id}?saved=1`);
    } catch (e) {
      const { status, body } = failureOf(refusalOf(e), 'save', {
        conflict: 'admin.people.conflict',
      });
      return fail(status, {
        ...body,
        values: fields(data),
        personIds: data.getAll('personIds').map(String),
      });
    }
  },
};
