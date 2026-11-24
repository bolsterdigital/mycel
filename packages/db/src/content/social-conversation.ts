// Read the current pointer of each locale, under tenant RLS. Neither the autosave revision nor
// a teaser of restricted content is a source for third-party requests.
import { sql, type Kysely } from 'kysely';
import type { Database } from '../infra/schema.js';

export async function publishedConversationLinks(trx: Kysely<Database>): Promise<string[]> {
  const { rows } = await sql<{ href: string }>`
    select distinct link.href
    from content_item_locales l
    join content_items i on i.tenant_id = l.tenant_id and i.id = l.item_id
    join content_revisions r on r.tenant_id = l.tenant_id and r.id = l.published_revision_id and r.item_id = l.item_id
    cross join lateral jsonb_array_elements(r.document->'blocks') as block(value)
    cross join lateral (values
      (block.value->'props'->'blueskyPost'->>l.locale),
      (block.value->'props'->'mastodonPost'->>l.locale)
    ) as link(href)
    where i.type = 'article' and i.deleted_at is null
      and coalesce(r.document->'access'->>'level', 'public') = 'public'
      and block.value->>'type' = 'social-conversation' and block.value->>'version' = '1'
      and link.href is not null
  `.execute(trx);
  return rows.map((row) => row.href);
}

type Network = 'bluesky' | 'mastodon';
type Key = { network: Network; key: string };
type Counts = { replies?: number; reposts?: number };

export function conversationCache(trx: Kysely<Database>, tenantId: string) {
  const cache = 'social_conversation_counts';
  return {
    async read(keys: readonly Key[], now: Date): Promise<Map<string, Counts>> {
      if (!keys.length) return new Map();
      const rows = await trx
        .selectFrom(cache)
        .select(['post_key', 'replies', 'reposts'])
        .where('tenant_id', '=', tenantId)
        .where('expires_at', '>', now)
        .where((eb) =>
          eb.or(
            keys.map(({ network, key }) =>
              eb.and([eb('network', '=', network), eb('post_key', '=', key)])
            )
          )
        )
        .execute();
      return new Map(
        rows.map((row) => [
          row.post_key,
          {
            ...(row.replies === null ? {} : { replies: row.replies }),
            ...(row.reposts === null ? {} : { reposts: row.reposts }),
          },
        ])
      );
    },
    async refreshOrder() {
      const rows = await trx
        .selectFrom(cache)
        .select(['post_key', 'checked_at'])
        .where('tenant_id', '=', tenantId)
        .execute();
      return new Map(rows.map((row) => [row.post_key, row.checked_at.getTime()]));
    },
    async claim({ network, key }: Key, now: Date, before: Date): Promise<boolean> {
      const row = await trx
        .insertInto(cache)
        .values({
          tenant_id: tenantId,
          network,
          post_key: key,
          checked_at: now,
          expires_at: null,
          replies: null,
          reposts: null,
        })
        .onConflict((oc) =>
          oc
            .columns(['tenant_id', 'network', 'post_key'])
            .doUpdateSet({ checked_at: now })
            .where('social_conversation_counts.checked_at', '<=', before)
        )
        .returning('post_key')
        .executeTakeFirst();
      return row !== undefined;
    },
    async finish({ network, key }: Key, checkedAt: Date, counts: Counts, expiresAt: Date | null) {
      await trx
        .updateTable(cache)
        .set({
          replies: counts.replies ?? null,
          reposts: counts.reposts ?? null,
          expires_at: expiresAt,
        })
        .where('tenant_id', '=', tenantId)
        .where('network', '=', network)
        .where('post_key', '=', key)
        .where('checked_at', '=', checkedAt)
        .execute();
    },
    async prune(before: Date) {
      await trx
        .deleteFrom(cache)
        .where('tenant_id', '=', tenantId)
        .where('checked_at', '<', before)
        .execute();
    },
  };
}
