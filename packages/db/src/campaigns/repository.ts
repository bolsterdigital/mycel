// Campaigns over Postgres (0049). The participation window and state are columns, so the database
// enforces an end after the start and no open archived campaign; the goal is a validated document
// and stays jsonb. `insert` uses `on conflict do nothing` for the two binding keys, so a lost race
// answers false instead of aborting the transaction. Rejected: the whole campaign as one jsonb
// column, which would leave the keys and checks to the application alone.
import { sql, type Kysely, type Selectable } from 'kysely';
import { Campaign, type CampaignParticipation, type CampaignRepository } from '@mycel/core';
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
    shareByForm: (formId) => one(rows().where('form_id', '=', formId).forShare()),
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
    // One statement: insert, or renew a withdrawn row; an active row stays as it is. `xmax = 0`
    // tells an insert from an update without a second read.
    async recordParticipation(p) {
      const row = await sql<{ inserted: boolean }>`
        insert into campaign_participations
          (tenant_id, campaign_id, supporter_id, submission_id, confirmed_at)
        values (${tenantId}, ${p.campaignId}, ${p.supporterId}, ${p.submissionId}, ${p.confirmedAt})
        on conflict (tenant_id, campaign_id, supporter_id) do update
          set submission_id = excluded.submission_id,
              confirmed_at = excluded.confirmed_at,
              withdrawn_at = null
          where campaign_participations.withdrawn_at is not null
        returning (xmax = 0) as inserted`.execute(trx);
      const first = row.rows[0];
      return !first ? 'unchanged' : first.inserted ? 'inserted' : 'renewed';
    },
    async withdrawParticipation(campaignId, supporterId, at) {
      const result = await trx
        .updateTable('campaign_participations')
        .set({ withdrawn_at: at })
        .where('campaign_id', '=', campaignId)
        .where('supporter_id', '=', supporterId)
        .where('withdrawn_at', 'is', null)
        .executeTakeFirst();
      return result.numUpdatedRows === 1n;
    },
    async participation(campaignId, supporterId): Promise<CampaignParticipation | null> {
      const row = await trx
        .selectFrom('campaign_participations')
        .selectAll()
        .where('campaign_id', '=', campaignId)
        .where('supporter_id', '=', supporterId)
        .executeTakeFirst();
      return row
        ? {
            campaignId: row.campaign_id,
            supporterId: row.supporter_id,
            submissionId: row.submission_id,
            confirmedAt: toIso(row.confirmed_at)!,
            withdrawnAt: toIso(row.withdrawn_at),
          }
        : null;
    },
    async activeCounts(ids) {
      if (!ids.length) return new Map();
      const found = await trx
        .selectFrom('campaign_participations')
        .select(['campaign_id', sql<number>`count(*)::int`.as('n')])
        .where('campaign_id', 'in', [...ids])
        .where('withdrawn_at', 'is', null)
        .groupBy('campaign_id')
        .execute();
      return new Map(found.map((r) => [r.campaign_id, r.n]));
    },
  };
}
