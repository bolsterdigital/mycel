// Media against Postgres (TODO #10): what the in-memory ports cannot prove. `media` and
// `media_usages` are isolated per tenant, `usage.storageBytes` counts one tenant's live assets,
// the per-tenant lock makes the storage cap hold under concurrency, a delete plans its purge in
// the same transaction and the purge job removes files and row, and the orphan sweep works per
// tenant without any cross-tenant policy. The files live in an in-memory BlobStore: the store's
// own contract is packages/blob's suite. The backup's list of required files
// (docker/backup/media-expected.sql, TODO #29A) is held to `mediaKeys` here.
//
// Skips without DATABASE_URL and APP_DATABASE_URL; with E2E_REQUIRED=1 (CI) that is a failure.

import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import {
  DEFAULT_ENTITLEMENTS,
  EXAMPLE_PNG,
  Invoker,
  MEDIA_PURGE_DELAY_MS,
  ORPHAN_AGE_MS,
  UseCaseError,
  buildRegistry,
  jobKey,
  mediaKeys,
  parseJobPayload,
  purgeMedia,
  sweepMediaOrphans,
  systemPrincipal,
  useCases,
  type MediaContentType,
  type Principal,
  type StoredVariant,
} from '@mycel/core';
import {
  FakeClock,
  FakeDns,
  FakeInputHasher,
  FakeSigner,
  MemoryBlobStore,
  memoryImageProcessor,
  memoryPlatform,
} from '@mycel/core/testing';
import {
  createDb,
  createUnitOfWork,
  migrate,
  runJobs,
  upsertTenant,
  uuidv7,
  uuidv7Ids,
} from './index.js';

const operatorUrl = process.env['DATABASE_URL'];
const appUrl = process.env['APP_DATABASE_URL'];
if (process.env['E2E_REQUIRED'] === '1' && (!operatorUrl || !appUrl))
  throw new Error('E2E_REQUIRED=1 but DATABASE_URL or APP_DATABASE_URL is not set');

/** A store whose writes take a while, so two uploads really overlap. */
class SlowBlobStore extends MemoryBlobStore {
  override async put(key: string, bytes: Uint8Array, o: { contentType: string }) {
    await new Promise((r) => setTimeout(r, 50));
    return super.put(key, bytes, o);
  }
}

