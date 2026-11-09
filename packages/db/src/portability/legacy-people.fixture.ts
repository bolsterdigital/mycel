// An archive made before the table rename must round-trip, including its original row digest.
// Kept beside the portability suite instead of lengthening its already broad fixture setup.
import { expect } from 'vitest';
import { createHash } from 'node:crypto';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sql, type Kysely } from 'kysely';
import { systemPrincipal, useCases, type BlobStore, type Invoker } from '@mycel/core';
import { createTenant } from '../platform.js';
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
  const dir = join(root, slug);
  const manifest = await exportTenant({ operatorDb, blobs, slug, out: dir, mycelVersion: 'test' });
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
  await invoker.run(useCases.createPersonGroup, admin, {
    name: { nl: 'Redactie' },
    personIds: [person.id],
  });
}
