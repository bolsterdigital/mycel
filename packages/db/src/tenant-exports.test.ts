// Self-service export against Postgres (TODO #28, brief tenant-self-export; ADR 002 rule 5, ADR
// 015 rule 7, ADR 019 rule 8). Two tenants: A asks for an archive through the Invoker, the
// `tenant.export` job builds it into the blob store under `exports/`, and the archive is the format
// `mycel import` reads (round trip into a second database when the login may create one). B sees
// none of it: not in the list, not under RLS, not in the archive. Around that: one export at a
// time, a long run keeps its lease and is not started twice while a crashed one is, a suspended
// tenant can still export and download, the download check refuses the same way for every wrong
// link and audits a granted one, and archives disappear after their retention and after an
// erasure. Skips without DATABASE_URL and APP_DATABASE_URL; in CI that is a
// failure.

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql, type Kysely } from 'kysely';
import {
  Invoker,
  UseCaseError,
  buildRegistry,
  exportArchiveKey,
  openExportDownload,
  signExportDownload,
  systemPrincipal,
  useCases,
  type JobRecord,
  type Principal,
} from '@mycel/core';
import {
  FakeDns,
  FakeInputHasher,
  FakeSigner,
  MemoryBlobStore,
  applyExportOp,
  drawExportOp,
  memoryExportLifecycle,
  type ExportLifecycle,
  memoryImageProcessor,
  memoryPlatform,
  principal,
  probeForm,
  publishProbePage,
  requireInCi,
  runSuffix,
} from '@mycel/core/testing';
import {
  JOB_LEASE_SECONDS,
  applyErasures,
  createDb,
  createTenant,
  createUnitOfWork,
  expireExports,
  importTenant,
  runExportJob,
  setStatus,
  uuidv7,
  uuidv7Ids,
  withTenant,
  type ExportManifest,
} from './index.js';
import { claimExportRow, stepExportRow, tenantExportRepository } from './tenant-exports.js';
import { toJobRecord } from './jobs.js';
import type { Database } from './infra/schema.js';
import { asRole } from './infra/roles.js';
import { requireDatabase, migrateSchema, testTenant } from './testing.js';

const { skip, operator: operatorUrl, app: appUrl } = requireDatabase('app');

const run$ = promisify(execFile);
const by = { actorId: 'tenant-exports-test', hasher: new FakeInputHasher() };

