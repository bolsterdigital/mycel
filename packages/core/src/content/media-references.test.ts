// Media references of blocks in memory (TODO #8b2, docs/reference/media.md § Usages): a save
// checks every image slot against the tenant's media (present, not deleted, an image), records
// one usage per (media, block) under its revision or pattern, refuses when the usage write falls
// short, and keeps historical revisions' usages so `media.delete` refuses. Patterns protect their
// media under `pattern:<id>`. Save and delete serialise on the media lock in both orders. The
// database conformance repeats the refs, the rollback and the races against Postgres.

import { beforeEach, describe, expect, it } from 'vitest';
import { UseCaseError } from '../errors.js';
import { Invoker } from '../invoke.js';
import { EXAMPLE_PNG } from '../media/service.js';
import { systemPrincipal } from '../principal.js';
import {
  FakeClock,
  MemoryBlobStore,
  MemoryUnitOfWork,
  overrideMedia,
  pauseMedia,
  expectCode,
  TENANT,
} from '../testing/index.js';
import { bytesToBase64 } from '../util/bytes.js';
import { buildRegistry, useCases } from '../use-cases.js';
import { longReadPattern, photoStoryPattern } from './patterns.js';

const OTHER = '01900000-0000-7000-8000-00000000bbbb';
const system = systemPrincipal(TENANT, 'test');
const other = systemPrincipal(OTHER, 'test');
const UNKNOWN = '01900000-0000-7000-8000-00000000dddd';

const para = (text: string) => ({
  type: 'doc' as const,
  content: [{ type: 'paragraph' as const, content: [{ type: 'text' as const, text }] }],
});
const text = (id: string) => ({
  id,
  type: 'rich-text' as const,
  version: 1 as const,
  props: { content: { nl: para(`${id} nl`), en: para(`${id} en`) } },
});
const twoParagraphs = (id: string) => ({
  id,
  type: 'rich-text' as const,
  version: 1 as const,
  props: {
    content: Object.fromEntries(
      ['nl', 'en'].map((l) => [
        l,
        {
          type: 'doc' as const,
          content: [...para(`${id} 1 ${l}`).content, ...para(`${id} 2 ${l}`).content],
        },
      ])
    ),
  },
});
const image = (id: string, mediaId: string) => ({
  id,
  type: 'image' as const,
  version: 1 as const,
  props: { mediaId, decorative: false, alt: { nl: 'Een foto', en: 'A photo' } },
});
const quote = (id: string) => ({
  id,
  type: 'quote' as const,
  version: 1 as const,
  props: { text: { nl: 'Citaat', en: 'Quote' }, attribution: { name: 'Sam' } },
});

/** Whether `p` is still pending after the event loop had a few turns to settle it. */
async function pending(p: Promise<unknown>): Promise<boolean> {
  let settled = false;
  p.then(
    () => (settled = true),
    () => (settled = true)
  );
  await new Promise((r) => setTimeout(r, 20));
  return !settled;
}

