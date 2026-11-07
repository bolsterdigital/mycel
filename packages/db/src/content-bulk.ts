// Immutable plans over Postgres, behind the same tenant transaction as content. Composite
// foreign keys bind every resolved base/latest pointer; opaque refused ids resolve to nothing.
import type { Kysely } from 'kysely';
import { BulkPlan, BulkResult, type BulkPlanRepository } from '@mycel/core';
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
    async lock(id) {
      await trx
        .insertInto('content_bulk_runs')
        .expression((eb) =>
          eb
            .selectFrom('content_bulk_plans')
            .select(['tenant_id', 'id as plan_id', eb.val(false).as('undo_requested')])
            .where('tenant_id', '=', tenantId)
            .where('id', '=', id)
        )
        .onConflict((oc) => oc.columns(['tenant_id', 'plan_id']).doNothing())
        .execute();
      const run = await trx
        .selectFrom('content_bulk_runs')
        .select('plan_id')
        .where('tenant_id', '=', tenantId)
        .where('plan_id', '=', id)
        .forUpdate()
        .executeTakeFirst();
      if (!run) return false;
      return true;
    },
    async undoRequested(id) {
      const row = await trx
        .selectFrom('content_bulk_runs')
        .select('undo_requested')
        .where('tenant_id', '=', tenantId)
        .where('plan_id', '=', id)
        .executeTakeFirst();
      return row?.undo_requested ?? false;
    },
    async requestUndo(id) {
      await trx
        .updateTable('content_bulk_runs')
        .set({ undo_requested: true })
        .where('tenant_id', '=', tenantId)
        .where('plan_id', '=', id)
        .execute();
    },
    async result(id, ordinal, phase) {
      const row = await trx
        .selectFrom('content_bulk_effects')
        .select('result')
        .where('tenant_id', '=', tenantId)
        .where('plan_id', '=', id)
        .where('ordinal', '=', ordinal)
        .where('phase', '=', phase)
        .executeTakeFirst();
      return row ? BulkResult.parse(row.result) : null;
    },
    async record(id, ordinal, phase, result) {
      const slot = await trx
        .selectFrom('content_bulk_plan_items')
        .select('item_id')
        .where('tenant_id', '=', tenantId)
        .where('plan_id', '=', id)
        .where('ordinal', '=', ordinal)
        .executeTakeFirstOrThrow();
      const row = {
        tenant_id: tenantId,
        plan_id: id,
        ordinal,
        phase,
        item_id: slot.item_id,
        before_revision_id: result.before?.latestRevisionId ?? null,
        after_revision_id: result.after?.latestRevisionId ?? null,
        result: JSON.stringify(result),
      };
      await trx
        .insertInto('content_bulk_effects')
        .values(row)
        .onConflict((oc) =>
          oc.columns(['tenant_id', 'plan_id', 'ordinal', 'phase']).doUpdateSet(row)
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
