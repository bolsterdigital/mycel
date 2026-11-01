// The demo content stays valid as the block schemas move: both documents parse, are
// ready to publish in nl and en, use every block type at its current version between them, and
// the seed creates, publishes and then leaves them alone.

import { describe, expect, it } from 'vitest';
import { BLOCK_DEFINITIONS } from '../content/block-types.js';
import { INSERTABLE_BLOCK_TYPES } from '../content/blocks.js';
import { assignBlockIds } from '../content/blocks.js';
import { ContentDocument, ContentDocumentInput, readinessIssues } from '../content/model.js';
import { Invoker } from '../invoke.js';
import { buildRegistry, useCases } from '../use-cases.js';
import { exampleId } from '../util/ids.js';
import { DEMO_IMAGES, demoArticle, demoPage, seedDemoContent } from './demo-content.js';
import { bytesToBase64 } from '../util/bytes.js';
import { adminOf, probeForm, publishProbePage } from './fixtures.js';
import { MemoryUnitOfWork } from './memory.js';

const FORM = exampleId(0xf00d);
const media = {
  market: exampleId(0xd101),
  bakery: exampleId(0xd102),
  measuring: exampleId(0xd103),
  signatures: exampleId(0xd104),
};
const documents = [
  demoPage({ formId: FORM, media }).document,
  demoArticle({ formId: FORM, media, pageId: exampleId(0xc101) }).document,
];

/** A JPEG start-of-image marker: all the memory image processor reads of a JPEG. */
const jpegHeader = async () => new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);

/** A PNG signature and IHDR, for the posters an earlier seed uploaded. */
function pngHeader() {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(bytes.buffer).setUint32(16, 1600);
  new DataView(bytes.buffer).setUint32(20, 900);
  return bytes;
}

/** The texts the poster-era seed wrote, in place of the photo texts. */
const posterEra = <T>(document: T): T => {
  let json = JSON.stringify(document);
  const swap = (from: Record<string, string>, to: Record<string, string>) => {
    for (const locale of ['nl', 'en'])
      json = json.replaceAll(JSON.stringify(from[locale]), JSON.stringify(to[locale]));
  };
  for (const image of DEMO_IMAGES) swap(image.alt, image.replaces.alt);
  swap(
    {
      nl: 'Na de actiedag van vorig jaar bespraken we de steunbetuigingen met de wethouder.',
      en: "After last year's day of action we discussed the messages of support with the alderman.",
    },
    {
      nl: 'Vrijwilligers sorteren de steunbetuigingen na de actiedag van vorig jaar.',
      en: "Volunteers sort the messages of support after last year's day of action.",
    }
  );
  json = json.replace(
    JSON.stringify({ work: null, photographer: DEMO_IMAGES[3]!.source.photographer }),
    JSON.stringify({ work: null, photographer: 'Demo-afbeelding, gemaakt door de Mycel-seed' })
  );
  // Every object's keys reversed, as Postgres `jsonb` reorders them (`en` before `nl`).
  return JSON.parse(json, (_, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).reverse())
      : v
  ) as T;
};