describe('media references of blocks', () => {
  let uow: MemoryUnitOfWork;
  let invoker: Invoker;
  let photo = '';
  let photo2 = '';
  let pdf = '';
  let foreign = '';
  let slug = 0;

  const upload = async (principal = system, contentType = 'image/png', bytes = EXAMPLE_PNG) =>
    (
      await invoker.run(useCases.uploadMedia, principal, {
        filename: contentType === 'application/pdf' ? 'r.pdf' : 'p.png',
        contentType: contentType as 'image/png',
        bytes,
      })
    ).id;
  const page = (blocks: object[], u: Invoker = invoker) =>
    u.run(useCases.createItem, system, {
      slug: `page-${++slug}`,
      document: {
        type: 'page',
        defaultLocale: 'nl',
        locales: ['nl', 'en'],
        title: { nl: 'Titel', en: 'Title' },
        blocks: blocks as never,
      },
    });
  const usages = (mediaId: string) =>
    [...uow.store.for(TENANT).mediaUsages.values()]
      .filter((u) => u.mediaId === mediaId)
      .map((u) => `${u.ref} ${u.blockId}`)
      .sort();
  const remove = (id: string) => invoker.run(useCases.deleteMedia, system, { id });

  beforeEach(async () => {
    const clock = new FakeClock();
    uow = new MemoryUnitOfWork({ clock, blobs: new MemoryBlobStore(clock) });
    invoker = new Invoker(buildRegistry(), uow);
    photo = await upload();
    photo2 = await upload();
    pdf = await upload(
      system,
      'application/pdf',
      bytesToBase64(new TextEncoder().encode('%PDF-1.7\n'))
    );
    foreign = await upload(other);
  });

  it('records one usage per image block under the revision', async () => {
    const { item, revision } = await page([image('a', photo), text('t'), image('b', photo)]);
    expect(usages(photo)).toEqual([
      `item:${item.id}:rev:${revision.id} a`,
      `item:${item.id}:rev:${revision.id} b`,
    ]);
    expect((await invoker.run(useCases.getMedia, system, { id: photo })).usageCount).toBe(2);
  });

  it('records a hero image under the hero block', async () => {
    const { item, revision } = await page([
      {
        id: 'hero',
        type: 'hero',
        version: 1,
        props: {
          variant: 'cover',
          title: { nl: 'Kop', en: 'Head' },
          image: { mediaId: photo, decorative: true, alt: null },
        },
      },
    ]);
    expect(usages(photo)).toEqual([`item:${item.id}:rev:${revision.id} hero`]);
  });

  it('refuses unknown, foreign, deleted and non-image media with the same kind of issue', async () => {
    await expectCode(
      page([image('a', UNKNOWN)]),
      'invalid_input',
      'content.reference.media-unknown'
    );
    // Another tenant's image is unknown here, with the same message as an id that never existed.
    await expectCode(
      page([image('a', foreign)]),
      'invalid_input',
      `content.reference.media-unknown:${foreign}`
    );
    await expectCode(page([image('a', pdf)]), 'invalid_input', 'content.reference.media-not-image');
    await remove(photo2);
    await expectCode(
      page([image('a', photo2)]),
      'invalid_input',
      'content.reference.media-unknown'
    );
    expect(uow.store.for(TENANT).items.size).toBe(0);
  });

  it('keeps the usages of older revisions: delete refuses while any revision uses the image', async () => {
    const { item, revision } = await page([image('a', photo), text('t')]);
    const next = await invoker.run(useCases.removeBlock, system, {
      itemId: item.id,
      baseRevisionId: revision.id,
      blockId: 'a',
    });
    expect(next.revision.document.blocks.map((b) => b.id)).toEqual(['t']);
    expect(usages(photo)).toEqual([`item:${item.id}:rev:${revision.id} a`]);
    await expectCode(remove(photo), 'conflict', 'media.in_use');
  });

  it('checks media again at publish: a revision whose image vanished is not published', async () => {
    const { item, revision } = await page([image('a', photo)]);
    // Not reachable through use cases (delete refuses); this is the worker's fresh check.
    uow.store.for(TENANT).media.get(photo)!.deletedAt = new Date();
    await expectCode(
      invoker.run(useCases.publishItem, system, {
        itemId: item.id,
        revisionId: revision.id,
        locale: 'nl',
      }),
      'invalid_input',
      'content.reference.media-unknown'
    );
  });

  it('refuses a save whose usage write records less than it asked for', async () => {
    const short = new Invoker(
      buildRegistry(),
      overrideMedia(uow, (media) => ({
        replaceUsages: async (ref, list) => (await media.replaceUsages(ref, list)) - 1,
      }))
    );
    await expectCode(
      page([image('a', photo)], short),
      'invalid_input',
      'content.reference.media-unrecorded'
    );
  });

  it('keeps both locales and refs when an image between two texts is moved, removed or split around', async () => {
    const { item, revision } = await page([text('a'), image('img', photo), twoParagraphs('b')]);
    const split = await invoker.run(useCases.splitInsertBlock, system, {
      itemId: item.id,
      baseRevisionId: revision.id,
      blockId: 'b',
      at: { nl: 1, en: 1 },
      block: quote('q'),
    });
    const [, , first, q, second] = split.revision.document.blocks;
    expect([first!.id, q!.id]).toEqual(['b', 'q']);
    for (const half of [first!, second!])
      expect(half.type === 'rich-text' && Object.keys(half.props.content).sort()).toEqual([
        'en',
        'nl',
      ]);
    expect(usages(photo)).toContain(`item:${item.id}:rev:${split.revision.id} img`);
    const removed = await invoker.run(useCases.removeBlock, system, {
      itemId: item.id,
      baseRevisionId: split.revision.id,
      blockId: 'img',
    });
    expect(removed.merged).toEqual([{ from: 'b', into: 'a' }]);
    const merged = removed.revision.document.blocks[0]!;
    expect(merged.type === 'rich-text' && Object.keys(merged.props.content).sort()).toEqual([
      'en',
      'nl',
    ]);
    // Earlier revisions keep their usages; the new one has none.
    expect(usages(photo)).toEqual(
      [
        `item:${item.id}:rev:${revision.id} img`,
        `item:${item.id}:rev:${split.revision.id} img`,
      ].sort()
    );
    const moved = await invoker.run(useCases.insertBlock, system, {
      itemId: item.id,
      baseRevisionId: removed.revision.id,
      block: image('img2', photo),
      place: { at: 'end' },
    });
    expect(usages(photo)).toContain(`item:${item.id}:rev:${moved.revision.id} img2`);
  });

  describe('patterns', () => {
    const pattern = (blocks: object[]) =>
      invoker.run(useCases.createPattern, system, {
        name: { nl: 'Fotoverhaal' },
        intendedType: 'article',
        blocks: blocks as never,
      });

    it('records usages under pattern:<id> and replaces only its own on update', async () => {
      const a = await pattern([image('a', photo)]);
      const b = await pattern([image('b', photo)]);
      expect(usages(photo)).toEqual(
        [`pattern:${a.id} ${a.blocks[0]!.id}`, `pattern:${b.id} ${b.blocks[0]!.id}`].sort()
      );
      await invoker.run(useCases.updatePattern, system, {
        patternId: a.id,
        name: { nl: 'Leeg' },
        intendedType: 'article',
        blocks: [text('t')] as never,
      });
      expect(usages(photo)).toEqual([`pattern:${b.id} ${b.blocks[0]!.id}`]);
      await expectCode(remove(photo), 'conflict', 'media.in_use');
      await invoker.run(useCases.updatePattern, system, {
        patternId: b.id,
        name: { nl: 'Leeg' },
        intendedType: 'article',
        blocks: [],
      });
      await expect(remove(photo)).resolves.toMatchObject({ id: photo });
    });

    it('checks pattern references like a document', async () => {
      await expectCode(
        pattern([image('a', foreign)]),
        'invalid_input',
        'content.reference.media-unknown'
      );
      await expectCode(
        pattern([image('a', pdf)]),
        'invalid_input',
        'content.reference.media-not-image'
      );
      expect(uow.store.for(TENANT).patterns.size).toBe(0);
    });

    it('copies into an item with new block ids and its own usages; a later pattern change leaves the item', async () => {
      const p = await pattern([image('a', photo)]);
      const { item, revision } = await invoker.run(useCases.createItem, system, {
        slug: 'from-pattern',
        patternId: p.id,
        document: {
          type: 'article',
          defaultLocale: 'nl',
          locales: ['nl', 'en'],
          title: { nl: 'Titel', en: 'Title' },
          blocks: [],
        },
      });
      const copied = revision.document.blocks[0]!.id;
      expect(copied).not.toBe(p.blocks[0]!.id);
      await invoker.run(useCases.updatePattern, system, {
        patternId: p.id,
        name: { nl: 'Leeg' },
        intendedType: 'article',
        blocks: [],
      });
      expect(usages(photo)).toEqual([`item:${item.id}:rev:${revision.id} ${copied}`]);
      const again = await invoker.run(useCases.getItem, system, { itemId: item.id });
      expect(again.revision.document.blocks.map((b) => b.type)).toEqual(['image']);
    });

    it('ships long-read and photo-story as factories whose output saves and applies', async () => {
      const long = longReadPattern();
      expect(long.blocks.map((b) => b.type)).toEqual(['rich-text', 'quote', 'rich-text']);
      const saved = await invoker.run(useCases.createPattern, system, long);
      expect(saved.blocks.every((b) => b.id)).toBe(true);

      expect(() => photoStoryPattern([])).toThrow();
      const story = photoStoryPattern([
        { mediaId: photo, decorative: false, alt: { nl: 'Plein', en: 'Square' } },
        { mediaId: photo2, decorative: true, alt: null, caption: { nl: 'Later', en: 'Later' } },
      ]);
      expect(story.blocks.map((b) => b.type)).toEqual(['hero', 'rich-text', 'image', 'rich-text']);
      const storyPattern = await invoker.run(useCases.createPattern, system, story);
      expect(usages(photo2)).toEqual([`pattern:${storyPattern.id} ${storyPattern.blocks[2]!.id}`]);
      // The tenant check runs at save: another tenant's photo is unknown.
      await expectCode(
        invoker.run(
          useCases.createPattern,
          system,
          photoStoryPattern([{ mediaId: foreign, decorative: true, alt: null }])
        ),
        'invalid_input',
        'content.reference.media-unknown'
      );
    });
  });

  describe("the document's own images: featured and share image", () => {
    const withImages = (images: { featuredImageId?: string; imageId?: string }, type = 'page') =>
      invoker.run(useCases.createItem, system, {
        slug: `doc-${++slug}`,
        document: {
          type,
          defaultLocale: 'nl',
          locales: ['nl'],
          title: { nl: 'Titel' },
          blocks: [],
          ...(images.featuredImageId ? { featuredImageId: images.featuredImageId } : {}),
          seo: images.imageId ? { imageId: images.imageId } : {},
        } as never,
      });

    it('records both under the revision, in their own slots, next to a block using the same image', async () => {
      const { item, revision } = await invoker.run(useCases.createItem, system, {
        slug: 'both',
        document: {
          type: 'article',
          defaultLocale: 'nl',
          locales: ['nl'],
          title: { nl: 'Titel' },
          blocks: [
            { ...image('a', photo), props: { ...image('a', photo).props, alt: { nl: 'x' } } },
          ],
          featuredImageId: photo,
          seo: { imageId: photo2 },
        },
      });
      const ref = `item:${item.id}:rev:${revision.id}`;
      expect(usages(photo)).toEqual([`${ref} a`, `${ref} doc:featured`]);
      expect(usages(photo2)).toEqual([`${ref} doc:seo`]);
      await expectCode(remove(photo2), 'conflict', 'media.in_use');
      // The read model has one document-level row per image, next to the block's.
      const refs = uow.store.for(TENANT).blockRefs.get(revision.id) ?? [];
      expect(refs.filter((r) => r.type === 'media').map((r) => `${r.blockId} ${r.refId}`)).toEqual([
        `a ${photo}`,
        `null ${photo}`,
        `null ${photo2}`,
      ]);
    });

    it('refuses an unknown, foreign, deleted or non-image id at its own path', async () => {
      const refused = async (p: Promise<unknown>, path: string, message: string) =>
        expect(p).rejects.toSatisfy(
          (e) =>
            e instanceof UseCaseError &&
            e.issues.some((i) => i.path === path && i.message.startsWith(message))
        );
      await refused(
        withImages({ featuredImageId: UNKNOWN }),
        'featuredImageId',
        'content.reference.media-unknown'
      );
      await refused(
        withImages({ imageId: foreign }),
        'seo.imageId',
        `content.reference.media-unknown:${foreign}`
      );
      await refused(
        withImages({ featuredImageId: pdf }),
        'featuredImageId',
        'content.reference.media-not-image'
      );
      await remove(photo2);
      await refused(
        withImages({ imageId: photo2 }, 'article'),
        'seo.imageId',
        'content.reference.media-unknown'
      );
      expect(uow.store.for(TENANT).items.size).toBe(0);
    });

    it('drops the usage from the next revision when the image is taken off, and keeps history', async () => {
      const { item, revision } = await withImages({ featuredImageId: photo });
      const next = await invoker.run(useCases.updateItem, system, {
        itemId: item.id,
        baseRevisionId: revision.id,
        document: { ...revision.document, featuredImageId: undefined },
      });
      expect(next.revision.document.featuredImageId).toBeUndefined();
      expect(usages(photo)).toEqual([`item:${item.id}:rev:${revision.id} doc:featured`]);
    });

    it('checks again at publish: a share image that vanished stops the publication', async () => {
      const { item, revision } = await withImages({ imageId: photo });
      uow.store.for(TENANT).media.get(photo)!.deletedAt = new Date();
      await expectCode(
        invoker.run(useCases.publishItem, system, {
          itemId: item.id,
          revisionId: revision.id,
          locale: 'nl',
        }),
        'invalid_input',
        'content.reference.media-unknown'
      );
    });

    it('publishes the share image, falling back to the featured image', async () => {
      const publish = async (images: { featuredImageId?: string; imageId?: string }) => {
        const { item, revision } = await withImages(images);
        await invoker.run(useCases.publishItem, system, {
          itemId: item.id,
          revisionId: revision.id,
          locale: 'nl',
        });
        return invoker.run(useCases.getPublished, system, { type: 'page', slug: item.slug });
      };
      expect(await publish({ featuredImageId: photo })).toMatchObject({
        featuredImageId: photo,
        seo: { imageId: photo, title: null, description: null },
      });
      expect(await publish({ featuredImageId: photo, imageId: photo2 })).toMatchObject({
        featuredImageId: photo,
        seo: { imageId: photo2 },
      });
      expect(await publish({})).toMatchObject({ featuredImageId: null, seo: { imageId: null } });
    });
  });

  describe('save and delete on the media lock', () => {
    it('save first: the delete waits and then refuses', async () => {
      const paused = pauseMedia(uow, 'replaceUsages');
      const save = page([image('a', photo)], new Invoker(buildRegistry(), paused.uow));
      await paused.reached;
      const del = remove(photo);
      expect(await pending(del)).toBe(true);
      paused.release();
      await expect(save).resolves.toBeTruthy();
      await expectCode(del, 'conflict', 'media.in_use');
    });

    it('delete first: the save waits and then refuses, writing nothing', async () => {
      const paused = pauseMedia(uow, 'softDelete');
      const del = new Invoker(buildRegistry(), paused.uow).run(useCases.deleteMedia, system, {
        id: photo,
      });
      await paused.reached;
      const save = page([image('a', photo)]);
      expect(await pending(save)).toBe(true);
      paused.release();
      await expect(del).resolves.toMatchObject({ id: photo });
      await expectCode(save, 'invalid_input', 'content.reference.media-unknown');
      expect(uow.store.for(TENANT).items.size).toBe(0);
      expect(usages(photo)).toEqual([]);
    });
  });
});
