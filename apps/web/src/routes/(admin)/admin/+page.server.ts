// GET /admin: the sites the operator is a member of, straight from the memberships.
import { requireSession } from '#lib/server/admin/admin.js';
import { runtime } from '#lib/server/runtime.js';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, url }) => {
  const session = requireSession(locals, url);
  const sites = await runtime().identity.membershipsOf(session.operatorId);
  return { sites: sites.map((s) => ({ slug: s.slug, name: s.name })), email: session.email };
};
