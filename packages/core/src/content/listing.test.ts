// Where a translation stands, which a list reports and filters on. Which items a list matches and
// in what order runs over both adapters in `packages/db/src/adapter-rules.test.ts`.

import { describe, expect, it } from 'vitest';
import { FakeClock, MemoryLogger, MemoryUnitOfWork, adminOf } from '../testing/index.js';
import { Invoker } from '../invoke.js';
import { buildRegistry, useCases } from '../use-cases.js';
import { translationState } from './listing.js';
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
  });
});
