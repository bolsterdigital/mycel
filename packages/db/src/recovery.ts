// Stuck work, made visible and recoverable (TODO #17c, migration 0016, brief
// observability-c-recovery). Two halves with one set of rules:
//
// * `jobRecoveryRepository` is `ctx.jobRecovery` in a tenant's unit of work, as mycel_app under
//   `tenant_isolation`: the tenant's own exhausted jobs, without the payload, and the two
//   recoveries behind `ops.job.retry` and `ops.job.close` (the Invoker audits those).
// * The `ops*` functions are the hoster's platform-wide view, for the platform API
//   (`/platform/ops/*`) and `npm run platform -- ops`. Each is one transaction as `mycel_ops`,
//   whose column grants keep `jobs.payload`, `outbox.props` and `outbox.actor` unreadable and whose
//   policies reach only stuck rows. Like platform.ts these are not use cases: they run under no
//   tenant. The hoster's recoveries are not here yet: under 0016's policies mycel_ops cannot move
//   a row out of the stuck set (see the migration), which is the open decision of TODO #17c.
//
// A job is recoverable when it is open, has used up its attempts, and no run holds its lease: a
// job on its last attempt counts as exhausted from the claim on, and resetting it while that run
// is still going would let a second worker run it beside the first. Rejected: recovering a job
// whatever its lease (two runs at once), and a status column (the state is derived, as in 0009).

import { sql, type Kysely } from 'kysely';
import { scrubText, type JobRecovery, type RecoveryResult, type StuckJob } from '@mycel/core';
import { JOB_LEASE_SECONDS } from './jobs.js';
import { MAX_ATTEMPTS } from './outbox.js';
import type { Database } from './schema.js';

type Trx = Kysely<Database>;

/** The columns of `jobs` that mycel_app and mycel_ops may read (0016): never `payload`. */
const JOB_COLUMNS = [
  'id',
  'tenant_id',
  'type',
  'key',
  'run_at',
  'attempts',
  'max_attempts',
  'last_error',
  'created_at',
] as const;

const exhausted = sql<boolean>`done_at is null and attempts >= max_attempts`;
const leaseFree = sql<boolean>`(claimed_at is null
  or claimed_at < now() - make_interval(secs => ${JOB_LEASE_SECONDS}))`;

/** Retry: a new round from zero, due now, unclaimed; `last_error` stays until the next run. */
const retryJobRow = (trx: Trx, id: string) =>
  trx
    .updateTable('jobs')
    .set({ attempts: 0, run_at: sql`now()`, claimed_at: null })
    .where('id', '=', id)
    .where(exhausted)
    .where(leaseFree)
    .returning(['id', 'tenant_id'])
    .executeTakeFirst();

/** Close: done now; `last_error` stays. The open-key index frees the key. */
const closeJobRow = (trx: Trx, id: string) =>
  trx
    .updateTable('jobs')
    .set({ done_at: sql`now()` })
    .where('id', '=', id)
    .where(exhausted)
    .where(leaseFree)
    .returning(['id', 'tenant_id'])
    .executeTakeFirst();

/** Why a recovery changed nothing: the row is not visible to this role, or not recoverable. */
async function whyNot(trx: Trx, id: string): Promise<RecoveryResult> {
  const seen = await trx.selectFrom('jobs').select('id').where('id', '=', id).executeTakeFirst();
  return seen ? 'not_exhausted' : 'not_found';
}

const toStuckJob = (r: {
  id: string;
  type: string;
  key: string;
  run_at: Date;
  attempts: number;
  max_attempts: number;
  last_error: string | null;
  created_at: Date;
}): StuckJob => ({
  id: r.id,
  type: r.type,
  key: r.key,
  runAt: new Date(r.run_at),
  attempts: r.attempts,
  maxAttempts: r.max_attempts,
  lastError: r.last_error === null ? null : scrubText(r.last_error),
  createdAt: new Date(r.created_at),
});

