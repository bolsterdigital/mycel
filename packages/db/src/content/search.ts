// The site search over Postgres: `content_search` (0055, 0073) holds, per published locale
// of an item, the tokens core derives from the published revision (`searchEntry`), as config-free
// `tsvector`s, and the access that revision asks for. Kept out of content.ts so that file stays
// one adapter object.
//
// `indexPublished` runs wherever the repository writes an item's publication rows: it removes the
// rows no pointer names any more and adds the ones a pointer names without a row. A revision is
// immutable, so a row never needs an update; a `noindex` revision gets none.
// `searchPublished` joins the publication pointer again and leaves the trash out, so a row that
// stayed behind matches nothing. It matches `body` only where core's `searchOpens` would, stated
// here once more in SQL for the tiers the reader stands in now, and `teaser` everywhere; a public
// row has no teaser, its body is for everyone.
//
// A question becomes a `tsquery` by a cast, not by `to_tsquery`: the tokens are core's already
// (letters and digits only, see `searchTokens`), and a configuration would fold them a second
// time, differently per database locale. Rejected: `plainto_tsquery('simple', q)` (no prefix
// match, and the parser splits `2024-11` where core does not).
//
// `rebuildSearchIndex` writes the index of a whole tenant again from its publication rows: for a
// tenant whose items were published before 0055, for an archive from before 0055 (the import
// calls it when the export has no `content_search`), and for a change of the token rule. It takes
// the row lock of every item it touches, in id order, as a save does for one, so a publication
// running meanwhile waits and then writes its own rows over a finished rebuild. It removes rows
// per locked item, never per tenant: an item first published while the rebuild waits for a lock
// is not in its list, and a tenant-wide delete would take that item's fresh row with it. Rejected:
// one `delete from content_search` for the tenant (it lost exactly that row).

import { sql, type Kysely } from 'kysely';
import {
  searchEntry,
  transcriptTokens,
  type ContentRepository,
  type ContentType,
  type PublishedHit,
} from '@mycel/core';
import type { Database } from '../infra/schema.js';
import { enterTenant } from '../infra/roles.js';
import { readableDocument } from './read-document.js';

/** Brings the index rows of one item in line with its publication rows, already written. */
export async function indexPublished(
  trx: Kysely<Database>,
  tenantId: string,
  itemId: string
): Promise<void> {
  await sql`
    delete from content_search s
    where s.item_id = ${itemId}
      and not exists (select 1 from content_item_locales l
                      where l.item_id = s.item_id and l.locale = s.locale
                        and l.published_revision_id = s.revision_id)`.execute(trx);
  const { rows } = await sql<{ revision_id: string; locale: string; document: unknown }>`
    select r.id as revision_id, l.locale, r.document
    from content_item_locales l
    join content_revisions r on r.id = l.published_revision_id
    where l.item_id = ${itemId}
      and not exists (select 1 from content_search s
                      where s.item_id = l.item_id and s.locale = l.locale)`.execute(trx);
  for (const row of rows) {
    const doc = readableDocument(row.document);
    const entry = doc ? searchEntry(doc, row.locale) : null;
    if (!entry) continue;
    await sql`
      insert into content_search
        (tenant_id, item_id, revision_id, locale, title, body, teaser, access_level, tier_ids)
      values (${tenantId}, ${itemId}, ${row.revision_id}, ${row.locale},
              array_to_tsvector(${entry.title}::text[]), array_to_tsvector(${entry.all}::text[]),
              ${entry.teaser ? sql`array_to_tsvector(${entry.teaser}::text[])` : null},
              ${entry.access.level}, ${entry.access.tierIds}::uuid[])
    `.execute(trx);
  }
}

/**
 * Rebuilds the index of the tenant the transaction entered: the rows of every locked item removed,
 * every published locale indexed again. Returns how many items were looked at and how many rows hold now.
 */
