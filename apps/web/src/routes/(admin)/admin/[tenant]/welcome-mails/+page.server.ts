// The welcome series of a site, one row per list (MY-258 PR 2), for whoever may read supporters:
// `mailing.automation.list` asks `supporters:read` and a refusal becomes the no-access page.
import { can } from '@mycel/core';
import { loaded } from '#lib/server/admin/admin-actions.js';
import { welcomeOverview } from '#lib/server/mail/welcome.js';
import type { PageServerLoad } from './$types';
export const load: PageServerLoad = async ({ parent, locals }) => {
  const { locale } = await parent();
  return {
    rows: await loaded(welcomeOverview(locals.principal!, locale)),
    canSend: can(locals.principal!, 'mailing:send'),
  };
};
