// Self-service export over Postgres (TODO #28, migration 0022; brief tenant-self-export). Three
// parts:
//
// * `tenantExportRepository`: `ctx.exports` in the unit of work, as mycel_app under RLS. A request
//   is one insert that the partial unique index turns into "the export that is already queued or
//   running" for a second click.
// * `runExportJob`: the `tenant.export` job. It builds the archive with `exportTenant`, the code
//   behind `mycel export`, into a temporary directory of the worker, streams it to the blob store
//   under `exports/<tenant>/<id>.tar` and marks the row ready. While it runs it renews its job
//   lease and the row's heartbeat every minute, so a long export is not started again by a second
//   worker; a run that finds a fresh heartbeat leaves it alone and looks again after a lease, and
//   one that finds a stale heartbeat (the worker died) starts over. A failure marks the row failed
//   with a scrubbed error and does not retry: the administrator sees it and asks again.
// * `expireExports`: the daily `tenant.export.expire` per tenant, and the purge after
//   `erasures.apply` (which may only expire rows: its role has no blob store). Expired and failed
//   archives lose their file; rows older than a year go.
//
// Rejected: the archive in memory (one large tenant would take the worker down), a status on the
// job row (jobs are deleted after JOBS_RETENTION_DAYS), and a longer lease for all job types.

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql, type Kysely } from 'kysely';
import {
  exportArchiveKey,
  noopLogger,
  scrubText,
  systemPrincipal,
  type BlobStore,
  type JobOutcome,
  type JobRecord,
  type Logger,
  type TenantExportRecord,
  type TenantExportRepository,
} from '@mycel/core';
import { exportTenant, schemaVersion } from './export.js';
import { withTenant } from './index.js';
import { JOB_LEASE_SECONDS, touchJob } from './jobs.js';
import { getTenant } from './platform.js';
import type { Database } from './schema.js';

type Trx = Kysely<Database>;

/** Rows older than this go in the daily expire, whatever their status (never a running one). */
const KEEP_ROWS_DAYS = 365;
/** How often a running export renews its lease and heartbeat. */
const HEARTBEAT_MS = 60_000;

interface ExportRow {
  id: string;
  requested_by: string;
  requested_at: Date;
  status: TenantExportRecord['status'];
  started_at: Date | null;
  heartbeat_at: Date | null;
  finished_at: Date | null;
  size_bytes: string | number | null;
  sha256: string | null;
  schema_version: string | null;
  error: string | null;
  expires_at: Date | null;
}

const date = (d: Date | null) => (d === null ? null : new Date(d));

const toRecord = (r: ExportRow): TenantExportRecord => ({
  id: r.id,
  requestedBy: r.requested_by,
  requestedAt: new Date(r.requested_at),
  status: r.status,
  startedAt: date(r.started_at),
  heartbeatAt: date(r.heartbeat_at),
  finishedAt: date(r.finished_at),
  sizeBytes: r.size_bytes === null ? null : Number(r.size_bytes),
  sha256: r.sha256,
  schemaVersion: r.schema_version,
  error: r.error,
  expiresAt: date(r.expires_at),
});

const COLUMNS = [
  'id',
  'requested_by',
  'requested_at',
  'status',
  'started_at',
  'heartbeat_at',
  'finished_at',
  'size_bytes',
  'sha256',
  'schema_version',
  'error',
  'expires_at',
] as const;

