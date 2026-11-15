// `ContentRepository.listPublished` over Postgres: one row per published locale, read
// from the publication pointer in `content_item_locales` (0011) and the revision it names, in the
// order of core's `comparePublished`. Kept out of content.ts so that file stays one adapter object.
//
// The timestamp is compared and ordered at millisecond precision, the precision of the cursor and
// of a JS Date, and the locale in the "C" collation, the code-point order of the memory adapter;
// item ids are uuids, which Postgres orders bytewise like their lowercase text. `noindex`, the
// section and the access level are read from the published revision's document without parsing
// it: a list must not fail on one row (as `latestDocuments`), and these three are plain values.
// Rejected: a join on `latest_revision_id` (a later draft would decide) and parsing every
// document with core's schema (a whole document per row for three fields).

import { sql, type Kysely } from 'kysely';
import type { ContentRepository, ContentType, PublishedEntry } from '@mycel/core';
import type { Database } from '../infra/schema.js';

type Access = PublishedEntry['access'];

interface Row {
  item_id: string;
  type: ContentType;
  slug: string;
  locale: string;
  locales: string[];
  revision_id: string;
  published_at: Date | string;
  updated_at: Date | string;
  noindex: boolean;
  section_id: string | null;
  access: Access;
}

export function listPublished(trx: Kysely<Database>): ContentRepository['listPublished'] {
  return async ({ type, sectionId }, after, limit) => {
    const at = sql`date_trunc('milliseconds', l.published_at)`;
    const position = after
      ? sql`and (${at} < ${after.publishedAt}
              or (${at} = ${after.publishedAt}
                  and (l.item_id > ${after.itemId}::uuid
                       or (l.item_id = ${after.itemId}::uuid
                           and l.locale collate "C" > ${after.locale}))))`
      : sql``;
    const { rows } = await sql<Row>`
      select l.item_id, i.type, i.slug, l.locale,
             array(select p.locale from content_item_locales p
                   where p.item_id = i.id and p.published_revision_id is not null
                   order by array_position(i.locales, p.locale)) as locales,
             r.id as revision_id, l.published_at, r.created_at as updated_at,
             coalesce((r.document->'seo'->>'noindex')::boolean, false) as noindex,
             case when i.type = 'article' then r.document->>'sectionId' end as section_id,
             coalesce(r.document->'access'->>'level', 'public') as access
      from content_item_locales l
      join content_items i on i.id = l.item_id and i.deleted_at is null
      join content_revisions r on r.id = l.published_revision_id
      where l.published_revision_id is not null
        ${type ? sql`and i.type = ${type}` : sql``}
        ${sectionId ? sql`and i.type = 'article' and r.document->>'sectionId' = ${sectionId}` : sql``}
        ${position}
      order by ${at} desc, l.item_id asc, l.locale collate "C" asc
      limit ${limit}
    `.execute(trx);
    return rows.map((r): PublishedEntry => ({
      itemId: r.item_id,
      type: r.type,
      slug: r.slug,
      locale: r.locale,
      locales: r.locales,
      revisionId: r.revision_id,
      publishedAt: new Date(r.published_at),
      updatedAt: new Date(r.updated_at),
      noindex: r.noindex,
      sectionId: r.section_id,
      access: r.access,
    }));
  };
}