/** `ctx.jobRecovery` inside a tenant transaction (mycel_app; `tenant_isolation` on `jobs`). */
export function jobRecoveryRepository(trx: Trx, tenantId: string): JobRecovery {
  return {
    async exhausted(limit) {
      const rows = await trx
        .selectFrom('jobs')
        .select(JOB_COLUMNS)
        .where('tenant_id', '=', tenantId)
        .where(exhausted)
        .orderBy('created_at')
        .orderBy('id')
        .limit(limit)
        .execute();
      return rows.map(toStuckJob);
    },
    async retry(id) {
      return (await retryJobRow(trx, id)) ? 'ok' : whyNot(trx, id);
    },
    async close(id) {
      return (await closeJobRow(trx, id)) ? 'ok' : whyNot(trx, id);
    },
  };
}

/** One transaction on `db` (the authentication login or the operator) as mycel_ops. */
function asOps<T>(db: Kysely<Database>, fn: (trx: Trx) => Promise<T>): Promise<T> {
  return db.transaction().execute(async (trx) => {
    await sql`set local role mycel_ops`.execute(trx);
    return fn(trx);
  });
}

export interface OpsPage {
  /** Only this tenant's rows. */
  tenantId?: string | undefined;
  /** The last id (for mail: key) of the previous page. */
  cursor?: string | undefined;
  /** Default 50, at most 200. */
  limit?: number | undefined;
}

const pageSize = (limit: number | undefined) => Math.min(Math.max(limit ?? 50, 1), 200);

export interface Paged<T> {
  items: T[];
  nextCursor: string | null;
}

function paged<T>(rows: T[], limit: number, cursorOf: (row: T) => string): Paged<T> {
  const items = rows.slice(0, limit);
  return {
    items,
    nextCursor: rows.length > limit && items.length ? cursorOf(items.at(-1)!) : null,
  };
}

export interface OpsJob extends StuckJob {
  /** Null: a platform job. */
  tenantId: string | null;
}

export interface OpsEvent {
  id: string;
  tenantId: string;
  type: string;
  occurredAt: Date;
  attempts: number;
  /** Subscribers that handled it; a retry runs only the others. */
  deliveredTo: string[];
  lastError: string | null;
  availableAt: Date;
}

export interface OpsMail {
  tenantId: string;
  key: string;
  subscriber: string;
  eventId: string;
  state: 'unknown' | 'abandoned';
  attempts: number;
  attemptedAt: Date;
  abandonedAt: Date | null;
  lastError: string | null;
}

export interface OpsTenantSummary {
  /** Null: platform work (platform jobs). */
  tenantId: string | null;
  slug: string | null;
  name: string | null;
  status: string | null;
  exhaustedJobs: number;
  deadEvents: number;
  unknownMail: number;
  abandonedMail: number;
}

/** Exhausted jobs of every tenant and of the platform, oldest first. */
export function opsJobs(db: Kysely<Database>, page: OpsPage = {}): Promise<Paged<OpsJob>> {
  const limit = pageSize(page.limit);
  return asOps(db, async (trx) => {
    let q = trx.selectFrom('jobs').select(JOB_COLUMNS).where(exhausted);
    if (page.tenantId) q = q.where('tenant_id', '=', page.tenantId);
    if (page.cursor) q = q.where('id', '>', page.cursor);
    const rows = await q
      .orderBy('id')
      .limit(limit + 1)
      .execute();
    return paged(
      rows.map((r) => ({ ...toStuckJob(r), tenantId: r.tenant_id })),
      limit,
      (j) => j.id
    );
  });
}

/** Outbox events that failed MAX_ATTEMPTS passes without reaching every subscriber. */
export function opsDeadEvents(db: Kysely<Database>, page: OpsPage = {}): Promise<Paged<OpsEvent>> {
  const limit = pageSize(page.limit);
  return asOps(db, async (trx) => {
    let q = trx
      .selectFrom('outbox')
      .select([
        'id',
        'tenant_id',
        'type',
        'occurred_at',
        'attempts',
        'delivered_to',
        'last_error',
        'available_at',
      ])
      .where('processed_at', 'is', null)
      .where('attempts', '>=', MAX_ATTEMPTS);
    if (page.tenantId) q = q.where('tenant_id', '=', page.tenantId);
    if (page.cursor) q = q.where('id', '>', page.cursor);
    const rows = await q
      .orderBy('id')
      .limit(limit + 1)
      .execute();
    return paged(
      rows.map((r) => ({
        id: r.id,
        tenantId: r.tenant_id,
        type: r.type,
        occurredAt: new Date(r.occurred_at),
        attempts: r.attempts,
        deliveredTo: r.delivered_to,
        lastError: r.last_error === null ? null : scrubText(r.last_error),
        availableAt: new Date(r.available_at),
      })),
      limit,
      (e) => e.id
    );
  });
}

