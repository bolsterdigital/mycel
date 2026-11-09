// Pinned author references are filtered by SQL, while locale and public projection are core's
// responsibility. Exercise both with real RLS; rejected: proving this only with the memory find.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Invoker, anonymousPrincipal, buildRegistry, useCases } from '@mycel/core';
import {
  adminOf,
  FakeClock,
  FakeDns,
  FakeInputHasher,
  FakeSigner,
  MemoryLogger,
  memoryPlatform,
  runSuffix,
} from '@mycel/core/testing';
import { createDb, createUnitOfWork, uuidv7Ids } from '../index.js';
import { closeTenantWork, migrateSchema, requireDatabase, testTenant } from '../testing.js';

const { skip, operator, app } = requireDatabase('app');
describe.skipIf(skip)('public people through Postgres', () => {
  const owner = createDb(operator);
  const db = createDb(app);
  const invoker = new Invoker(
    buildRegistry(),
    createUnitOfWork(db, {
      clock: new FakeClock(),
      log: new MemoryLogger(),
      ids: uuidv7Ids,
      signer: new FakeSigner(),
      inputHasher: new FakeInputHasher(),
      dns: new FakeDns(),
      platform: memoryPlatform,
    })
  );
  let tenant = '';
  let foreign = '';
  beforeAll(async () => {
    await migrateSchema(operator);
    const run = runSuffix();
    tenant = (await testTenant(owner, `people-public-${run}`, { locales: ['nl', 'en'] })).id;
    foreign = (await testTenant(owner, `people-other-${run}`)).id;
  });
  afterAll(async () => {
    await closeTenantWork(owner, [tenant, foreign]);
    await db.destroy();
    await owner.destroy();
  });
  it('reads pinned authors across locales, excludes restricted cards and respects tenant boundaries', async () => {
    const admin = adminOf(tenant);
    const visitor = anonymousPrincipal(tenant, ['content:read']);
    const sam = await invoker.run(useCases.createPerson, admin, {
      slug: 'sam',
      name: 'Sam',
      email: 'internal-only@example.org',
    });
    const lee = await invoker.run(useCases.createPerson, admin, { slug: 'lee', name: 'Lee' });
    const created = await invoker.run(useCases.createItem, admin, {
      slug: 'pinned-story',
      document: {
        type: 'article',
        defaultLocale: 'nl',
        locales: ['nl', 'en'],
        title: { nl: 'Published NL', en: 'Published EN' },
        authorIds: [sam.id],
        blocks: [],
      },
    });
    await invoker.run(useCases.publishItem, admin, {
      itemId: created.item.id,
      revisionId: created.revision.id,
      locale: 'nl',
    });
    if (created.revision.document.type !== 'article') throw new Error('article expected');
    const changed = await invoker.run(useCases.updateItem, admin, {
      itemId: created.item.id,
      baseRevisionId: created.revision.id,
      document: {
        ...created.revision.document,
        title: { nl: 'Private new title', en: 'Private new title' },
        authorIds: [lee.id],
        lead: { nl: 'Private lead', en: 'Private lead' },
        access: { level: 'members', teaser: 'lead' },
      },
    });
    // EN has another pinned author and restricted access; NL must retain its original public card.
    await invoker.run(useCases.publishItem, admin, {
      itemId: created.item.id,
      revisionId: changed.revision.id,
      locale: 'en',
    });
    const profile = await invoker.run(useCases.getPublicPerson, visitor, {
      slug: 'sam',
      locale: 'nl',
    });
    expect(profile.articles.map((a) => a.title)).toEqual(['Published NL']);
    expect(JSON.stringify(profile)).not.toMatch(/internal-only|Private/);
    expect(
      (await invoker.run(useCases.getPublicPerson, visitor, { slug: 'sam', locale: 'en' })).articles
    ).toEqual([]);
    const restrictedOnly = await invoker.run(useCases.getPublicPerson, visitor, {
      slug: 'lee',
      locale: 'en',
    });
    expect(restrictedOnly.articles).toEqual([]);
    expect(restrictedOnly.total).toBe(0);
    await expect(
      invoker.run(useCases.getPublicPerson, anonymousPrincipal(foreign, ['content:read']), {
        slug: 'sam',
        locale: 'nl',
      })
    ).rejects.toMatchObject({ code: 'not_found' });
    await invoker.run(useCases.unpublishItem, admin, { itemId: created.item.id, locale: 'nl' });
    await expect(
      invoker.run(useCases.getPublicPerson, visitor, { slug: 'sam', locale: 'nl' })
    ).rejects.toMatchObject({ code: 'not_found' });
  });
});