describe.skipIf(!operatorUrl || !appUrl)('media conformance', () => {
  const operatorDb = createDb(operatorUrl ?? '');
  const appDb = createDb(appUrl ?? '');
  const run = Math.random().toString(36).slice(2, 8);
  const clock = new FakeClock(new Date());
  const blobs = new SlowBlobStore(clock);
  const uow = createUnitOfWork(appDb, {
    clock,
    ids: uuidv7Ids,
    signer: new FakeSigner(),
    inputHasher: new FakeInputHasher(),
    dns: new FakeDns(),
    platform: memoryPlatform,
    media: { blobs, images: memoryImageProcessor },
  });
  const invoker = new Invoker(buildRegistry(), uow);
  let a = '';
  let b = '';
  const upload = (principal: Principal) =>
    invoker.run(useCases.uploadMedia, principal, {
      filename: 'pixel.png',
      contentType: 'image/png',
      bytes: EXAMPLE_PNG,
    });
  const keys = async (prefix: string) => {
    const out: string[] = [];
    for await (const x of blobs.list(prefix)) out.push(x.key);
    return out;
  };

  beforeAll(async () => {
    await migrate(operatorUrl!, {
      log: () => {},
    });
    const tenant = (slug: string) =>
      upsertTenant(
        operatorDb,
        { id: uuidv7(), slug: `${slug}-${run}`, name: slug, defaultLocale: 'nl', locales: ['nl'] },
        { platformDomain: 'localhost' }
      ).then((t) => t.id);
    [a, b] = [await tenant('media-a'), await tenant('media-b')];
  });

  afterAll(async () => {
    await operatorDb.destroy();
    await appDb.destroy();
  });

  it('isolates media and usages per tenant and counts only live storage of one tenant', async () => {
    const A = systemPrincipal(a, 'test');
    const B = systemPrincipal(b, 'test');
    const mine = await upload(A);
    const theirs = await upload(B);
    await uow.run(A, (ctx) =>
      ctx.media.replaceUsages('item:1:rev:1', [{ mediaId: mine.id, blockId: 'b' }])
    );
    // B cannot read, list, count or reference A's asset.
    await expect(invoker.run(useCases.getMedia, B, { id: mine.id })).rejects.toSatisfy(
      (e) => e instanceof UseCaseError && e.code === 'not_found'
    );
    expect((await invoker.run(useCases.listMedia, B, {})).items.map((m) => m.id)).toEqual([
      theirs.id,
    ]);
    expect(
      await uow.run(B, (ctx) =>
        ctx.media.replaceUsages('item:x', [{ mediaId: mine.id, blockId: 'b' }])
      )
    ).toBe(0);
    expect(await uow.run(B, (ctx) => ctx.media.idsOf())).toEqual([theirs.id]);
    expect((await invoker.run(useCases.getMedia, A, { id: mine.id })).usageCount).toBe(1);

    const used = (p: Principal) =>
      invoker.run(useCases.getUsage, p, {}).then((u) => u.storage.usedBytes);
    expect(await used(A)).toBe(mine.totalBytes);
    expect(await used(B)).toBe(theirs.totalBytes);
    await invoker.run(useCases.deleteMedia, B, { id: theirs.id });
    expect(await used(B)).toBe(0);
  });

  it('lets exactly one of two concurrent uploads past the cap (the lock)', async () => {
    const probe = await upload(systemPrincipal(b, 'probe'));
    const t = await upsertTenant(
      operatorDb,
      { id: uuidv7(), slug: `media-cap-${run}`, name: 'cap', defaultLocale: 'nl', locales: ['nl'] },
      { platformDomain: 'localhost' }
    );
    const capped: Principal = {
      ...systemPrincipal(t.id, 'test'),
      entitlements: { ...DEFAULT_ENTITLEMENTS, 'media.storage_max_bytes': probe.totalBytes * 1.5 },
    };
    const results = await Promise.allSettled([upload(capped), upload(capped)]);
    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    const refused = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(refused.reason).toMatchObject({ code: 'limit_exceeded' });
    expect(await uow.run(capped, (ctx) => ctx.media.idsOf())).toHaveLength(1);
  });

  it('refuses to delete a used asset, plans the purge with the delete, and the purge job removes files and row', async () => {
    const A = systemPrincipal(a, 'test');
    const m = await upload(A);
    await uow.run(A, (ctx) =>
      ctx.media.replaceUsages('og:home', [{ mediaId: m.id, blockId: 'og' }])
    );
    await expect(invoker.run(useCases.deleteMedia, A, { id: m.id })).rejects.toMatchObject({
      code: 'conflict',
    });
    await uow.run(A, (ctx) => ctx.media.replaceUsages('og:home', []));
    await invoker.run(useCases.deleteMedia, A, { id: m.id });
    expect(await keys(`tenants/${a}/media/${m.id}/`)).toHaveLength(4);

    const purge = () =>
      runJobs(
        operatorDb,
        {
          'media.purge': async (job) =>
            uow.run(systemPrincipal(job.tenantId!, 'jobs:media.purge'), (ctx) =>
              purgeMedia(ctx, parseJobPayload('media.purge', job.payload))
            ),
        },
        { types: ['media.purge'], tenantId: a }
      );
    // TODO #29A: the purge waits MEDIA_PURGE_DELAY_MS, so a backup that began before the delete
    // still finds the files; the runner does not claim it before then.
    const key = jobKey('media.purge', m.id);
    const { rows: planned } = await sql<{ runAt: Date }>`
      select run_at as "runAt" from jobs where key = ${key}`.execute(operatorDb);
    expect(planned[0]?.runAt).toEqual(new Date(clock.now().getTime() + MEDIA_PURGE_DELAY_MS));
    await purge();
    expect(await keys(`tenants/${a}/media/${m.id}/`)).toHaveLength(4);

    await sql`update jobs set run_at = now() where key = ${key}`.execute(operatorDb);
    const result = await purge();
    expect(result.failed).toBe(0);
    expect(result.completed).toBeGreaterThanOrEqual(1);
    expect(await keys(`tenants/${a}/media/${m.id}/`)).toEqual([]);
    const { rows } = await sql<{
      n: string;
    }>`select count(*) as n from media where id = ${m.id}`.execute(operatorDb);
    expect(Number(rows[0]?.n)).toBe(0);
  });

  it('sweeps a tenant’s old orphans only, keeping young ones, files with a row and other tenants', async () => {
    const A = systemPrincipal(a, 'test');
    const kept = await upload(A);
    const old = `tenants/${a}/media/${uuidv7()}/original.png`;
    const elsewhere = `tenants/${b}/media/${uuidv7()}/original.png`;
    await blobs.put(old, new Uint8Array(1), { contentType: 'image/png' });
    await blobs.put(elsewhere, new Uint8Array(1), { contentType: 'image/png' });
    clock.advance(ORPHAN_AGE_MS + 1000);
    const young = `tenants/${a}/media/${uuidv7()}/original.png`;
    await blobs.put(young, new Uint8Array(1), { contentType: 'image/png' });

    // The row of `kept` is older than a day too: a file with a row is never an orphan.
    expect(await uow.run(A, sweepMediaOrphans)).toEqual([old]);
    const left = await keys('tenants/');
    expect(left).toEqual(expect.arrayContaining([young, elsewhere]));
    expect(left.filter((k) => k.includes(kept.id))).toHaveLength(4);
  });
  it('lists every file of every live asset for the backup by its key, as mediaKeys does', async () => {
    const c = await upsertTenant(
      operatorDb,
      {
        id: uuidv7(),
        slug: `media-keys-${run}`,
        name: 'keys',
        defaultLocale: 'nl',
        locales: ['nl'],
      },
      { platformDomain: 'localhost' }
    ).then((t) => t.id);
    const v = (name: string, format: StoredVariant['format']): StoredVariant => ({
      name,
      format,
      width: null,
      height: null,
      bytes: 1,
    });
    // Every content type, a raster original next to its variants, and the two kinds stored as
    // `file` (a PDF, an animated GIF), which have no separate original.
    const fixtures: { contentType: MediaContentType; variants: StoredVariant[] }[] = [
      {
        contentType: 'image/jpeg',
        variants: [v('w320', 'avif'), v('w320', 'webp'), v('thumb', 'webp')],
      },
      { contentType: 'image/png', variants: [v('w640', 'webp')] },
      { contentType: 'image/webp', variants: [] },
      { contentType: 'image/avif', variants: [v('thumb', 'avif')] },
      { contentType: 'image/gif', variants: [v('file', 'gif'), v('thumb', 'webp')] },
      { contentType: 'application/pdf', variants: [v('file', 'pdf')] },
    ];
    const rows = fixtures.map((f) => ({ id: uuidv7(), ...f }));
    const gone = uuidv7();
    const insert = (id: string, f: (typeof fixtures)[number], deleted: boolean) => sql`
      insert into media (id, tenant_id, kind, content_type, filename, checksum, size_bytes,
        total_bytes, variants, created_by, deleted_at)
      values (${id}, ${c}, ${f.contentType === 'application/pdf' ? 'document' : 'image'},
        ${f.contentType}, 'x', ${'0'.repeat(64)}, 1, 1, ${JSON.stringify(f.variants)}::jsonb,
        '{"type": "system"}'::jsonb, ${deleted ? sql`now()` : null})`;
    const query = await readFile(
      new URL('../../../docker/backup/media-expected.sql', import.meta.url),
      'utf8'
    );
    const listed = await operatorDb.transaction().execute(async (trx) => {
      await sql`select set_config('role', 'mycel_app', true),
        set_config('app.tenant_id', ${c}, true)`.execute(trx);
      for (const r of rows) await insert(r.id, r, false).execute(trx);
      await insert(gone, fixtures[0]!, true).execute(trx);
      return (await sql<{ id: string; key: string }>`${sql.raw(query)}`.execute(trx)).rows;
    });

    const t0 = listed.filter((r) => r.id === 't0');
    expect(t0).toHaveLength(1);
    expect(Math.abs(Number(t0[0]!.key) - Date.now() / 1000)).toBeLessThan(60);
    const files = listed.filter((r) => r.id !== 't0');
    expect(files.map((r) => r.key).sort()).toEqual(rows.flatMap((r) => mediaKeys(c, r)).sort());
    for (const r of files) expect(r.key.startsWith(`tenants/${c}/media/${r.id}/`)).toBe(true);
    // A soft-deleted asset may miss its files (its purge runs again after a restore).
    expect(files.some((r) => r.id === gone)).toBe(false);
  });
});
