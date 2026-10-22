// Job types and their payloads (TODO #15). A job is stored as `type` plus a jsonb payload; every
// type has a Zod schema here, so a handler never sees a payload it did not declare, and adding a
// type is one line plus its handler. `content.publish { itemId, revisionId }` (#8a, ADR 018
// rule 1) joins here when scheduled publishing is built.
//
// Rejected: a free `string` type with `unknown` payloads (every handler would validate on its
// own, or not), and one table per job kind (the claim discipline would be written twice).

import { z } from 'zod';

export const JobPayloads = {
  /** Tenant job: re-check the TXT record of one custom hostname (ADR 014). */
  'hostnames.reverify': z.object({ hostname: z.string().min(1) }).strict(),
  /** Platform job: monthly `events` partitions up to three months ahead (ADR 003). */
  'events.partitions': z.object({}).strict(),
  /** Platform job: delete expired rate-limit windows as mycel_janitor (ADR 011 rule 2). */
  'rate_limits.sweep': z.object({}).strict(),
  /** Tenant job: delete a soft-deleted asset's files, then its row (`media.delete`, TODO #10). */
  'media.purge': z
    .object({ mediaId: z.string().uuid(), keys: z.array(z.string().min(1)).max(64) })
    .strict(),
  /** Platform job: per tenant, delete media files without a row that are older than a day. */
  'media.orphans': z.object({}).strict(),
  /** Platform job: delete jobs finished more than JOBS_RETENTION_DAYS ago (TODO #17a). */
  'jobs.retention': z.object({}).strict(),
  /** Platform job: delete audit rows older than AUDIT_RETENTION_DAYS (TODO #17b). */
  'audit.retention': z.object({}).strict(),
  /**
   * Tenant job: settle or resend one mail intent (`reconcileMail`, brief #22C). Ids only: the
   * message is rebuilt from the outbox event, so no address sits in the queue.
   */
  'mail.reconcile': z
    .object({ key: z.string().min(1), subscriber: z.string().min(1), eventId: z.string().uuid() })
    .strict(),
} as const;

export type JobType = keyof typeof JobPayloads;
export type JobPayload<T extends JobType> = z.infer<(typeof JobPayloads)[T]>;

export const isJobType = (type: string): type is JobType => Object.hasOwn(JobPayloads, type);

/** The payload of a stored job, validated against its type; throws on an unknown type. */
export function parseJobPayload<T extends JobType>(type: T, payload: unknown): JobPayload<T> {
  return JobPayloads[type].parse(payload) as JobPayload<T>;
}

/**
 * The deterministic key of a job: `<type>:<subject>` for a tenant job, `<type>:<period>` for a
 * recurring platform job. The subject must be globally unique, because the key is; a subject that
 * can move between tenants (a hostname) carries the tenant id (`<tenant>:<hostname>`), so a job
 * left open by the previous owner never blocks the new owner's. Idempotency lives in the key and
 * the open-key index, not in the handler.
 */
export const jobKey = (type: JobType | string, subject: string): string => `${type}:${subject}`;
