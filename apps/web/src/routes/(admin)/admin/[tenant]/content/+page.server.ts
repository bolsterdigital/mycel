// The content list (TODO #11, brief content-editor § A1): pages or articles of this site, newest
// first, a page at a time, with each locale's status (ADR 018 rule 9) and whether a published
// locale has unpublished changes (rule 3). Filter and paging are links, so the list works without
// JavaScript and every view has its own URL.
import { ContentType, useCases } from '@mycel/core';
import { runtime } from '#lib/server/runtime.js';
import { when } from '#lib/server/content-admin.js';
import { adminTimeZone } from '#lib/server/admin.js';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ parent, locals, url }) => {
  await parent();
  const { zone } = await adminTimeZone(locals);
  const type = ContentType.safeParse(url.searchParams.get('type')).data ?? 'page';
  const after = url.searchParams.get('after') ?? undefined;
  const { items, next } = await runtime().invoker.run(useCases.listItems, locals.principal!, {
    type,
    ...(after && /^[0-9a-f-]{36}$/.test(after) ? { after } : {}),
  });
  return {
    type,
    contentType: type,
    next,
    items: items.map((i) => ({
      id: i.id,
      slug: i.slug,
      title: i.title[i.defaultLocale] ?? Object.values(i.title)[0] ?? '',
      updated: when(i.updatedAt, zone),
      publication: i.publication.map((p) => ({
        locale: p.locale,
        status: p.status,
        changes: p.hasUnpublishedChanges,
      })),
    })),
  };
};
