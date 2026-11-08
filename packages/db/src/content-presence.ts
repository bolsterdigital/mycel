// Presence over Postgres (ADR 029, migration 0038). The upsert keeps one row per actor, item and
// tab; the actor is in the key, so one account cannot overwrite another's row with a guessed
// session id.
import { sql, type Kysely } from 'kysely';
import { Actor, PRESENCE_READ_LIMIT, auditActor, type PresenceRepository } from '@mycel/core';
import type { Database } from './infra/schema.js';

export function presenceRepository(trx: Kysely<Database>, tenantId: string): PresenceRepository {
  return {
    async beat({ itemId, sessionId, actor, state, lastSeenAt }) {
      const { kind, id } = auditActor(actor);
      await trx
        .insertInto('content_presence')
        .values({
          tenant_id: tenantId,
          item_id: itemId,
          actor_kind: kind,
          actor_id: id ?? '',
          session_id: sessionId,
          actor: JSON.stringify(actor),
          state,
          last_seen_at: lastSeenAt,
        })
        .onConflict((c) =>
          c.columns(['tenant_id', 'item_id', 'actor_kind', 'actor_id', 'session_id']).doUpdateSet({
            actor: sql`excluded.actor`,
            state: sql`excluded.state`,
            last_seen_at: sql`excluded.last_seen_at`,
          })
        )
        .execute();
    },
    async active(itemId, since) {
      const rows = await trx
        .selectFrom('content_presence')
        .select(['item_id', 'session_id', 'actor', 'state', 'last_seen_at'])
        .where('tenant_id', '=', tenantId)
        .where('item_id', '=', itemId)
        .where('last_seen_at', '>', since)
        .orderBy('last_seen_at', 'desc')
        .limit(PRESENCE_READ_LIMIT)
        .execute();
      return rows.map((r) => ({
        itemId: r.item_id,
        sessionId: r.session_id,
        actor: Actor.parse(r.actor),
        state: r.state === 'editing' ? 'editing' : 'viewing',
        lastSeenAt: r.last_seen_at,
      }));
    },
  };
}
