// "Profile and preferences" on two addresses: `/admin/voorkeuren` outside any site (from the site
// picker) and `/admin/[tenant]/profiel` inside a site's shell, so the admin navigation stays when
// an operator opens their profile from a site. Both read and save through these two functions;
// the routes only say where "back" and the redirect after a save go.
// Rejected: one address with a `return` parameter that renders the shell of the site it names
// (the shell's layout load checks membership per tenant route; a page outside `[tenant]` would
// have to repeat that check and the navigation data by hand).
import {
  DEFAULT_OPERATOR_PREFERENCES,
  OperatorPreferences,
  roleFor,
  updateOperatorPreferences,
  type OperatorSession,
} from '@mycel/core';
import { fail } from '@sveltejs/kit';
import { runtime } from '../runtime.js';
import { timeZoneOptions } from './time-zones.js';

/** The account, the operator's role on each site, and the preferences form's values. */
export async function profileData(locals: App.Locals, session: OperatorSession) {
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
  };
}

/** Save the posted preferences; a `fail` with the values when they do not parse, else null. */
export async function saveProfile(session: OperatorSession, request: Request) {
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
  return null;
}
