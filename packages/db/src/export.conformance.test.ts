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
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import {
  Invoker,
  buildRegistry,
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
    if (canCreateDb) {
      await sql`create database ${sql.id(target.name)}`.execute(operatorDb);
      const url = new URL(operatorUrl!);
      url.pathname = `/${target.name}`;
      target.url = url.href;
      await migrate(target.url, roles);
      target.db = createDb(target.url);
    }
  });

  afterAll(async () => {
    await target.db?.destroy();
    if (canCreateDb)
      await sql`drop database if exists ${sql.id(target.name)} with (force)`.execute(operatorDb);
    if (scratch.dir) await rm(scratch.dir, { recursive: true, force: true });
    await operatorDb.destroy();
    await appDb.destroy();
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
  });
});
