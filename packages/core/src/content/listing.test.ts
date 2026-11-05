// Where a translation stands, which a list reports and filters on. Which items a list matches and
// in what order runs over both adapters in `packages/db/src/adapter-rules.test.ts`.

import { describe, expect, it } from 'vitest';
import { FakeClock, MemoryLogger, MemoryUnitOfWork, adminOf } from '../testing/index.js';
import { Invoker } from '../invoke.js';
import { buildRegistry, useCases } from '../use-cases.js';
import { MAX_TRANSLATION_WALK, TRANSLATION_TOO_BROAD, translationState } from './listing.js';
import { ContentDocument } from './model.js';

describe('translationState', () => {
  const doc = ContentDocument.parse({
    type: 'page',
    title: { nl: 'Titel', en: 'Title' },
    lead: { nl: 'Kern' },
    defaultLocale: 'nl',
    locales: ['nl', 'en'],
    blocks: [],
  });
  it('names a locale missing, behind or ok', () => {
    expect(translationState(doc, 'nl')).toBe('ok');
    expect(translationState(doc, 'en')).toBe('behind');
    expect(translationState(doc, 'de')).toBe('missing');
  });
});

describe('a list without the document of a row', () => {
  it('keeps the row without its details, and logs it', async () => {
    const log = new MemoryLogger();
    const uow = new MemoryUnitOfWork({ clock: new FakeClock(), log });
    const invoker = new Invoker(buildRegistry(), uow);
    const { item } = await invoker.run(useCases.createItem, adminOf(), {
      slug: 'kapot',
      document: {
        type: 'article',
        defaultLocale: 'nl',
        locales: ['nl'],
        title: { nl: 'Kapot' },
        tags: ['een'],
        blocks: [],
      },
    });
    // What Postgres answers for a document that no longer validates, or an item just gone.
    const list = (input: Parameters<typeof useCases.listItems.handler>[1]) =>
      uow.run(adminOf(), (ctx) =>
        useCases.listItems.handler(
          { ...ctx, content: { ...ctx.content, latestDocuments: async () => new Map() } },
          input
        )
      );

    const { items } = await list({});
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id: item.id, authorIds: [], sectionId: null, tags: [] });
    expect(items[0]!.translations).toEqual({});
    expect(log.lines).toContainEqual(
      expect.objectContaining({
        level: 'warn',
        message: 'content.list.document_unreadable',
        fields: expect.objectContaining({ itemId: item.id }),
      })
    );
    // Where a translation stands cannot be said, so the filter does not claim it.
    const filtered = await list({ translation: { state: 'missing', locales: ['de'] } });
    expect(filtered).toMatchObject({ items: [], total: 0 });
    // One line per walk, however many rows it could not read, and none per row of them.
    const unreadable = log.lines.filter((l) => l.message.startsWith('content.list.document'));
    expect(unreadable.map((l) => l.message)).toEqual([
      'content.list.document_unreadable',
      'content.list.documents_unreadable',
    ]);
    expect(unreadable[1]?.fields).toMatchObject({ count: 1 });
  });
});

describe('the translation filter', () => {
  const behindInEnglish = { translation: { state: 'behind' as const, locales: ['en'] } };

  async function siteOf(count: number) {
    const clock = new FakeClock();
    const uow = new MemoryUnitOfWork({ clock, log: new MemoryLogger() });
    const invoker = new Invoker(buildRegistry(), uow);
    const ids: string[] = [];
    for (let n = 0; n < count; n++) {
      clock.advance(1000);
      const { item } = await invoker.run(useCases.createItem, adminOf(), {
        slug: `stuk-${n}`,
        document: {
          type: 'page',
          defaultLocale: 'nl',
          locales: ['nl', 'en'],
          title: { nl: `Stuk ${n}` },
          blocks: [],
        },
      });
      ids.push(item.id);
    }
    return { clock, uow, invoker, ids };
  }

  it('counts each item once when one is saved between two batches', async () => {
    // One more than a batch holds, with the last-saved order the admin list opens on.
    const { clock, uow, ids } = await siteOf(101);
    const walked = await uow.run(adminOf(), (ctx) => {
      let saved = false;
      return useCases.listItems.handler(
        {
          ...ctx,
          content: {
            ...ctx.content,
            // A colleague saves the batch's last item: the cursor of a walk in this order.
            async list(filter, position) {
              const batch = await ctx.content.list(filter, position);
              const last = batch.rows.at(-1);
              if (!saved && last) {
                saved = true;
                clock.advance(1000);
                await ctx.content.save({ ...last, updatedAt: clock.now() });
              }
              return batch;
            },
          },
        },
        { ...behindInEnglish, sort: 'updated', limit: 100 }
      );
    });
    expect(walked.total).toBe(101);
    expect(new Set(walked.items.map((i) => i.id)).size).toBe(100);
    // Still in the order asked for, last saved first, though the walk ran on the id.
    expect(walked.items[0]?.id).toBe(ids[100]);
    expect(walked.items[99]?.id).toBe(ids[1]);
  });

  it('reads up to its bound, and past it refuses before reading a document', async () => {
    const { uow, invoker } = await siteOf(MAX_TRANSLATION_WALK);
    const atBound = await invoker.run(useCases.listItems, adminOf(), behindInEnglish);
    expect(atBound.total).toBe(MAX_TRANSLATION_WALK);

    await invoker.run(useCases.createItem, adminOf(), {
      slug: 'een-te-veel',
      document: {
        type: 'page',
        defaultLocale: 'nl',
        locales: ['nl'],
        title: { nl: 'Een te veel' },
        blocks: [],
      },
    });
    let documentsRead = 0;
    const refused = uow.run(adminOf(), (ctx) =>
      useCases.listItems.handler(
        {
          ...ctx,
          content: {
            ...ctx.content,
            latestDocuments(ids) {
              documentsRead += ids.length;
              return ctx.content.latestDocuments(ids);
            },
          },
        },
        behindInEnglish
      )
    );
    await expect(refused).rejects.toMatchObject({
      code: 'invalid_input',
      issues: [
        {
          path: 'translation',
          message: TRANSLATION_TOO_BROAD,
          params: { limit: String(MAX_TRANSLATION_WALK) },
        },
      ],
    });
    expect(documentsRead).toBe(0);
    // Narrowed by another filter, the same site answers.
    const narrowed = await invoker.run(useCases.listItems, adminOf(), {
      ...behindInEnglish,
      q: 'stuk-4242',
    });
    expect(narrowed.total).toBe(1);
  }, 60_000);
});
