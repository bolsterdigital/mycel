// Who the site's supporters are (`supporter.list`, brief MY-251): the list, narrowed by a GET
// form to a list, a consent state and the start of an address, a page at a time. Only readers of
// `supporters:read` get here; the menu hides the entry from everyone else and this load refuses
// them. The filter and the address never leave the query string and the use case: nothing here
// logs them (ADR 019 rule 7).
//
// Paging follows the use case's cursor. `trail` holds the cursors of the pages before this one,
// so Previous is a link like Next and works without JavaScript; past TRAIL_MAX pages the oldest
// cursor is dropped and Previous from there leads to the start. Rejected: an offset (a signup
// while someone reads shifts every page) and Previous through the browser's history only.
import { can, useCases } from '@mycel/core';
import { loaded } from '#lib/server/admin/admin-actions.js';
import { refuse } from '#lib/server/http/refuse.js';
import { signupLists } from '#lib/server/mail/newsletter.js';
import { runtime } from '#lib/server/runtime.js';
import { langOf } from '../../../../../i18n/index.js';
import type { PageServerLoad } from './$types';

const PAGE_SIZE = 50;
const TRAIL_MAX = 20;

export const load: PageServerLoad = async ({ parent, locals, url }) => {
  await parent();
  const principal = locals.principal!;
  if (!can(principal, 'supporters:read')) refuse(403);
  const param = (name: string, max: number) =>
    (url.searchParams.get(name) ?? '').trim().slice(0, max);
  const q = param('q', 254);
  const list = param('list', 100);
  const asked = url.searchParams.get('status');
  const status = list && (asked === 'confirmed' || asked === 'pending') ? asked : '';
  const after = param('after', 60);
  const trail = param('trail', 61 * TRAIL_MAX)
    .split(',')
    .filter(Boolean);
  const page = await loaded(
    runtime().invoker.run(useCases.listSupporters, principal, {
      limit: PAGE_SIZE,
      ...(q ? { q } : {}),
      ...(list ? { list } : {}),
      ...(status ? { status } : {}),
      ...(after ? { after } : {}),
    })
  );
  // The site's signup lists, then what the rows on this page name, then the one asked for: a
  // list no form knows (an import, a removed form) can still be chosen while it is in view.
  const known = await signupLists(principal, langOf(locals));
  const lists = new Map(known.map((l) => [l.id, l.label]));
  for (const name of [
    ...page.supporters.flatMap((s) => [...s.lists, ...s.pendingLists]),
    ...(list ? [list] : []),
  ])
    if (!lists.has(name)) lists.set(name, name);
  const href = (cursor: string, before: string[]) =>
    `?${new URLSearchParams({
      ...(q ? { q } : {}),
      ...(list ? { list } : {}),
      ...(status ? { status } : {}),
      ...(cursor ? { after: cursor } : {}),
      ...(before.length ? { trail: before.join(',') } : {}),
    })}`;
  return {
    supporters: page.supporters,
    total: page.total,
    lists: [...lists].map(([id, label]) => ({ id, label })),
    q,
    list,
    status,
    filtered: Boolean(q || list),
    paging: {
      ...(after ? { previous: href(trail.at(-1) ?? '', trail.slice(0, -1)) } : {}),
      ...(page.next
        ? { next: href(page.next, after ? [...trail, after].slice(-TRAIL_MAX) : []) }
        : {}),
    },
  };
};
