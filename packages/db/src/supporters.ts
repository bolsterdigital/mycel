// Kysely implementation of the supporter log and projection ports, under the tenant's RLS
// context.

import { sql, type Kysely, type Selectable } from 'kysely';
import {
  AccessGrant,
  ERASED_DOMAIN,
  type Ids,
  SupporterEvent,
  type SupporterFilter,
  type SupporterProjection,
  type SupporterRepository,
} from '@mycel/core';
import type { Database } from './infra/schema.js';
import { lockSupporter } from './supporters/lifecycle.js';

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
    // Parsed, not trusted: a grant that no longer reads as one is dropped, so it opens nothing.
    grants: row.grants.flatMap((g) => {
      const grant = AccessGrant.safeParse(g);
      return grant.success ? [grant.data] : [];
    }),
    lastSeenAt: row.last_seen_at === null ? null : new Date(row.last_seen_at).toISOString(),
    appliedThrough: {
      at: new Date(row.applied_through_at).toISOString(),
      id: row.applied_through_id,
    },
  });
  return {
    async lock(email) {
      await lockSupporter(trx, tenantId, email);
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
    // `lists @> array[list]`: confirmed members only; pending ones are in `pending_lists`.
    async members(list, { after, limit }) {
      let query = trx
        .selectFrom('supporters')
        .selectAll()
        .where(sql<boolean>`lists @> array[${list}]::text[]`)
        .orderBy('id')
        .limit(limit);
      if (after) query = query.where('id', '>', after);
      return (await query.execute()).map(toProjection);
    },
    async countMembers(list) {
      const row = await trx
        .selectFrom('supporters')
        .select(sql<string>`count(*)`.as('n'))
        .where(sql<boolean>`lists @> array[${list}]::text[]`)
        .executeTakeFirstOrThrow();
      return Number(row.n);
    },
    // The rules of core `supporters/listing.ts` in SQL; adapter-rules holds the two together.
    // `starts_with` takes the term as a value, so a `%` or `_` in it is a character, not a
    // pattern. The row comparison reads `(last_activity, id) < (edge, id)`: newest first, then
    // the higher id, as `compareSupporters` orders.
    async page(filter: SupporterFilter, { after, limit }) {
      const { list, status, q } = filter;
      let matches = trx
        .selectFrom('supporters')
        .where(
          sql<boolean>`not right(email, ${ERASED_DOMAIN.length + 1}) = ${'@' + ERASED_DOMAIN}`
        );
      if (q) matches = matches.where(sql<boolean>`starts_with(email, ${q})`);
      if (list) {
        const confirmed = sql<boolean>`lists @> array[${list}]::text[]`;
        const pending = sql<boolean>`pending_lists @> array[${list}]::text[]`;
        matches = matches.where(
          status === 'confirmed'
            ? confirmed
            : status === 'pending'
              ? pending
              : sql<boolean>`(${confirmed} or ${pending})`
        );
      }
      const total = await matches.select(sql<string>`count(*)`.as('n')).executeTakeFirstOrThrow();
      let rows = matches
        .selectAll()
        .orderBy('last_activity', 'desc')
        .orderBy('id', 'desc')
        .limit(limit);
      if (after)
        rows = rows.where(
          sql<boolean>`(last_activity, id) < (${after.lastActivity}::timestamptz, ${after.id}::uuid)`
        );
      return { rows: (await rows.execute()).map(toProjection), total: Number(total.n) };
    },
    async saveProjection(p) {
      const values = {
        email: p.email,
        first_seen: p.firstSeen,
        last_activity: p.lastActivity,
        lists: p.lists,
        pending_lists: p.pendingLists,
        grants: JSON.stringify(p.grants),
        last_seen_at: p.lastSeenAt ?? null,
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
