// Content repositories over Postgres (TODO #8a, migration 0011): items with their per-locale
// publication rows, immutable revisions, and the author, section and pattern entities. All run
// in a use case's tenant transaction as mycel_app under RLS.
//
// `lock` is `select ... for update` on the item row: every write and the scheduled-publish job
// take it first, so concurrent saves on one base serialise and the second sees the new latest
// revision. Revisions are parsed with core's schema on read, so a stored document that no longer
// validates fails loudly instead of reaching a renderer. Rejected: an advisory lock (the item row
// exists before any write, so a row lock is enough and shows up in pg_locks under its table).

import { sql, type Kysely, type Selectable } from 'kysely';
import {
  Actor,
  Author,
  documentReferences,
  Pattern,
  Revision,
  Section,
  upgradeFaqV1InDocument,
  type ContentRepository,
  type EntityRepository,
  type ItemRecord,
  type LocaleState,
  type Paged,
  type RevisionSummary,
  type SluggedRepository,
} from '@mycel/core';
import type { Database } from './infra/schema.js';

type Trx = Kysely<Database>;
type ItemRow = Selectable<Database['content_items']>;
type LocaleRow = Selectable<Database['content_item_locales']>;

const date = (v: Date | string | null): Date | null => (v === null ? null : new Date(v));
const iso = (v: Date | string): string => new Date(v).toISOString();

/** Keyset page: `limit + 1` rows were fetched, newest first. */
function paged<T extends { id: string }>(rows: T[], limit: number): Paged<T> {
  const page = rows.slice(0, limit);
  return { rows: page, next: rows.length > limit ? (page.at(-1)?.id ?? null) : null };
}

const toLocale = (r: LocaleRow): LocaleState => ({
  locale: r.locale,
  publishedRevisionId: r.published_revision_id,
  publishedAt: date(r.published_at),
  firstPublishedAt: date(r.first_published_at),
  scheduledRevisionId: r.scheduled_revision_id,
  scheduledFor: date(r.scheduled_for),
  scheduleId: r.schedule_id,
});

