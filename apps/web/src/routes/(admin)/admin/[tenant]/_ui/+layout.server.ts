// The catalogue of the admin's components and page patterns (brief #56) exists only outside
// production (a 404 there) and only for `tenant:admin`; one guard for the index and every pattern
// page under it. Rejected: the check per page, which a new pattern page could forget.
import { can } from '@mycel/core';
import { error } from '@sveltejs/kit';
import { runtime } from '#lib/server/runtime.js';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = async ({ parent, locals }) => {
  if (runtime().config.NODE_ENV === 'production') error(404, 'Not Found');
  await parent();
  if (!can(locals.principal!, 'tenant:admin')) error(403, 'tenant:admin');
};
