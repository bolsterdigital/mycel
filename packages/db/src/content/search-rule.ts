// The site search scenario of the adapter rules (adapter-rules.test.ts runs it over the memory
// adapter and over Postgres and compares both with `expectedSearch`). In a file of its own because
// the suite is at its size ceiling; it builds its own documents, so it imports nothing from a
// testing barrel.

import type { z } from 'zod';
import { useCases, type Invoker, type Principal } from '@mycel/core';

interface Clock {
  now(): Date;
  advance(ms: number): void;
}

const pageDocument = <T extends Record<string, unknown>>(over: T = {} as T) => ({
  type: 'page' as const,
  defaultLocale: 'nl',
  locales: ['nl', 'en'],
  title: { nl: 'Titel', en: 'Title' },
  blocks: [] as never[],
  ...over,
});

/**
 * The site search (`content.published.find`): a question finds only what a visitor may read
 * now. Prefixes and folded accents match, every token must; a title hit ranks first, then the
 * newest publication; the other locale, a draft after publication, an unpublished locale, a
 * scheduled pin, `noindex`, the trash and another tenant are never found, and a newly published
 * revision replaces what the old one was found by. A restricted item is found by its title and
 * teaser, marked `restricted`, never by a word behind its boundary and never with an excerpt
 * from there (reader access in Postgres: content/reader-search.test.ts).
 */
