// An archive made before migration 0053 holds operator addresses in its stored actors; import
// writes them without (ADR 035 rule 5) and still holds the tenant to the archive's digests, after
// the same normalisation on both sides. Kept beside the portability suite, as legacy-people is,
// instead of lengthening its fixture setup.
import { expect } from 'vitest';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sql, type Kysely } from 'kysely';
import { systemPrincipal, useCases, type BlobStore, type Invoker } from '@mycel/core';
import { createTenant } from '../platform.js';
import { uuidv7 } from '../infra/ids.js';
import type { Database } from '../infra/schema.js';
import { exportTenant } from './export.js';
import { importTenant, type ImportOptions } from './import.js';

export async function checkLegacyActorImport(options: {
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
  const slug = `actors-${run}`;
  const address = `legacy-actor-${run}@example.org`;
  const operatorId = uuidv7();
  const source = await createTenant(
    operatorDb,
    { id: uuidv7(), slug, name: 'Legacy actors', locales: ['nl'] },
    platform,
    by
  );
  const admin = systemPrincipal(source.id, 'test');
  await invoker.run(useCases.createItem, admin, {
    ...useCases.createItem.examples[0].input,
    slug: `actors-${run}`,
  });
  await invoker.run(useCases.uploadMedia, admin, useCases.uploadMedia.examples[0].input);
  const dir = join(root, slug);
  const manifest = await exportTenant({ operatorDb, blobs, slug, out: dir, mycelVersion: 'test' });

  // The actor as every write stored it before 0053: with the operator's address.
  const old = JSON.stringify({ kind: 'operator', operatorId, email: address });
  for (const [table, column] of [
    ['content_revisions', 'actor'],
    ['media', 'created_by'],
  ] as const) {
    const entry = manifest.tables[table]!;
    let text = '';
    for (const line of (await readFile(join(dir, entry.file), 'utf8')).trim().split('\n')) {
      const { rows } = await sql<{ line: string }>`
        select jsonb_set(${line}::jsonb, ${`{${column}}`}::text[], ${old}::jsonb)::text as line`.execute(
        operatorDb
      );
      text += rows[0]!.line + '\n';
    }
    expect(text).toContain(address);
    await writeFile(join(dir, entry.file), text);
    entry.sha256 = createHash('sha256').update(text).digest('hex');
  }
  await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest));

  const report = await importTenant({
    operatorDb: targetDb,
    blobs: targetBlobs,
    path: dir,
    platform,
    by,
  });
  expect(report.differences).toEqual([]);
  expect(report.lines).toContainEqual(
    expect.stringMatching(/^content_revisions: 1 imported, 1 with an operator address/)
  );
  expect(report.lines).toContainEqual(
    expect.stringMatching(/^media: 1 imported, 1 with an operator address/)
  );

  const restored = join(root, `${slug}-restored`);
  const after = await exportTenant({
    operatorDb: targetDb,
    blobs: targetBlobs,
    slug,
    out: restored,
    mycelVersion: 'test',
  });
  for (const entry of Object.values(after.tables))
    expect(await readFile(join(restored, entry.file), 'utf8'), entry.file).not.toContain(address);
  const revision = JSON.parse(
    (await readFile(join(restored, after.tables['content_revisions']!.file), 'utf8')).trim()
  ) as { actor: unknown };
  expect(revision.actor).toEqual({ kind: 'operator', operatorId });
}
