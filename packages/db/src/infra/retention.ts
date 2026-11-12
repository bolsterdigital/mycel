// Retention over Postgres (migration 0048; terms in docs/reference/jobs.md § Retention, arithmetic in
// core `ops/retention.ts`): one tenant's rows past their term, deleted as `mycel_retention`
// inside that tenant's transaction, in bounded batches so a backlog never holds one long lock.
// Only the operator connection may enter the role, like `applyErasures`.
//
// A row something still needs stays, whatever its age:
//   * an outbox event stays while a `mail.reconcile` job that is not done names it: the job
//     rebuilds the message from the event (`mailReconcileJob`), and without the event an
//     uncertain attempt could never be settled. An unprocessed event is never a candidate.
//   * a submission stays while an unprocessed outbox event or such a job's event names it, and
//     while a connection intent that is `pending` or `unknown` was planned from it
//     (`formFeedSource.prepare` rereads it). Without it those effects fail closed (no mail, no
//     dispatch), but their outcome at the provider would stay unknown for good.
// A fed submission whose intent is settled goes at its term like any other, also that of a
// readmitted lifecycle: the provider comparison then works from the receipt
// (`applyMailchimpObservation`; ADR 032 rule 3 accepts it as the evidence for a withdrawal).
// A mail intent goes with its event: it holds a keyed digest of the recipient that the erasure
// register finds through the event only, so an intent without its event would be a copy nothing
// can erase any more.
// Rejected: one statement over all tenants as a cross-tenant role (reads every tenant's
// submissions and props), and deleting by age alone (an open effect would lose its source).

import { sql, type Kysely } from 'kysely';
import { systemPrincipal, type RetentionCutoffs } from '@mycel/core';
import { withTenant } from '../index.js';
import type { Database } from './schema.js';
import { setRole } from './roles.js';

/** Rows per transaction; a backlog larger than this takes several. */
export const RETENTION_BATCH = 500;

export interface RetentionResult {
  outbox: number;
  mailIntents: number;
  submissions: number;
  admissions: number;
}

type Trx = Kysely<Database>;

const asRetention = <T>(
  operatorDb: Kysely<Database>,
  tenantId: string,
  fn: (trx: Trx) => Promise<T>
): Promise<T> =>
  withTenant(operatorDb, systemPrincipal(tenantId, 'retention'), async (trx) => {
    try {
      await setRole(trx, 'mycel_retention');
    } catch (e) {
      throw new Error(
        'retention can only be applied on the operator connection (the worker), ' +
          `not as the fronts' login: ${(e as Error).message}`
      );
    }
    return fn(trx);
  });

/** Whether an open `mail.reconcile` job of this tenant still reads the outbox event `o`. */
const NEEDED = sql`exists (
  select 1 from jobs j
  where j.type = 'mail.reconcile' and j.done_at is null and j.payload->>'eventId' = o.id::text)`;

async function outboxBatch(
  trx: Trx,
  before: Date,
  limit: number
): Promise<{ outbox: number; mailIntents: number }> {
  const { rows } = await sql<{ id: string }>`
    delete from outbox where id in (
      select o.id from outbox o
      where o.processed_at < ${before} and not ${NEEDED}
      order by o.processed_at limit ${limit}
    ) returning id`.execute(trx);
  if (!rows.length) return { outbox: 0, mailIntents: 0 };
  // A second statement on purpose: the policy lets an intent go only once its event is gone,
  // and a data-modifying CTE would still see the event in its snapshot.
  const intents = await sql`
    delete from mail_sends where event_id = any(${rows.map((r) => r.id)}::uuid[])`.execute(trx);
  return { outbox: rows.length, mailIntents: Number(intents.numAffectedRows ?? 0n) };
}

async function submissionBatch(trx: Trx, before: Date, limit: number): Promise<number> {
  const result = await sql`
    delete from form_submissions where id in (
      select s.id from form_submissions s
      where s.created_at < ${before}
        and not exists (
          select 1 from outbox o
          where o.props->>'submissionId' = s.id::text
            and (o.processed_at is null or ${NEEDED})
        )
        and not exists (
          select 1 from connection_intents i
          where i.state in ('pending', 'unknown')
            and s.evaluation->'feedActions'
                @> jsonb_build_array(jsonb_build_object('businessId', i.business_id::text))
        )
      order by s.created_at limit ${limit}
    )`.execute(trx);
  return Number(result.numAffectedRows ?? 0n);
}

/**
 * Delete what passed its term for one tenant and return how much went. Idempotent: a second run
 * with the same cut-offs finds nothing. `batch` is for the tests; the worker uses the default.
 */
export async function applyRetention(
  operatorDb: Kysely<Database>,
  tenantId: string,
  cutoffs: RetentionCutoffs,
  batch = RETENTION_BATCH
): Promise<RetentionResult> {
  const total: RetentionResult = { outbox: 0, mailIntents: 0, submissions: 0, admissions: 0 };
  for (;;) {
    const got = await asRetention(operatorDb, tenantId, (trx) =>
      outboxBatch(trx, cutoffs.outboxBefore, batch)
    );
    total.outbox += got.outbox;
    total.mailIntents += got.mailIntents;
    if (got.outbox < batch) break;
  }
  for (;;) {
    const got = await asRetention(operatorDb, tenantId, (trx) =>
      submissionBatch(trx, cutoffs.submissionsBefore, batch)
    );
    total.submissions += got;
    if (got < batch) break;
  }
  total.admissions = await asRetention(operatorDb, tenantId, async (trx) => {
    const gone = await trx
      .deleteFrom('supporter_admissions')
      .where('admitted_at', '<=', cutoffs.admissionsThrough)
      .executeTakeFirst();
    return Number(gone.numDeletedRows);
  });
  return total;
}