export function contentRepository(trx: Trx, tenantId: string): ContentRepository {
  /** Items with their locale rows, in the item's locale order. */
  async function withLocales(rows: ItemRow[]): Promise<ItemRecord[]> {
    if (!rows.length) return [];
    const locales = await trx
      .selectFrom('content_item_locales')
      .selectAll()
      .where(
        'item_id',
        'in',
        rows.map((r) => r.id)
      )
      .execute();
    return rows.map((r) => ({
      id: r.id,
      type: r.type,
      slug: r.slug,
      title: r.title,
      defaultLocale: r.default_locale,
      locales: r.locales,
      latestRevisionId: r.latest_revision_id,
      createdAt: new Date(r.created_at),
      updatedAt: new Date(r.updated_at),
      publication: r.locales.flatMap((l) => {
        const row = locales.find((x) => x.item_id === r.id && x.locale === l);
        return row ? [toLocale(row)] : [];
      }),
    }));
  }
  const one = async (rows: ItemRow[]) => (await withLocales(rows))[0] ?? null;
  const items = () => trx.selectFrom('content_items').selectAll();

  async function writeLocales(item: ItemRecord): Promise<void> {
    for (const s of item.publication) {
      const values = {
        published_revision_id: s.publishedRevisionId,
        published_at: s.publishedAt,
        first_published_at: s.firstPublishedAt,
        scheduled_revision_id: s.scheduledRevisionId,
        scheduled_for: s.scheduledFor,
        schedule_id: s.scheduleId,
      };
      await trx
        .insertInto('content_item_locales')
        .values({ tenant_id: tenantId, item_id: item.id, locale: s.locale, ...values })
        .onConflict((oc) => oc.columns(['tenant_id', 'item_id', 'locale']).doUpdateSet(values))
        .execute();
    }
    await trx
      .deleteFrom('content_item_locales')
      .where('item_id', '=', item.id)
      .where(
        'locale',
        'not in',
        item.publication.map((s) => s.locale)
      )
      .execute();
  }

  const insertRevision = async (r: Revision) => {
    await trx
      .insertInto('content_revisions')
      .values({
        id: r.id,
        tenant_id: tenantId,
        item_id: r.itemId,
        document: JSON.stringify(r.document),
        provenance: r.provenance ? JSON.stringify(r.provenance) : null,
        actor: JSON.stringify(r.actor),
        created_at: r.createdAt,
      })
      .execute();
    const refs = documentReferences(r.document);
    if (refs.length)
      await trx
        .insertInto('content_block_refs')
        .values(
          refs.map((ref) => ({
            tenant_id: tenantId,
            item_id: r.itemId,
            revision_id: r.id,
            block_id: ref.blockId,
            type: ref.type,
            ref_id: ref.refId,
          }))
        )
        .execute();
  };

  /** The revisions find searches: the latest, or every one a locale publishes. */
  const searched = (live: boolean) =>
    live
      ? sql<boolean>`r.id in (select l.published_revision_id from content_item_locales l
                              where l.item_id = i.id)`
      : sql<boolean>`r.id = i.latest_revision_id`;

  return {
    lock: async (itemId) => one(await items().where('id', '=', itemId).forUpdate().execute()),
    get: async (itemId) => one(await items().where('id', '=', itemId).execute()),
    findBySlug: async (type, slug) =>
      one(await items().where('type', '=', type).where('slug', '=', slug).execute()),
    async list({ type, slug }, after, limit) {
      let q = items();
      if (type) q = q.where('type', '=', type);
      if (slug) q = q.where('slug', '=', slug);
      if (after) q = q.where('id', '<', after);
      const rows = await q
        .orderBy('id', 'desc')
        .limit(limit + 1)
        .execute();
      const page = paged(rows, limit);
      return { rows: await withLocales(page.rows), next: page.next };
    },
    async insert(item, first) {
      await trx
        .insertInto('content_items')
        .values({
          id: item.id,
          tenant_id: tenantId,
          type: item.type,
          slug: item.slug,
          title: JSON.stringify(item.title),
          default_locale: item.defaultLocale,
          locales: item.locales,
          latest_revision_id: item.latestRevisionId,
          created_at: item.createdAt,
          updated_at: item.updatedAt,
        })
        .execute();
      await insertRevision(first);
      await writeLocales(item);
    },
    async save(item) {
      await trx
        .updateTable('content_items')
        .set({
          title: JSON.stringify(item.title),
          default_locale: item.defaultLocale,
          locales: item.locales,
          latest_revision_id: item.latestRevisionId,
          updated_at: item.updatedAt,
        })
        .where('id', '=', item.id)
        .execute();
      await writeLocales(item);
    },
    insertRevision,
    async find({ blockType, ref, live, type }, after, limit) {
      // Containment on the whole document, so the GIN jsonb_path_ops index of 0017 applies.
      const typed = blockType
        ? sql<boolean>`r.document @> ${JSON.stringify({ blocks: [{ type: blockType }] })}::jsonb`
        : sql<boolean>`true`;
      const referenced = ref
        ? sql<boolean>`r.id in (select f.revision_id from content_block_refs f
                                where f.type = ${ref.type} and f.ref_id = ${ref.id})`
        : sql<boolean>`true`;
      let q = trx
        .selectFrom('content_items as i')
        .selectAll('i')
        .where(
          sql<boolean>`exists (select 1 from content_revisions r where r.item_id = i.id
                               and ${searched(live)} and ${typed} and ${referenced})`
        );
      if (type) q = q.where('i.type', '=', type);
      if (after) q = q.where('i.id', '<', after);
      const rows = await q
        .orderBy('i.id', 'desc')
        .limit(limit + 1)
        .execute();
      const page = paged(rows, limit);
      if (!page.rows.length) return { rows: [], next: page.next };
      const ids = page.rows.map((r) => r.id);
      // The blocks that matched, per item, over revisions satisfying both filters.
      // Another locale may publish a revision matching only one filter; exclude its ids too.
      const { rows: hits } = await sql<{ item_id: string; block_id: string }>`
        select r.item_id, b->>'id' as block_id
        from content_items i
        join content_revisions r on r.item_id = i.id and ${searched(live)}
        cross join lateral jsonb_array_elements(r.document->'blocks') b
        where ${blockType ?? null}::text is not null and b->>'type' = ${blockType ?? null}
          and i.id = any(${ids}::uuid[]) and ${typed} and ${referenced}
        union
        select f.item_id, f.block_id
        from content_items i
        join content_revisions r on r.item_id = i.id and ${searched(live)}
        join content_block_refs f on f.revision_id = r.id
        where f.type = ${ref?.type ?? null} and f.ref_id = ${ref?.id ?? null}::uuid
          and f.block_id is not null and i.id = any(${ids}::uuid[]) and ${typed} and ${referenced}
      `.execute(trx);
      const records = await withLocales(page.rows);
      return {
        rows: records.map((item) => ({
          item,
          blockIds: hits.filter((h) => h.item_id === item.id).map((h) => h.block_id),
        })),
        next: page.next,
      };
    },
    async liveReferences(ref) {
      const row = await trx
        .selectFrom('content_item_locales as l')
        .innerJoin('content_block_refs as f', 'f.revision_id', 'l.published_revision_id')
        .where('f.type', '=', ref.type)
        .where('f.ref_id', '=', ref.id)
        .select(sql<string>`count(distinct l.item_id)`.as('n'))
        .executeTakeFirstOrThrow();
      return Number(row.n);
    },
    async revision(itemId, revisionId) {
      const r = await trx
        .selectFrom('content_revisions')
        .selectAll()
        .where('item_id', '=', itemId)
        .where('id', '=', revisionId)
        .executeTakeFirst();
      return r
        ? Revision.parse({
            id: r.id,
            itemId: r.item_id,
            createdAt: iso(r.created_at),
            actor: r.actor,
            ...(r.provenance ? { provenance: r.provenance } : {}),
            document: upgradeFaqV1InDocument(r.document),
          })
        : null;
    },
    async revisions(itemId, after, limit) {
      let q = trx
        .selectFrom('content_revisions')
        .select(['id', 'item_id', 'actor', 'created_at'])
        .where('item_id', '=', itemId);
      if (after) q = q.where('id', '<', after);
      const rows = await q
        .orderBy('id', 'desc')
        .limit(limit + 1)
        .execute();
      return paged(
        rows.map((r): RevisionSummary => ({
          id: r.id,
          itemId: r.item_id,
          createdAt: iso(r.created_at),
          actor: Actor.parse(r.actor),
        })),
        limit
      );
    },
  };
}

