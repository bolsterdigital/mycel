// Groups have their own list: changing a profile must not replace a group's membership.
import { can } from '@mycel/core';
import { loaded } from '#lib/server/admin/admin-actions.js';
import { groupDirectory } from '#lib/server/people/directory.js';
import type { PageServerLoad } from './$types';
export const load: PageServerLoad = async ({ parent, locals }) => {
  await parent();
  return {
    groups: await loaded(groupDirectory(locals.principal!)),
    write: can(locals.principal!, 'content:write'),
  };
};
