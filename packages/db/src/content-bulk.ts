// Immutable plans over Postgres, behind the same tenant transaction as content. Composite
// foreign keys bind every resolved base/latest pointer; opaque refused ids resolve to nothing.
import type { Kysely } from 'kysely';
import { BulkPlan, type BulkPlanRepository } from '@mycel/core';
import type { Database } from './infra/schema.js';

export function bulkPlanRepository(trx: Kysely<Database>, tenantId: string): BulkPlanRepository {
  return {
    async insert(plan) {
      await trx
        .insertInto('content_bulk_plans')
        .values({
          tenant_id: tenantId,
          item_count: plan.items.length,
          id: plan.id,
          version: plan.version,
          actor: JSON.stringify(plan.actor),
          locale: plan.locale,
          created_at: plan.createdAt,
        })
        .execute();
      await trx
        .insertInto('content_bulk_plan_items')
        .values(
          plan.items.map((item, ordinal) => ({
            tenant_id: tenantId,
            plan_id: plan.id,
            plan_size: plan.items.length,
            ordinal,
            requested_item_id: item.selection.itemId,
            item_id: item.resolvedItemId,
            base_revision_id: item.baseRevisionId,
            latest_revision_id: item.latestRevisionId,
            selection: JSON.stringify(item.selection),
            publication: JSON.stringify(item.publication),
            preview: JSON.stringify(item.preview),
          }))
        )
        .execute();
    },
    async get(id) {
      const plan = await trx
        .selectFrom('content_bulk_plans')
        .selectAll()
        .where('tenant_id', '=', tenantId)
        .where('id', '=', id)
        .executeTakeFirst();
      if (!plan) return null;
      const items = await trx
        .selectFrom('content_bulk_plan_items')
        .selectAll()
        .where('tenant_id', '=', tenantId)
        .where('plan_id', '=', id)
        .orderBy('ordinal')
        .execute();
      return BulkPlan.parse({
        id: plan.id,
        version: plan.version,
        actor: plan.actor,
        locale: plan.locale,
        createdAt: new Date(plan.created_at).toISOString(),
        items: items.map((i) => ({
          selection: i.selection,
          resolvedItemId: i.item_id,
          baseRevisionId: i.base_revision_id,
          latestRevisionId: i.latest_revision_id,
          publication: i.publication,
          preview: i.preview,
        })),
      });
    },
  };
}
