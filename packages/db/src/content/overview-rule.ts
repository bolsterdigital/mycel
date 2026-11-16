// The overview scenario of the adapter rules (adapter-rules.test.ts runs it over the memory
// adapter and over Postgres and compares both with `expectedOverview`). In a file of its own
// because the suite is at its size ceiling; it builds its own documents.

import type { z } from 'zod';
import { useCases, type Invoker, type Principal } from '@mycel/core';

interface Clock {
  now(): Date;
  advance(ms: number): void;
}

const article = <T extends Record<string, unknown>>(slug: string, over: T = {} as T) => ({
  type: 'article' as const,
  defaultLocale: 'nl',
  locales: ['nl', 'en'],
  title: { nl: `Titel ${slug}`, en: `Title ${slug}` },
  blocks: [] as never[],
  ...over,
});

/**
 * An overview block's list (`content.overview.get`): published, public revisions in the asked
 * locale only, filtered by type, section and every tag, ordered by first publication with the
 * item id breaking a tie; pins on top in the editor's order, a pin not published in this locale
 * dropping out; page 2 continuing page 1. A draft after publication, an unpublished or other
 * locale, a scheduled pin, a restricted item, the trash and another tenant never appear, and a
 * republish does not move an item.
 */
export async function observeOverview(
  invoker: Invoker,
  admin: Principal,
  other: Principal,
  clock: Clock
) {
  const create = async (slug: string, document: Record<string, unknown>, by = admin) =>
    (await invoker.run(useCases.createItem, by, { slug, document: document as never })).item;
  const publish = (item: { id: string; latestRevisionId: string }, locale: string, by = admin) =>
    invoker.run(useCases.publishItem, by, {
      itemId: item.id,
      revisionId: item.latestRevisionId,
      locale,
    });
  const buurt = await invoker.run(useCases.createSection, admin, {
    slug: 'buurt',
    title: { nl: 'Buurt' },
  });
  const inBuurt = { sectionId: buurt.id };

  clock.advance(1000);
  const oud = await create('oud', article('oud', { ...inBuurt, tags: ['Zout', 'suiker'] }));
  await publish(oud, 'nl');
  await publish(oud, 'en');
  clock.advance(1000);
  const midden = await create('midden', article('midden', { ...inBuurt, tags: ['zout'] }));
  await publish(midden, 'nl');
  clock.advance(1000);
  const nieuw = await create(
    'nieuw',
    article('nieuw', { ...inBuurt, lead: { nl: 'Kort en nieuw.', en: 'Short and new.' } })
  );
  await publish(nieuw, 'nl');
  clock.advance(1000);
  const elders = await create('elders-rubriek', article('elders-rubriek'));
  await publish(elders, 'nl');
  const pagina = await create('pagina', { ...article('pagina'), type: 'page' });
  await publish(pagina, 'nl');
  // Never in a list: restricted, scheduled, unpublished, in the trash, another tenant, a draft.
  const leden = await create(
    'leden',
    article('leden', {
      ...inBuurt,
      lead: { nl: 'Voor leden.', en: 'Members.' },
      access: { level: 'members' },
    })
  );
  await publish(leden, 'nl');
  const gepland = await create('gepland', article('gepland', inBuurt));
  await invoker.run(useCases.scheduleItem, admin, {
    itemId: gepland.id,
    revisionId: gepland.latestRevisionId,
    locale: 'nl',
    at: new Date(clock.now().getTime() + 3_600_000).toISOString(),
  });
  const weg = await create('ingetrokken', article('ingetrokken', inBuurt));
  await publish(weg, 'nl');
  await invoker.run(useCases.unpublishItem, admin, { itemId: weg.id, locale: 'nl' });
  const prullenbak = await create('prullenbak', article('prullenbak', inBuurt));
  await publish(prullenbak, 'nl');
  await invoker.run(useCases.deleteItem, admin, { itemId: prullenbak.id });
  const vreemd = await create('vreemd', article('vreemd'), other);
  await publish(vreemd, 'nl', other);
  await create('concept', article('concept', inBuurt));
  // A later draft of `oud` changes nothing; a republish of `midden` does not move it up.
  clock.advance(1000);
  await invoker.run(useCases.updateItem, admin, {
    itemId: oud.id,
    baseRevisionId: oud.latestRevisionId,
    document: article('oud', {
      ...inBuurt,
      title: { nl: 'Concepttitel', en: 'Draft title' },
    }) as never,
  });
  const herzien = await invoker.run(useCases.updateItem, admin, {
    itemId: midden.id,
    baseRevisionId: midden.latestRevisionId,
    document: article('midden', {
      ...inBuurt,
      tags: ['zout'],
      title: { nl: 'Midden herzien' },
    }) as never,
  });
  await invoker.run(useCases.publishItem, admin, {
    itemId: midden.id,
    revisionId: herzien.revision.id,
    locale: 'nl',
  });

  type Props = z.input<typeof useCases.getOverview.input>['props'];
  const get = (props: Props, locale = 'nl', page = 1, by = admin) =>
    invoker.run(useCases.getOverview, by, { props, locale, page });
  const slugs = async (props: Props, locale = 'nl', page = 1, by = admin) => {
    const { entries, older } = await get(props, locale, page, by);
    return `${entries.map((e) => `${e.slug}${e.pinned ? '*' : ''}`).join(' ')}${older ? ' +' : ''}`;
  };
  const first = (await get({ sectionId: buurt.id, limit: '1' })).entries[0];
  return {
    articles: await slugs({}),
    oldest: await slugs({ order: 'oldest' }),
    pages: await slugs({ source: 'page' }),
    section: await slugs({ sectionId: buurt.id }),
    // Canonical tags, and every one of them.
    oneTag: await slugs({ tags: [{ tag: ' ZOUT ' }] }),
    everyTag: await slugs({ tags: [{ tag: 'zout' }, { tag: 'suiker' }] }),
    english: await slugs({}, 'en'),
    pinsOnTop: await slugs({ limit: '3', pinned: [{ itemId: oud.id }, { itemId: pagina.id }] }),
    // `midden` is not published in English: it drops out and the list fills its place.
    pinNotInLocale: await slugs({ limit: '2', pinned: [{ itemId: midden.id }] }, 'en'),
    pinRestricted: await slugs({ limit: '2', pinned: [{ itemId: leden.id }] }),
    page1: await slugs({ limit: '2', pinned: [{ itemId: oud.id }] }),
    page2: await slugs({ limit: '2', pinned: [{ itemId: oud.id }] }, 'nl', 2),
    page3: await slugs({ limit: '2', pinned: [{ itemId: oud.id }] }, 'nl', 3),
    otherTenant: await slugs({}, 'nl', 1, other),
    card: first && {
      title: first.title,
      summary: first.summary,
      revisionIsPublished: first.revisionId === nieuw.latestRevisionId,
    },
    // A page source carries no section or tags.
    pageWithSection: await get({ source: 'page', sectionId: buurt.id }).then(
      () => 'answered',
      (e: { code?: string }) => e.code
    ),
  };
}

export const expectedOverview = {
  // `midden` was republished last, and stays where its first publication put it.
  articles: 'elders-rubriek nieuw midden oud',
  oldest: 'oud midden nieuw elders-rubriek',
  pages: 'pagina',
  section: 'nieuw midden oud',
  oneTag: 'midden oud',
  everyTag: 'oud',
  english: 'oud',
  pinsOnTop: 'oud* pagina* elders-rubriek +',
  pinNotInLocale: 'oud',
  pinRestricted: 'elders-rubriek nieuw +',
  page1: 'oud* elders-rubriek +',
  page2: 'nieuw midden',
  page3: '',
  otherTenant: 'vreemd',
  card: {
    title: 'Titel nieuw',
    summary: 'Kort en nieuw.',
    revisionIsPublished: true,
  },
  pageWithSection: 'invalid_input',
};
