// Who took part in one campaign (`campaign.participation.list`, TODO MY-256 PR 2): address, when
// the participation was confirmed and whether it was withdrawn, newest first, fifty at a time.
// These are supporters' addresses, so only holders of `supporters:read` get here, whatever they
// may do with the campaign; the panel on the landing page links here for them alone. With
// `supporters:export` the page also offers the whole list as a CSV file, posted to
// `participants/export`. The title is the landing page's, which a reader of content gets; anyone
// else reads the kind.
//
// Paging follows the use case's cursor with a trail of earlier cursors, as the Supporters list
// does, so Previous is a link and works without JavaScript. Rejected: the rows in the editor's
// side column (too narrow for an address, and the editor's load would hand addresses to every
// writer) and a filter on the Supporters list (the date and the withdrawal are the
// participation's, not the supporter's).
import { PARTICIPATION_EXPORT_MAX, can, pickAny, useCases } from '@mycel/core';
import { loaded } from '#lib/server/admin/admin-actions.js';
import { refuse } from '#lib/server/http/refuse.js';
import { runtime } from '#lib/server/runtime.js';
import type { PageServerLoad } from './$types';

const PAGE_SIZE = 50;
const TRAIL_MAX = 20;

export const load: PageServerLoad = async ({ parent, locals, url, params }) => {
  const { tenant, locale } = await parent();
  const principal = locals.principal!;
  if (!can(principal, 'supporters:read')) refuse(403);
  const param = (name: string, max: number) =>
    (url.searchParams.get(name) ?? '').trim().slice(0, max);
  const after = param('after', 60);
  const trail = param('trail', 61 * TRAIL_MAX)
    .split(',')
    .filter(Boolean);
  const run = runtime().invoker;
  const page = await loaded(
    run.run(useCases.listParticipations, principal, {
      campaignId: params.id,
      limit: PAGE_SIZE,
      ...(after ? { after } : {}),
    })
  );
  // A page in the trash or a member who reads no content: the list still shows, under its kind.
  const landing = can(principal, 'content:read')
    ? await run
        .run(useCases.getItem, principal, { itemId: page.landingItemId })
        .then(({ item }) => pickAny(item.title, locale, tenant.defaultLocale) ?? item.slug)
        .catch(() => null)
    : null;
  const href = (cursor: string, before: string[]) =>
    `?${new URLSearchParams({
      ...(cursor ? { after: cursor } : {}),
      ...(before.length ? { trail: before.join(',') } : {}),
    })}`;
  return {
    campaign: { id: params.id, kind: page.kind, landingItemId: page.landingItemId, landing },
    participants: page.participants,
    total: page.total,
    active: page.active,
    canExport: can(principal, 'supporters:export'),
    exportMax: PARTICIPATION_EXPORT_MAX,
    paging: {
      ...(after ? { previous: href(trail.at(-1) ?? '', trail.slice(0, -1)) } : {}),
      ...(page.next ? { next: href(page.next, [...trail, after].slice(-TRAIL_MAX)) } : {}),
    },
  };
};