export function tenantExportRepository(trx: Trx, tenantId: string): TenantExportRepository {
  const active = () =>
    trx
      .selectFrom('tenant_exports')
      .select(COLUMNS)
      .where('status', 'in', ['queued', 'running'])
      .executeTakeFirst();
  return {
    async request({ id, requestedBy, requestedAt }) {
      // Twice at most: the active export may finish between the refused insert and the read.
      for (let i = 0; i < 2; i++) {
        const { rows } = await sql<ExportRow>`
          insert into tenant_exports (id, tenant_id, requested_by, requested_at)
          values (${id}, ${tenantId}, ${requestedBy}, ${requestedAt})
          on conflict (tenant_id) where status in ('queued', 'running') do nothing
          returning ${sql.join(COLUMNS.map((c) => sql.ref(c)))}`.execute(trx);
        if (rows[0]) return { record: toRecord(rows[0]), created: true };
        const existing = await active();
        if (existing) return { record: toRecord(existing as ExportRow), created: false };
      }
      throw new Error('tenant.export: could not insert or find the active export');
    },
    async get(id) {
      const r = await trx
        .selectFrom('tenant_exports')
        .select(COLUMNS)
        .where('id', '=', id)
        .executeTakeFirst();
      return r ? toRecord(r as ExportRow) : null;
    },
    async list(limit) {
      const rows = await trx
        .selectFrom('tenant_exports')
        .select(COLUMNS)
        .orderBy('requested_at', 'desc')
        .orderBy('id', 'desc')
        .limit(limit)
        .execute();
      return rows.map((r) => toRecord(r as ExportRow));
    },
  };
}

/** One statement or a few as mycel_app in the tenant's context, on the operator connection. */
const asTenant = <T>(
  operatorDb: Kysely<Database>,
  tenantId: string,
  fn: (trx: Trx) => Promise<T>
) => withTenant(operatorDb, systemPrincipal(tenantId, 'jobs:tenant.export'), fn);

/**
 * Take the export for this run: `start` when it is queued, or running with a heartbeat older than
 * a lease (its worker died); `busy` when another run is alive; `gone` when there is nothing to do.
 */
async function claimExport(
  operatorDb: Kysely<Database>,
  tenantId: string,
  exportId: string
): Promise<'start' | 'busy' | 'gone'> {
  return asTenant(operatorDb, tenantId, async (trx) => {
    const { rows } = await sql<{ status: string; fresh: boolean }>`
      select status,
             heartbeat_at > now() - make_interval(secs => ${JOB_LEASE_SECONDS}) as fresh
      from tenant_exports where id = ${exportId} for update`.execute(trx);
    const row = rows[0];
    if (!row || (row.status !== 'queued' && row.status !== 'running')) return 'gone';
    if (row.status === 'running' && row.fresh) return 'busy';
    await sql`
      update tenant_exports
      set status = 'running', started_at = now(), heartbeat_at = now(), error = null
      where id = ${exportId}`.execute(trx);
    return 'start';
  });
}

const heartbeat = (operatorDb: Kysely<Database>, tenantId: string, exportId: string) =>
  asTenant(operatorDb, tenantId, (trx) =>
    sql`update tenant_exports set heartbeat_at = now()
        where id = ${exportId} and status = 'running'`.execute(trx)
  );

async function fileDigest(path: string): Promise<{ size: number; sha256: string }> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return { size: (await stat(path)).size, sha256: hash.digest('hex') };
}

export interface ExportJobDeps {
  operatorDb: Kysely<Database>;
  blobs: BlobStore;
  mycelVersion: string;
  /** EXPORT_RETENTION_DAYS: how long a ready archive can be downloaded. */
  retentionDays: number;
  log?: Logger | undefined;
  /** Tests only: a shorter heartbeat, and a hook between the tables and the files. */
  heartbeatMs?: number;
  afterSnapshot?: () => Promise<void>;
}

