// Durable local readmission, under the same hashed address lock as ingest and erase (ADR 032).
// Rejected: trusting a queue timestamp, or allowing an old submission to open a new identity.
import type { Kysely } from 'kysely';
import {
  emailKey,
  admissionFor,
  allowsLifecycle,
  type SupporterLifecycle,
  type ErasureBoundary,
} from '@mycel/core';
import type { Database } from '../infra/schema.js';
import { advisoryLock } from '../infra/roles.js';

export const lockSupporter = async (trx: Kysely<Database>, tenantId: string, email: string) =>
  advisoryLock(trx, 'supporter', tenantId, await emailKey(tenantId, email, 'erasure'));

export async function lifecycleEvidence(trx: Kysely<Database>) {
  const registrations: ErasureBoundary[] = (
    await trx.selectFrom('erasures').selectAll().execute()
  ).map((r) => ({ supporterId: r.supporter_id, emailHash: r.email_hash, erasedAt: r.erased_at }));
  const lifecycles: SupporterLifecycle[] = (
    await trx.selectFrom('supporter_lifecycles').selectAll().execute()
  ).map((r) => ({
    id: r.id,
    emailHash: r.email_hash,
    submissionId: r.submission_id,
    startedAt: r.started_at,
  }));
  return { registrations, lifecycles };
}

export function lifecycleRepository(trx: Kysely<Database>, tenantId: string) {
  return {
    async admit(email: string, submissionId: string, at: Date) {
      await lockSupporter(trx, tenantId, email);
      const hash = await emailKey(tenantId, email, 'erasure');
      const { registrations, lifecycles } = await lifecycleEvidence(trx);
      const id = admissionFor(hash, submissionId, at, registrations, lifecycles);
      if (!id || lifecycles.some((l) => l.id === id)) return id;
      await trx
        .insertInto('supporter_lifecycles')
        .values({
          tenant_id: tenantId,
          id,
          email_hash: hash,
          submission_id: submissionId,
          started_at: at,
        })
        .execute();
      return id;
    },
    async allows(email: string, lifecycleId?: string) {
      const hash = await emailKey(tenantId, email, 'erasure');
      const { registrations, lifecycles } = await lifecycleEvidence(trx);
      return allowsLifecycle(hash, lifecycleId, registrations, lifecycles);
    },
  };
}
