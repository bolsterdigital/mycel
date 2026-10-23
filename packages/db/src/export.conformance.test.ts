// Tenant export and import against Postgres (TODO #18d, brief production-and-restore § 12, 13 and
// 15; ADR 002 rule 5, ADR 015 rule 7). Two tenants with content, an image, a supporter, a member,
// a key, a custom hostname and an erasure registration; A is exported (suspended, which must not
// matter) and imported into a second, empty database; the import's own read-back equals the
// manifest, the platform hostname and the verification excepted; B is never in A's export and
// never touched. Import refuses a newer schema, a taken slug or tenant id, and a file that does
// not match its manifest. The table list is held to the live catalog, so a new tenant table of
// either lane fails here until it has its place in the export order.
//
// The second database needs CREATEDB (CI and dev-server-1 connect as a superuser); without it the
// round trip is skipped and the rest runs. Skips without DATABASE_URL and APP_DATABASE_URL; with
// E2E_REQUIRED=1 (CI) that is a failure.

import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql, type Kysely } from 'kysely';
import {
  Invoker,
  buildRegistry,
  purgeMedia,
  supporterIngestSubscriber,
  systemPrincipal,
  useCases,
} from '@mycel/core';
import {
  FakeDns,
  FakeInputHasher,
  FakeSigner,
  MemoryBlobStore,
  memoryImageProcessor,
  memoryPlatform,
  probeForm,
  publishProbePage,
} from '@mycel/core/testing';
import {
  EXPORT_ORDER,
  TABLES,
  createDb,
  createTenant,
  createUnitOfWork,
  exportTenant,
  importTenant,
  migrate,
  setStatus,
  uuidv7,
  uuidv7Ids,
  type ExportManifest,
} from './index.js';
import type { Database } from './schema.js';

const operatorUrl = process.env['DATABASE_URL'];
const appUrl = process.env['APP_DATABASE_URL'];
if (process.env['E2E_REQUIRED'] === '1' && (!operatorUrl || !appUrl))
  throw new Error('E2E_REQUIRED=1 but DATABASE_URL or APP_DATABASE_URL is not set');

const by = { actorId: 'export-test', hasher: new FakeInputHasher() };
const roles = {
  appPassword: process.env['MYCEL_APP_PASSWORD'],
  authPassword: process.env['MYCEL_AUTH_PASSWORD'],
  log: () => {},
};
// The second database migrates without passwords. Roles live in the cluster, not in a database,
// and migrate's advisory lock is per database, so an `alter role ... password` here raced the
// suites migrating the primary database at the same moment: `tuple concurrently updated` on
// pg_authid, red CI on f51bb92 (TODO #27). The roles already have their passwords from the
// primary; the second database only needs the schema. Rejected: one global lock around every
// suite's migrate (serialises the whole run for one call site).
const secondDatabase = { log: () => {} };

/**
 * Drop a scratch database once its pool has really gone. `db.destroy()` resolves when pg-pool has
 * removed its idle clients, not when their backends have exited; a `drop ... with (force)` in that
 * gap terminates a backend mid-shutdown and the 57P01 lands on a client with no error listener:
 * an unhandled error that fails the run with every test green (CI on 1e097cb). Rejected: an error
 * listener on the pool (would also hide a real connection loss elsewhere in the suite).
 */
