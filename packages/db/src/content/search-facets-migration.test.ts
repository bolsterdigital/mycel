// Migration 0094 (MY-308 PR 2): the backfill gives every existing search row the section and
// article profile of its published revision, the values core writes for a new row. The migrator
// applied it once, on whatever rows existed then, so this suite publishes through the
// repository (which writes both columns) on two tenants, clears both columns as a row from
// before 0094 would hold them, replays the backfill's `update` inside a transaction it rolls back,
// and checks that each tenant gets its own values back.
//
// The update runs narrowed to the two tenants and without the block's `alter table` lines: those
// take an exclusive lock on two tables every other suite writes, and deadlocked the parallel run.
// The test login is a superuser (erasure-backups.test.ts requires it in CI), which forced RLS does
// not bind, so the lines are checked as text: forced RLS lifted before the update and restored
// after it, on both tables.
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
  let update = '';

  beforeAll(async () => {
    await migrateSchema(operatorUrl);
    const text = await readFile(MIGRATION, 'utf8');
    const backfill = text.slice(text.indexOf('-- backfill:begin'), text.indexOf('-- backfill:end'));
    const lines = backfill.split('\n').filter((l) => l.startsWith('alter table'));
    expect(lines).toEqual([
      'alter table content_search no force row level security;',
      'alter table content_revisions no force row level security;',
      'alter table content_search force row level security;',
      'alter table content_revisions force row level security;',
    ]);
    const from = backfill.indexOf('update content_search');
    update = backfill.slice(from, backfill.indexOf(';', from));
    expect(update).toMatch(/r\.tenant_id = s\.tenant_id/);
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
      const written = { a: await read(a.id), b: await read(b.id) };
      // What the repository writes now is what the backfill must restore; a new article
      // starts as a Post.
      expect(written.a).toEqual(
        [
          { item_id: a.video, section_id: a.section, profile: 'media' },
          { item_id: a.post, section_id: null, profile: 'post' },
          { item_id: a.page, section_id: null, profile: null },
        ].sort((x, y) => (x.item_id < y.item_id ? -1 : 1))
      );
      expect(written.b.find((r) => r.item_id === b.video)?.section_id).toBe(b.section);
      const both = [a.id, b.id];
      await client.query(
        'update content_search set section_id = null, profile = null where tenant_id = any($1)',
        [both]
      );

      await client.query(`${update} and s.tenant_id = any($1)`, [both]);

      expect({ a: await read(a.id), b: await read(b.id) }).toEqual(written);
    } finally {
      await client.query('rollback').catch(() => undefined);
      await client.end();
    }
  });
});
