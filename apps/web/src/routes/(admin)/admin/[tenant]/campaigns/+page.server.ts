// The campaigns of a site (ADR 033 rule 1): a presentation over each landing page plus its
// campaign row, under Content. One read of `campaign.list`, which carries the landing page's title,
// slug and published locales, so the list needs no item read per row here.
import { can, useCases } from '@mycel/core';
import { loaded } from '#lib/server/admin/admin-actions.js';
import { runtime } from '#lib/server/runtime.js';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ parent, locals, url }) => {
  await parent();
  const principal = locals.principal!;
  const archived = url.searchParams.get('archived') === '1';
  const { campaigns } = await loaded(
    runtime().invoker.run(useCases.listCampaigns, principal, { archived })
  );
  return {
    archived,
    campaigns,
    // Starting one makes a petition or signup form, which asks publishing permission too.
    canCreate:
      can(principal, 'content:write') &&
      can(principal, 'forms:write') &&
      can(principal, 'content:publish'),
  };
};
