// The navigation repository over Postgres (ADR 036, migration 0056), in the use case's tenant
// transaction as mycel_app: RLS scopes every read, the explicit `tenant_id` on inserts satisfies
// the policies' WITH CHECK. `lock` is a transaction-scoped advisory lock per tenant, exclusive for
// a writer of the aggregate and shared for a delete that checks references, so a save waits for
// every running delete and the reverse; two deletes run together. Rejected: `select ... for
// update` on the head row, which locks nothing before the tenant's first save.
//
// `publishedTargets` reads the publication pointer and the few values a menu needs from the
// published revision (title, featured title, access, top-level block ids) in one statement,
// never a draft and never a whole document per row.

import { sql, type Kysely } from 'kysely';
import {
  NavigationDocument,
  navigationReferences,
  type ContentType,
  type NavigationRepository,
  type NavigationRevision,
  type PublishedTarget,
} from '@mycel/core';
import type { Database } from './infra/schema.js';
import { advisoryLock, advisoryLockShared } from './infra/roles.js';

type Trx = Kysely<Database>;

interface RevisionRow {
  id: string;
  document: unknown;
  base_revision_id: string | null;
  merged: boolean;
  restored_from: string | null;
  created_at: Date | string;
}

const summary = (r: Omit<RevisionRow, 'document'>) => ({
  id: r.id,
  baseRevisionId: r.base_revision_id,
  merged: r.merged,
  restoredFrom: r.restored_from,
  createdAt: new Date(r.created_at),
});

export function navigationRepository(trx: Trx, tenantId: string): NavigationRepository {
  return {
    async lock(mode) {
      await (mode === 'shared' ? advisoryLockShared : advisoryLock)(trx, 'navigation', tenantId);
    },
    async head() {
      const head = await trx
        .selectFrom('site_navigation')
        .select(['latest_revision_id', 'updated_at'])
        .executeTakeFirst();
      if (!head) return null;
      const locales = await trx
        .selectFrom('site_navigation_locales')
        .select(['locale', 'revision_id', 'published_at'])
        .orderBy(sql`locale collate "C"`)
        .execute();
      return {
        latestRevisionId: head.latest_revision_id,
        updatedAt: new Date(head.updated_at),
        publication: locales.map((l) => ({
          locale: l.locale,
          revisionId: l.revision_id,
          publishedAt: new Date(l.published_at),
        })),
      };
    },
    async revision(id) {
      const row = await trx
        .selectFrom('site_navigation_revisions')
        .select(['id', 'document', 'base_revision_id', 'merged', 'restored_from', 'created_at'])
        .where('id', '=', id)
        .executeTakeFirst();
      if (!row) return null;
      return { ...summary(row), document: NavigationDocument.parse(row.document) };
    },
    async revisions(limit) {
      const rows = await trx
        .selectFrom('site_navigation_revisions')
        .select(['id', 'base_revision_id', 'merged', 'restored_from', 'created_at'])
        .orderBy('created_at', 'desc')
        .orderBy('id', 'desc')
        .limit(limit)
        .execute();
      return rows.map(summary);
    },
    async insertRevision(revision: NavigationRevision) {
      await trx
        .insertInto('site_navigation_revisions')
        .values({
          tenant_id: tenantId,
          id: revision.id,
          document: JSON.stringify(revision.document),
          base_revision_id: revision.baseRevisionId,
          merged: revision.merged,
          restored_from: revision.restoredFrom,
          created_at: revision.createdAt,
        })
        .execute();
      const refs = navigationReferences(revision.document);
      if (refs.length)
        await trx
          .insertInto('site_navigation_refs')
          .values(
            refs.map((r) => ({
              tenant_id: tenantId,
              revision_id: revision.id,
              menu_id: r.menuId,
              item_id: r.itemId,
            }))
          )
          .execute();
      await trx
        .insertInto('site_navigation')
        .values({
          tenant_id: tenantId,
          latest_revision_id: revision.id,
          updated_at: revision.createdAt,
        })
        .onConflict((oc) =>
          oc.column('tenant_id').doUpdateSet({
            latest_revision_id: revision.id,
            updated_at: revision.createdAt,
          })
        )
        .execute();
    },
    async publish(locale, revisionId, at) {
      await trx
        .insertInto('site_navigation_locales')
        .values({ tenant_id: tenantId, locale, revision_id: revisionId, published_at: at })
        .onConflict((oc) =>
          oc
            .columns(['tenant_id', 'locale'])
            .doUpdateSet({ revision_id: revisionId, published_at: at })
        )
        .execute();
    },
    async unpublish(locale) {
      const result = await trx
        .deleteFrom('site_navigation_locales')
        .where('locale', '=', locale)
        .executeTakeFirst();
      return Number(result.numDeletedRows) > 0;
    },
    async referencingMenus(itemId) {
      // In document order: the latest revision's menus first, then those only a published
      // revision still has, newest first, as the memory adapter lists them.
      const { rows } = await sql<{ menu_id: string; name: string | null }>`
        select menu_id, name from (
          select distinct on (f.menu_id) f.menu_id, m.value->>'name' as name, m.pos,
                 f.revision_id = (select latest_revision_id from site_navigation) as latest,
                 r.created_at
          from site_navigation_refs f
          join site_navigation_revisions r on r.id = f.revision_id
          cross join lateral jsonb_array_elements(r.document->'menus')
            with ordinality as m(value, pos)
          where f.item_id = ${itemId}::uuid
            and m.value->>'id' = f.menu_id
            and (f.revision_id = (select latest_revision_id from site_navigation)
                 or f.revision_id in (select revision_id from site_navigation_locales))
          order by f.menu_id, latest desc, r.created_at desc
        ) found
        order by latest desc, created_at desc, pos
      `.execute(trx);
      return rows.map((r) => ({ menuId: r.menu_id, name: r.name ?? r.menu_id }));
    },
    async existingItems(ids) {
      if (!ids.length) return new Set();
      const rows = await trx
        .selectFrom('content_items')
        .select('id')
        .where('id', 'in', [...ids])
        .where('deleted_at', 'is', null)
        .execute();
      return new Set(rows.map((r) => r.id));
    },
    async publishedTargets(ids, locale) {
      const out = new Map<string, PublishedTarget>();
      if (!ids.length) return out;
      const { rows } = await sql<{
        id: string;
        type: ContentType;
        slug: string;
        title: string | null;
        featured_title: string | null;
        access: PublishedTarget['access'];
        block_ids: string[];
      }>`
        select i.id, i.type, i.slug,
               r.document->'title'->>${locale} as title,
               r.document->'featured'->'title'->>${locale} as featured_title,
               coalesce(r.document->'access'->>'level', 'public') as access,
               array(select b->>'id' from jsonb_array_elements(r.document->'blocks') b) as block_ids
        from content_items i
        join content_item_locales l
          on l.item_id = i.id and l.locale = ${locale} and l.published_revision_id is not null
        join content_revisions r on r.id = l.published_revision_id
        where i.deleted_at is null and i.id = any(${[...ids]}::uuid[])
      `.execute(trx);
      for (const r of rows)
        out.set(r.id, {
          itemId: r.id,
          type: r.type,
          slug: r.slug,
          title: r.title,
          featuredTitle: r.featured_title,
          access: r.access,
          blockIds: r.block_ids,
        });
      return out;
    },
  };
}