describe('demo content', () => {
  it.each(documents.map((d) => [d.type, d] as const))(
    'the %s is a valid document, ready in nl and en',
    (_, input) => {
      const parsed = ContentDocumentInput.parse(input);
      const stored = ContentDocument.parse({
        ...parsed,
        blocks: assignBlockIds(
          parsed.blocks,
          (() => {
            let n = 0;
            return () => exampleId(0xb000 + n++);
          })()
        ),
      });
      expect(stored.blocks.length).toBeGreaterThanOrEqual(10);
      expect(stored.blocks.length).toBeLessThanOrEqual(14);
      expect(stored.lead?.['nl']).toBeTruthy();
      expect(stored.heroImageId).toBeDefined();
      for (const locale of ['nl', 'en']) expect(readinessIssues(stored, locale)).toEqual([]);
    }
  );

  // Every type new content can get, at its current version; not the hero, which new content
  // does not get (ADR 025 rule 4): the page's header is its title, lead and main image.
  it('uses every insertable block type at its current version, and no hero', () => {
    const used = new Map(documents.flatMap((d) => d.blocks.map((b) => [b.type, b.version])));
    for (const type of INSERTABLE_BLOCK_TYPES)
      expect([type, used.get(type)]).toEqual([type, BLOCK_DEFINITIONS[type].version]);
    expect(used.has('hero')).toBe(false);
  });

  it('seeds both items published in every locale, once', async () => {
    const uow = new MemoryUnitOfWork();
    const invoker = new Invoker(buildRegistry(), uow);
    const admin = adminOf();
    await uow.run(admin, (ctx) => ctx.forms.insert(probeForm(FORM)));

    const first = await seedDemoContent(invoker, admin, { formId: FORM, load: jpegHeader });
    expect(first).toMatchObject({ created: true, upgraded: [] });
    for (const item of [first.page, first.article])
      expect(
        item.publication.map((p) => [p.locale, p.status]).sort((x, y) => x[0]!.localeCompare(y[0]!))
      ).toEqual([
        ['en', 'published'],
        ['nl', 'published'],
      ]);
    const { items } = await invoker.run(useCases.listMedia, admin, {});
    expect(items.map((m) => m.filename).sort()).toEqual(DEMO_IMAGES.map((i) => i.filename).sort());

    const again = await seedDemoContent(invoker, admin, { formId: FORM, load: jpegHeader });
    expect(again).toMatchObject({ created: false, upgraded: [], page: { id: first.page.id } });
    expect((await invoker.run(useCases.listMedia, admin, {})).items).toHaveLength(4);
  });

  it('swaps the posters of an earlier seed for the photos, once, keeping history and drafts', async () => {
    const uow = new MemoryUnitOfWork();
    const invoker = new Invoker(buildRegistry(), uow);
    const admin = adminOf();
    await uow.run(admin, (ctx) => ctx.forms.insert(probeForm(FORM)));

    // What the poster-era seed left: four PNG posters, both items published with their ids and
    // texts, and an editor's unpublished change to the article.
    const posters = Object.fromEntries(
      await Promise.all(
        DEMO_IMAGES.map(async (image) => {
          const m = await invoker.run(useCases.uploadMedia, admin, {
            filename: image.replaces.filename,
            contentType: 'image/png',
            bytes: bytesToBase64(pngHeader()),
          });
          return [image.key, m.id];
        })
      )
    ) as typeof media;
    const page = await publishProbePage(
      invoker,
      admin,
      FORM,
      posterEra(demoPage({ formId: FORM, media: posters }))
    );
    const article = await publishProbePage(
      invoker,
      admin,
      FORM,
      posterEra(demoArticle({ formId: FORM, media: posters, pageId: page.id }))
    );
    const published = (await invoker.run(useCases.getItem, admin, { itemId: article.id })).revision;
    const edited = posterEra(published.document);
    const editedAlt = { nl: 'Door de redactie herschreven', en: 'Rewritten by the editors' };
    const imageBlock = edited.blocks.find((b) => b.type === 'image')!;
    (imageBlock.props as { alt: unknown }).alt = editedAlt;
    await invoker.run(useCases.updateItem, admin, {
      itemId: article.id,
      baseRevisionId: published.id,
      document: edited,
    });

    const seeded = await seedDemoContent(invoker, admin, { formId: FORM, load: jpegHeader });
    expect(seeded.created).toBe(false);
    expect(seeded.upgraded.map((u) => [u.item.id, u.published])).toEqual([
      [page.id, true],
      [article.id, false],
    ]);

    const photoIds = new Set(
      (await invoker.run(useCases.listMedia, admin, {})).items
        .filter((m) => DEMO_IMAGES.some((i) => i.filename === m.filename))
        .map((m) => m.id)
    );
    expect(photoIds.size).toBe(4);
    const latest = async (itemId: string) =>
      JSON.stringify((await invoker.run(useCases.getItem, admin, { itemId })).revision.document);
    for (const item of [page, article]) {
      const json = await latest(item.id);
      for (const id of Object.values(posters)) expect(json).not.toContain(id);
      for (const image of DEMO_IMAGES) expect(json).not.toContain(image.replaces.alt.nl);
      expect(json).not.toContain('Mycel-seed');
    }
    // The page went live with the photos; the article's live revision still has the posters,
    // and the editor's text survived in the new draft.
    const livePage = await invoker.run(useCases.getItem, admin, {
      itemId: page.id,
      revisionId: seeded.upgraded[0]!.item.publication[0]!.publishedRevisionId!,
    });
    // The main image's alt (`heroAlt`) is swapped like any other use of a photo.
    expect(JSON.stringify(livePage.revision.document)).toContain(DEMO_IMAGES[1]!.alt.nl);
    const liveArticle = seeded.upgraded[1]!.item.publication[0]!;
    expect(liveArticle.publishedRevisionId).toBe(published.id);
    expect(liveArticle.hasUnpublishedChanges).toBe(true);
    expect(await latest(article.id)).toContain(editedAlt.nl);

    const again = await seedDemoContent(invoker, admin, { formId: FORM, load: jpegHeader });
    expect(again).toMatchObject({ created: false, upgraded: [] });
    expect((await invoker.run(useCases.listMedia, admin, {})).items).toHaveLength(8);
  });
});
