// The scheduling port (TODO #15, ADR 011, ADR 012 rule 4). A use case plans work for later with
// `ctx.jobs.enqueue` inside its own transaction, exactly like `ctx.events.publish`: the job
// exists if and only if the change that caused it committed. The worker that runs jobs is an
// adapter concern (packages/db/src/jobs.ts); the core only says what to run and when.

import type { JobPayload, JobType } from './types.js';

export interface JobRequest<T extends JobType = JobType> {
  type: T;
  /** `jobKey(type, subject)`; one open job per key. */
  key: string;
  runAt: Date;
  payload: JobPayload<T>;
}

export interface Scheduler {
  /** False when an open job with this key exists already; it is left as it is. */
  enqueue<T extends JobType>(job: JobRequest<T>): Promise<boolean>;
}

/** A row of `jobs` as the worker and the tests see it. `tenantId` null is a platform job. */
export interface JobRecord {
  id: string;
  tenantId: string | null;
  type: string;
  key: string;
  runAt: Date;
  payload: unknown;
  attempts: number;
  maxAttempts: number;
  claimedAt: Date | null;
  doneAt: Date | null;
  lastError: string | null;
  createdAt: Date;
}

/**
 * What a handler tells the worker. `next`: plan the same job (type, key, payload, tenant) again
 * at this time, in the transaction that marks this run done; the open-key index would refuse a
 * re-plan from inside the handler, because the running job still holds its key.
 */
export interface JobOutcome {
  next?: Date;
}

declare module '../ports.js' {
  interface TransactionContext {
    jobs: Scheduler;
  }
}
