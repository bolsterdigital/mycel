// Campaigns over Postgres (0049). The participation window and state are columns, so the database
// enforces an end after the start and no open archived campaign; the goal is a validated document
// and stays jsonb. `insert` uses `on conflict do nothing` for the two binding keys, so a lost race
// answers false instead of aborting the transaction. Rejected: the whole campaign as one jsonb
// column, which would leave the keys and checks to the application alone.
import { sql, type Kysely, type Selectable } from 'kysely';
import { Campaign, type CampaignRepository } from '@mycel/core';
import type { Database } from '../infra/schema.js';
import { toIso } from '../infra/dates.js';

type Row = Selectable<Database['campaigns']>;

function read(row: Row): Campaign {
  return Campaign.parse({
    id: row.id,
    kind: row.kind,
    landingItemId: row.landing_item_id,
    formId: row.form_id,
    participation: {
      state: row.participation_state,
      opensAt: toIso(row.opens_at),
      closesAt: toIso(row.closes_at),
    },
    goal: row.goal ?? null,
    counterVisible: row.counter_visible,
    erasedCount: row.erased_count,
    archivedAt: toIso(row.archived_at),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  });
}

/** Everything a write may change; `erased_count` is the erasure's, never a use case's. */
const fields = (c: Campaign) => ({
  form_id: c.formId,
  participation_state: c.participation.state,
  opens_at: c.participation.opensAt,
  closes_at: c.participation.closesAt,
  goal: c.goal === null ? null : JSON.stringify(c.goal),
  counter_visible: c.counterVisible,
  archived_at: c.archivedAt,
  updated_at: c.updatedAt,
});

export function campaignRepository(trx: Kysely<Database>, tenantId: string): CampaignRepository {
  const rows = () => trx.selectFrom('campaigns').selectAll();
  const one = async (q: ReturnType<typeof rows>) => {
    const row = await q.executeTakeFirst();
    return row ? read(row) : null;
  };
  return {
    get: (id) => one(rows().where('id', '=', id)),
    lock: (id) => one(rows().where('id', '=', id).forUpdate()),
    byLandingItem: (itemId) => one(rows().where('landing_item_id', '=', itemId)),
    byForm: (formId) => one(rows().where('form_id', '=', formId)),
    async list({ kind, archived }, offset, limit) {
      let q = rows().where(sql<boolean>`(archived_at is not null) = ${archived}`);
      if (kind) q = q.where('kind', '=', kind);
      const found = await q
        .orderBy('created_at', 'desc')
        .orderBy('id', 'desc')
        .offset(offset)
        .limit(limit)
        .execute();
      return found.map(read);
    },
    async insert(c) {
      const result = await trx
        .insertInto('campaigns')
        .values({
          id: c.id,
          tenant_id: tenantId,
          kind: c.kind,
          landing_item_id: c.landingItemId,
          erased_count: c.erasedCount,
          created_at: c.createdAt,
          ...fields(c),
        })
        .onConflict((oc) => oc.doNothing())
        .returning('id')
        .executeTakeFirst();
      return result !== undefined;
    },
    async update(c, base) {
      const result = await trx
        .updateTable('campaigns')
        .set(fields(c))
        .where('id', '=', c.id)
        .where('updated_at', '=', new Date(base))
        .executeTakeFirst();
      return result.numUpdatedRows === 1n;
    },
  };
}
