// The tenant's view of its own stuck jobs (TODO #17c, brief observability-c-recovery decision 2):
// exhausted jobs without their payload, and the two recoveries. Tenant data in the unit of work
// like any repository, so a recovery and its audit row commit together. The hoster's platform-wide
// counterpart is not a port: it runs under no tenant, as `mycel_ops` (packages/db/src/recovery.ts),
// with the same rules (`retry` and `close` touch an exhausted job only).

/** An exhausted job as the status page shows it: never the payload. */
export interface StuckJob {
  id: string;
  type: string;
  key: string;
  runAt: Date;
  attempts: number;
  maxAttempts: number;
  /** Scrubbed when written (`failJob`); scrubbed again wherever it is shown. */
  lastError: string | null;
  createdAt: Date;
}

/** `ok`, or why nothing changed: no such job of this tenant, or a job that is not exhausted. */
export type RecoveryResult = 'ok' | 'not_found' | 'not_exhausted';

export interface JobRecovery {
  /** This tenant's open jobs that used up their attempts, oldest first. */
  exhausted(limit: number): Promise<StuckJob[]>;
  /** `attempts = 0, run_at = now, claimed_at = null`; `last_error` stays until the next run. */
  retry(id: string): Promise<RecoveryResult>;
  /** `done_at = now`; `last_error` stays. Frees the job's key. */
  close(id: string): Promise<RecoveryResult>;
}

declare module '../ports.js' {
  interface TransactionContext {
    jobRecovery: JobRecovery;
  }
}
