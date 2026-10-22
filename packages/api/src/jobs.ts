// The job handler registry (TODO #15): which code runs a job type, and under which role. The
// worker in packages/db claims and retries; this file is the composition that knows both the
// core handlers and the platform's SQL jobs.
//
// A tenant job (`tenant_id` set) runs in a unit of work under a `system` principal for that
// tenant, as mycel_app under RLS like any use case (ADR 011 rule 3). That principal carries the
// tenant's entitlements and status as they are when the job runs (`IdentityStore.tenantAccess`,
// loaded just before the unit of work), so a handler that publishes can refuse a suspended
// tenant with `requireActive` (ADR 015 rule 7; review round 1 of TODO #16, audit point 4). A platform job gets the
// operator connection and picks its role per transaction: `sweepRateLimits` enters
// mycel_janitor, the partition function runs as the schema owner (execute is revoked from
// public, 0005). Rejected: one role that may do both, which would give tenant handlers platform
// rights.

import {
  parseJobPayload,
  purgeMedia,
  reconcileMail,
  reverifyHostname,
  sweepMediaOrphans,
  systemPrincipal,
  type Clock,
  type DomainEvent,
  type JobOutcome,
  type JobPayload,
  type JobRecord,
  type IdentityStore,
  type JobType,
  type MailSources,
  type Mailer,
  type TransactionContext,
  type UnitOfWork,
} from '@mycel/core';
import {
  createDb,
  createEventPartitions,
  listTenants,
  readOutboxEvent,
  sweepRateLimits,
  type JobHandler,
  type JobHandlers,
  type RecurringJob,
} from '@mycel/db';

/** Platform jobs the worker plans for itself (brief #15 decision 6). */
export const RECURRING_JOBS: readonly RecurringJob[] = [
  { type: 'events.partitions', cadence: 'monthly' },
  { type: 'rate_limits.sweep', cadence: 'hourly' },
  { type: 'media.orphans', cadence: 'daily' },
];

/**
 * A handler for a tenant job: validated payload, tenant-scoped unit of work, and a principal with
 * the tenant's current access. Exported for the test that proves the status reaches the handler.
 */
export function tenantJob<T extends JobType>(
  { uow, identity }: { uow: UnitOfWork; identity: Pick<IdentityStore, 'tenantAccess'> },
  type: T,
  handler: (ctx: TransactionContext, payload: JobPayload<T>) => Promise<JobOutcome | void>
): JobHandler {
  return async (job: JobRecord) => {
    if (job.tenantId === null) throw new Error(`${type} is a tenant job but has no tenant`);
    const payload = parseJobPayload(type, job.payload);
    const access = await identity.tenantAccess(job.tenantId);
    return uow.run(systemPrincipal(job.tenantId, `jobs:${type}`, access), (ctx) =>
      handler(ctx, payload)
    );
  };
}

/** A handler for a platform job: never runs with a tenant set. */
function platformJob(type: JobType, handler: () => Promise<unknown>): JobHandler {
  return async (job: JobRecord) => {
    if (job.tenantId !== null) throw new Error(`${type} is a platform job but has a tenant`);
    parseJobPayload(type, job.payload);
    await handler();
  };
}

/**
 * `media.orphans` (TODO #10): the tenant list comes from the platform role, then each tenant is
 * swept in its own unit of work as mycel_app, so the sweep reads `media` under RLS and never
 * across tenants (ADR 011 rule 1: platform reports use per-tenant transactions). One tenant's
 * failure does not stop the others; the job fails afterwards so the worker retries it.
 */
