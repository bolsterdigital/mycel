// The decided retention terms (docs/reference/jobs.md § Retention): a processed outbox event goes after
// 30 days, a form submission after a number of calendar months the tenant sets (24 unless it chose
// fewer), a reserved admission seat after its window. This file is the arithmetic and the
// document; `retention.apply` in the worker reads the setting, asks for the cut-offs here and
// hands them to the adapter, so memory, Postgres and the docs count the same way.
// Rejected: a term in days for submissions (the decision is in months, and "24 months" as 730
// days drifts a day per leap year), and the tenant's time zone for the month boundary (a term
// that moves with a setting an editor changes for other reasons; UTC is the same everywhere).

import { z } from 'zod';
import { ADMISSION_WINDOW_MS } from '../supporters/ports.js';

/** A processed outbox event is kept this long after `processed_at`, for every tenant. */
export const OUTBOX_RETENTION_DAYS = 30;
/** The longest a tenant may keep form submissions, and the term when it chose nothing. */
export const MAX_SUBMISSION_RETENTION_MONTHS = 24;
/** The shortest term on offer: a month leaves room for confirmation, mail and reconciliation. */
export const MIN_SUBMISSION_RETENTION_MONTHS = 1;

/**
 * What a site decides about retention: how many calendar months a form submission is kept. No
 * unlimited option and nothing above 24 months; a lower term applies to what is already stored.
 */
export const SiteRetention = z
  .object({
    submissionMonths: z
      .number()
      .int()
      .min(MIN_SUBMISSION_RETENTION_MONTHS)
      .max(MAX_SUBMISSION_RETENTION_MONTHS),
  })
  .strict();
export type SiteRetention = z.infer<typeof SiteRetention>;
export const DEFAULT_RETENTION: SiteRetention = {
  submissionMonths: MAX_SUBMISSION_RETENTION_MONTHS,
};

/**
 * `at` minus `months` calendar months in UTC, same time of day. A day the earlier month lacks
 * becomes its last day: 31 March minus one month is 28 February (29 in a leap year), so a term
 * never runs longer than its months.
 */
export function monthsBefore(at: Date, months: number): Date {
  const first = Date.UTC(at.getUTCFullYear(), at.getUTCMonth() - months, 1);
  const lastDay = new Date(
    Date.UTC(new Date(first).getUTCFullYear(), new Date(first).getUTCMonth() + 1, 0)
  ).getUTCDate();
  const out = new Date(first);
  out.setUTCDate(Math.min(at.getUTCDate(), lastDay));
  out.setUTCHours(
    at.getUTCHours(),
    at.getUTCMinutes(),
    at.getUTCSeconds(),
    at.getUTCMilliseconds()
  );
  return out;
}

/** The moments before which each kind of row has passed its term; a row at the moment stays. */
export interface RetentionCutoffs {
  /** Outbox events with `processed_at` before this. */
  outboxBefore: Date;
  /** Form submissions with `created_at` before this. */
  submissionsBefore: Date;
  /** Admission seats with `admitted_at` at or before this, the window `form.submit` counts with. */
  admissionsThrough: Date;
}

export function retentionCutoffs(now: Date, retention: SiteRetention): RetentionCutoffs {
  return {
    outboxBefore: new Date(now.getTime() - OUTBOX_RETENTION_DAYS * 24 * 60 * 60 * 1000),
    submissionsBefore: monthsBefore(now, retention.submissionMonths),
    admissionsThrough: new Date(now.getTime() - ADMISSION_WINDOW_MS),
  };
}
