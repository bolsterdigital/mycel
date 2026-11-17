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
import {
  ContentDocument,
  upgradeFaqV1InDocument,
  type ContentRepository,
  type ContentType,
  type PublishedEntry,
} from '@mycel/core';
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
  canonical: string | null;
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
             r.document->'seo'->>'canonical' as canonical,
             case when i.type = 'article' then r.document->>'sectionId' end as section_id,
             coalesce(r.document->'access'->>'level', 'public') as access
      from content_item_locales l
      join content_items i on i.id = l.item_id and i.deleted_at is null
       and i.profile is distinct from 'zone'
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
      canonical: r.canonical,
      sectionId: r.section_id,
      access: r.access,
    }));
  };
}

interface CardRow {
  item_id: string;
  type: ContentType;
  slug: string;
  revision_id: string;
  first_published_at: Date | string;
  document: unknown;
}

/**
 * `ContentRepository.publishedCards`: one query per overview, the published revision's
 * document included so core derives the card (`effectiveOf`) the way every other card does, after
 * projecting a restricted one (`cardDocument`). The filter is on plain values of that document
 * (access level unless `restricted` asks for every level, section, tags), as above; the tag
 * test is jsonb containment, so every tag must be there. A document that no longer parses is left
 * out, as `latestDocuments` does, so one broken row does not empty a homepage. An agenda's test
 * and order are on the published document's event times, plain `YYYY-MM-DDTHH:mm` text, so they
 * compare as text in the byte order (`"C"`) the memory adapter's string comparison uses.
 */
export function publishedCards(trx: Kysely<Database>): ContentRepository['publishedCards'] {
  return async (
    { locale, type, sectionId, authorId, tags, ids, exclude, order, events, restricted },
    offset,
    limit
  ) => {
    if (ids && ids.length === 0) return [];
    const start = sql`(r.document->'event'->>'startsAt') collate "C"`;
    const end = sql`coalesce(r.document->'event'->>'endsAt', r.document->'event'->>'startsAt') collate "C"`;
    const at = events ? start : sql`date_trunc('milliseconds', l.first_published_at)`;
    const direction = (events ? events.when === 'past' : order === 'newest') ? sql`desc` : sql`asc`;
    const { rows } = await sql<CardRow>`
      select l.item_id, i.type, i.slug, r.id as revision_id, l.first_published_at, r.document
      from content_item_locales l
      join content_items i on i.id = l.item_id and i.deleted_at is null
       and i.profile is distinct from 'zone'
      join content_revisions r on r.id = l.published_revision_id
      where l.published_revision_id is not null
        and l.locale = ${locale}
        ${restricted ? sql`` : sql`and coalesce(r.document->'access'->>'level', 'public') = 'public'`}
        ${type ? sql`and i.type = ${type}` : sql``}
        ${sectionId ? sql`and i.type = 'article' and r.document->>'sectionId' = ${sectionId}` : sql``}
        ${authorId ? sql`and i.type = 'article' and r.document->'authorIds' @> ${JSON.stringify([authorId])}::jsonb` : sql``}
        ${tags?.length ? sql`and i.type = 'article' and r.document->'tags' @> ${JSON.stringify(tags)}::jsonb` : sql``}
        ${ids ? sql`and l.item_id = any(${[...ids]}::uuid[])` : sql``}
        ${exclude?.length ? sql`and l.item_id <> all(${[...exclude]}::uuid[])` : sql``}
        ${
          events
            ? sql`and i.type = 'page' and i.profile = 'event' and ${start} is not null
                and ${end} ${events.when === 'upcoming' ? sql`>=` : sql`<`} ${events.now} collate "C"`
            : sql``
        }
      order by ${at} ${direction}, l.item_id asc
      offset ${offset}
      limit ${limit}
    `.execute(trx);
    return rows.flatMap((r) => {
      let document: ContentDocument;
      try {
        document = ContentDocument.parse(upgradeFaqV1InDocument(r.document));
      } catch {
        return [];
      }
      return [
        {
          itemId: r.item_id,
          type: r.type,
          slug: r.slug,
          revisionId: r.revision_id,
          firstPublishedAt: new Date(r.first_published_at),
          document,
        },
      ];
    });
  };
}
