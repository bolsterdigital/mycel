// The operator's own preferences (#88): language of the admin, time zone and date display.
// Outside any site, because they are the person's and hold on every site they work on. The
// operator is the session's (`updateOperatorPreferences`), so the form names no one. A save
// redirects, so the next response already speaks the chosen language (the hook reads it).
// Rejected: the preferences on the site picker, which a member of one site never sees again.
// #101 makes this "Profile and preferences": first the account as the IdP gave it (read only),
// then the operator's role on each site (from the memberships, named by core's `roleFor`), then
// the preferences. Rejected: the role on Members ("your capabilities on this site"), where it sat
// among other people's rows without saying it was yours.
// Inside a site the same page lives at `/admin/[tenant]/profiel`, in the site's shell; both read
// and save through `lib/server/admin/profile.ts`. This address stays for the site picker and old
// links with `return`.
import { redirect } from '@sveltejs/kit';
import { requireSession } from '#lib/server/admin/admin.js';
import { safeReturn } from '#lib/server/admin/admin-paths.js';
import { profileData, saveProfile } from '#lib/server/admin/profile.js';
import type { Actions, PageServerLoad } from './$types';

/** Where "back" goes: the admin page the operator came from, never another origin. */
const back = (url: URL): string => safeReturn(url.searchParams.get('return'));

export const load: PageServerLoad = async ({ locals, url }) => {
  const session = requireSession(locals, url);
  return {
    ...(await profileData(locals, session)),
    back: back(url),
    saved: url.searchParams.has('saved'),
  };
};

export const actions: Actions = {
  default: async ({ locals, request, url }) => {
    const session = requireSession(locals, url);
    const failed = await saveProfile(session, request);
    if (failed) return failed;
    const next = new URLSearchParams({ saved: '1' });
    if (back(url) !== '/admin') next.set('return', back(url));
    redirect(303, `/admin/voorkeuren?${next}`);
  },
};
