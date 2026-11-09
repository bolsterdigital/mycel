// Content repositories over Postgres (TODO #8a, migration 0011): items with their per-locale
// publication rows, immutable revisions, and the author, section and pattern entities. All run
// in a use case's tenant transaction as mycel_app under RLS.
//
// `lock` is `select ... for update` on the item row: every write and the scheduled-publish job
// take it first, so concurrent saves on one base serialise and the second sees the new latest
// revision. Revisions are parsed with core's schema on read, so a stored document that no longer
// validates fails loudly instead of reaching a renderer; `latestDocuments` alone leaves such a
// document out, because a list renders nothing from it. Rejected: an advisory lock (the item row
// exists before any write, so a row lock is enough and shows up in pg_locks under its table).

import { sql, type Kysely, type RawBuilder, type Selectable } from 'kysely';
import {
  Actor,
  Author,
  ContentDocument,
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
import { toIso } from './infra/dates.js';

type Trx = Kysely<Database>;
type ItemRow = Selectable<Database['content_items']>;
type LocaleRow = Selectable<Database['content_item_locales']>;

const date = (v: Date | string | null): Date | null => (v === null ? null : new Date(v));

/** A stored document as a list reads it; null when it no longer validates, the upgrade included. */
function readableDocument(stored: unknown): ContentDocument | null {
  try {
    return ContentDocument.parse(upgradeFaqV1InDocument(stored));
  } catch {
    return null;
  }
}

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
  review: r.review_since ? { since: new Date(r.review_since), note: r.review_note } : null,
});

/** Whether `e` is Postgres refusing a row on this unique key, and not any other failure. */
function hitKey(e: unknown, constraint: string): boolean {
  const pg = e as { code?: string; constraint?: string };
  return pg.code === '23505' && pg.constraint === constraint;
}

/**
 * Run an insert whose slug the use case checked just before: a second request can pass that check
 * too, and then the unique key decides. False says the slug is taken; core words the refusal, and
 * throwing it ends the transaction this failed statement has already aborted. Rejected: a lock
 * around check and insert (it would serialise every create of a tenant for a rare race).
 */
