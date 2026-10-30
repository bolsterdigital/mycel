// The media repository over Postgres (TODO #10, migration 0012), in the use case's tenant
// transaction as mycel_app: RLS scopes every query to the tenant, the explicit `tenant_id` on
// inserts satisfies the policy's WITH CHECK. `lock` is a transaction-scoped advisory lock per
// tenant, the `members.lock()` pattern, so the storage count and the new row of two concurrent
// uploads are serialised. Rejected: `select ... for update` on the tenant's rows, which locks
// nothing when the tenant has no media yet.

import { sql, type Kysely, type Selectable } from 'kysely';
import {
  MediaCredit,
  MediaFocal,
  StoredVariant,
  type MediaContentType,
  type MediaRecord,
  type MediaRepository,
} from '@mycel/core';
import type { Database } from './infra/schema.js';
import { advisoryLock } from './infra/roles.js';

type Trx = Kysely<Database>;
type Row = Selectable<Database['media']> & { usage_count: string | number };

const toRecord = (r: Row): MediaRecord => ({
  id: r.id,
  kind: r.kind,
  contentType: r.content_type as MediaContentType,
  filename: r.filename,
  checksum: r.checksum,
  sizeBytes: Number(r.size_bytes),
  totalBytes: Number(r.total_bytes),
  width: r.width,
  height: r.height,
  variants: StoredVariant.array().parse(r.variants),
  access: r.access,
  caption: r.caption,
  credit: MediaCredit.parse(r.credit),
  source: r.source,
  licence: r.licence,
  focal: MediaFocal.parse(r.focal),
  state: r.state,
  createdBy: r.created_by,
  createdAt: new Date(r.created_at),
  updatedAt: new Date(r.updated_at),
  deletedAt: r.deleted_at ? new Date(r.deleted_at) : null,
  usageCount: Number(r.usage_count),
});

export function mediaRepository(trx: Trx, tenantId: string): MediaRepository {
  const select = () =>
    trx
      .selectFrom('media')
      .selectAll('media')
      .select(
        sql<string>`(select count(*) from media_usages u where u.tenant_id = media.tenant_id and u.media_id = media.id)`.as(
          'usage_count'
        )
      );
  return {
    async lock() {
      await advisoryLock(trx, 'media', tenantId);
    },
    async get(id) {
      const row = await select().where('media.id', '=', id).executeTakeFirst();
      return row ? toRecord(row) : null;
    },
    async list({ kind, q: text, cursor, limit }) {
      let q = select().where('media.deleted_at', 'is', null);
      if (kind) q = q.where('media.kind', '=', kind);
      if (text) {
        // A sequential scan of one tenant's media; a trigram index waits for a measured need
        // (ADR 008). The caption is matched on its values, never on the jsonb keys.
        const like = `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
        q = q.where(
          sql<boolean>`(media.filename ilike ${like} or exists (select 1 from jsonb_each_text(media.caption) c where c.value ilike ${like}))`
        );
      }
      if (cursor)
        q = q.where(
          sql<boolean>`(media.created_at, media.id) < (select c.created_at, c.id from media c where c.id = ${cursor})`
        );
      const rows = await q
        .orderBy('media.created_at', 'desc')
        .orderBy('media.id', 'desc')
        .limit(limit)
        .execute();
      return rows.map(toRecord);
    },
    async insert(m) {
      await trx
        .insertInto('media')
        .values({
          id: m.id,
          tenant_id: tenantId,
          kind: m.kind,
          content_type: m.contentType,
          filename: m.filename,
          checksum: m.checksum,
          size_bytes: m.sizeBytes,
          total_bytes: m.totalBytes,
          width: m.width,
          height: m.height,
          variants: JSON.stringify(m.variants),
          access: m.access,
          caption: JSON.stringify(m.caption),
          credit: JSON.stringify(m.credit),
          source: m.source,
          licence: m.licence,
          focal: JSON.stringify(m.focal),
          state: m.state,
          created_by: JSON.stringify(m.createdBy),
          created_at: m.createdAt,
          updated_at: m.updatedAt,
        })
        .execute();
    },
    async update(id, patch, at) {
      const r = await trx
        .updateTable('media')
        .set({
          ...(patch.caption !== undefined ? { caption: JSON.stringify(patch.caption) } : {}),
          ...(patch.credit !== undefined ? { credit: JSON.stringify(patch.credit) } : {}),
          ...(patch.focal !== undefined ? { focal: JSON.stringify(patch.focal) } : {}),
          ...(patch.source !== undefined ? { source: patch.source } : {}),
          ...(patch.licence !== undefined ? { licence: patch.licence } : {}),
          ...(patch.access !== undefined ? { access: patch.access } : {}),
          updated_at: at,
        })
        .where('id', '=', id)
        .where('deleted_at', 'is', null)
        .executeTakeFirst();
      return r.numUpdatedRows > 0n;
    },
    async softDelete(id, at) {
      const r = await trx
        .updateTable('media')
        .set({ deleted_at: at, updated_at: at })
        .where('id', '=', id)
        .where('deleted_at', 'is', null)
        .executeTakeFirst();
      return r.numUpdatedRows > 0n;
    },
    async hardDelete(id) {
      const gone = await trx
        .selectFrom('media')
        .select('id')
        .where('id', '=', id)
        .where('deleted_at', 'is not', null)
        .executeTakeFirst();
      if (!gone) return false;
      await trx.deleteFrom('media_usages').where('media_id', '=', id).execute();
      const r = await trx.deleteFrom('media').where('id', '=', id).executeTakeFirst();
      return r.numDeletedRows > 0n;
    },
    async replaceUsages(ref, usages) {
      await trx.deleteFrom('media_usages').where('ref', '=', ref).execute();
      if (usages.length === 0) return 0;
      // Only media of this tenant that is not deleted: an unknown id is skipped, never an error,
      // so a block that points at a purged image still saves.
      const { rows } = await sql<{ n: string }>`
        with wanted (media_id, block_id) as (
          select * from unnest(${usages.map((u) => u.mediaId)}::uuid[],
                               ${usages.map((u) => u.blockId)}::text[]))
        , inserted as (
          insert into media_usages (tenant_id, media_id, ref, block_id)
          select ${tenantId}::uuid, w.media_id, ${ref}, w.block_id
          from wanted w join media m on m.id = w.media_id and m.deleted_at is null
          on conflict do nothing
          returning 1)
        select count(*) as n from inserted`.execute(trx);
      return Number(rows[0]?.n ?? 0);
    },
    async idsOf() {
      return (await trx.selectFrom('media').select('id').execute()).map((r) => r.id);
    },
  };
}

/** `usage.storageBytes`: every byte of every live asset, original and variants. */
export async function mediaStorageBytes(trx: Trx, tenantId: string): Promise<number> {
  const row = await trx
    .selectFrom('media')
    .select(sql<string>`coalesce(sum(total_bytes), 0)`.as('n'))
    .where('tenant_id', '=', tenantId)
    .where('deleted_at', 'is', null)
    .executeTakeFirstOrThrow();
  return Number(row.n);
}
