// The content list (TODO #11, brief content-editor § A1): pages or articles of this site, newest
// first, a page at a time. It follows the content locale (#66 PR 4): each row shows the title and
// the one status of that locale (ADR 018 rule 9; "changed" when a published locale has unpublished
// changes, rule 3), and the site's other locales as codes with a dot where the translation is
// behind or missing, read from each item's latest revision (`translationState`). Filter and paging
// are links, so the list works without JavaScript and every view has its own URL.
// The latest revision is one read per row, a page of at most 20; rejected for now: a translation
// summary in `content.item.list` itself, which changes core's output for the overviews of #79.
import { ContentType, useCases } from '@mycel/core';
import { translationState } from '#lib/server/content-locale.js';
import { runtime } from '#lib/server/runtime.js';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ parent, locals, url }) => {
  const { tenant, contentLocale: work } = await parent();
  const type = ContentType.safeParse(url.searchParams.get('type')).data ?? 'page';
  const after = url.searchParams.get('after') ?? undefined;
  const { invoker } = runtime();
  const principal = locals.principal!;
  const { items, next } = await invoker.run(useCases.listItems, principal, {
    type,
    ...(after && /^[0-9a-f-]{36}$/.test(after) ? { after } : {}),
  });
  const multi = tenant.locales.length > 1;
  return {
    type,
    contentType: type,
    next,
    workLocale: work,
    items: await Promise.all(
      items.map(async (i) => {
        const doc = multi
          ? (await invoker.run(useCases.getItem, principal, { itemId: i.id })).revision.document
          : null;
        const p = i.publication.find((x) => x.locale === work);
        const own = i.title[work];
        return {
          id: i.id,
          slug: i.slug,
          title: own ?? i.title[i.defaultLocale] ?? Object.values(i.title)[0] ?? '',
          // The title shown is another locale's: it carries that language.
          titleLocale: own ? work : i.title[i.defaultLocale] ? i.defaultLocale : null,
          updated: i.updatedAt,
          status: !p
            ? ('missing' as const)
            : p.hasUnpublishedChanges
              ? ('changed' as const)
              : p.status,
          others: doc
            ? tenant.locales
                .filter((l) => l !== work)
                .map((l) => ({ locale: l, state: translationState(doc, l) }))
            : [],
        };
      })
    ),
  };
};