export async function observeSearch(
  invoker: Invoker,
  admin: Principal,
  other: Principal,
  clock: Clock
) {
  const heading = (nl: string, en: string) => ({
    type: 'heading',
    version: 1,
    props: { text: { nl, en } },
  });
  const create = async (slug: string, document: Record<string, unknown>, by = admin) =>
    (await invoker.run(useCases.createItem, by, { slug, document: document as never })).item;
  const publish = (item: { id: string; latestRevisionId: string }, locale: string, by = admin) =>
    invoker.run(useCases.publishItem, by, {
      itemId: item.id,
      revisionId: item.latestRevisionId,
      locale,
    });
  clock.advance(1000);
  const pad = await create(
    'route',
    pageDocument({
      title: { nl: 'Het fietspad', en: 'The cycle path' },
      lead: { nl: 'Een café aan de Dorpsstraat.', en: 'A village pub.' },
      blocks: [heading('Wethouder opent de route', 'Alderman opens the route')],
    })
  );
  await publish(pad, 'nl');
  await publish(pad, 'en');
  clock.advance(1000);
  const raad = await create(
    'raad',
    pageDocument({
      locales: ['nl'],
      title: { nl: 'De raad vergadert' },
      lead: { nl: 'Over het fietspad en de wethouder.' },
    })
  );
  await publish(raad, 'nl');
  clock.advance(1000);
  const verborgen = await create(
    'verborgen',
    pageDocument({ title: { nl: 'Fietspad verborgen', en: 'Hidden' }, seo: { noindex: true } })
  );
  await publish(verborgen, 'nl');
  const leden = await create('leden', {
    type: 'article',
    defaultLocale: 'nl',
    locales: ['nl'],
    title: { nl: 'Fietspad voor leden' },
    lead: { nl: 'De wethouder schrijft alleen voor leden.' },
    access: { level: 'members' },
    blocks: [
      {
        type: 'rich-text',
        version: 1,
        props: {
          content: {
            nl: {
              type: 'doc',
              content: [
                { type: 'paragraph', content: [{ type: 'text', text: 'Het geheime besluit.' }] },
              ],
            },
          },
        },
      },
    ],
  });
  await publish(leden, 'nl');
  const concept = await create('concept', pageDocument({ title: { nl: 'Fietspad concept' } }));
  const gepland = await create('gepland', pageDocument({ title: { nl: 'Fietspad gepland' } }));
  await invoker.run(useCases.scheduleItem, admin, {
    itemId: gepland.id,
    revisionId: gepland.latestRevisionId,
    locale: 'nl',
    at: new Date(clock.now().getTime() + 3_600_000).toISOString(),
  });
  const weg = await create('ingetrokken', pageDocument({ title: { nl: 'Fietspad ingetrokken' } }));
  await publish(weg, 'nl');
  await invoker.run(useCases.unpublishItem, admin, { itemId: weg.id, locale: 'nl' });
  const prullenbak = await create('prullenbak', pageDocument({ title: { nl: 'Fietspad weg' } }));
  await publish(prullenbak, 'nl');
  await invoker.run(useCases.deleteItem, admin, { itemId: prullenbak.id });
  const elders = await create('elders', pageDocument({ title: { nl: 'Fietspad elders' } }), other);
  await publish(elders, 'nl', other);

  type Input = z.input<typeof useCases.findPublished.input>;
  const find = (input: Input, by = admin) => invoker.run(useCases.findPublished, by, input);
  const slugs = async (q: string, locale = 'nl', by = admin) =>
    (await find({ q, locale }, by)).items.map((r) => r.slug).join(' ');
  const before = {
    // Title hit first, then the lead hit, although `raad` is the newer publication.
    titleFirst: await slugs('fietspad'),
    prefix: await slugs('fiets'),
    notASuffix: await slugs('pad'),
    foldedAccent: await slugs('CAFE'),
    everyToken: await slugs('wethouder route'),
    oneTokenMisses: await slugs('wethouder zwembad'),
    block: await slugs('opent'),
    otherLocale: await slugs('cycle', 'en'),
    notAcrossLocales: await slugs('cycle'),
    tooShort: await slugs('f'),
    empty: await slugs('  '),
    otherTenant: await slugs('fietspad', 'nl', other),
    excerpt: (await find({ q: 'dorps', locale: 'nl' })).items[0]?.excerpt,
    behindTheBoundary: await slugs('geheime'),
    teaserHit: (await find({ q: 'leden', locale: 'nl' })).items.map((r) => ({
      slug: r.slug,
      restricted: r.restricted,
      excerpt: r.excerpt.map((x) => x.text).join(''),
    })),
    title: (await find({ q: 'dorps', locale: 'nl' })).items[0]?.title,
    firstPage: await find({ q: 'fietspad', locale: 'nl', limit: 1 }),
    secondPage: await find({ q: 'fietspad', locale: 'nl', limit: 1, page: 2 }),
  };
  // A draft after publication changes nothing; publishing it replaces what the item is found by.
  clock.advance(1000);
  const draft = await invoker.run(useCases.updateItem, admin, {
    itemId: raad.id,
    baseRevisionId: raad.latestRevisionId,
    document: pageDocument({
      locales: ['nl'],
      title: { nl: 'De raad zwemt' },
      lead: { nl: 'Over het zwembad.' },
    }) as never,
  });
  const draftOnly = { old: await slugs('wethouder'), fresh: await slugs('zwembad') };
  await invoker.run(useCases.publishItem, admin, {
    itemId: raad.id,
    revisionId: draft.revision.id,
    locale: 'nl',
  });
  const republished = { old: await slugs('wethouder'), fresh: await slugs('zwembad') };
  await invoker.run(useCases.restoreItem, admin, { itemId: prullenbak.id });
  return {
    ...before,
    firstPage: {
      slugs: before.firstPage.items.map((r) => r.slug).join(' '),
      next: before.firstPage.next,
    },
    secondPage: {
      slugs: before.secondPage.items.map((r) => r.slug).join(' '),
      next: before.secondPage.next,
    },
    draftOnly,
    republished,
    // Restored items come back unpublished.
    restored: await slugs('weg'),
  };
}

export const expectedSearch = {
  // The members' article ranks by its title, which its teaser shows everyone.
  titleFirst: 'leden route raad',
  prefix: 'leden route raad',
  notASuffix: '',
  foldedAccent: 'route',
  everyToken: 'route',
  oneTokenMisses: '',
  block: 'route',
  otherLocale: 'route',
  notAcrossLocales: '',
  tooShort: '',
  empty: '',
  otherTenant: 'elders',
  excerpt: [
    { text: 'Een café aan de ', match: false },
    { text: 'Dorpsstraat', match: true },
    { text: '.', match: false },
  ],
  title: 'Het fietspad',
  // A word behind the boundary finds nothing for anyone who is no reader with access; the lead
  // does, with an excerpt from the lead and the mark.
  behindTheBoundary: '',
  teaserHit: [
    { slug: 'leden', restricted: true, excerpt: 'De wethouder schrijft alleen voor leden.' },
  ],
  firstPage: { slugs: 'leden', next: 2 },
  secondPage: { slugs: 'route', next: 3 },
  draftOnly: { old: 'leden raad route', fresh: '' },
  republished: { old: 'leden route', fresh: 'raad' },
  restored: '',
};