async function insertedUnlessTaken(constraint: string, insert: () => Promise<void>) {
  try {
    await insert();
    return true;
  } catch (e) {
    if (hitKey(e, constraint)) return false;
    throw e;
  }
}

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
  /** Every item outside the trash: the one way the module reads items (ADR 030 rule 2). */
  const items = () => trx.selectFrom('content_items').selectAll().where('deleted_at', 'is', null);

  async function writeLocales(item: ItemRecord): Promise<void> {
    for (const s of item.publication) {
      const values = {
        published_revision_id: s.publishedRevisionId,
        published_at: s.publishedAt,
        first_published_at: s.firstPublishedAt,
        scheduled_revision_id: s.scheduledRevisionId,
        scheduled_for: s.scheduledFor,
        schedule_id: s.scheduleId,
        review_since: s.review?.since ?? null,
        review_note: s.review?.note ?? null,
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
    async list(filter, { order, after, offset, limit }) {
      const {
        type,
        slug,
        q,
        locale,
        status,
        hasUnpublishedChanges,
        authorId,
        sectionId,
        tag,
        updatedFrom,
        updatedBefore,
      } = filter;
      // Core's `matchesItemFilter` in SQL; `adapter-rules.test.ts` holds the two together.
      const matches: RawBuilder<boolean>[] = [];
      if (type) matches.push(sql<boolean>`i.type = ${type}`);
      if (slug) matches.push(sql<boolean>`i.slug = ${slug}`);
      if (q) {
        // `%`, `_` and the backslash stand for themselves.
        const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
        matches.push(
          sql<boolean>`(i.slug ilike ${like} or exists (
            select 1 from jsonb_each_text(i.title) t where t.value ilike ${like}))`
        );
      }
      if (updatedFrom) matches.push(sql<boolean>`i.updated_at >= ${updatedFrom}`);
      if (updatedBefore) matches.push(sql<boolean>`i.updated_at < ${updatedBefore}`);
      for (const [refType, refId] of [
        ['author', authorId],
        ['section', sectionId],
      ] as const)
        if (refId)
          matches.push(
            sql<boolean>`exists (
              select 1 from content_block_refs b
              where b.revision_id = i.latest_revision_id
                and b.block_id is null and b.type = ${refType} and b.ref_id = ${refId})`
          );
      if (tag)
        matches.push(
          sql<boolean>`exists (
            select 1 from content_revisions r
            where r.id = i.latest_revision_id
              and r.document @> ${JSON.stringify({ tags: [tag] })}::jsonb)`
        );
      if (status !== undefined || hasUnpublishedChanges !== undefined) {
        const changed = sql<boolean>`(l.published_revision_id is not null
          and l.published_revision_id <> i.latest_revision_id)`;
        matches.push(
          sql<boolean>`exists (
            select 1 from content_item_locales l
            where l.item_id = i.id
              and l.locale = coalesce(${locale ?? null}::text, i.default_locale)
              and ${status ? sql<boolean>`l.status = ${status}` : sql<boolean>`true`}
              and ${
                hasUnpublishedChanges === undefined
                  ? sql<boolean>`true`
                  : hasUnpublishedChanges
                    ? changed
                    : sql<boolean>`not ${changed}`
              })`
        );
      }
      const matching = () => {
        let query = trx.selectFrom('content_items as i').where('i.deleted_at', 'is', null);
        for (const condition of matches) query = query.where(condition);
        return query;
      };

      // Core's `compareItems`: the key, then the id, both in the order's direction. The page
      // after an item starts from where that item stands now, read by id in the same statement;
      // `key` writes one expression for the listed row (`i`) and for that item (`p`).
      const key =
        order.by === 'title'
          ? (row: 'i' | 'p') =>
              sql<string>`coalesce(${sql.ref(`${row}.title`)}->>(${locale ?? null}::text),
                ${sql.ref(`${row}.title`)}->>${sql.ref(`${row}.default_locale`)}, '')
                collate "und-x-icu"`
          : order.by === 'updated'
            ? (row: 'i' | 'p') => sql<Date>`${sql.ref(`${row}.updated_at`)}`
            : null;
      const asc = order.direction === 'asc';
      let rows = matching().selectAll('i');
      if (after && key) {
        const pivot = sql`(select ${key('p')}, p.id from content_items p where p.id = ${after})`;
        rows = rows.where(
          asc
            ? sql<boolean>`(${key('i')}, i.id) > ${pivot}`
            : sql<boolean>`(${key('i')}, i.id) < ${pivot}`
        );
      } else if (after) {
        rows = rows.where('i.id', asc ? '>' : '<', after);
      }
      if (key) rows = rows.orderBy(key('i'), order.direction);
      const found = await rows
        .orderBy('i.id', order.direction)
        .offset(offset)
        .limit(limit + 1)
        .execute();
      const counted = await matching()
        .select((eb) => eb.fn.countAll<string>().as('n'))
        .executeTakeFirstOrThrow();
      const page = paged(found, limit);
      return { rows: await withLocales(page.rows), next: page.next, total: Number(counted.n) };
    },
    async insert(item, first) {
      const inserted = await insertedUnlessTaken(
        'content_items_tenant_id_type_slug_key',
        async () => {
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
        }
      );
      if (!inserted) return false;
      await insertRevision(first);
      await writeLocales(item);
      return true;
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
    async setSlug(itemId, slug, at) {
      try {
        await trx
          .updateTable('content_items')
          .set({ slug, updated_at: at })
          .where('id', '=', itemId)
          .execute();
        return true;
      } catch (e) {
        // Only the slug key; any other failure is not a taken slug.
        if (hitKey(e, 'content_items_tenant_id_type_slug_key')) return false;
        throw e;
      }
    },
    insertRevision,
    lockTrashed: async (itemId) =>
      one(
        await trx
          .selectFrom('content_items')
          .selectAll()
          .where('id', '=', itemId)
          .where('deleted_at', 'is not', null)
          .forUpdate()
          .execute()
      ),
    async trash(itemId, at) {
      await trx
        .updateTable('content_items')
        .set({ deleted_at: at, updated_at: at })
        .where('id', '=', itemId)
        .execute();
    },
    async restore(itemId, slug, at) {
      try {
        await trx
          .updateTable('content_items')
          .set({ deleted_at: null, slug, updated_at: at })
          .where('id', '=', itemId)
          .execute();
        return true;
      } catch (e) {
        if (hitKey(e, 'content_items_tenant_id_type_slug_key')) return false;
        throw e;
      }
    },
    async trashed(offset, limit) {
      const inTrash = () => trx.selectFrom('content_items').where('deleted_at', 'is not', null);
      const rows = await inTrash()
        .selectAll()
        .orderBy('deleted_at', 'desc')
        .orderBy('id', 'desc')
        .offset(offset)
        .limit(limit)
        .execute();
      const { n } = await inTrash()
        .select((eb) => eb.fn.countAll<string>().as('n'))
        .executeTakeFirstOrThrow();
      const records = await withLocales(rows);
      return {
        rows: records.map((item, i) => ({ item, deletedAt: new Date(rows[i]!.deleted_at!) })),
        total: Number(n),
      };
    },
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
        .where('i.deleted_at', 'is', null)
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
    async latestDocuments(itemIds) {
      if (!itemIds.length) return new Map();
      const rows = await trx
        .selectFrom('content_items as i')
        .innerJoin('content_revisions as r', 'r.id', 'i.latest_revision_id')
        .select(['i.id', 'r.document'])
        .where('i.deleted_at', 'is', null)
        .where('i.id', 'in', [...itemIds])
        .execute();
      const documents = new Map<string, ContentDocument>();
      for (const r of rows) {
        const document = readableDocument(r.document);
        if (document) documents.set(r.id, document);
      }
      return documents;
    },
    async offeredForReview(limit) {
      const rows = await trx
        .selectFrom('content_item_locales as l')
        .innerJoin('content_items as i', 'i.id', 'l.item_id')
        .where('l.review_since', 'is not', null)
        .where('i.deleted_at', 'is', null)
        .select([
          'l.item_id',
          'l.locale',
          'l.review_since',
          sql<string | null>`coalesce(i.title->>l.locale, i.title->>i.default_locale)`.as('title'),
        ])
        .orderBy('l.review_since', 'desc')
        .orderBy('l.item_id')
        .orderBy('l.locale')
        .limit(limit)
        .execute();
      return rows.map((r) => ({
        itemId: r.item_id,
        locale: r.locale,
        title: r.title,
        since: new Date(r.review_since!),
      }));
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
            createdAt: toIso(r.created_at),
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
          createdAt: toIso(r.created_at),
          actor: Actor.parse(r.actor),
        })),
        limit
      );
    },
  };
}