export async function sweepAllMediaOrphans(
  uow: UnitOfWork,
  tenantIds: () => Promise<string[]>
): Promise<number> {
  let swept = 0;
  const failed: string[] = [];
  for (const id of await tenantIds())
    try {
      swept += (await uow.run(systemPrincipal(id, 'jobs:media.orphans'), sweepMediaOrphans)).length;
    } catch (e) {
      console.error(`media.orphans: tenant ${id} failed:`, e);
      failed.push(id);
    }
  if (failed.length) throw new Error(`media.orphans failed for ${failed.length} tenant(s)`);
  return swept;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** What `mail.reconcile` needs besides the unit of work: the provider and the message builders. */
export interface MailJobDeps {
  mailer: Mailer;
  clock: Clock;
  /** Per subscriber name, how to rebuild its message from the event (`MailSource`). */
  sources: MailSources;
  reconcileLagMs?: number | undefined;
  /** The outbox event by id; `readOutboxEvent` on the operator connection unless a test sets it. */
  readEvent?: (id: string) => Promise<DomainEvent | null>;
}

/**
 * `mail.reconcile` (brief #22C decision 6). Not a `tenantJob`: `reconcileMail` opens its own
 * units of work, three per send like the outbox subscriber. The event comes from the outbox as
 * mycel_worker, the cross-tenant log ADR 011 rule 1 allows, and is used only when its tenant is
 * the job's. A suspended tenant sends nothing and is looked at again in a day (ADR 015 rule 7),
 * like `content.publish`. A missing event or an unknown subscriber is a programming error: the
 * job fails and, exhausted, stays visible (#17).
 */
export function mailReconcileJob({
  uow,
  identity,
  readEvent,
  ...mail
}: MailJobDeps & {
  uow: UnitOfWork;
  identity: Pick<IdentityStore, 'tenantAccess'>;
  readEvent: (id: string) => Promise<DomainEvent | null>;
}): JobHandler {
  return async (job: JobRecord) => {
    if (job.tenantId === null) throw new Error('mail.reconcile is a tenant job but has no tenant');
    const { key, subscriber, eventId } = parseJobPayload('mail.reconcile', job.payload);
    const access = await identity.tenantAccess(job.tenantId);
    if (access.status === 'suspended')
      return { next: new Date(mail.clock.now().getTime() + DAY_MS) };
    const event = await readEvent(eventId);
    if (!event) throw new Error(`mail.reconcile ${key}: outbox event ${eventId} not found`);
    if (event.tenantId !== job.tenantId)
      throw new Error(`mail.reconcile ${key}: event ${eventId} belongs to another tenant`);
    const source = Object.hasOwn(mail.sources, subscriber) ? mail.sources[subscriber] : undefined;
    if (!source) throw new Error(`mail.reconcile ${key}: no mail source for ${subscriber}`);
    if (`${subscriber}:${event.id}` !== key)
      throw new Error(`mail.reconcile ${key}: key does not match subscriber and event`);
    const message = await source(event);
    if (!message) return {};
    return reconcileMail({ ...mail, uow }, event, subscriber, message);
  };
}

export function jobHandlers({
  uow,
  operatorDb,
  identity,
  mail,
  tenantIds = async () => (await listTenants(operatorDb)).map((t) => t.id),
}: {
  uow: UnitOfWork;
  operatorDb: ReturnType<typeof createDb>;
  identity: Pick<IdentityStore, 'tenantAccess'>;
  mail: MailJobDeps;
  /** Every tenant id, for platform jobs that work per tenant; tests pass their own. */
  tenantIds?: () => Promise<string[]>;
}): JobHandlers {
  return {
    // A recheck is not a publication: it runs whatever the status (`requireActive` is for #8a).
    'hostnames.reverify': tenantJob({ uow, identity }, 'hostnames.reverify', reverifyHostname),
    'events.partitions': platformJob('events.partitions', () => createEventPartitions(operatorDb)),
    'rate_limits.sweep': platformJob('rate_limits.sweep', () => sweepRateLimits(operatorDb)),
    // Deleting files is not publishing: a suspended tenant's purge still runs.
    'media.purge': tenantJob({ uow, identity }, 'media.purge', purgeMedia),
    'media.orphans': platformJob('media.orphans', () => sweepAllMediaOrphans(uow, tenantIds)),
    'mail.reconcile': mailReconcileJob({
      uow,
      identity,
      readEvent: (id) => readOutboxEvent(operatorDb, id),
      ...mail,
    }),
  } satisfies Record<JobType, JobHandler>;
}
