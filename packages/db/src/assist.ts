// Tenant-owned assistance state. The advisory lock covers quota counting plus insert in one
// transaction; counting before insert without it would admit concurrent requests past the cap.

import { sql, type Kysely, type Selectable } from 'kysely';
import type { AssistRepository, AssistSettings, AssistSuggestion } from '@mycel/core';
import type { Database } from './schema.js';

const empty: AssistSettings = {
  enabled: false,
  allowRestricted: false,
  consentedProvider: null,
  consentedBy: null,
  consentedAt: null,
};
type Row = Selectable<Database['assist_suggestions']>;
const date = (value: Date | string) => new Date(value);
const suggestion = (r: Row): AssistSuggestion => ({
  id: r.id,
  itemId: r.item_id,
  baseRevisionId: r.base_revision_id,
  blockId: r.block_id,
  locale: r.locale,
  status: r.status,
  value: r.value,
  failure: r.failure,
  provider: r.provider,
  requestedBy: r.requested_by,
  model: r.model,
  createdAt: date(r.created_at),
  updatedAt: date(r.updated_at),
});

export function assistRepository(trx: Kysely<Database>, tenantId: string): AssistRepository {
  return {
    async settings() {
      const r = await trx
        .selectFrom('assist_settings')
        .selectAll()
        .where('tenant_id', '=', tenantId)
        .executeTakeFirst();
      return r
        ? {
            enabled: r.enabled,
            allowRestricted: r.allow_restricted,
            consentedProvider: r.consented_provider,
            consentedBy: r.consented_by,
            consentedAt: r.consented_at ? date(r.consented_at) : null,
          }
        : { ...empty };
    },
    async saveSettings(s) {
      await trx
        .insertInto('assist_settings')
        .values({
          tenant_id: tenantId,
          enabled: s.enabled,
          allow_restricted: s.allowRestricted,
          consented_provider: s.consentedProvider,
          consented_by: s.consentedBy,
          consented_at: s.consentedAt,
        })
        .onConflict((oc) =>
          oc.column('tenant_id').doUpdateSet({
            enabled: s.enabled,
            allow_restricted: s.allowRestricted,
            consented_provider: s.consentedProvider,
            consented_by: s.consentedBy,
            consented_at: s.consentedAt,
          })
        )
        .execute();
    },
    async lockQuota() {
      await sql`select pg_advisory_xact_lock(hashtextextended(${tenantId}::text, 24))`.execute(trx);
    },
    async countSince(since) {
      const month = since.toISOString().slice(0, 7) + '-01';
      const row = await trx
        .selectFrom('assist_usage')
        .select('count')
        .where('tenant_id', '=', tenantId)
        .where('month', '=', month)
        .executeTakeFirst();
      return row?.count ?? 0;
    },
    async pendingCount(since) {
      const row = await trx
        .selectFrom('assist_suggestions')
        .select(sql<string>`count(*)`.as('n'))
        .where('tenant_id', '=', tenantId)
        .where('status', '=', 'pending')
        .where('created_at', '>=', since)
        .executeTakeFirstOrThrow();
      return Number(row.n);
    },
    async countByOperatorSince(operatorId, since) {
      const row = await trx
        .selectFrom('assist_suggestions')
        .select(sql<string>`count(*)`.as('n'))
        .where('tenant_id', '=', tenantId)
        .where('requested_by', '=', operatorId)
        .where('created_at', '>=', since)
        .executeTakeFirstOrThrow();
      return Number(row.n);
    },
    async insert(s) {
      await trx
        .insertInto('assist_suggestions')
        .values({
          id: s.id,
          tenant_id: tenantId,
          item_id: s.itemId,
          base_revision_id: s.baseRevisionId,
          block_id: s.blockId,
          locale: s.locale,
          status: s.status,
          value: s.value,
          failure: s.failure,
          provider: s.provider,
          requested_by: s.requestedBy,
          model: s.model,
          created_at: s.createdAt,
          updated_at: s.updatedAt,
        })
        .execute();
      const month = s.createdAt.toISOString().slice(0, 7) + '-01';
      await trx
        .insertInto('assist_usage')
        .values({ tenant_id: tenantId, month, count: 1 })
        .onConflict((oc) =>
          oc.columns(['tenant_id', 'month']).doUpdateSet({ count: sql`assist_usage.count + 1` })
        )
        .execute();
    },
    async get(id) {
      const r = await trx
        .selectFrom('assist_suggestions')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirst();
      return r ? suggestion(r) : null;
    },
    async list(itemId) {
      return (
        await trx
          .selectFrom('assist_suggestions')
          .selectAll()
          .where('item_id', '=', itemId)
          .orderBy('created_at', 'desc')
          .limit(100)
          .execute()
      ).map(suggestion);
    },
    async complete(id, patch) {
      const r = await trx
        .updateTable('assist_suggestions')
        .set({
          status: patch.status,
          value: patch.value,
          failure: patch.failure,
          model: patch.model,
          updated_at: patch.updatedAt,
        })
        .where('id', '=', id)
        .where('status', '=', 'pending')
        .returning('id')
        .executeTakeFirst();
      return !!r;
    },
    async decide(id, status, at) {
      const r = await trx
        .updateTable('assist_suggestions')
        .set({ status, value: null, updated_at: at })
        .where('id', '=', id)
        .where('status', 'in', status === 'dismissed' ? ['ready', 'failed', 'pending'] : ['ready'])
        .returning('id')
        .executeTakeFirst();
      return !!r;
    },
    async deleteBefore(before) {
      const rows = await trx
        .deleteFrom('assist_suggestions')
        .where('created_at', '<', before)
        .returning('id')
        .execute();
      const month = before.toISOString().slice(0, 7) + '-01';
      await trx.deleteFrom('assist_usage').where('month', '<', month).execute();
      return rows.length;
    },
  };
}