export function authorRepository(trx: Trx, tenantId: string): SluggedRepository<Author> {
  const toAuthor = (r: Selectable<Database['authors']>): Author =>
    Author.parse({
      id: r.id,
      slug: r.slug,
      name: r.name,
      ...(r.bio ? { bio: r.bio } : {}),
      ...(r.image_id ? { imageId: r.image_id } : {}),
      links: r.links,
      ...(r.email ? { email: r.email } : {}),
      createdAt: iso(r.created_at),
      updatedAt: iso(r.updated_at),
    });
  const fields = (a: Author) => ({
    name: a.name,
    bio: a.bio ? JSON.stringify(a.bio) : null,
    image_id: a.imageId ?? null,
    links: JSON.stringify(a.links),
    email: a.email ?? null,
    updated_at: a.updatedAt,
  });
  const rows = () => trx.selectFrom('authors').selectAll();
  return {
    async get(id) {
      const r = await rows().where('id', '=', id).executeTakeFirst();
      return r ? toAuthor(r) : null;
    },
    async findBySlug(slug) {
      const r = await rows().where('slug', '=', slug).executeTakeFirst();
      return r ? toAuthor(r) : null;
    },
    async list(after, limit) {
      let q = rows();
      if (after) q = q.where('id', '<', after);
      return paged(
        (
          await q
            .orderBy('id', 'desc')
            .limit(limit + 1)
            .execute()
        ).map(toAuthor),
        limit
      );
    },
    async insert(a) {
      await trx
        .insertInto('authors')
        .values({
          id: a.id,
          tenant_id: tenantId,
          slug: a.slug,
          created_at: a.createdAt,
          ...fields(a),
        })
        .execute();
    },
    async update(a) {
      await trx.updateTable('authors').set(fields(a)).where('id', '=', a.id).execute();
    },
  };
}

