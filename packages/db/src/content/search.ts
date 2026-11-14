// The site search over Postgres (TODO #42A): `content_search` (0055) holds, per published locale
// of an item, the tokens core derives from the published revision (`searchEntry`), as config-free
// `tsvector`s. Kept out of content.ts so that file stays one adapter object.
//
// `indexPublished` runs wherever the repository writes an item's publication rows: it removes the
// rows no pointer names any more and adds the ones a pointer names without a row. A revision is
// immutable, so a row never needs an update; a restricted or `noindex` revision gets none.
// `searchPublished` joins the publication pointer again and leaves the trash out, so a row that
// stayed behind matches nothing.
//
// A question becomes a `tsquery` by a cast, not by `to_tsquery`: the tokens are core's already
// (letters and digits only, see `searchTokens`), and a configuration would fold them a second
// time, differently per database locale. Rejected: `plainto_tsquery('simple', q)` (no prefix
// match, and the parser splits `2024-11` where core does not).

import { sql, type Kysely } from 'kysely';
import {
  ContentDocument,
  searchEntry,
  type ContentRepository,
  type ContentType,
  type PublishedHit,
} from '@mycel/core';
import type { Database } from '../infra/schema.js';

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
    // A document that no longer validates is not searchable; its page fails on its own.
    const doc = ContentDocument.safeParse(row.document);
    const entry = doc.success ? searchEntry(doc.data, row.locale) : null;
    if (!entry) continue;
    await sql`
      insert into content_search (tenant_id, item_id, revision_id, locale, title, body)
      values (${tenantId}, ${itemId}, ${row.revision_id}, ${row.locale},
              array_to_tsvector(${entry.title}::text[]), array_to_tsvector(${entry.all}::text[]))
    `.execute(trx);
  }
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
  return async ({ tokens, locale }, offset, limit) => {
    if (!tokens.length) return [];
    // Core's tokens hold letters and digits only, so a quoted lexeme needs no escaping; the
    // quote and backslash are doubled all the same, so this line does not rest on that.
    const query = tokens
      .map((t) => `'${t.replace(/\\/g, '\\\\').replace(/'/g, "''")}':*`)
      .join(' & ');
    const { rows } = await sql<Row>`
      select s.item_id, i.type, i.slug, s.revision_id, l.published_at,
             s.title @@ ${query}::tsquery as in_title
      from content_search s
      join content_item_locales l
        on l.item_id = s.item_id and l.locale = s.locale
       and l.published_revision_id = s.revision_id
      join content_items i on i.id = s.item_id and i.deleted_at is null
      where s.locale = ${locale} and s.body @@ ${query}::tsquery
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