/** The `tenant.export` job for one export id of the job's tenant. */
export async function runExportJob(
  deps: ExportJobDeps,
  job: JobRecord,
  exportId: string
): Promise<JobOutcome> {
  const { operatorDb, blobs, log = noopLogger } = deps;
  const tenantId = job.tenantId;
  if (tenantId === null) throw new Error('tenant.export is a tenant job but has no tenant');
  const claim = await claimExport(operatorDb, tenantId, exportId);
  if (claim === 'gone') return {};
  // Another run is alive: look again after a lease, and take over if its heartbeat stopped.
  if (claim === 'busy') return { next: new Date(Date.now() + JOB_LEASE_SECONDS * 1000) };

  const key = exportArchiveKey(tenantId, exportId);
  let beating = Promise.resolve();
  const timer = setInterval(() => {
    beating = beating
      .then(async () => {
        await touchJob(operatorDb, job);
        await heartbeat(operatorDb, tenantId, exportId);
      })
      .catch((e) =>
        log.warn('tenant.export: heartbeat failed', {
          exportId,
          error: scrubText((e as Error).message),
        })
      );
  }, deps.heartbeatMs ?? HEARTBEAT_MS);
  const dir = await mkdtemp(join(tmpdir(), 'mycel-export-job-'));
  try {
    const tenant = await getTenant(operatorDb, tenantId);
    if (!tenant) throw new Error(`tenant ${tenantId} not found`);
    const file = join(dir, 'archive.tar');
    await exportTenant({
      operatorDb,
      blobs,
      slug: tenant.slug,
      out: file,
      mycelVersion: deps.mycelVersion,
      ...(deps.afterSnapshot ? { afterSnapshot: deps.afterSnapshot } : {}),
    });
    const { size, sha256 } = await fileDigest(file);
    await blobs.putFile(key, file, { contentType: 'application/x-tar' });
    const version = await schemaVersion(operatorDb);
    const ready = await asTenant(operatorDb, tenantId, (trx) =>
      sql`update tenant_exports
          set status = 'ready', finished_at = now(), heartbeat_at = now(), size_bytes = ${size},
              sha256 = ${sha256}, schema_version = ${version},
              expires_at = now() + (${deps.retentionDays} * interval '24 hours')
          where id = ${exportId} and status = 'running'`.execute(trx)
    );
    // An erasure expired it while it ran (its snapshot may hold the person): the file goes.
    if (!ready.numAffectedRows) await blobs.delete([key]);
    return {};
  } catch (e) {
    await blobs.delete([key]).catch(() => {});
    const error = scrubText(e instanceof Error ? e.message : String(e)).slice(0, 1000);
    await asTenant(operatorDb, tenantId, (trx) =>
      sql`update tenant_exports
          set status = 'failed', finished_at = now(), error = ${error}
          where id = ${exportId} and status = 'running'`.execute(trx)
    );
    log.error('tenant.export failed', { tenantId, exportId, error });
    return {};
  } finally {
    clearInterval(timer);
    await beating;
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Expire and purge one tenant's archives: ready ones past `expires_at` or without their file (after
 * a restore) become expired; every
 * expired or failed one whose file may remain loses it; rows older than a year go. Returns the
 * number of files deleted. Runs as mycel_app under the tenant's context, never across tenants.
 */
export async function expireExports(
  operatorDb: Kysely<Database>,
  blobs: BlobStore,
  tenantId: string
): Promise<number> {
  return asTenant(operatorDb, tenantId, async (trx) => {
    await sql`update tenant_exports set status = 'expired'
              where status = 'ready' and expires_at <= now()`.execute(trx);
    // A ready row whose file is gone: a restore brings the row back but never the file (backups
    // leave `exports/` out). It cannot be downloaded; say so instead of offering a dead link.
    const { rows: ready } = await sql<{ id: string }>`
      select id from tenant_exports where status = 'ready'`.execute(trx);
    for (const { id } of ready)
      if (!(await blobs.head(exportArchiveKey(tenantId, id))))
        await sql`update tenant_exports
                  set status = 'expired', error = 'the archive file is missing', purged_at = now()
                  where id = ${id}`.execute(trx);
    const { rows } = await sql<{ id: string }>`
      select id from tenant_exports
      where status in ('expired', 'failed') and purged_at is null
      for update`.execute(trx);
    const ids = rows.map((r) => r.id);
    if (ids.length) {
      await blobs.delete(ids.map((id) => exportArchiveKey(tenantId, id)));
      await sql`update tenant_exports set purged_at = now()
                where id = any(${ids}::uuid[])`.execute(trx);
    }
    await sql`delete from tenant_exports
              where requested_at < now() - make_interval(days => ${KEEP_ROWS_DAYS})
                and status not in ('queued', 'running')`.execute(trx);
    return ids.length;
  });
}
