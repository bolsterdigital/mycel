// Kysely implementation of the supporter log and projection ports, under the tenant's RLS
// context.

import { type Kysely, type Selectable } from 'kysely';
import {
  type Ids,
  SupporterEvent,
  type SupporterProjection,
  type SupporterRepository,
} from '@mycel/core';
import type { Database } from './infra/schema.js';
import { advisoryLock } from './infra/roles.js';

type Trx = Kysely<Database>;

/**
 * Supporter log and projection (ADR 003, ADR 019). `lock` takes a transaction-scoped advisory
 * lock per (tenant, address); rejected: `select ... for update` on the projection row, which does
 * not exist yet for a first event, so two first events would both create a supporter.
 */
export function supporterRepository(trx: Trx, tenantId: string, ids: Ids): SupporterRepository {
  const toProjection = (row: Selectable<Database['supporters']>): SupporterProjection => ({
    id: row.id,
    email: row.email,
    firstSeen: new Date(row.first_seen).toISOString(),
    lastActivity: new Date(row.last_activity).toISOString(),
    lists: row.lists,
    pendingLists: row.pending_lists,
    appliedThrough: {
      at: new Date(row.applied_through_at).toISOString(),
      id: row.applied_through_id,
    },
  });
  return {
    async lock(email) {
      await advisoryLock(trx, 'supporter', tenantId, email);
    },
    async resolve(email) {
      const row = await trx
        .selectFrom('supporters')
        .select('id')
        .where('email', '=', email)
        .executeTakeFirst();
      return row ? { id: row.id, isNew: false } : { id: ids.next(), isNew: true };
    },
    async appendEvent(e) {
      const inserted = await trx
        .insertInto('events')
        .values({
          tenant_id: tenantId,
          id: e.id,
          supporter_id: e.supporter_id,
          schema: e.schema,
          type: e.type,
          email: e.email,
          occurred_at: e.occurred_at,
          source: e.source,
          source_site: e.source_site,
          source_ref: e.source_ref,
          props: JSON.stringify(e.props),
        })
        // The key includes occurred_at (partitioning); the id hashes it, so this is dedup on id.
        .onConflict((oc) => oc.columns(['tenant_id', 'id', 'occurred_at']).doNothing())
        .returning('id')
        .executeTakeFirst();
      return inserted !== undefined;
    },
    async eventsFor(supporterId) {
      const rows = await trx
        .selectFrom('events')
        .selectAll()
        .where('supporter_id', '=', supporterId)
        .orderBy('occurred_at')
        .orderBy('id')
        .execute();
      return rows.map((r) =>
        SupporterEvent.parse({ ...r, occurred_at: new Date(r.occurred_at).toISOString() })
      );
    },
    async getProjection(email) {
      const row = await trx
        .selectFrom('supporters')
        .selectAll()
        .where('email', '=', email)
        .executeTakeFirst();
      return row ? toProjection(row) : null;
    },
    async getProjectionById(id) {
      const row = await trx
        .selectFrom('supporters')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirst();
      return row ? toProjection(row) : null;
    },
    async saveProjection(p) {
      const values = {
        email: p.email,
        first_seen: p.firstSeen,
        last_activity: p.lastActivity,
        lists: p.lists,
        pending_lists: p.pendingLists,
        applied_through_at: p.appliedThrough.at,
        applied_through_id: p.appliedThrough.id,
        updated_at: new Date(),
      };
      await trx
        .insertInto('supporters')
        .values({ tenant_id: tenantId, id: p.id, ...values })
        .onConflict((oc) => oc.columns(['tenant_id', 'id']).doUpdateSet(values))
        .execute();
    },
  };
}
