// Manage's own page (#114): only for a member who may open one of its screens, like the entry
// in the menu. Rejected: an empty overview for everyone else (a page that says nothing is there
// reads as broken).
import { error } from '@sveltejs/kit';
import { MANAGE, opens } from '#lib/admin/nav.js';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ parent }) => {
  const { capabilities } = await parent();
  if (!MANAGE.screens.some((s) => opens(capabilities, s.needs))) error(403, 'tenant:admin');
  return {};
};
