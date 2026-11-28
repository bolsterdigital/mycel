// Migration 0094 (MY-308 PR 2): the backfill gives every existing search row the section and
// article profile of its published revision, the values core writes for a new row. The migrator
// applied it once, on whatever rows existed then, so this suite publishes through the
// repository (which writes both columns), clears them as a row from before 0094 would be, replays
// the SQL between the `backfill:begin` and `backfill:end` markers as the owner inside a
// transaction it rolls back, and checks the values, the other tenant's rows and that RLS is
// forced again afterwards.
//
// Rejected: inserting index rows by hand (tokens and access would be a second copy of what core
// derives, and the test would check the fixture, not the migration).

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Invoker, buildRegistry, systemPrincipal, useCases } from '@mycel/core';
import {
  FakeDns,
  FakeInputHasher,
  FakeSigner,
  memoryPlatform,
  runSuffix,
} from '@mycel/core/testing';
import { createDb, createUnitOfWork, uuidv7Ids } from '../index.js';
import { migrateSchema, requireDatabase, testTenant } from '../testing.js';

const { skip, operator: operatorUrl, app: appUrl } = requireDatabase('app');

const MIGRATION = fileURLToPath(
  new URL('../../migrations/0094_content_search_facets.sql', import.meta.url)
);

describe.skipIf(skip)('migration 0094 backfill', () => {
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
  let backfill = '';

  beforeAll(async () => {
    await migrateSchema(operatorUrl);
    const text = await readFile(MIGRATION, 'utf8');
    backfill = text.slice(text.indexOf('-- backfill:begin'), text.indexOf('-- backfill:end'));
    expect(backfill).toContain('update content_search');
  });
  afterAll(async () => {
    await owner.destroy();
    await app.destroy();
  });

  async function site(name: string) {
    const { id } = await testTenant(owner, `${name}-${runSuffix()}`, { name, locales: ['nl'] });
    const admin = systemPrincipal(id, 'test');
    const section = await invoker.run(useCases.createSection, admin, {
      slug: 'verkeer',
      title: { nl: 'Verkeer' },
    });
    const publish = async (slug: string, document: Record<string, unknown>) => {
      const { item, revision } = await invoker.run(useCases.createItem, admin, {
        slug,
        document: { defaultLocale: 'nl', locales: ['nl'], blocks: [], ...document } as never,
      });
      await invoker.run(useCases.publishItem, admin, {
        itemId: item.id,
        revisionId: revision.id,
        locale: 'nl',
      });
      return item.id;
    };
    return {
      id,
      section: section.id,
      video: await publish('video', {
        type: 'article',
        title: { nl: 'Video' },
        sectionId: section.id,
        presentation: { profile: 'media' },
      }),
      post: await publish('post', { type: 'article', title: { nl: 'Bericht' } }),
      page: await publish('pagina', { type: 'page', title: { nl: 'Pagina' } }),
    };
  }

  it('fills section and profile from the published revision, per tenant', async () => {
    const a = await site('facets-a');
    const b = await site('facets-b');
    const client = new pg.Client({ connectionString: operatorUrl });
    await client.connect();
    const read = async (tenant: string) =>
      (
        await client.query<{ item_id: string; section_id: string | null; profile: string | null }>(
          `select item_id, section_id, profile from content_search
            where tenant_id = $1 order by item_id`,
          [tenant]
        )
      ).rows;
    try {
      await client.query('begin');
      await client.query('alter table content_search no force row level security');
      const written = await read(a.id);
      // What the repository writes now is what the backfill must restore.
      expect(written).toEqual(
        [
          { item_id: a.video, section_id: a.section, profile: 'media' },
          { item_id: a.post, section_id: null, profile: 'post' },
          { item_id: a.page, section_id: null, profile: null },
        ].sort((x, y) => (x.item_id < y.item_id ? -1 : 1))
      );
      const other = await read(b.id);
      await client.query(
        'update content_search set section_id = null, profile = null where tenant_id = $1',
        [a.id]
      );

      await client.query(backfill);

      const { rows: forced } = await client.query<{ relname: string; forced: boolean }>(
        `select relname, relforcerowsecurity as forced from pg_class
          where relname in ('content_search', 'content_revisions') and relkind = 'r'
          order by relname`
      );
      expect(forced).toEqual([
        { relname: 'content_revisions', forced: true },
        { relname: 'content_search', forced: true },
      ]);
      await client.query('alter table content_search no force row level security');
      expect(await read(a.id)).toEqual(written);
      expect(await read(b.id)).toEqual(other);
    } finally {
      await client.query('rollback').catch(() => undefined);
      await client.end();
    }
  });
});
