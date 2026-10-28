// `ctx.jobs` and `ctx.jobRecovery` over a MemoryStore's `jobs` list.

import type { JobRecord, JobRequest, Scheduler } from '../../jobs/ports.js';
import type { JobType } from '../../jobs/types.js';
import type { JobRecovery, RecoveryResult, StuckJob } from '../../ops/ports.js';
import type { Clock, Ids } from '../../ports.js';
import { FakeClock, SequentialIds } from './fakes.js';
import type { MemoryStore } from './store.js';

/**
 * `ctx.jobs` over a MemoryStore: one open job per key across all tenants, like the partial
 * unique index of `jobs` (migration 0009). Not transactional, like the rest of this store.
 */
export class MemoryScheduler implements Scheduler {
  constructor(
    readonly store: MemoryStore,
    readonly tenantId: string | null,
    readonly ids: Ids = new SequentialIds(),
    readonly clock: Clock = new FakeClock()
  ) {}

  async enqueue<T extends JobType>(job: JobRequest<T>): Promise<boolean> {
    if (this.store.jobs.some((j) => j.key === job.key && j.doneAt === null)) return false;
    this.store.jobs.push({
      id: this.ids.next(),
      tenantId: this.tenantId,
      type: job.type,
      key: job.key,
      runAt: new Date(job.runAt),
      payload: structuredClone(job.payload),
      attempts: 0,
      maxAttempts: 10,
      claimedAt: null,
      doneAt: null,
      lastError: null,
      createdAt: this.clock.now(),
    });
    return true;
  }
}

/**
 * `ctx.jobRecovery` over a MemoryStore: this tenant's jobs only, like `tenant_isolation` on `jobs`
 * (0016), and the same exhaustion rule as the SQL in packages/db/src/recovery.ts.
 */
export class MemoryJobRecovery implements JobRecovery {
  constructor(
    readonly store: MemoryStore,
    readonly tenantId: string,
    readonly clock: Clock = new FakeClock()
  ) {}

  #exhausted = (j: JobRecord) => j.doneAt === null && j.attempts >= j.maxAttempts;

  async exhausted(limit: number): Promise<StuckJob[]> {
    return this.store.jobs
      .filter((j) => j.tenantId === this.tenantId && this.#exhausted(j))
      .sort((a, b) => +a.createdAt - +b.createdAt || a.id.localeCompare(b.id))
      .slice(0, limit)
      .map(({ payload: _payload, claimedAt: _claimed, doneAt: _done, tenantId: _t, ...j }) => j);
  }

  #recover(id: string, change: (j: JobRecord) => void): RecoveryResult {
    const job = this.store.jobs.find((j) => j.id === id && j.tenantId === this.tenantId);
    if (!job) return 'not_found';
    if (!this.#exhausted(job)) return 'not_exhausted';
    change(job);
    return 'ok';
  }

  async retry(id: string): Promise<RecoveryResult> {
    return this.#recover(id, (j) => {
      j.attempts = 0;
      j.runAt = this.clock.now();
      j.claimedAt = null;
    });
  }

  async close(id: string): Promise<RecoveryResult> {
    return this.#recover(id, (j) => {
      j.doneAt = this.clock.now();
    });
  }
}
