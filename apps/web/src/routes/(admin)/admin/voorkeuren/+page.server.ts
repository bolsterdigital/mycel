// The operator's own preferences (#88): language of the admin, time zone and date display.
// Outside any site, because they are the person's and hold on every site they work on. The
// operator is the session's (`updateOperatorPreferences`), so the form names no one. A save
// redirects, so the next response already speaks the chosen language (the hook reads it).
// Rejected: the preferences on the site picker, which a member of one site never sees again.
// #101 makes this "Profile and preferences": first the account as the IdP gave it (read only),
// then the operator's role on each site (from the memberships, named by core's `roleFor`), then
// the preferences. Rejected: the role on Members ("your capabilities on this site"), where it sat
// among other people's rows without saying it was yours.
import {
  DEFAULT_OPERATOR_PREFERENCES,
  roleFor,
  OperatorPreferences,
  updateOperatorPreferences,
} from '@mycel/core';
import { fail, redirect } from '@sveltejs/kit';
import { requireSession } from '#lib/server/admin/admin.js';
import { safeReturn } from '#lib/server/admin/admin-paths.js';
import { runtime } from '#lib/server/runtime.js';
import { timeZoneOptions } from '#lib/server/admin/time-zones.js';
import type { Actions, PageServerLoad } from './$types';

/** Where "back" goes: the admin page the operator came from, never another origin. */
const back = (url: URL): string => safeReturn(url.searchParams.get('return'));

export const load: PageServerLoad = async ({ locals, url }) => {
  const session = requireSession(locals, url);
  const memberships = await runtime().identity.membershipsOf(session.operatorId);
  return {
    email: session.email,
    name: session.name,
    sites: memberships.map((m) => ({
      slug: m.slug,
      name: m.name,
      role: roleFor(m.capabilities),
    })),
    preferences: locals.preferences ?? DEFAULT_OPERATOR_PREFERENCES,
    zones: timeZoneOptions(locals.lang ?? 'en'),
    back: back(url),
    saved: url.searchParams.has('saved'),
  };
};

export const actions: Actions = {
  default: async ({ locals, request, url }) => {
    const session = requireSession(locals, url);
    const data = await request.formData();
    const text = (key: string) => String(data.get(key) ?? '');
    const values = {
      uiLocale: text('uiLocale') || null,
      timeZone: text('timeZone') || null,
      dateFormat: text('dateFormat'),
    };
    const parsed = OperatorPreferences.safeParse(values);
    if (!parsed.success)
      return fail(400, {
        values,
        invalid: [...new Set(parsed.error.issues.map((i) => String(i.path[0])))],
      });
    await updateOperatorPreferences(runtime().identity, session.operatorId, parsed.data);
    const next = new URLSearchParams({ saved: '1' });
    if (back(url) !== '/admin') next.set('return', back(url));
    redirect(303, `/admin/voorkeuren?${next}`);
  },
};
