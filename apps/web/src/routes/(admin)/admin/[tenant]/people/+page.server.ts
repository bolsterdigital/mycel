// The editorial register of people and organisations shares the ordinary content permissions and
// page patterns. Rejected: a separate author or organisation directory that duplicates identity.
import { can, pickAny } from '@mycel/core';
import { loaded } from '#lib/server/admin/admin-actions.js';
import { peopleDirectory, groupDirectory, pageStatuses } from '#lib/server/people/directory.js';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ parent, locals, url }) => {
  const context = await parent();
  const principal = locals.principal!;
  const [all, groups] = await loaded(
    Promise.all([peopleDirectory(principal), groupDirectory(principal)])
  );
  const q = (url.searchParams.get('q') ?? '').trim();
  const group = url.searchParams.get('group') ?? '';
  const kindParam = url.searchParams.get('kind');
  const kind = kindParam === 'person' || kindParam === 'organisation' ? kindParam : '';
  const selected = groups.find((g) => g.id === group);
  const matches = all.filter(
    (p) =>
      (!q || p.name.toLocaleLowerCase().includes(q.toLocaleLowerCase())) &&
      (!kind || p.kind === kind) &&
      (!group || selected?.personIds.includes(p.id))
  );
  const offset = Math.max(0, Number.parseInt(url.searchParams.get('offset') ?? '0', 10) || 0);
  const people = matches.slice(offset, offset + 50);
  return {
    people,
    groups: groups.map((g) => ({ id: g.id, name: pickAny(g.name, context.contentLocale) ?? '' })),
    statuses: await loaded(pageStatuses(principal, people)),
    q,
    kind,
    group,
    offset,
    total: matches.length,
    write: can(principal, 'content:write'),
  };
};