export function sectionRepository(trx: Trx, tenantId: string): SluggedRepository<Section> {
  const toSection = (r: Selectable<Database['sections']>): Section =>
    Section.parse({
      id: r.id,
      slug: r.slug,
      title: r.title,
      ...(r.description ? { description: r.description } : {}),
      order: r.sort_order,
      createdAt: iso(r.created_at),
      updatedAt: iso(r.updated_at),
    });
  const fields = (s: Section) => ({
    title: JSON.stringify(s.title),
    description: s.description ? JSON.stringify(s.description) : null,
    sort_order: s.order,
    updated_at: s.updatedAt,
  });
  const rows = () => trx.selectFrom('sections').selectAll();
  return {
    async get(id) {
      const r = await rows().where('id', '=', id).executeTakeFirst();
      return r ? toSection(r) : null;
    },
    async findBySlug(slug) {
      const r = await rows().where('slug', '=', slug).executeTakeFirst();
      return r ? toSection(r) : null;
    },
    async list(after, limit) {
      let q = rows();
      if (after) q = q.where('id', '<', after);
      return paged(
        (
          await q
            .orderBy('id', 'desc')
            .limit(limit + 1)
            .execute()
        ).map(toSection),
        limit
      );
    },
    async insert(s) {
      await trx
        .insertInto('sections')
        .values({
          id: s.id,
          tenant_id: tenantId,
          slug: s.slug,
          created_at: s.createdAt,
          ...fields(s),
        })
        .execute();
    },
    async update(s) {
      await trx.updateTable('sections').set(fields(s)).where('id', '=', s.id).execute();
    },
  };
}

export function patternRepository(trx: Trx, tenantId: string): EntityRepository<Pattern> {
  const toPattern = (r: Selectable<Database['patterns']>): Pattern =>
    Pattern.parse({
      id: r.id,
      name: r.name,
      ...(r.description ? { description: r.description } : {}),
      intendedType: r.intended_type,
      blocks: r.blocks,
      createdAt: iso(r.created_at),
      updatedAt: iso(r.updated_at),
    });
  const fields = (p: Pattern) => ({
    name: JSON.stringify(p.name),
    description: p.description ? JSON.stringify(p.description) : null,
    intended_type: p.intendedType,
    blocks: JSON.stringify(p.blocks),
    updated_at: p.updatedAt,
  });
  const rows = () => trx.selectFrom('patterns').selectAll();
  return {
    async get(id) {
      const r = await rows().where('id', '=', id).executeTakeFirst();
      return r ? toPattern(r) : null;
    },
    async list(after, limit) {
      let q = rows();
      if (after) q = q.where('id', '<', after);
      return paged(
        (
          await q
            .orderBy('id', 'desc')
            .limit(limit + 1)
            .execute()
        ).map(toPattern),
        limit
      );
    },
    async insert(p) {
      await trx
        .insertInto('patterns')
        .values({ id: p.id, tenant_id: tenantId, created_at: p.createdAt, ...fields(p) })
        .execute();
    },
    async update(p) {
      await trx.updateTable('patterns').set(fields(p)).where('id', '=', p.id).execute();
    },
  };
}
