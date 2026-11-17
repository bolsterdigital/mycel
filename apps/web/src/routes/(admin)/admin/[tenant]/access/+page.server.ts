// The access tiers of a site (ADR 016 rule 2), listed for whoever may read content; the link to
// a tier's form shows only to who may change one, which asks for `content:publish` because a
// tier's name is copy a visitor reads on a published item.
import { can } from '@mycel/core';
import { loaded } from '#lib/server/admin/admin-actions.js';
import { tierDirectory } from '#lib/server/access/tiers.js';
import type { PageServerLoad } from './$types';
export const load: PageServerLoad = async ({ parent, locals }) => {
  await parent();
  return {
    tiers: await loaded(tierDirectory(locals.principal!)),
    write: can(locals.principal!, 'content:publish'),
  };
};
