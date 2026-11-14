// An archive made before the table rename must round-trip, including its original row digest.
// Such an archive also predates the site search index (0055): the import builds `content_search`
// from the imported publication rows, so a published page is found on the new installation. And
// it predates the navigation document (0056/0057): its menus are still in the chrome, and the
// import moves them with the migration's own function (ADR 036 rule 10).
// Kept beside the portability suite instead of lengthening its already broad fixture setup.
import { expect } from 'vitest';
import { createHash } from 'node:crypto';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sql, type Kysely } from 'kysely';
import { EXAMPLE_PNG, systemPrincipal, useCases, type BlobStore, type Invoker } from '@mycel/core';
import { createTenant } from '../platform.js';
import { enterTenant } from '../infra/roles.js';
import { uuidv7 } from '../infra/ids.js';
import type { Database } from '../infra/schema.js';
import { exportTenant } from './export.js';
import { importTenant, type ImportOptions } from './import.js';

export async function checkLegacyPeopleImport(options: {
  operatorDb: Kysely<Database>;
  targetDb: Kysely<Database>;
  invoker: Invoker;
  blobs: BlobStore;
  targetBlobs: BlobStore;
  root: string;
  run: string;
  by: ImportOptions['by'];
  platform: ImportOptions['platform'];
}) {
  const { operatorDb, targetDb, invoker, blobs, targetBlobs, root, run, by, platform } = options;
  const slug = `authors-${run}`;
  const source = await createTenant(
    operatorDb,
    { id: uuidv7(), slug, name: 'Legacy authors', locales: ['nl'] },
    platform,
    by
  );
  const person = await invoker.run(useCases.createPerson, systemPrincipal(source.id, 'test'), {
    slug: 'legacy',
    name: 'Legacy',
    email: 'internal@example.org',
  });
  const admin = systemPrincipal(source.id, 'test');
  const { item, revision } = await invoker.run(useCases.createItem, admin, {
    slug: 'vindbaar',
    document: {
      type: 'page',
      defaultLocale: 'nl',
      locales: ['nl'],
      title: { nl: 'Vindbaar' },
      blocks: [],
    } as never,
  });
  await invoker.run(useCases.publishItem, admin, {
    itemId: item.id,
    revisionId: revision.id,
    locale: 'nl',
  });
  await invoker.run(useCases.updateSiteChrome, admin, {
    baseVersion: 0,
    chrome: { footer: { nl: 'Voet' } },
  });
  const dir = join(root, slug);
  const manifest = await exportTenant({ operatorDb, blobs, slug, out: dir, mycelVersion: 'test' });
  // The chrome as it was stored before 0057, and no navigation tables at all.
  for (const table of [
    'site_navigation',
    'site_navigation_revisions',
    'site_navigation_locales',
    'site_navigation_refs',
  ]) {
    const nav = manifest.tables[table];
    if (nav) await rm(join(dir, nav.file));
    delete manifest.tables[table];
  }
  const settings = manifest.tables['site_settings']!;
  const settingsText =
    (await readFile(join(dir, settings.file), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => {
        const row = JSON.parse(line) as { chrome: unknown };
        const chrome = typeof row.chrome === 'string' ? JSON.parse(row.chrome) : row.chrome;
        const old = {
          ...(chrome as object),
          navigation: [{ href: '/vindbaar', label: { nl: 'Vindbaar' } }],
          legal: [],
          support: null,
          help: null,
        };
        return JSON.stringify({
          ...row,
          chrome: typeof row.chrome === 'string' ? JSON.stringify(old) : old,
        });
      })
      .join('\n') + '\n';
  await writeFile(join(dir, settings.file), settingsText);
  settings.sha256 = createHash('sha256').update(settingsText).digest('hex');
  expect(manifest.tables['content_search']?.rows).toBe(1);
  await rm(join(dir, manifest.tables['content_search']!.file));
  delete manifest.tables['content_search'];
  const entry = manifest.tables['people']!;
  const newColumns = ['role', 'organisation', 'public_email', 'phone', 'page_policy'];
  const original = await readFile(join(dir, entry.file), 'utf8');
  let text = '';
  for (const line of original.trim().split('\n')) {
    const { rows } = await sql<{
      line: string;
    }>`select (${line}::jsonb - ${newColumns}::text[])::text as line`.execute(operatorDb);
    text += rows[0]!.line + '\n';
  }
  await rm(join(dir, entry.file));
  await writeFile(join(dir, 'tables/authors.ndjson'), text);
  delete manifest.tables['people'];
  manifest.tables['authors'] = {
    ...entry,
    file: 'tables/authors.ndjson',
    columns: entry.columns.filter((c) => !newColumns.includes(c)),
    sha256: createHash('sha256').update(text).digest('hex'),
  };
  await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest));
  const report = await importTenant({
    operatorDb: targetDb,
    blobs: targetBlobs,
    path: dir,
    platform,
    by,
  });
  const restored = join(root, `${slug}-restored`);
  await exportTenant({
    operatorDb: targetDb,
    blobs: targetBlobs,
    slug,
    out: restored,
    mycelVersion: 'test',
  });
  const row = JSON.parse((await readFile(join(restored, 'tables/people.ndjson'), 'utf8')).trim());
  expect(report.differences).toEqual([]);
  expect(report.lines).toContainEqual(expect.stringMatching(/^people: 1 imported/));
  expect(report.lines).toContain(
    'content_search: not in the export (older schema), rebuilt, 1 rows'
  );
  const indexed = await targetDb.transaction().execute(async (trx) => {
    await enterTenant(trx, source.id);
    return (await sql<{ item_id: string }>`select item_id from content_search`.execute(trx)).rows;
  });
  expect(indexed).toEqual([{ item_id: item.id }]);
  expect(report.lines).toContain('site_navigation: menus moved from the older chrome');
  // On the target installation: one published revision holding the old link as a placed menu.
  const moved = await targetDb.transaction().execute(async (trx) => {
    await enterTenant(trx, source.id);
    return (
      await sql<{ document: { placements: { main: unknown } }; locale: string }>`
        select r.document, l.locale from site_navigation n
          join site_navigation_revisions r on r.id = n.latest_revision_id
          join site_navigation_locales l on l.revision_id = r.id`.execute(trx)
    ).rows;
  });
  expect(moved).toEqual([
    expect.objectContaining({
      locale: 'nl',
      document: expect.objectContaining({
        placements: expect.objectContaining({
          main: { menuId: 'chrome-main', bar: ['chrome-main-1'] },
        }),
      }),
    }),
  ]);
  expect(row).toMatchObject({
    id: person.id,
    email: 'internal@example.org',
    public_email: null,
    page_policy: 'auto',
  });
}

/** Seed both new export tables with a real ordered relationship, not empty catalog entries. */
export async function seedGroupedPerson(
  invoker: Invoker,
  admin: Parameters<Invoker['run']>[1],
  name: string
) {
  const person = await invoker.run(useCases.createPerson, admin, {
    slug: 'redactie',
    name,
    email: 'internal@example.org',
    publicEmail: 'public@example.org',
    role: { nl: 'Redacteur' },
    pagePolicy: 'never',
  });
  await invoker.run(useCases.uploadMedia, admin, {
    filename: 'credit.png',
    contentType: 'image/png',
    bytes: EXAMPLE_PNG,
    credit: { work: null, photographer: 'Fallback', photographerPersonId: person.id },
  });
  await invoker.run(useCases.createPersonGroup, admin, {
    name: { nl: 'Redactie' },
    personIds: [person.id],
  });
  // The person register travels as a set of its own (ADR 034 rule 2): a registered, unapplied id.
  const gone = await invoker.run(useCases.createPerson, admin, { slug: 'gewist', name: 'Gewist' });
  await invoker.run(useCases.erasePeople, admin, { personIds: [gone.id] });
}
