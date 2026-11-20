// The launch checklist's stored state over Postgres (0085, ADR 037 rule 2), in the tenant's
// transaction under RLS. `put` is one upsert on the primary key, so two administrators ticking
// different steps never touch each other's row.

import type { Kysely } from 'kysely';
import type { LaunchStepRecord, LaunchStepRepository } from '@mycel/core';
import type { Database } from '../infra/schema.js';

export function launchStepRepository(
  trx: Kysely<Database>,
  tenantId: string
): LaunchStepRepository {
  return {
    async list() {
      const rows = await trx.selectFrom('launch_steps').selectAll().orderBy('step_id').execute();
      return rows.map((r): LaunchStepRecord => ({
        stepId: r.step_id,
        done: r.done,
        acknowledged: r.acknowledged,
        applicable: r.applicable,
        owner: r.owner,
        note: r.note,
        updatedAt: new Date(r.updated_at),
      }));
    },
    async put(r) {
      const values = {
        done: r.done,
        acknowledged: r.acknowledged,
        applicable: r.applicable,
        owner: r.owner,
        note: r.note,
        updated_at: r.updatedAt,
      };
      await trx
        .insertInto('launch_steps')
        .values({ tenant_id: tenantId, step_id: r.stepId, ...values })
        .onConflict((oc) => oc.columns(['tenant_id', 'step_id']).doUpdateSet(values))
        .execute();
    },
  };
}
