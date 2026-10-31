// GET /admin: the sites the operator is a member of, straight from the memberships, each with
// the role its capabilities amount to (brief admin-entry § 4). With exactly one site the picker
// steps aside and opens it; `?all` keeps the picker, which is where the admin's "Back to your
// sites" leads, so the way back always exists. `q` filters by name or slug, offered from nine
// sites on. Rejected: the site's domain on each card (the memberships come from the auth role,
// which reads no tenant's hostnames; reading them would enter every tenant for one page) and a
// remembered "last site" (a cookie that decides where you land is a second, hidden setting).
import { roleFor } from '@mycel/core';
import { redirect } from '@sveltejs/kit';
import { requireSession } from '#lib/server/admin/admin.js';
import { runtime } from '#lib/server/runtime.js';
import type { PageServerLoad } from './$types';

/** From this many sites on the picker offers a search field. */
const SEARCH_FROM = 9;

export const load: PageServerLoad = async ({ locals, url }) => {
  const session = requireSession(locals, url);
  const memberships = await runtime().identity.membershipsOf(session.operatorId);
  if (memberships.length === 1 && !url.searchParams.has('all'))
    redirect(303, `/admin/${memberships[0]!.slug}`);
  const q = (url.searchParams.get('q') ?? '').trim().slice(0, 100);
  const match = (s: { slug: string; name: string }) =>
    !q || `${s.name} ${s.slug}`.toLocaleLowerCase().includes(q.toLocaleLowerCase());
  return {
    sites: memberships
      .filter(match)
      .map((s) => ({ slug: s.slug, name: s.name, role: roleFor(s.capabilities) })),
    total: memberships.length,
    searchable: memberships.length >= SEARCH_FROM,
    q,
    email: session.email,
  };
};
