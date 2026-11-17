// The feed scenario of the adapter rules (adapter-rules.test.ts runs it over the memory adapter
// and over Postgres and compares both with `expectedFeed`). In a file of its own because the
// suite is at its size ceiling; it builds its own documents.

import { useCases, type Invoker, type Principal } from '@mycel/core';

interface Clock {
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
 * A feed (`content.feed.get`): the newest published articles in the asked locale, by first
 * publication, narrowed to a section or to an author's articles, a restricted one as its teaser
 * marked `restricted`; never noindex, a canonical elsewhere, a draft or another tenant. An unknown section or a person
 * without a public page is not found. The published list carries the canonical, so the sitemap
 * can leave such an item out.
 */
export async function observeFeed(
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
  const zout = await invoker.run(useCases.createSection, admin, {
    slug: 'zout',
    title: { nl: 'Zout', en: 'Salt' },
  });
  const sam = await invoker.run(useCases.createPerson, admin, { slug: 'sam', name: 'Sam' });
  const verborgen = await invoker.run(useCases.createPerson, admin, {
    slug: 'verborgen-persoon',
    name: 'Verborgen',
    pagePolicy: 'never',
  });

  clock.advance(1000);
  const een = await create(
    'een',
    article('een', { sectionId: zout.id, authorIds: [sam.id], lead: { nl: 'Kort.', en: 'Short.' } })
  );
  await publish(een, 'nl');
  await publish(een, 'en');
  clock.advance(1000);
  const twee = await create('twee', article('twee', { authorIds: [verborgen.id] }));
  await publish(twee, 'nl');
  clock.advance(1000);
  const drie = await create('drie', article('drie', { sectionId: zout.id }));
  await publish(drie, 'nl');
  const pagina = await create('pagina', { ...article('pagina'), type: 'page' });
  await publish(pagina, 'nl');
  // Never in a feed: noindex, canonical elsewhere, a draft, another tenant.
  const noindex = await create('noindex', article('noindex', { seo: { noindex: true } }));
  await publish(noindex, 'nl');
  const elders = await create(
    'elders',
    article('elders', { seo: { canonical: 'https://example.org/elders' } })
  );
  await publish(elders, 'nl');
  const leden = await create(
    'leden',
    article('leden', {
      authorIds: [sam.id],
      access: { level: 'members' },
      lead: { nl: 'L.' },
      blocks: [
        { id: 'body', type: 'heading', version: 1, props: { text: { nl: 'SENTINEL-BODY' } } },
      ],
    })
  );
  await publish(leden, 'nl');
  await create('concept', article('concept', { authorIds: [sam.id] }));
  const vreemd = await create('vreemd', article('vreemd'), other);
  await publish(vreemd, 'nl', other);

  type Input = Parameters<typeof useCases.getFeed.handler>[1];
  const feed = (input: Partial<Input>, by = admin) =>
    invoker.run(useCases.getFeed, by, { locale: 'nl', ...input });
  const slugs = async (input: Partial<Input>, by = admin) =>
    (await feed(input, by)).entries.map((e) => e.slug).join(' ');
  const refused = (input: Partial<Input>) =>
    feed(input).then(
      () => 'served',
      (e: { code: string }) => e.code
    );
  const site = await feed({});
  const list = (await invoker.run(useCases.listPublished, admin, { limit: 50 })).items;
  return {
    site: await slugs({}),
    english: await slugs({ locale: 'en' }),
    pages: await slugs({ type: 'page' }),
    section: await slugs({ section: 'zout' }),
    sectionName: (await feed({ section: 'zout', locale: 'en' })).name,
    author: await slugs({ author: 'sam' }),
    authorName: (await feed({ author: 'sam' })).name,
    noSection: await refused({ section: 'onbekend' }),
    noPublicPage: await refused({ author: 'verborgen-persoon' }),
    limit: await slugs({ limit: 1 }),
    entry: site.entries.at(-1) && {
      title: site.entries.at(-1)!.title,
      summary: site.entries.at(-1)!.summary,
      name: site.name,
    },
    restricted: site.entries
      .filter((e) => e.restricted)
      .map((e) => `${e.slug}: ${e.summary}${JSON.stringify(e).includes('SENTINEL') ? '!' : ''}`),
    otherTenant: await slugs({}, other),
    canonicalInList: list.filter((r) => r.canonical).map((r) => r.slug),
  };
}

export const expectedFeed = {
  site: 'drie leden twee een',
  english: 'een',
  pages: 'pagina',
  section: 'drie een',
  sectionName: 'Salt',
  author: 'leden een',
  authorName: 'Sam',
  noSection: 'not_found',
  noPublicPage: 'not_found',
  limit: 'drie',
  entry: { title: 'Titel een', summary: 'Kort.', name: null },
  restricted: ['leden: L.'],
  otherTenant: 'vreemd',
  canonicalInList: ['elders'],
};