export async function rebuildSearchIndex(
  trx: Kysely<Database>,
  tenantId: string
): Promise<{ items: number; rows: number }> {
  const { rows: items } = await sql<{ id: string }>`
    select i.id from content_items i
    where exists (select 1 from content_item_locales l
                  where l.item_id = i.id and l.published_revision_id is not null)
       or exists (select 1 from content_search s where s.item_id = i.id)
    order by i.id
    for update of i`.execute(trx);
  for (const { id } of items) {
    await sql`delete from content_search where item_id = ${id}`.execute(trx);
    await indexPublished(trx, tenantId, id);
  }
  const { rows } = await sql<{ n: string }>`select count(*) as n from content_search`.execute(trx);
  return { items: items.length, rows: Number(rows[0]?.n ?? 0) };
}

/** `rebuildSearchIndex` for one tenant in a transaction of its own, as `mycel_app`. */
export async function reindexSearch(
  operatorDb: Kysely<Database>,
  tenantId: string
): Promise<{ items: number; rows: number }> {
  return operatorDb.transaction().execute(async (trx) => {
    await enterTenant(trx, tenantId);
    return rebuildSearchIndex(trx, tenantId);
  });
}

interface Row {
  item_id: string;
  type: ContentType;
  slug: string;
  revision_id: string;
  published_at: Date | string;
  in_title: boolean;
}

export function searchPublished(trx: Kysely<Database>): ContentRepository['searchPublished'] {
  return async ({ tokens, locale, reader, libraryId }, offset, limit) => {
    if (!tokens.length) return [];
    // Core's tokens hold letters and digits only, so a quoted lexeme needs no escaping; the
    // quote and backslash are doubled all the same, so this line does not rest on that.
    const query = tokens
      .map((t) => `'${t.replace(/\\/g, '\\\\').replace(/'/g, "''")}':*`)
      .join(' & ');
    // `searchOpens`: public, or a reader and `members`, or a reader standing in one of the tiers.
    const opens = reader
      ? sql`(s.access_level in ('public', 'members')
             or (s.access_level = 'tier' and s.tier_ids && ${[...reader.tierIds]}::uuid[]))`
      : sql`s.access_level = 'public'`;
    // Older archives carry the WebVTT alone. Use the same tokenizer until their next publish.
    const legacy = libraryId
      ? (
          await sql<{ id: string; track: string }>`
      select v.id, v.published_tracks ->> ${locale} as track from managed_videos v
      where v.published_tracks ? ${locale} and not (v.transcript_lexemes ? ${locale})
    `.execute(trx)
        ).rows
      : [];
    const fallback = JSON.stringify(
      Object.fromEntries(legacy.map((row) => [row.id, transcriptTokens(row.track)]))
    );
    const videoBody = libraryId
      ? sql`or (s.access_level = 'public' and exists (
      select 1 from content_block_refs r
      join managed_videos v on v.tenant_id = r.tenant_id and v.id = r.ref_id
      join managed_video_uploads u on u.tenant_id = v.tenant_id and u.video_id = v.id
      cross join lateral jsonb_array_elements_text(coalesce(v.transcript_lexemes -> ${locale}, ${fallback}::jsonb -> v.id::text)) word
      where r.revision_id = s.revision_id and r.type = 'video' and v.has_source and v.trashed_at is null
        and u.state = 'ready' and u.library_id = ${libraryId} and u.provider_id is not null and u.mp4_height > 0
      having (s.body || array_to_tsvector(array_agg(distinct word))) @@ ${query}::tsquery
    ))`
      : sql``;
    const { rows } = await sql<Row>`
      select s.item_id, i.type, i.slug, s.revision_id, l.published_at,
             s.title @@ ${query}::tsquery as in_title
      from content_search s
      join content_item_locales l
        on l.item_id = s.item_id and l.locale = s.locale
       and l.published_revision_id = s.revision_id
      join content_items i on i.id = s.item_id and i.deleted_at is null
      where s.locale = ${locale}
        and ((${opens} and s.body @@ ${query}::tsquery) or s.teaser @@ ${query}::tsquery ${videoBody})
      order by in_title desc, date_trunc('milliseconds', l.published_at) desc, s.item_id asc
      limit ${limit} offset ${offset}
    `.execute(trx);
    return rows.map((r): PublishedHit => ({
      itemId: r.item_id,
      type: r.type,
      slug: r.slug,
      revisionId: r.revision_id,
      publishedAt: new Date(r.published_at),
      inTitle: r.in_title,
    }));
  };
}
