// The WordPress import against a real tenant (brief wordpress-import-execution, PR 2 "Klaar als"):
// the fixture goes into an empty tenant through the registry, and what a visitor's read routes
// return afterwards has the plan's titles, slugs, locales and original dates, with images that
// point at the uploaded files and items findable by the site search. A second run on the same
// tenant is refused unless `intoExisting`. Real Postgres only; skips without DATABASE_URL.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Invoker, buildRegistry, systemPrincipal, useCases } from '@mycel/core';
import {
  FakeDns,
  FakeInputHasher,
  FakeSigner,
  MemoryBlobStore,
  memoryImageProcessor,
  memoryPlatform,
  runSuffix,
} from '@mycel/core/testing';
import { createDb, createUnitOfWork, uuidv7Ids } from '@mycel/db';
import { closeTenantWork, migrateSchema, requireDatabase, testTenant } from '@mycel/db/testing';
import {
  TenantNotEmpty,
  execute,
  plan,
  type ImportPlan,
  type ImportResult,
  mediaSource,
} from '@mycel/import-wordpress';

const { skip, operator: operatorUrl, app: appUrl } = requireDatabase('app');

const FIXTURE = new URL('../../../import-wordpress/fixtures/dreamkit-export.xml', import.meta.url);

/** The synthetic uploads that belong to the fixture, as `--media-dir` would give them. */
const UPLOADS = fileURLToPath(
  new URL('../../../import-wordpress/fixtures/uploads', import.meta.url)
);

describe.skipIf(skip)('WordPress import into a tenant', () => {
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
      media: { blobs: new MemoryBlobStore(), images: memoryImageProcessor },
    })
  );
  let tenant = '';
  let importPlan: ImportPlan;
  let result: ImportResult;
  let media: ReturnType<typeof mediaSource>;
  const principal = () => systemPrincipal(tenant, 'importer');

  beforeAll(async () => {
    await migrateSchema(operatorUrl);
    tenant = (
      await testTenant(owner, `wp-import-${runSuffix()}`, { name: 'Import', locales: ['nl', 'en'] })
    ).id;
    importPlan = plan(readFileSync(FIXTURE, 'utf8'));
    media = mediaSource({ siteUrl: importPlan.site.url, mediaDir: UPLOADS });
    result = await execute(importPlan, { invoker, principal: principal(), media });
  });

  afterAll(async () => {
    await closeTenantWork(owner, [tenant]);
    await app.destroy();
    await owner.destroy();
  });

  it('creates every planned item, file, author and section, and reports no failures', () => {
    expect(result.items).toHaveLength(importPlan.items.length);
    for (const ref of [...importPlan.media, ...importPlan.people, ...importPlan.sections].map(
      (e) => e.ref
    ))
      expect(result.ids[ref]).toMatch(/^[0-9a-f-]{36}$/);
    const runCodes =
      /^(media|person|section|item)\.\w*failed$|^item\.image-missing$|^block\.reference-missing$/;
    expect(result.report.filter((l) => runCodes.test(l.code))).toEqual([]);
  });

  it('reads back titles, slugs, locales and the original dates through the public routes', async () => {
    for (const item of importPlan.items.filter((i) => i.status === 'published')) {
      for (const locale of item.document.locales) {
        const read = await invoker.run(useCases.getPublished, principal(), {
          type: item.document.type,
          slug: item.slug,
          locale,
        });
        expect(read.title).toBe(item.document.title[locale]);
        expect(read.locale).toBe(locale);
        expect(read.publishedAt).toBe(new Date(item.publishedAt!).toISOString());
      }
    }
    const listed = await invoker.run(useCases.listPublished, principal(), { limit: 50 });
    const published = importPlan.items.filter((i) => i.status === 'published');
    expect([...new Set(listed.items.map((i) => i.slug))].sort()).toEqual(
      published.map((i) => i.slug).sort()
    );
    const drafts = importPlan.items.filter((i) => i.status === 'draft').map((i) => i.slug);
    expect(listed.items.some((i) => drafts.includes(i.slug))).toBe(false);
  });

  it('points images, links and authors at what the tenant made', async () => {
    const made = new Set(Object.values(result.ids));
    const read = (type: 'page' | 'article', slug: string) =>
      invoker.run(useCases.getPublished, principal(), { type, slug, locale: 'nl' });
    const page = importPlan.items.find((i) => i.document.heroImageId)!;
    expect((await read('page', page.slug)).heroImageId).toBe(
      result.ids[page.document.heroImageId!]
    );

    const article = importPlan.items.find((i) => i.document.featuredImageId)!;
    const shown = await read('article', article.slug);
    expect(shown.featuredImageId).toBe(result.ids[article.document.featuredImageId!]);
    for (const image of shown.blocks.filter((b) => b.type === 'image'))
      expect(made).toContain((image.props as { mediaId: string }).mediaId);

    // An item whose blocks link to another item gets them in the second round, with real ids.
    const linking = importPlan.items.find((i) => JSON.stringify(i.document).includes('-8004-'))!;
    const linked = await read(linking.document.type, linking.slug);
    expect(linked.blocks.map((b) => b.type)).toEqual(linking.document.blocks.map((b) => b.type));
    const text = JSON.stringify(linked);
    expect(text).not.toMatch(/00000000-0000-4000-800/);
    expect([...text.matchAll(/"itemId":"([^"]+)"/g)].every(([, id]) => made.has(id!))).toBe(true);
  });

  it('finds an imported article through the site search', async () => {
    const article = importPlan.items.find(
      (i) => i.document.type === 'article' && i.status === 'published'
    )!;
    const word = article.document.title.nl!.split(/\s+/).find((w) => w.length > 5)!;
    const found = await invoker.run(useCases.findPublished, principal(), { q: word, locale: 'nl' });
    expect(found.items.map((i) => i.slug)).toContain(article.slug);
  });

  it('refuses a second run on the same tenant unless it is asked to import into existing content', async () => {
    await expect(
      execute(importPlan, { invoker, principal: principal(), media })
    ).rejects.toBeInstanceOf(TenantNotEmpty);
  });
});