/** Unknown and abandoned mail intents (docs/reference/mail.md), by key. */
export function opsUnresolvedMail(
  db: Kysely<Database>,
  page: OpsPage = {}
): Promise<Paged<OpsMail>> {
  const limit = pageSize(page.limit);
  return asOps(db, async (trx) => {
    let q = trx
      .selectFrom('mail_sends')
      .select([
        'tenant_id',
        'key',
        'subscriber',
        'event_id',
        'attempts',
        'attempted_at',
        'abandoned_at',
        'last_error',
      ])
      .where('attempted_at', 'is not', null)
      .where('sent_at', 'is', null)
      .where((eb) =>
        eb.or([
          eb('abandoned_at', 'is not', null),
          eb('claimed_until', 'is', null),
          eb('claimed_until', '<=', sql<Date>`now()`),
        ])
      );
    if (page.tenantId) q = q.where('tenant_id', '=', page.tenantId);
    if (page.cursor) q = q.where('key', '>', page.cursor);
    const rows = await q
      .orderBy('key')
      .limit(limit + 1)
      .execute();
    return paged(
      rows.map((r) => ({
        tenantId: r.tenant_id,
        key: r.key,
        subscriber: r.subscriber,
        eventId: r.event_id,
        state: r.abandoned_at ? ('abandoned' as const) : ('unknown' as const),
        attempts: r.attempts,
        attemptedAt: new Date(r.attempted_at!),
        abandonedAt: r.abandoned_at ? new Date(r.abandoned_at) : null,
        lastError: r.last_error === null ? null : scrubText(r.last_error),
      })),
      limit,
      (m) => m.key
    );
  });
}

/**
 * Per tenant with anything stuck (and one row for platform jobs): counts only, as mycel_ops. The
 * lag figures stay on the worker's `/metrics` (#17a).
 */
export function opsSummary(db: Kysely<Database>): Promise<OpsTenantSummary[]> {
  return asOps(db, async (trx) => {
    const { rows } = await sql<{
      tenant_id: string | null;
      slug: string | null;
      name: string | null;
      status: string | null;
      exhausted_jobs: string;
      dead_events: string;
      unknown_mail: string;
      abandoned_mail: string;
    }>`
      with stuck as (
        select tenant_id, 'job' as kind from jobs
        where done_at is null and attempts >= max_attempts
        union all
        select tenant_id, 'event' from outbox
        where processed_at is null and attempts >= ${MAX_ATTEMPTS}
        union all
        select tenant_id, case when abandoned_at is null then 'unknown' else 'abandoned' end
        from mail_sends
        where attempted_at is not null and sent_at is null
          and (abandoned_at is not null or claimed_until is null or claimed_until <= now()))
      select s.tenant_id, t.slug, t.name, t.status,
             count(*) filter (where kind = 'job') as exhausted_jobs,
             count(*) filter (where kind = 'event') as dead_events,
             count(*) filter (where kind = 'unknown') as unknown_mail,
             count(*) filter (where kind = 'abandoned') as abandoned_mail
      from stuck s left join tenants t on t.id = s.tenant_id
      group by s.tenant_id, t.slug, t.name, t.status
      order by t.slug nulls first`.execute(trx);
    return rows.map((r) => ({
      tenantId: r.tenant_id,
      slug: r.slug,
      name: r.name,
      status: r.status,
      exhaustedJobs: Number(r.exhausted_jobs),
      deadEvents: Number(r.dead_events),
      unknownMail: Number(r.unknown_mail),
      abandonedMail: Number(r.abandoned_mail),
    }));
  });
}