/** As in export.conformance.test.ts: drop only once the scratch pool's backends have exited. */
async function dropDatabase(operatorDb: Kysely<Database>, name: string) {
  for (let i = 0; i < 50; i++) {
    const { rows } = await sql<{ n: number }>`
      select count(*)::int as n from pg_stat_activity where datname = ${name}`.execute(operatorDb);
    if (rows[0]?.n === 0) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  await sql`drop database if exists ${sql.id(name)} with (force)`.execute(operatorDb);
}

describe.skipIf(skip)('self-service export', () => {
  const operatorDb = createDb(operatorUrl);
  const appDb = createDb(appUrl);
  const run = runSuffix();
  const blobs = new MemoryBlobStore(
    { now: () => new Date() },
    async (path) => new Uint8Array(await readFile(path))
  );
  const signer = new FakeSigner();
  const clock = { now: () => new Date() };
  const uow = createUnitOfWork(appDb, {
    clock,
    ids: uuidv7Ids,
    signer,
    inputHasher: new FakeInputHasher(),
    dns: new FakeDns(),
    platform: memoryPlatform,
    media: { blobs, images: memoryImageProcessor },
  });
  const invoker = new Invoker(buildRegistry(), uow);
  const tenant = { a: { id: '', slug: `tex-a-${run}` }, b: { id: '', slug: `tex-b-${run}` } };
  const admin = (t: { id: string }, status: 'active' | 'suspended' = 'active'): Principal =>
    principal({
      tenantId: t.id,
      actor: { kind: 'system', job: 'tenant-exports-test' },
      tenantStatus: status,
    });
  const scratch = { dir: '' };
  const deps = () => ({ operatorDb, blobs, clock, mycelVersion: 'test', retentionDays: 7 });

  /** The open `tenant.export` job of an export, read and claimed as the worker would. */
  async function claimed(exportId: string): Promise<JobRecord> {
    return asRole(operatorDb, 'mycel_worker', async (trx) => {
      const { rows } = await sql<Parameters<typeof toJobRecord>[0]>`
        update jobs set claimed_at = now(), attempts = attempts + 1
        where key = ${`tenant.export:${exportId}`} and done_at is null
        returning *`.execute(trx);
      if (!rows[0]) throw new Error(`no open job for export ${exportId}`);
      return toJobRecord(rows[0]);
    });
  }

  /** Close the job like `completeJob`, so suites that drain jobs never see it. */
  async function close(job: JobRecord) {
    await asRole(operatorDb, 'mycel_worker', async (trx) => {
      await sql`update jobs set done_at = now() where id = ${job.id}`.execute(trx);
    });
  }

  const request = (t: { id: string }, status?: 'active' | 'suspended') =>
    invoker.run(useCases.requestExport, admin(t, status), {});
  const list = (t: { id: string }) => invoker.run(useCases.listExports, admin(t), {});

  /** Request, run the job, close it: a ready archive of `t`. */
  async function readyExport(t: { id: string }): Promise<string> {
    const { id } = await request(t);
    const job = await claimed(id);
    await runExportJob(deps(), job, id);
    await close(job);
    const row = (await list(t)).exports.find((e) => e.id === id);
    expect(row?.status, row?.error ?? undefined).toBe('ready');
    return id;
  }

  /** Rows of tenant_exports `tenantId` sees as mycel_app, whatever it asks for. */
  const visible = (tenantId: string, where: 'all' | string) =>
    withTenant(operatorDb, systemPrincipal(tenantId, 'test'), async (trx) => {
      const { rows } = await sql<{ id: string }>`
        select id from tenant_exports
        where ${where === 'all' ? sql`true` : sql`id = ${where}`}`.execute(trx);
      return rows.map((r) => r.id);
    });

  const setRow = (tenantId: string, id: string, set: ReturnType<typeof sql>) =>
    withTenant(operatorDb, systemPrincipal(tenantId, 'test'), (trx) =>
      sql`update tenant_exports set ${set} where id = ${id}`.execute(trx)
    );

  async function populate(t: { id: string; slug: string }) {
    const p = admin(t);
    const formId = uuidv7();
    await uow.run(p, (ctx) => ctx.forms.insert(probeForm(formId)));
    await publishProbePage(invoker, p, formId);
    await invoker.run(useCases.uploadMedia, p, useCases.uploadMedia.examples[0].input);
    await invoker.run(useCases.createAuthor, p, { slug: 'redactie', name: `Redactie ${t.slug}` });
  }

  async function archiveOf(t: { id: string }, id: string): Promise<string> {
    const stream = await blobs.getStream(exportArchiveKey(t.id, id));
    if (!stream) throw new Error('no archive in the store');
    const chunks: Uint8Array[] = [];
    for await (const chunk of stream) chunks.push(chunk);
    const file = join(scratch.dir, `${id}.tar`);
    await writeFile(file, Buffer.concat(chunks));
    return file;
  }

  beforeAll(async () => {
    await migrateSchema(operatorUrl);
    scratch.dir = await mkdtemp(join(tmpdir(), 'mycel-tenant-exports-'));
    for (const key of ['a', 'b'] as const) {
      const t = tenant[key];
      t.id = (
        await createTenant(
          operatorDb,
          { id: uuidv7(), slug: t.slug, name: `Tenant export ${key}`, locales: ['nl', 'en'] },
          memoryPlatform,
          by
        )
      ).id;
      await populate(t);
    }
  });

  afterAll(async () => {
    // Close whatever this suite left open, so a draining suite never runs it.
    await asRole(operatorDb, 'mycel_worker', async (trx) => {
      await sql`update jobs set done_at = now()
                where tenant_id = any(${[tenant.a.id, tenant.b.id]}::uuid[])
                  and done_at is null`.execute(trx);
    });
    if (scratch.dir) await rm(scratch.dir, { recursive: true, force: true });
    await operatorDb.destroy();
    await appDb.destroy();
  });

  it('builds the archive of A in the job, outside the media prefix, and B sees none of it', async () => {
    const id = await readyExport(tenant.a);
    const row = (await list(tenant.a)).exports.find((e) => e.id === id)!;
    expect(row).toMatchObject({ status: 'ready', requestedBy: 'system:tenant-exports-test' });
    expect(row.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(row.sizeBytes).toBeGreaterThan(0);
    expect(new Date(row.expiresAt!).getTime() - new Date(row.finishedAt!).getTime()).toBe(
      7 * 24 * 3600 * 1000
    );
    // The archive is not media: the next export does not carry it, the orphan sweep never sees it.
    expect(exportArchiveKey(tenant.a.id, id)).toBe(`exports/${tenant.a.id}/${id}.tar`);

    expect((await list(tenant.b)).exports.map((e) => e.id)).not.toContain(id);
    expect(await visible(tenant.b.id, id)).toEqual([]);
    expect(await visible(tenant.a.id, id)).toEqual([id]);

    const file = await archiveOf(tenant.a, id);
    const dir = join(scratch.dir, `x-${id}`);
    await run$('mkdir', ['-p', dir]);
    await run$('tar', ['-xf', file, '-C', dir]);
    const manifest = JSON.parse(
      await readFile(join(dir, 'manifest.json'), 'utf8')
    ) as ExportManifest;
    expect(manifest.tenant.id).toBe(tenant.a.id);
    expect(Object.keys(manifest.media).length).toBeGreaterThan(0);
    for (const key of Object.keys(manifest.media)) expect(key).toMatch(`tenants/${tenant.a.id}/`);
    // Every row of every table is A's.
    for (const entry of Object.values(manifest.tables)) {
      const text = await readFile(join(dir, entry.file), 'utf8');
      expect(text).not.toContain(tenant.b.id);
    }
    expect(manifest.tables['tenant_exports']).toBeUndefined();
  });

  it('is the format `mycel import` reads: the archive imports into an empty database', async (ctx) => {
    const { rows } = await sql<{ ok: boolean }>`
      select rolsuper or rolcreatedb as ok from pg_roles where rolname = current_user`.execute(
      operatorDb
    );
    if (
      !requireInCi(
        process.env,
        rows[0]?.ok === true,
        'the login has neither CREATEDB nor superuser'
      )
    )
      ctx.skip();
    const id = (await list(tenant.a)).exports.find((e) => e.status === 'ready')!.id;
    const file = await archiveOf(tenant.a, id);
    const name = `mycel_tex_${run}`;
    await sql`create database ${sql.id(name)}`.execute(operatorDb);
    const url = new URL(operatorUrl);
    url.pathname = `/${name}`;
    const target = createDb(url.href);
    try {
      await migrateSchema(url.href);
      const report = await importTenant({
        operatorDb: target,
        blobs: new MemoryBlobStore(),
        path: file,
        platform: memoryPlatform,
        by,
      });
      expect(report.tenantId).toBe(tenant.a.id);
      expect(report.differences).toEqual([]);
    } finally {
      await target.destroy();
      await dropDatabase(operatorDb, name);
    }
  });

  it('builds one export at a time: a second request returns the queued one, after ready a new one', async () => {
    const [first, second] = await Promise.all([request(tenant.b), request(tenant.b)]);
    expect(second.id).toBe(first.id);
    expect([first.created, second.created].sort()).toEqual([false, true]);
    expect((await request(tenant.b)).id).toBe(first.id);
    const job = await claimed(first.id);
    await runExportJob(deps(), job, first.id);
    await close(job);
    const next = await request(tenant.b);
    expect(next.created).toBe(true);
    expect(next.id).not.toBe(first.id);
    const jobB = await claimed(next.id);
    await runExportJob(deps(), jobB, next.id);
    await close(jobB);
  });

  it('keeps its lease while it runs longer than one, and is not started twice; a crashed run is', async () => {
    const { id } = await request(tenant.a);
    const job = await claimed(id);
    const leaseFresh = async () => {
      const r = await asRole(operatorDb, 'mycel_worker', async (trx) => {
        return sql<{ fresh: boolean }>`
          select claimed_at > now() - make_interval(secs => ${JOB_LEASE_SECONDS}) as fresh
          from jobs where id = ${job.id}`.execute(trx);
      });
      return r.rows[0]?.fresh;
    };
    let second: unknown;
    // runExportJob turns any error into a failed export, including an assertion thrown in this
    // hook, so a failure here would surface only as `second` being undefined. Keep it and throw
    // it after the run. The heartbeat runs every 30 ms beside the hook, so the lease is polled
    // until it is fresh again, not read once after a fixed sleep: under CI load the old lease
    // could already be renewed before the first read, or not yet after 200 ms (TODO #27).
    // Rejected: a fake clock, which cannot drive the heartbeat's own transactions.
    let hookFailure: unknown;
    await runExportJob(
      {
        ...deps(),
        heartbeatMs: 30,
        // Between the tables and the files: the lease is made old, as after five minutes, and a
        // second worker comes for the same job.
        afterSnapshot: async () => {
          try {
            const aged = await asRole(operatorDb, 'mycel_worker', async (trx) => {
              return sql<{ fresh: boolean }>`
                update jobs set claimed_at = now() - interval '10 minutes' where id = ${job.id}
                returning claimed_at > now() - make_interval(secs => ${JOB_LEASE_SECONDS})
                  as fresh`.execute(trx);
            });
            expect(aged.rows).toEqual([{ fresh: false }]);
            await expect.poll(leaseFresh, { timeout: 10_000, interval: 20 }).toBe(true);
            second = await runExportJob(deps(), job, id);
          } catch (e) {
            hookFailure = e;
          }
        },
      },
      job,
      id
    );
    await close(job);
    if (hookFailure) throw hookFailure;
    const row = (await list(tenant.a)).exports.find((e) => e.id === id);
    expect(row?.status, row?.error ?? undefined).toBe('ready');
    // The second run left it alone and looks again after a lease.
    expect(second).toEqual({ next: expect.any(Date) });

    // A crash: running, heartbeat older than a lease. The next run starts it again.
    const crashed = await request(tenant.a);
    await setRow(
      tenant.a.id,
      crashed.id,
      sql`status = 'running', started_at = now() - interval '1 hour',
          heartbeat_at = now() - interval '10 minutes'`
    );
    const again = await claimed(crashed.id);
    expect(await runExportJob(deps(), again, crashed.id)).toEqual({});
    await close(again);
    expect((await list(tenant.a)).exports.find((e) => e.id === crashed.id)?.status).toBe('ready');
  });

  it('lets a suspended tenant export and download, and nothing else', async () => {
    await setStatus(operatorDb, tenant.b.id, 'suspended', by);
    try {
      const { id } = await request(tenant.b, 'suspended');
      const job = await claimed(id);
      await runExportJob(deps(), job, id);
      await close(job);
      const p = admin(tenant.b, 'suspended');
      const link = await signExportDownload(signer, tenant.b.id, id, new Date(Date.now() + 60_000));
      const download = await uow.run(p, (ctx) =>
        openExportDownload(ctx, { id, exp: String(link.exp), sig: link.sig })
      );
      expect(download?.key).toBe(exportArchiveKey(tenant.b.id, id));
      await expect(
        invoker.run(useCases.createAuthor, p, { slug: `x-${run}`, name: 'X' })
      ).rejects.toBeInstanceOf(UseCaseError);
    } finally {
      await setStatus(operatorDb, tenant.b.id, 'active', by);
    }
  });

  it('opens a download only with a valid link of this tenant, the same refusal for all, and audits it', async () => {
    const id = (await list(tenant.a)).exports.find((e) => e.status === 'ready')!.id;
    const soon = new Date(Date.now() + 60_000);
    const link = await signExportDownload(signer, tenant.a.id, id, soon);
    const open = (p: Principal, input: { id: string; exp: string | null; sig: string | null }) =>
      uow.run(p, (ctx) => openExportDownload(ctx, input));
    const valid = { id, exp: String(link.exp), sig: link.sig };

    const old = await signExportDownload(signer, tenant.a.id, id, new Date(Date.now() - 1000));
    const editor: Principal = { ...admin(tenant.a), capabilities: ['content:write'] };
    expect(await open(admin(tenant.a), { ...valid, exp: String(old.exp), sig: old.sig })).toBe(
      null
    );
    expect(await open(admin(tenant.a), { ...valid, sig: link.sig + 'x' })).toBe(null);
    expect(await open(admin(tenant.a), { ...valid, exp: String(link.exp + 60) })).toBe(null);
    // A's link on B's admin: B's context has no such row, and the signature names A.
    expect(await open(admin(tenant.b), valid)).toBe(null);
    expect(await open(editor, valid)).toBe(null);
    expect(await open(admin(tenant.a), { ...valid, id: uuidv7() })).toBe(null);

    const before = await uow.run(admin(tenant.a), (ctx) =>
      ctx.audit.list({ operation: 'tenant.export.download', limit: 50 })
    );
    expect((await open(admin(tenant.a), valid))?.record.id).toBe(id);
    const after = await uow.run(admin(tenant.a), (ctx) =>
      ctx.audit.list({ operation: 'tenant.export.download', limit: 50 })
    );
    expect(after.length).toBe(before.length + 1);
    expect(after[0]).toMatchObject({ effect: 'export', subjectId: id, result: 'ok' });
  });

  it('expires archives after their retention, and after an erasure of someone in them', async () => {
    const kept = await readyExport(tenant.b);
    const expired = (await list(tenant.a)).exports.find((e) => e.status === 'ready')!.id;
    await setRow(tenant.a.id, expired, sql`expires_at = now() - interval '1 second'`);
    expect((await list(tenant.a)).exports.find((e) => e.id === expired)?.status).toBe('expired');
    await expireExports(operatorDb, blobs, tenant.a.id, new Date());
    expect(await blobs.head(exportArchiveKey(tenant.a.id, expired))).toBeNull();
    expect(await blobs.head(exportArchiveKey(tenant.b.id, kept))).not.toBeNull();

    // An erasure registered after the archive: the archive goes, with no trace of who.
    const archived = await readyExport(tenant.a);
    await uow.run(admin(tenant.a), (ctx) =>
      ctx.erasures.register(uuidv7(), `someone-${run}@example.org`)
    );
    await applyErasures(operatorDb, tenant.a.id);
    const row = (await list(tenant.a)).exports.find((e) => e.id === archived)!;
    expect(row.status).toBe('expired');
    expect(row.error).toBe('deleted after an erasure');
    expect(await expireExports(operatorDb, blobs, tenant.a.id, new Date())).toBeGreaterThan(0);
    expect(await blobs.head(exportArchiveKey(tenant.a.id, archived))).toBeNull();
    // B's archive is B's: A's erasure does not touch it.
    expect((await list(tenant.b)).exports.find((e) => e.id === kept)?.status).toBe('ready');
  });

  // Requests, job steps, expiries and time. Fifteen runs of fifteen steps are some 700 transactions,
  // so a loaded machine needs far more than the default 5 s: 11.9 s in a full run on a laptop, under
  // 1 s on a server. Rejected: fewer runs, which would let a slow machine pass by proving less.
  it('runs every sequence of steps like core (property)', { timeout: 30_000 }, async () => {
    const leaseMs = JOB_LEASE_SECONDS * 1000;
    await fc.assert(
      fc.asyncProperty(fc.gen(), async (g) => {
        const pick = <T>(xs: readonly T[]): T => g(fc.constantFrom, ...xs);
        const { id: tenantId } = await testTenant(operatorDb, `tex-p-${runSuffix()}`);
        const memory = memoryExportLifecycle(tenantId, leaseMs);
        const stored = new MemoryBlobStore(clock, async () => new Uint8Array(1));
        const ids: string[] = [];
        const key = (id: string) => exportArchiveKey(tenantId, id);
        const scoped = <T>(fn: (trx: Kysely<Database>) => Promise<T>) =>
          withTenant(operatorDb, systemPrincipal(tenantId, 'tenant-exports-test'), fn);
        const postgres: ExportLifecycle = {
          request: (id, now) =>
            scoped((trx) =>
              tenantExportRepository(trx, tenantId).request({
                id,
                requestedBy: 'property',
                requestedAt: now,
              })
            ),
          claim: (id, now) => claimExportRow(operatorDb, tenantId, id, now),
          // As runExportJob: the file first, gone again when the step did not apply.
          async step(id, step, now) {
            if (step.kind === 'ready')
              await stored.put(key(id), new Uint8Array(1), { contentType: 'application/x-tar' });
            const next = await stepExportRow(operatorDb, tenantId, id, step, now);
            if (step.kind === 'ready' && !next) await stored.delete([key(id)]);
            return next;
          },
          expire: (now) => expireExports(operatorDb, stored, tenantId, now),
          rows: () =>
            scoped(async (trx) =>
              (await tenantExportRepository(trx, tenantId).list(1000)).sort((a, b) =>
                a.id.localeCompare(b.id)
              )
            ),
          async files() {
            const present = await Promise.all(
              ids.map(async (id) => [id, await stored.head(key(id))] as const)
            );
            return present
              .filter(([, head]) => head)
              .map(([id]) => key(id))
              .sort();
          },
        };
        let now = Math.floor(Date.now() / 1000) * 1000;
        for (let i = 0; i < 15; i++) {
          const op = drawExportOp(pick, ids, uuidv7(), leaseMs);
          if (op.kind === 'advance') {
            now += op.ms;
            continue;
          }
          const at = new Date(now);
          const label = JSON.stringify(op);
          expect(await applyExportOp(postgres, op, at), label).toEqual(
            await applyExportOp(memory, op, at)
          );
          if (op.kind === 'request' && !ids.includes(op.id)) ids.push(op.id);
          expect(await postgres.rows(), label).toEqual(await memory.rows());
          expect(await postgres.files(), label).toEqual(await memory.files());
        }
      }),
      { numRuns: 15 }
    );
  });
});