export function authorRepository(trx: Trx, tenantId: string): SluggedRepository<Author> {
  const toAuthor = (r: Selectable<Database['people']>): Author =>
    Author.parse({
      id: r.id,
      slug: r.slug,
      name: r.name,
      ...(r.role ? { role: r.role } : {}),
      ...(r.organisation ? { organisation: r.organisation } : {}),
      ...(r.public_email ? { publicEmail: r.public_email } : {}),
      ...(r.phone ? { phone: r.phone } : {}),
      pagePolicy: r.page_policy,
      ...(r.bio ? { bio: r.bio } : {}),
      ...(r.image_id ? { imageId: r.image_id } : {}),
      links: r.links,
      ...(r.email ? { email: r.email } : {}),
      createdAt: toIso(r.created_at),
      updatedAt: toIso(r.updated_at),
    });
  const fields = (a: Author) => ({
    name: a.name,
    role: a.role ? JSON.stringify(a.role) : null,
    organisation: a.organisation ?? null,
    public_email: a.publicEmail ?? null,
    phone: a.phone ?? null,
    page_policy: a.pagePolicy,
    bio: a.bio ? JSON.stringify(a.bio) : null,
    image_id: a.imageId ?? null,
    links: JSON.stringify(a.links),
    email: a.email ?? null,
    updated_at: a.updatedAt,
  });
  const rows = () => trx.selectFrom('people').selectAll();
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
      return insertedUnlessTaken('authors_tenant_id_slug_key', async () => {
        await trx
          .insertInto('people')
          .values({
            id: a.id,
            tenant_id: tenantId,
            slug: a.slug,
            created_at: a.createdAt,
            ...fields(a),
          })
          .execute();
      });
    },
    async update(a, baseUpdatedAt) {
      // A concurrent update holds the row lock; this one then re-reads the row and finds a newer
      // `updated_at`, so exactly one of them writes.
      const r = await trx
        .updateTable('people')
        .set(fields(a))
        .where('id', '=', a.id)
        .where('updated_at', '=', new Date(baseUpdatedAt))
        .executeTakeFirst();
      return r.numUpdatedRows > 0n;
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
      createdAt: toIso(r.created_at),
      updatedAt: toIso(r.updated_at),
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
      return insertedUnlessTaken('sections_tenant_id_slug_key', async () => {
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
      });
    },
    async update(s, baseUpdatedAt) {
      // A concurrent update holds the row lock; this one then re-reads the row and finds a newer
      // `updated_at`, so exactly one of them writes.
      const r = await trx
        .updateTable('sections')
        .set(fields(s))
        .where('id', '=', s.id)
        .where('updated_at', '=', new Date(baseUpdatedAt))
        .executeTakeFirst();
      return r.numUpdatedRows > 0n;
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
      createdAt: toIso(r.created_at),
      updatedAt: toIso(r.updated_at),
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