async function dropDatabase(operatorDb: Kysely<Database>, name: string) {
  for (let i = 0; i < 50; i++) {
    const { rows } = await sql<{ n: number }>`
      select count(*)::int as n from pg_stat_activity where datname = ${name}`.execute(operatorDb);
    if (rows[0]?.n === 0) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  await sql`drop database if exists ${sql.id(name)} with (force)`.execute(operatorDb);
}

describe.skipIf(!operatorUrl || !appUrl)('tenant export and import', () => {
  const operatorDb = createDb(operatorUrl ?? '');
  const appDb = createDb(appUrl ?? '');
  const run = Math.random().toString(36).slice(2, 8);
  const blobs = new MemoryBlobStore();
  const uow = createUnitOfWork(appDb, {
    clock: { now: () => new Date() },
    ids: uuidv7Ids,
    signer: new FakeSigner(),
    inputHasher: new FakeInputHasher(),
    dns: new FakeDns(),
    platform: memoryPlatform,
    media: { blobs, images: memoryImageProcessor },
  });
  const invoker = new Invoker(buildRegistry(), uow);
  const tenant = { a: { id: '', slug: `exp-a-${run}` }, b: { id: '', slug: `exp-b-${run}` } };
  const scratch = { dir: '' };
  const target = {
    name: `mycel_export_${run}`,
    url: '',
    db: null as ReturnType<typeof createDb> | null,
  };
  let canCreateDb = false;
  let manifestA: ExportManifest;
  let exportB: ExportManifest;

  async function populate(t: { id: string; slug: string }, n: number) {
    const admin = systemPrincipal(t.id, 'export-test');
    const formId = uuidv7();
    await uow.run(admin, (ctx) => ctx.forms.insert(probeForm(formId)));
    await publishProbePage(invoker, admin, formId);
    await invoker.run(useCases.createAuthor, admin, { slug: 'redactie', name: `Redactie ${n}` });
    await invoker.run(useCases.createSection, admin, { slug: 'nieuws', title: { nl: 'Nieuws' } });
    await invoker.run(useCases.createPattern, admin, {
      name: { nl: 'Patroon' },
      intendedType: 'page',
      blocks: [],
    });
    await invoker.run(useCases.inviteMember, admin, {
      email: `member-${t.slug}@example.org`,
      capabilities: ['content:write'],
    });
    await invoker.run(useCases.createKey, admin, {
      name: 'export',
      capabilities: ['content:read'],
    });
    await invoker.run(useCases.addHostname, admin, { hostname: `www.${t.slug}.example` });
    const media = await invoker.run(
      useCases.uploadMedia,
      admin,
      useCases.uploadMedia.examples[0].input
    );
    await uow.run(admin, (ctx) =>
      ctx.media.replaceUsages(`item:${run}:rev:${n}`, [{ mediaId: media.id, blockId: 'b1' }])
    );
    const email = `supporter-${t.slug}@example.org`;
    const submitted = await invoker.run(useCases.submitForm, admin, {
      formId,
      values: { email, consent: true },
      locale: 'nl',
    });
    if (submitted.status !== 'accepted') throw new Error(`signup ${submitted.status}`);
    await supporterIngestSubscriber(uow).handle({
      id: uuidv7(),
      type: 'newsletter.subscribed',
      tenantId: t.id,
      occurredAt: new Date(),
      actor: { kind: 'system', job: 'export-test' },
      props: {
        email,
        list: 'newsletter',
        formId,
        submissionId: submitted.submissionId,
        locale: 'nl',
        pageUrl: null,
        consentTextVersion: 'v1',
        confirmed: true,
      },
    });
    // A seat without a signup, and a registration: both tables must travel.
    await uow.run(admin, async (ctx) => {
      await ctx.admissions.lock();
      await ctx.admissions.reserve(`pending-${t.slug}@example.org`);
      await ctx.erasures.register(uuidv7(), `gone-${t.slug}@example.org`);
    });
  }

  const files = async (dir: string) =>
    Object.fromEntries(
      await Promise.all(
        (await readdir(join(dir, 'tables'))).map(
          async (f) => [f, await readFile(join(dir, 'tables', f), 'utf8')] as const
        )
      )
    );

  beforeAll(async () => {
    await migrate(operatorUrl!, roles);
    scratch.dir = await mkdtemp(join(tmpdir(), 'mycel-export-test-'));
    for (const [key, n] of [
      ['a', 1],
      ['b', 2],
    ] as const) {
      const t = tenant[key];
      t.id = (
        await createTenant(
          operatorDb,
          { id: uuidv7(), slug: t.slug, name: `Export ${key}`, locales: ['nl', 'en'] },
          memoryPlatform,
          by
        )
      ).id;
      await populate(t, n);
    }
    // Export works for a suspended tenant (ADR 015 rule 7), and the status travels.
    await setStatus(operatorDb, tenant.a.id, 'suspended', by);
    exportB = await exportTenant({
      operatorDb,
      blobs,
      slug: tenant.b.slug,
      out: join(scratch.dir, 'b-before'),
      mycelVersion: 'test',
    });
    manifestA = await exportTenant({
      operatorDb,
      blobs,
      slug: tenant.a.slug,
      out: join(scratch.dir, 'a'),
      mycelVersion: 'test',
    });

    const { rows } = await sql<{ ok: boolean }>`
      select rolsuper or rolcreatedb as ok from pg_roles where rolname = current_user`.execute(
      operatorDb
    );
    canCreateDb = rows[0]?.ok === true;
    // Import and rollback need a second database; in CI their absence is a failure, not a skip
    // (TODO #29B), as in consent-snapshot-migration.conformance.test.ts.
    if (!canCreateDb && process.env['E2E_REQUIRED'] === '1')
      throw new Error('E2E_REQUIRED=1 but the login has neither CREATEDB nor superuser');
    if (canCreateDb) {
      await sql`create database ${sql.id(target.name)}`.execute(operatorDb);
      const url = new URL(operatorUrl!);
      url.pathname = `/${target.name}`;
      target.url = url.href;
      await migrate(target.url, secondDatabase);
      target.db = createDb(target.url);
    }
  });

  afterAll(async () => {
    await target.db?.destroy();
    if (canCreateDb) await dropDatabase(operatorDb, target.name);
    if (scratch.dir) await rm(scratch.dir, { recursive: true, force: true });
    await operatorDb.destroy();
    await appDb.destroy();
  });

  it('migrates a second database beside the primary without racing on the shared roles', async (ctx) => {
    if (!canCreateDb) ctx.skip();
    // The race of TODO #27 on demand: with `roles` on both sides this fails within a few rounds
    // (236 of 600 calls in a measurement on dev-server-1); with `secondDatabase` it cannot.
    for (let round = 0; round < 10; round++)
      await Promise.all([migrate(target.url, secondDatabase), migrate(operatorUrl!, roles)]);
  });

  it('places every table of the schema, and the catalog has no tenant table without a place', async () => {
    const exported = Object.entries(TABLES)
      .filter(([, kind]) => kind === 'export')
      .map(([name]) => name);
    expect([...EXPORT_ORDER].sort()).toEqual(exported.sort());
    const { rows } = await sql<{ name: string }>`
      select c.relname as name from pg_class c join pg_attribute a on a.attrelid = c.oid
      where a.attname = 'tenant_id' and not a.attisdropped and c.relkind in ('r', 'p')
        and c.relnamespace = 'public'::regnamespace and not c.relispartition`.execute(operatorDb);
    const placed = Object.entries(TABLES)
      .filter(([, kind]) => kind !== 'platform')
      .map(([name]) => name);
    const unplaced = rows.map((r) => r.name).filter((name) => !placed.includes(name));
    expect(unplaced, 'tenant tables without a place in TABLES and EXPORT_ORDER').toEqual([]);
  });

  it('exports every table with rows, the suspended status and the files', () => {
    expect(manifestA.tenant).toMatchObject({
      id: tenant.a.id,
      slug: tenant.a.slug,
      status: 'suspended',
      locales: ['nl', 'en'],
    });
    const empty = EXPORT_ORDER.filter((t) => manifestA.tables[t]!.rows === 0);
    expect(empty).toEqual([]);
    const keys = Object.keys(manifestA.media);
    expect(keys.length).toBeGreaterThan(1);
    expect(keys.every((k) => k.startsWith(`tenants/${tenant.a.id}/`))).toBe(true);
  });

  it('holds no row and no file of the other tenant (sentinel)', async () => {
    const text = Object.values(await files(join(scratch.dir, 'a'))).join('\n');
    expect(text).not.toContain(tenant.b.id);
    expect(text).not.toContain(tenant.b.slug);
    expect(JSON.stringify(manifestA.media)).not.toContain(tenant.b.id);
    // The membership travels as an address, never as this installation's operator id.
    expect(text).toContain(`member-${tenant.a.slug}@example.org`);
    expect(text).not.toMatch(/"operator_id"/);
  });

  it('refuses a manifest that does not match its files', async () => {
    const broken = join(scratch.dir, 'broken');
    await cp(join(scratch.dir, 'a'), broken, { recursive: true });
    const file = join(broken, 'tables', 'events.ndjson');
    await writeFile(file, (await readFile(file, 'utf8')).replace('newsletter', 'newsletteR'));
    await expect(
      importTenant({ operatorDb, blobs, path: broken, platform: memoryPlatform, by })
    ).rejects.toThrow(/events.ndjson does not match the manifest/);
  });

  it('refuses a manifest that names a file outside the format', async () => {
    const crafted = join(scratch.dir, 'crafted');
    await cp(join(scratch.dir, 'a'), crafted, { recursive: true });
    const [key, media] = Object.entries(manifestA.media)[0]!;
    await writeFile(
      join(crafted, 'manifest.json'),
      JSON.stringify({
        ...manifestA,
        media: { [key]: { ...media, file: '../../package.json' } },
      })
    );
    await expect(
      importTenant({ operatorDb, blobs, path: crafted, platform: memoryPlatform, by })
    ).rejects.toThrow(/names a file outside the format/);
    await writeFile(
      join(crafted, 'manifest.json'),
      JSON.stringify({
        ...manifestA,
        tables: { ...manifestA.tables, forms: { ...manifestA.tables['forms'], file: '../x' } },
      })
    );
    await expect(
      importTenant({ operatorDb, blobs, path: crafted, platform: memoryPlatform, by })
    ).rejects.toThrow(/names a file outside the format/);
  });

  it('refuses a newer schema and a tenant that exists', async () => {
    const newer = join(scratch.dir, 'newer');
    await cp(join(scratch.dir, 'a'), newer, { recursive: true });
    await writeFile(
      join(newer, 'manifest.json'),
      JSON.stringify({ ...manifestA, schemaVersion: '9999_future' })
    );
    await expect(
      importTenant({ operatorDb, blobs, path: newer, platform: memoryPlatform, by })
    ).rejects.toThrow(/newer than this database/);
    await expect(
      importTenant({
        operatorDb,
        blobs,
        path: join(scratch.dir, 'a'),
        slug: `exp-new-${run}`,
        platform: memoryPlatform,
        by,
      })
    ).rejects.toThrow(/exists in this database/);
  });

  describe('round trip into an empty database', () => {
    const otherPlatform = { ...memoryPlatform, domain: 'other.example' };
    const targetBlobs = new MemoryBlobStore();

    it.skipIf(!operatorUrl)('refuses a slug that is taken there', async (ctx) => {
      if (!canCreateDb) ctx.skip();
      await createTenant(
        target.db!,
        { id: uuidv7(), slug: `taken-${run}`, name: 'Taken', locales: ['nl'] },
        otherPlatform,
        by
      );
      await expect(
        importTenant({
          operatorDb: target.db!,
          blobs: targetBlobs,
          path: join(scratch.dir, 'a'),
          slug: `taken-${run}`,
          platform: otherPlatform,
          by,
        })
      ).rejects.toThrow(/slug "taken-/);
      // The refusal wrote nothing: no tenant, no file.
      expect(await targetBlobs.get(Object.keys(manifestA.media)[0]!)).toBeNull();
    });

    it.skipIf(!operatorUrl)(
      'leaves no tenant and no file when a row fails halfway, such as one of another tenant',
      async (ctx) => {
        if (!canCreateDb) ctx.skip();
        const forged = join(scratch.dir, 'forged');
        await cp(join(scratch.dir, 'a'), forged, { recursive: true });
        // A row of B smuggled into A's forms, with a manifest that matches: RLS refuses it.
        const file = join(forged, 'tables', 'forms.ndjson');
        const text = (await readFile(file, 'utf8')).replace(tenant.a.id, tenant.b.id);
        await writeFile(file, text);
        const manifest = JSON.parse(await readFile(join(forged, 'manifest.json'), 'utf8'));
        manifest.tables.forms.sha256 = createHash('sha256').update(text).digest('hex');
        await writeFile(join(forged, 'manifest.json'), JSON.stringify(manifest));
        await expect(
          importTenant({
            operatorDb: target.db!,
            blobs: targetBlobs,
            path: forged,
            platform: otherPlatform,
            by,
          })
        ).rejects.toThrow(/row-level security/);
        const { rows } = await sql<{ n: number }>`
          select count(*)::int as n from tenants where id = ${tenant.a.id}`.execute(target.db!);
        expect(rows[0]?.n).toBe(0);
        for (const key of Object.keys(manifestA.media))
          expect(await targetBlobs.get(key)).toBeNull();
      }
    );

    it.skipIf(!operatorUrl)('removes the files it wrote when a later file fails', async (ctx) => {
      if (!canCreateDb) ctx.skip();
      let puts = 0;
      const failing = Object.assign(Object.create(targetBlobs) as MemoryBlobStore, {
        put: async (...args: Parameters<MemoryBlobStore['put']>) => {
          if (++puts === 2) throw new Error('bucket unavailable');
          return targetBlobs.put(...args);
        },
      });
      await expect(
        importTenant({
          operatorDb: target.db!,
          blobs: failing,
          path: join(scratch.dir, 'a'),
          platform: otherPlatform,
          by,
        })
      ).rejects.toThrow(/bucket unavailable/);
      expect(puts).toBe(2);
      for (const key of Object.keys(manifestA.media)) expect(await targetBlobs.get(key)).toBeNull();
      const { rows } = await sql<{ n: number }>`
        select count(*)::int as n from tenants where id = ${tenant.a.id}`.execute(target.db!);
      expect(rows[0]?.n).toBe(0);
    });

    it.skipIf(!operatorUrl)(
      "imports A equal to its manifest, on this installation's hostname",
      async (ctx) => {
        if (!canCreateDb) ctx.skip();
        const report = await importTenant({
          operatorDb: target.db!,
          blobs: targetBlobs,
          path: join(scratch.dir, 'a'),
          platform: otherPlatform,
          by,
        });
        expect(report.differences).toEqual([]);
        expect(report.lines).toEqual(
          expect.arrayContaining([
            expect.stringMatching(/^tenant_hostnames: 1 imported, 1 skipped$/),
            expect.stringMatching(/^tenant_memberships: 1 imported$/),
            expect.stringMatching(/^fingerprint: equal/),
          ])
        );
        for (const [key, entry] of Object.entries(manifestA.media))
          expect((await targetBlobs.get(key))?.byteLength).toBe(entry.bytes);

        // Read back as an export from the target: equal files, the hostnames and the import's
        // own audit row excepted.
        const again = await exportTenant({
          operatorDb: target.db!,
          blobs: targetBlobs,
          slug: tenant.a.slug,
          out: join(scratch.dir, 'a-again'),
          mycelVersion: 'test',
        });
        expect(again.tenant).toEqual(manifestA.tenant);
        for (const table of EXPORT_ORDER)
          if (table !== 'tenant_hostnames' && table !== 'audit_log')
            expect(again.tables[table]!.sha256, table).toBe(manifestA.tables[table]!.sha256);
        expect(again.tables['audit_log']!.rows).toBe(manifestA.tables['audit_log']!.rows + 1);
        expect(again.media).toEqual(manifestA.media);

        const hostnames = (
          await readFile(join(scratch.dir, 'a-again', 'tables', 'tenant_hostnames.ndjson'), 'utf8')
        )
          .trim()
          .split('\n')
          .map(
            (l) =>
              JSON.parse(l) as {
                hostname: string;
                kind: string;
                verified_at: string | null;
                is_primary: boolean;
              }
          );
        expect(hostnames).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              hostname: `${tenant.a.slug}.other.example`,
              kind: 'platform',
              is_primary: true,
            }),
            expect.objectContaining({
              hostname: `www.${tenant.a.slug}.example`,
              kind: 'custom',
              verified_at: null,
            }),
          ])
        );
        // The member is a pending operator here: no login subject until they sign in again.
        const { rows } = await sql<{ subject: string | null }>`
        select subject from operators where email = ${`member-${tenant.a.slug}@example.org`}`.execute(
          target.db!
        );
        expect(rows).toEqual([{ subject: null }]);
      }
    );

    it.skipIf(!operatorUrl)('imports B from a tar, and the source B is untouched', async (ctx) => {
      if (!canCreateDb) ctx.skip();
      const tar = join(scratch.dir, 'b.tar');
      await exportTenant({
        operatorDb,
        blobs,
        slug: tenant.b.slug,
        out: tar,
        mycelVersion: 'test',
      });
      const report = await importTenant({
        operatorDb: target.db!,
        blobs: targetBlobs,
        path: tar,
        platform: otherPlatform,
        by,
      });
      expect(report.differences).toEqual([]);
      const after = await exportTenant({
        operatorDb,
        blobs,
        slug: tenant.b.slug,
        out: join(scratch.dir, 'b-after'),
        mycelVersion: 'test',
      });
      expect(after.tables).toEqual(exportB.tables);
      expect(after.media).toEqual(exportB.media);
    });

    it.skipIf(!operatorUrl)(
      'imports an export from before the consent snapshot (0019), deriving it from the form',
      async (ctx) => {
        if (!canCreateDb) ctx.skip();
        // B as an 0019 installation exported it: form_submissions without the two columns.
        const older = join(scratch.dir, 'b-0019');
        await cp(join(scratch.dir, 'b-before'), older, { recursive: true });
        const file = join(older, 'tables', 'form_submissions.ndjson');
        const text = (await readFile(file, 'utf8'))
          .trim()
          .split('\n')
          .map((line) => {
            const { list: _list, consent_text_version: _version, ...row } = JSON.parse(line);
            return JSON.stringify(row);
          })
          .join('\n')
          .concat('\n');
        await writeFile(file, text);
        const manifest = JSON.parse(await readFile(join(older, 'manifest.json'), 'utf8'));
        manifest.schemaVersion = '0019_erasures';
        const entry = manifest.tables.form_submissions;
        entry.sha256 = createHash('sha256').update(text).digest('hex');
        entry.columns = entry.columns.filter(
          (c: string) => c !== 'list' && c !== 'consent_text_version'
        );
        await writeFile(join(older, 'manifest.json'), JSON.stringify(manifest));

        // A database of its own: B also travels into the shared target below.
        const name = `${target.name}_0019`;
        await sql`create database ${sql.id(name)}`.execute(operatorDb);
        const url = new URL(operatorUrl!);
        url.pathname = `/${name}`;
        const db = createDb(url.href);
        try {
          await migrate(url.href, roles);
          const report = await importTenant({
            operatorDb: db,
            blobs: new MemoryBlobStore(),
            path: older,
            platform: otherPlatform,
            by,
          });
          // The fingerprint differs exactly where the newer schema has more than the export.
          expect(report.differences).toEqual([expect.stringMatching(/^form_submissions/)]);
          const { rows } = await sql<{ list: string; consent_text_version: string }>`
            select list, consent_text_version from form_submissions
             where tenant_id = ${tenant.b.id}`.execute(db);
          expect(rows).toEqual([
            { list: 'newsletter', consent_text_version: probeForm(uuidv7()).consentTextVersion },
          ]);
        } finally {
          await db.destroy();
          await dropDatabase(operatorDb, name);
        }
      }
    );
  });

  // TODO #29A, ADR 019 rule 8: media that changes between the table snapshot and the file copy.
  // An asset deleted during the run keeps its files (the purge waits MEDIA_PURGE_DELAY_MS); one
  // purged anyway fails the export by id and nothing is left; an upload during the run travels
  // as files without a row, which media.orphans removes after import.
  describe('media that changes while the export runs', () => {
    const c = { id: '', slug: `exp-c-${run}` };
    const admin = () => systemPrincipal(c.id, 'export-test');
    const PDF = Buffer.from('%PDF-1.4\n%drill\n').toString('base64');
    const upload = (input: Parameters<typeof useCases.uploadMedia.handler>[1]) =>
      invoker.run(useCases.uploadMedia, admin(), input);
    const png = () => upload(useCases.uploadMedia.examples[0].input);
    const keysOf = async (mediaId: string) => {
      const keys: string[] = [];
      for await (const { key } of blobs.list(`tenants/${c.id}/media/${mediaId}/`)) keys.push(key);
      return keys;
    };
    const mediaRows = async (dir: string) =>
      (await readFile(join(dir, 'tables', 'media.ndjson'), 'utf8'))
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as { id: string; checksum: string; deleted_at: string | null });

    beforeAll(async () => {
      c.id = (
        await createTenant(
          operatorDb,
          { id: uuidv7(), slug: c.slug, name: 'Export c', locales: ['nl'] },
          memoryPlatform,
          by
        )
      ).id;
      // A raster image (original plus variants) and a file delivered as stored (`file.pdf`).
      await png();
      await upload({ filename: 'flyer.pdf', contentType: 'application/pdf', bytes: PDF });
    });

    it('refuses a directory that is not empty and leaves it as it was', async () => {
      const dir = join(scratch.dir, 'c-occupied');
      await mkdir(dir);
      await writeFile(join(dir, 'keep.txt'), 'mine');
      await expect(
        exportTenant({ operatorDb, blobs, slug: c.slug, out: dir, mycelVersion: 'test' })
      ).rejects.toThrow(/not empty/);
      expect(await readdir(dir)).toEqual(['keep.txt']);
    });

    it('fails naming an asset purged after the snapshot, and leaves no directory or tar', async () => {
      const doomed = await png();
      const purgeDuring = async () => {
        const keys = await keysOf(doomed.id);
        expect(keys.length).toBeGreaterThan(1);
        await invoker.run(useCases.deleteMedia, admin(), { id: doomed.id });
        // The purge forced past its delay, as a worker with a wrong clock or a run over the limit
        // would.
        await uow.run(admin(), (ctx) => purgeMedia(ctx, { mediaId: doomed.id, keys }));
      };
      const dir = join(scratch.dir, 'c-purged');
      await expect(
        exportTenant({
          operatorDb,
          blobs,
          slug: c.slug,
          out: dir,
          mycelVersion: 'test',
          afterSnapshot: purgeDuring,
        })
      ).rejects.toThrow(doomed.id);
      await expect(readdir(dir)).rejects.toMatchObject({ code: 'ENOENT' });

      // The same as a tar, with an asset that has no row by the time the tables are read again.
      const again = await png();
      const tar = join(scratch.dir, 'c-purged.tar');
      await expect(
        exportTenant({
          operatorDb,
          blobs,
          slug: c.slug,
          out: tar,
          mycelVersion: 'test',
          afterSnapshot: async () => {
            const keys = await keysOf(again.id);
            await invoker.run(useCases.deleteMedia, admin(), { id: again.id });
            await uow.run(admin(), (ctx) => purgeMedia(ctx, { mediaId: again.id, keys }));
          },
        })
      ).rejects.toThrow(again.id);
      expect((await readdir(scratch.dir)).filter((f) => f.startsWith('c-purged'))).toEqual([]);
    });

    it('keeps an asset deleted during the run and leaves out the row of an upload during it', async (ctx) => {
      const deleted = await png();
      let uploaded = '';
      const dir = join(scratch.dir, 'c-concurrent');
      const manifest = await exportTenant({
        operatorDb,
        blobs,
        slug: c.slug,
        out: dir,
        mycelVersion: 'test',
        afterSnapshot: async () => {
          await invoker.run(useCases.deleteMedia, admin(), { id: deleted.id });
          uploaded = (
            await upload({ filename: 'late.pdf', contentType: 'application/pdf', bytes: PDF })
          ).id;
        },
      });
      const rows = await mediaRows(dir);
      expect(rows.find((r) => r.id === deleted.id)).toMatchObject({ deleted_at: null });
      expect(rows.map((r) => r.id)).not.toContain(uploaded);
      for (const key of await keysOf(deleted.id)) expect(manifest.media[key]).toBeDefined();
      // The upload's file travels without its row: the orphan sweep's to remove after import.
      expect(Object.keys(manifest.media).some((k) => k.includes(uploaded))).toBe(true);

      if (!canCreateDb) ctx.skip();
      const report = await importTenant({
        operatorDb: target.db!,
        blobs: new MemoryBlobStore(),
        path: dir,
        platform: { ...memoryPlatform, domain: 'other.example' },
        by,
      });
      expect(report.differences).toEqual([]);
      const { rows: imported } = await sql<{ id: string; checksum: string }>`
        select id, checksum from media where tenant_id = ${c.id} and deleted_at is null
        order by id`.execute(target.db!);
      expect(imported).toEqual(
        rows
          .filter((r) => r.deleted_at === null)
          .map(({ id, checksum }) => ({ id, checksum }))
          .sort((x, y) => x.id.localeCompare(y.id))
      );
      expect(imported.map((r) => r.id)).toContain(deleted.id);
    });
  });
});
