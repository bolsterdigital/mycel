// Status follows the published snapshot, including a non-default locale, never a draft byline.
import { expect, it } from 'vitest';
import { Invoker, buildRegistry, systemPrincipal, useCases } from '@mycel/core';
import { MemoryUnitOfWork, TENANT } from '@mycel/core/testing';
import { pageStatuses, peopleDirectory, groupDirectory } from './directory.js';

it('walks beyond the first directory page and preserves ordered groups', async () => {
  const invoker = new Invoker(buildRegistry(), new MemoryUnitOfWork());
  const principal = systemPrincipal(TENANT, 'test');
  for (let i = 0; i < 101; i++) {
    const person = await invoker.run(useCases.createPerson, principal, {
      name: `Person ${i}`,
      slug: `person-${i}`,
    });
    await invoker.run(useCases.createPersonGroup, principal, {
      name: { en: `Group ${i}` },
      order: i,
      personIds: [person.id],
    });
  }
  expect(await peopleDirectory(principal, invoker)).toHaveLength(101);
  expect((await groupDirectory(principal, invoker)).map((g) => g.order)).toEqual(
    Array.from({ length: 101 }, (_, i) => i)
  );
});
it('uses published authors even after a draft changes them, and obeys site off', async () => {
  const invoker = new Invoker(buildRegistry(), new MemoryUnitOfWork());
  const principal = systemPrincipal(TENANT, 'test');
  const a = await invoker.run(useCases.createPerson, principal, {
    name: 'Published',
    slug: 'published',
  });
  const b = await invoker.run(useCases.createPerson, principal, { name: 'Draft', slug: 'draft' });
  const created = await invoker.run(useCases.createItem, principal, {
    slug: 'story',
    document: {
      type: 'article',
      defaultLocale: 'en',
      locales: ['en'],
      title: { en: 'Story' },
      authorIds: [a.id],
      blocks: [],
    },
  });
  await invoker.run(useCases.publishItem, principal, {
    itemId: created.item.id,
    revisionId: created.revision.id,
    locale: 'en',
  });
  if (created.revision.document.type !== 'article') throw new Error('article expected');
  await invoker.run(useCases.updateItem, principal, {
    itemId: created.item.id,
    baseRevisionId: created.revision.id,
    document: { ...created.revision.document, authorIds: [b.id] },
  });
  expect(await pageStatuses(principal, [a, b], invoker)).toEqual({
    [a.id]: 'enabled',
    [b.id]: 'no-articles',
  });
  await invoker.run(useCases.updateSiteGeneral, principal, {
    baseVersion: 0,
    general: { timeZone: 'UTC', personPages: 'off' },
  });
  expect(await pageStatuses(principal, [a, b], invoker)).toEqual({
    [a.id]: 'site-off',
    [b.id]: 'site-off',
  });
});
