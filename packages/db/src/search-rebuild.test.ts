// The rebuild of the site search index (`reindexSearch`, `mycel search rebuild`, and the import of
// an archive from before 0055). A tenant whose index rows are gone, as for items published before
// the migration, finds nothing; after the rebuild it finds what a fresh publication would, no more
// (restricted, `noindex` and drafts stay out), another tenant's rows are untouched, a second
// run changes nothing, and an item first published while the rebuild waits for a row lock keeps
// its index row. Real Postgres only: the memory adapter has no index to lose. Skips without
// DATABASE_URL; in CI that is a failure.
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Invoker, buildRegistry, systemPrincipal, useCases } from '@mycel/core';
import {
  FakeDns,
  FakeInputHasher,
  FakeSigner,
  memoryPlatform,
  runSuffix,
} from '@mycel/core/testing';
import { createDb, createUnitOfWork, reindexSearch, uuidv7Ids } from './index.js';
import { enterTenant } from './infra/roles.js';
import { requireDatabase, testTenant, migrateSchema } from './testing.js';

const { skip, operator: operatorUrl, app: appUrl } = requireDatabase('app');

describe.skipIf(skip)('site search rebuild', () => {
  const owner = createDb(operatorUrl);
  const app = createDb(appUrl);
  const invoker = new Invoker(
    buildRegistry(),
    createUnitOfWork(app, {
      clock: { now: () => new Date() },
      ids: uuidv7Ids,
      signer: new FakeSigner(),
      inputHasher: new FakeInputHasher(),
      dns: new FakeDns(),
      platform: memoryPlatform,
    })
  );
  let a = '';
  let b = '';
  const word = `herbouw${runSuffix().replace(/\W/g, '')}`;

  const page = (slug: string, over: Record<string, unknown> = {}) => ({
    type: 'page' as const,
    defaultLocale: 'nl',
    locales: ['nl', 'en'],
    title: { nl: `Over ${word} ${slug}`, en: `About ${word} ${slug}` },
    blocks: [] as never[],
    ...over,
  });

  async function published(tenant: string, slug: string, over: Record<string, unknown> = {}) {
    const admin = systemPrincipal(tenant, 'test');
    const { item, revision } = await invoker.run(useCases.createItem, admin, {
      slug,
      document: page(slug, over) as never,
    });
    for (const locale of ['nl', 'en'])
      await invoker.run(useCases.publishItem, admin, {
        itemId: item.id,
        revisionId: revision.id,
        locale,
      });
    return item.id;
  }

  const found = async (tenant: string, locale = 'nl') =>
    (
      await invoker.run(useCases.findPublished, systemPrincipal(tenant, 'test'), {
        q: word,
        locale,
      })
    ).items
      .map((i) => i.slug)
      .sort();

  const rows = (tenant: string) =>
    owner.transaction().execute(async (trx) => {
      await enterTenant(trx, tenant);
      const r = await sql<{ n: string }>`select count(*) as n from content_search`.execute(trx);
      return Number(r.rows[0]!.n);
    });

  beforeAll(async () => {
    await migrateSchema(operatorUrl);
    const run = runSuffix();
    a = (await testTenant(owner, `search-a-${run}`, { name: 'A', locales: ['nl', 'en'] })).id;
    b = (await testTenant(owner, `search-b-${run}`, { name: 'B', locales: ['nl', 'en'] })).id;
    await published(a, 'open');
    await published(a, 'leden', { access: { level: 'members', teaser: 'lead' } });
    await published(a, 'verborgen', { seo: { noindex: true } });
    await invoker.run(useCases.createItem, systemPrincipal(a, 'test'), {
      slug: 'concept',
      document: page('concept') as never,
    });
    await published(b, 'ander');
  });

  afterAll(async () => {
    await app.destroy();
    await owner.destroy();
  });

  it('indexes the published, public, indexable locales again, and only those', async () => {
    expect(await found(a)).toEqual(['open']);
    expect(await rows(a)).toBe(2);
    // As before 0055: the rows of tenant a are gone, its pages are not found.
    await owner.transaction().execute(async (trx) => {
      await enterTenant(trx, a);
      await sql`delete from content_search`.execute(trx);
    });
    expect(await found(a)).toEqual([]);

    // Three items have publication rows (open, leden, verborgen); only open gets index rows.
    expect(await reindexSearch(owner, a)).toEqual({ items: 3, rows: 2 });
    expect(await found(a)).toEqual(['open']);
    expect(await found(a, 'en')).toEqual(['open']);
    expect(await found(b)).toEqual(['ander']);
    expect(await rows(b)).toBe(2);

    // A second run writes the same rows.
    expect(await reindexSearch(owner, a)).toEqual({ items: 3, rows: 2 });
    expect(await found(a)).toEqual(['open']);
  });

  it('keeps the row of an item first published while the rebuild waits for a lock', async () => {
    const admin = systemPrincipal(a, 'test');
    const open = await invoker.run(useCases.findPublished, admin, { q: word, locale: 'nl' });
    const openId = open.items[0]!.id;
    const fresh = await invoker.run(useCases.createItem, admin, {
      slug: 'nieuw',
      document: page('nieuw') as never,
    });

    // Hold the lock of a listed item, so the rebuild has its list and waits on that row.
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let locked!: () => void;
    const isLocked = new Promise<void>((r) => (locked = r));
    const blocker = owner.transaction().execute(async (trx) => {
      await enterTenant(trx, a);
      await sql`select id from content_items where id = ${openId} for update`.execute(trx);
      locked();
      await held;
    });
    await isLocked;
    const rebuild = reindexSearch(owner, a);
    let waiting = false;
    for (let i = 0; i < 100 && !waiting; i++) {
      const r = await sql<{ n: string }>`
        select count(*) as n from pg_stat_activity
        where wait_event_type = 'Lock' and query like '%for update of i%'
          and pid <> pg_backend_pid()`.execute(owner);
      waiting = Number(r.rows[0]!.n) > 0;
      if (!waiting) await new Promise((r) => setTimeout(r, 50));
    }
    expect(waiting).toBe(true);

    // First publication of an item the rebuild's list does not hold, committed meanwhile.
    await invoker.run(useCases.publishItem, admin, {
      itemId: fresh.item.id,
      revisionId: fresh.revision.id,
      locale: 'nl',
    });
    release();
    await blocker;
    await rebuild;
    expect(await found(a)).toEqual(['nieuw', 'open']);
  });
});
