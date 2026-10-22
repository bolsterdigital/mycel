// The job handler registry (TODO #15): which code runs a job type, and under which role. The
// worker in packages/db claims and retries; this file is the composition that knows both the
// core handlers and the platform's SQL jobs.
//
// A tenant job (`tenant_id` set) runs in a unit of work under a `system` principal for that
// tenant, as mycel_app under RLS like any use case (ADR 011 rule 3). A platform job gets the
// operator connection and picks its role per transaction: `sweepRateLimits` enters
// mycel_janitor, the partition function runs as the schema owner (execute is revoked from
// public, 0005). Rejected: one role that may do both, which would give tenant handlers platform
// rights.

import {
  parseJobPayload,
  reverifyHostname,
  systemPrincipal,
  type JobOutcome,
  type JobPayload,
  type JobRecord,
  type JobType,
  type TransactionContext,
  type UnitOfWork,
} from '@mycel/core';
import {
  createDb,
  createEventPartitions,
  sweepRateLimits,
  type JobHandler,
  type JobHandlers,
  type RecurringJob,
} from '@mycel/db';

/** Platform jobs the worker plans for itself (brief #15 decision 6). */
export const RECURRING_JOBS: readonly RecurringJob[] = [
  { type: 'events.partitions', cadence: 'monthly' },
  { type: 'rate_limits.sweep', cadence: 'hourly' },
];

/** A handler for a tenant job: validated payload, tenant-scoped unit of work. */
function tenantJob<T extends JobType>(
  uow: UnitOfWork,
  type: T,
  handler: (ctx: TransactionContext, payload: JobPayload<T>) => Promise<JobOutcome | void>
): JobHandler {
  return async (job: JobRecord) => {
    if (job.tenantId === null) throw new Error(`${type} is a tenant job but has no tenant`);
    const payload = parseJobPayload(type, job.payload);
    return uow.run(systemPrincipal(job.tenantId, `jobs:${type}`), (ctx) => handler(ctx, payload));
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

export function jobHandlers({
  uow,
  operatorDb,
}: {
  uow: UnitOfWork;
  operatorDb: ReturnType<typeof createDb>;
}): JobHandlers {
  return {
    'hostnames.reverify': tenantJob(uow, 'hostnames.reverify', reverifyHostname),
    'events.partitions': platformJob('events.partitions', () => createEventPartitions(operatorDb)),
    'rate_limits.sweep': platformJob('rate_limits.sweep', () => sweepRateLimits(operatorDb)),
  } satisfies Record<JobType, JobHandler>;
}
