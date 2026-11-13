// The person register of ADR 034 over Postgres (migration 0050), and the person phase of
// `ctx.erasures.apply()`. `register` appends as mycel_app under the tenant's person-erasure lock
// taken exclusively; every write that stores a credit takes the same lock shared (`guard`) before
// it reads the register, so a registration and such a write serialise and a write that commits
// after the registration never stores the name (rule 4). Fronts run at read committed, so the
// read after the lock sees the registration that held it.
//
// The phase runs as mycel_erasure inside the apply transaction: it deletes the people and their
// memberships and runs core's credit scrub over every stored copy that mentions a registered id
// (revisions, patterns, plan slots, media credits), writing back only the rows the scrub changed.
// Rejected: a scrub in SQL (jsonb paths per block type would miss a new image slot; core's scrub
// recognises a credit by its shape) and a table-wide rewrite (it would touch every revision).

import { sql, type Kysely } from 'kysely';
import {
  scrubErasedChanges,
  scrubErasedCredits,
  type Clock,
  type PersonErasureRepository,
  type Principal,
  storedActor,
} from '@mycel/core';
import type { Database } from '../infra/schema.js';
import { advisoryLock, advisoryLockShared } from '../infra/roles.js';

type Trx = Kysely<Database>;

export function personErasureRepository(
  trx: Trx,
  tenantId: string,
  principal: Principal,
  clock: Clock
): PersonErasureRepository {
  return {
    async register(personIds) {
      await advisoryLock(trx, 'person-erasure', tenantId);
      if (!personIds.length) return [];
      const at = clock.now();
      const rows = await trx
        .insertInto('person_erasures')
        .values(
          personIds.map((person_id) => ({
            tenant_id: tenantId,
            person_id,
            erased_at: at,
            actor: JSON.stringify(storedActor(principal.actor)),
          }))
        )
        .onConflict((oc) => oc.columns(['tenant_id', 'person_id']).doNothing())
        .returning('person_id')
        .execute();
      return rows.map((r) => r.person_id);
    },

    guard: () => advisoryLockShared(trx, 'person-erasure', tenantId),

    async registered(ids) {
      const list = [...new Set(ids)];
      if (!list.length) return new Set();
      const rows = await trx
        .selectFrom('person_erasures')
        .select('person_id')
        .where('person_id', 'in', list)
        .execute();
      return new Set(rows.map((r) => r.person_id));
    },

    async get(personId) {
      const row = await trx
        .selectFrom('person_erasures')
        .select('erased_at')
        .where('person_id', '=', personId)
        .executeTakeFirst();
      return row ? { registeredAt: row.erased_at } : null;
    },
  };
}

/**
 * The person phase, as mycel_erasure in the caller's tenant transaction. Returns the rows it
 * changed; a second run changes none.
 */
export async function applyPersonErasures(trx: Trx): Promise<number> {
  const ids = (await trx.selectFrom('person_erasures').select('person_id').execute()).map(
    (r) => r.person_id
  );
  if (!ids.length) return 0;
  const erased = new Set(ids);
  // A uuid has no LIKE wildcard, so each id is its own exact substring pattern. ILIKE, because a
  // stored copy may spell the id in upper case (the input accepts it, `uuid` compares regardless);
  // core's scrub compares the same way (`canonicalPersonId`).
  const mentions = ids.map((id) => `%${id}%`);
  let changed = 0;
  const count = (r: { numAffectedRows?: bigint; numDeletedRows?: bigint }) =>
    (changed += Number(r.numAffectedRows ?? r.numDeletedRows ?? 0n));

  count(
    await trx.deleteFrom('person_group_members').where('person_id', 'in', ids).executeTakeFirst()
  );
  count(await trx.deleteFrom('people').where('id', 'in', ids).executeTakeFirst());

  const revisions = await sql<{ id: string; document: unknown }>`
    select id, document from content_revisions
    where document::text ilike any(${mentions}::text[])`.execute(trx);
  for (const row of revisions.rows) {
    const document = scrubErasedCredits(row.document, erased);
    if (document !== row.document)
      count(
        await sql`update content_revisions set document = ${JSON.stringify(document)}::jsonb
                  where id = ${row.id}`.execute(trx)
      );
  }
  const patterns = await sql<{ id: string; blocks: unknown }>`
    select id, blocks from patterns where blocks::text ilike any(${mentions}::text[])`.execute(trx);
  for (const row of patterns.rows) {
    const blocks = scrubErasedCredits(row.blocks, erased);
    if (blocks !== row.blocks)
      count(
        await sql`update patterns set blocks = ${JSON.stringify(blocks)}::jsonb
                  where id = ${row.id}`.execute(trx)
      );
  }
  const slots = await sql<{
    plan_id: string;
    ordinal: number;
    selection: unknown;
    preview: { candidate: unknown; changes: import('@mycel/core').Change[] } & Record<
      string,
      unknown
    >;
  }>`
    select plan_id, ordinal, selection, preview from content_bulk_plan_items
    where selection::text ilike any(${mentions}::text[])
       or preview::text ilike any(${mentions}::text[])`.execute(trx);
  for (const row of slots.rows) {
    const selection = scrubErasedCredits(row.selection, erased);
    const candidate = scrubErasedCredits(row.preview.candidate, erased);
    const changes = scrubErasedChanges(row.preview.changes ?? [], candidate, erased);
    if (
      selection !== row.selection ||
      candidate !== row.preview.candidate ||
      changes !== row.preview.changes
    )
      count(
        await sql`update content_bulk_plan_items
                  set selection = ${JSON.stringify(selection)}::jsonb,
                      preview = ${JSON.stringify({ ...row.preview, candidate, changes })}::jsonb
                  where plan_id = ${row.plan_id} and ordinal = ${row.ordinal}`.execute(trx)
      );
  }
  const media = await sql<{ id: string; credit: unknown }>`
    select id, credit from media where credit::text ilike any(${mentions}::text[])`.execute(trx);
  for (const row of media.rows) {
    const credit = scrubErasedCredits(row.credit, erased);
    if (credit !== row.credit)
      count(
        await sql`update media set credit = ${JSON.stringify(credit)}::jsonb
                  where id = ${row.id}`.execute(trx)
      );
  }
  return changed;
}
