// "Read more" (MY-304) through Postgres: the two `publishedCards` reads behind it, with the
// section, `exclude`, `restricted` and locale filters of the adapter and its `newest` order, on a
// tenant of its own so other suites' articles cannot fill the row. The cases one by one are the
// memory suite (packages/core/src/content/published/read-more.test.ts); this proves the adapter
// answers the same. Rejected: a case in `content.test.ts`, which stands at the file-size limit.

import { describe, expect, it } from 'vitest';
import { Invoker, anonymousPrincipal, buildRegistry, useCases } from '@mycel/core';
import {
  FakeClock,
  FakeDns,
  FakeInputHasher,
  FakeSigner,
  MemoryLogger,
  adminOf,
  memoryPlatform,
  runSuffix,
} from '@mycel/core/testing';
import { createDb, createUnitOfWork, uuidv7Ids } from './index.js';
import { requireDatabase, testTenant } from './testing.js';

const { skip, operator: operatorUrl, app: appUrl } = requireDatabase('app');
const HOUR = 60 * 60 * 1000;

describe.skipIf(skip)('read more in Postgres (MY-304)', () => {
  it('picks the section first, fills up, and leaves out itself, drafts and other locales', async () => {
    const operatorDb = createDb(operatorUrl);
    const appDb = createDb(appUrl);
    const clock = new FakeClock(new Date(Date.now() - 48 * HOUR));
    const uow = createUnitOfWork(appDb, {
      clock,
      log: new MemoryLogger(),
      ids: uuidv7Ids,
      signer: new FakeSigner(),
      inputHasher: new FakeInputHasher(),
      dns: new FakeDns(),
      platform: memoryPlatform,
    });
    const invoker = new Invoker(buildRegistry(), uow);
    try {
      const run = runSuffix();
      const tenant = (await testTenant(operatorDb, `rm-${run}`, { locales: ['nl', 'en'] })).id;
      const admin = adminOf(tenant);
      const section = (
        await invoker.run(useCases.createSection, admin, { slug: 'stad', title: { nl: 'Stad' } })
      ).id;
      const item = async (slug: string, over: Record<string, unknown> = {}, locales = ['nl']) => {
        clock.advance(HOUR);
        const { item, revision } = await invoker.run(useCases.createItem, admin, {
          slug,
          document: {
            type: 'article',
            defaultLocale: 'nl',
            locales: ['nl', 'en'],
            title: { nl: `NL ${slug}`, en: `EN ${slug}` },
            blocks: [],
            ...over,
          } as never,
        });
        for (const locale of locales)
          await invoker.run(useCases.publishItem, admin, {
            itemId: item.id,
            revisionId: revision.id,
            locale,
          });
      };
      await item('stad-oud', { sectionId: section });
      await item('los-oud');
      await item('leden', {
        sectionId: section,
        access: { level: 'members', teaser: 'lead' },
        lead: { nl: 'Voor leden.' },
      });
      await item('engels', { sectionId: section }, ['en']);
      await item('concept', { sectionId: section }, []);
      await item('los-nieuw');
      await item('stuk', { sectionId: section });
      const read = await invoker.run(
        useCases.getPublished,
        anonymousPrincipal(tenant, ['content:read']),
        { type: 'article', slug: 'stuk', locale: 'nl' }
      );
      expect(read.readMore?.map((e) => [e.slug, e.restricted])).toEqual([
        ['leden', true],
        ['stad-oud', false],
        ['los-nieuw', false],
      ]);
    } finally {
      await Promise.all([operatorDb.destroy(), appDb.destroy()]);
    }
  });
});
