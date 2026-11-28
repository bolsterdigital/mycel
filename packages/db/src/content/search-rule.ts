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
 * from there (reader access in Postgres: content/reader-search.test.ts). Each result carries
 * the same card fields on both adapters.
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
  const section = await invoker.run(useCases.createSection, admin, {
    slug: 'verkeer',
    title: { nl: 'Verkeer' },
  });
  const leden = await create('leden', {
    type: 'article',
    defaultLocale: 'nl',
    locales: ['nl'],
    sectionId: section.id,
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
    // The card fields (MY-308): kind or section, image, where the match stood, no moments
    // without a recording; a restricted article keeps its section, which its teaser shows.
    cards: (await find({ q: 'fietspad', locale: 'nl' })).items.map((r) => ({
      slug: r.slug,
      kind: r.kind,
      section: r.section?.name ?? null,
      imageId: r.imageId,
      foundIn: r.foundIn,
      moments: r.moments.length,
      recording: r.recording ?? null,
    })),
    firstPage: await find({ q: 'fietspad', locale: 'nl', limit: 1 }),
    secondPage: await find({ q: 'fietspad', locale: 'nl', limit: 1, page: 2 }),
  };
  const filters = await observeFilters(invoker, admin, clock, section.id);
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
    filters,
    draftOnly,
    republished,
    // Restored items come back unpublished.
    restored: await slugs('weg'),
  };
}

/**
 * Filters, sort and counts (MY-308 PR 2) over a word of their own: kind (a Video/audio article is
 * `media`), section and period narrow the list; each kind count ignores the kind filter and each
 * section count the section filter; the members' article that only its body matches counts for
 * no visitor; an unknown section is `not_found`.
 */
async function observeFilters(invoker: Invoker, admin: Principal, clock: Clock, verkeer: string) {
  const sport = await invoker.run(useCases.createSection, admin, {
    slug: 'sport',
    title: { nl: 'Sport' },
  });
  const article = (over: Record<string, unknown>) => ({
    type: 'article',
    defaultLocale: 'nl',
    locales: ['nl'],
    blocks: [],
    ...over,
  });
  const make = async (slug: string, document: Record<string, unknown>, firstPublishedAt?: Date) => {
    const { item } = await invoker.run(useCases.createItem, admin, {
      slug,
      document: document as never,
    });
    await invoker.run(useCases.publishItem, admin, {
      itemId: item.id,
      revisionId: item.latestRevisionId,
      locale: 'nl',
      ...(firstPublishedAt ? { firstPublishedAt: firstPublishedAt.toISOString() } : {}),
    });
    clock.advance(1000);
  };
  // Inside the last month, outside the last week.
  const longAgo = new Date(clock.now().getTime() - 20 * 86_400_000);
  await make(
    'zebra-oud',
    article({ sectionId: verkeer, title: { nl: 'Zebrapad van toen' } }),
    longAgo
  );
  await make(
    'zebra-video',
    article({
      sectionId: verkeer,
      title: { nl: 'Het zebrapad op video' },
      presentation: { profile: 'media' },
    })
  );
  await make(
    'zebra-sport',
    article({ sectionId: sport.id, title: { nl: 'Hardlopen' }, lead: { nl: 'Over het zebrapad.' } })
  );
  await make(
    'zebra-pagina',
    pageDocument({ locales: ['nl'], title: { nl: 'Oversteken' }, lead: { nl: 'Een zebrapad.' } })
  );
  await make(
    'zebra-leden',
    article({
      sectionId: sport.id,
      title: { nl: 'Besloten' },
      lead: { nl: 'Voor steuners.' },
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
                  { type: 'paragraph', content: [{ type: 'text', text: 'Een zebrapad.' }] },
                ],
              },
            },
          },
        },
      ],
    })
  );
  type Input = Omit<z.input<typeof useCases.findPublished.input>, 'q' | 'locale'>;
  const look = async (input: Input = {}) => {
    const r = await invoker.run(useCases.findPublished, admin, {
      q: 'zebrapad',
      locale: 'nl',
      ...input,
    });
    return {
      slugs: r.items.map((i) => i.slug).join(' '),
      total: r.total,
      kinds: r.facets.kinds,
      sections: r.facets.sections.map((x) => `${x.name}:${x.count}`).join(' '),
    };
  };
  return {
    all: await look(),
    newest: await look({ sort: 'newest' }),
    articles: await look({ kind: 'article' }),
    media: await look({ kind: 'media' }),
    section: await look({ section: 'verkeer' }),
    month: await look({ period: 'month' }),
    week: await look({ period: 'week' }),
    none: await look({ section: 'sport', kind: 'page' }),
    unknown: await look({ section: 'nergens' }).then(
      () => 'found',
      (e: { code?: string }) => e.code
    ),
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
  cards: [
    { slug: 'leden', kind: 'article', section: 'Verkeer' },
    { slug: 'route', kind: 'page', section: null },
    { slug: 'raad', kind: 'page', section: null },
  ].map((card) => ({ ...card, imageId: null, foundIn: 'text', moments: 0, recording: null })),
  // A word behind the boundary finds nothing for anyone who is no reader with access; the lead
  // does, with an excerpt from the lead and the mark.
  behindTheBoundary: '',
  teaserHit: [
    { slug: 'leden', restricted: true, excerpt: 'De wethouder schrijft alleen voor leden.' },
  ],
  firstPage: { slugs: 'leden', next: 2 },
  secondPage: { slugs: 'route', next: 3 },
  filters: {
    // Title hits first (the newer one leads), then body hits, newest first; the members' article
    // matches only in its body, so a visitor neither finds nor counts it.
    all: {
      slugs: 'zebra-video zebra-oud zebra-pagina zebra-sport',
      total: 4,
      kinds: { page: 1, article: 2, media: 1 },
      sections: 'Sport:1 Verkeer:2',
    },
    newest: {
      slugs: 'zebra-pagina zebra-sport zebra-video zebra-oud',
      total: 4,
      kinds: { page: 1, article: 2, media: 1 },
      sections: 'Sport:1 Verkeer:2',
    },
    // The kind counts ignore the kind filter; the sections follow it.
    articles: {
      slugs: 'zebra-oud zebra-sport',
      total: 2,
      kinds: { page: 1, article: 2, media: 1 },
      sections: 'Sport:1 Verkeer:1',
    },
    media: {
      slugs: 'zebra-video',
      total: 1,
      kinds: { page: 1, article: 2, media: 1 },
      sections: 'Verkeer:1',
    },
    // The section counts ignore the section filter; the kinds follow it.
    section: {
      slugs: 'zebra-video zebra-oud',
      total: 2,
      kinds: { page: 0, article: 1, media: 1 },
      sections: 'Sport:1 Verkeer:2',
    },
    month: {
      slugs: 'zebra-video zebra-oud zebra-pagina zebra-sport',
      total: 4,
      kinds: { page: 1, article: 2, media: 1 },
      sections: 'Sport:1 Verkeer:2',
    },
    week: {
      slugs: 'zebra-video zebra-pagina zebra-sport',
      total: 3,
      kinds: { page: 1, article: 1, media: 1 },
      sections: 'Sport:1 Verkeer:1',
    },
    // Nothing under both: the chosen section is listed with zero, so the form can show it.
    none: { slugs: '', total: 0, kinds: { page: 0, article: 1, media: 0 }, sections: 'Sport:0' },
    unknown: 'not_found',
  },
  draftOnly: { old: 'leden raad route', fresh: '' },
  republished: { old: 'leden route', fresh: 'raad' },
  restored: '',
};
