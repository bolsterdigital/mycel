// The operator's profile and preferences inside a site's shell, so the admin navigation stays
// when an operator opens "Profile" from a site (trial 4b-8/9). The same data and save as
// `/admin/voorkeuren` (`lib/server/admin/profile.ts`); "back" is the site's dashboard and a save
// returns here. Rejected: linking from the shell to `/admin/voorkeuren?return=…`, a page without
// the shell, where the operator lost the menu.
import { redirect } from '@sveltejs/kit';
import { requireSession } from '#lib/server/admin/admin.js';
import { profileData, saveProfile } from '#lib/server/admin/profile.js';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, url, params }) => {
  const session = requireSession(locals, url);
  return {
    ...(await profileData(locals, session)),
    back: `/admin/${params.tenant}`,
    saved: url.searchParams.has('saved'),
  };
};

export const actions: Actions = {
  default: async ({ locals, request, url, params }) => {
    const session = requireSession(locals, url);
    const failed = await saveProfile(session, request);
    if (failed) return failed;
    redirect(303, `/admin/${params.tenant}/profiel?saved=1`);
  },
};
