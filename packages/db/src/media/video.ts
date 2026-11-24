// Keep tenant and library identity in predicates on local bindings. Export reads the editorial
// table independently and never restores a binding from an archive.
import { sql, type Kysely, type Selectable } from 'kysely';
import {
  VideoMetadata,
  type VideoRepository,
  type VideoRecord,
  type VideoUpload,
} from '@mycel/core';
import type { Database } from '../infra/schema.js';

function record(row: Selectable<Database['managed_videos']>): VideoRecord {
  return {
    id: row.id,
    posterId: row.poster_id,
    metadata: VideoMetadata.parse(row.metadata),
    durationSeconds: row.duration_seconds,
    hasSource: row.has_source,
    publishedTracks: row.published_tracks,
    createdAt: row.created_at,
    trashedAt: row.trashed_at,
  };
}

function binding(
  row: Selectable<Database['managed_video_uploads']> | undefined
): VideoUpload | null {
  return row
    ? {
        videoId: row.video_id,
        uploadKey: row.upload_key,
        libraryId: row.library_id,
        providerId: row.provider_id,
        mp4Height: row.mp4_height,
        state: row.state,
        storageBytes: Number(row.storage_bytes),
        durationSeconds: row.duration_seconds,
      }
    : null;
}

export function videoRepository(db: Kysely<Database>, tenantId: string): VideoRepository {
  const videos = () =>
    db.selectFrom('managed_videos').selectAll().where('tenant_id', '=', tenantId);
  const uploads = () => db.selectFrom('managed_video_uploads').where('tenant_id', '=', tenantId);
  return {
    async get(id) {
      const row = await videos().where('id', '=', id).executeTakeFirst();
      return row ? record(row) : null;
    },
    async list() {
      return (
        await videos().where('trashed_at', 'is', null).orderBy('created_at', 'desc').execute()
      ).map(record);
    },
    async insert(video) {
      await db
        .insertInto('managed_videos')
        .values({
          tenant_id: tenantId,
          id: video.id,
          poster_id: video.posterId,
          metadata: JSON.stringify(video.metadata),
          published_tracks: JSON.stringify(video.publishedTracks),
          duration_seconds: video.durationSeconds,
          has_source: video.hasSource,
          created_at: video.createdAt,
          trashed_at: video.trashedAt,
        })
        .execute();
    },
    async update(id, patch) {
      await db
        .updateTable('managed_videos')
        .set({
          duration_seconds: patch.durationSeconds,
          has_source: patch.hasSource,
          trashed_at: patch.trashedAt,
        })
        .where('tenant_id', '=', tenantId)
        .where('id', '=', id)
        .execute();
    },
    async upload(id) {
      return binding(await uploads().selectAll().where('video_id', '=', id).executeTakeFirst());
    },
    async byUploadKey(key) {
      return binding(await uploads().selectAll().where('upload_key', '=', key).executeTakeFirst());
    },
    async saveUpload(upload) {
      const values = {
        tenant_id: tenantId,
        video_id: upload.videoId,
        upload_key: upload.uploadKey,
        library_id: upload.libraryId,
        provider_id: upload.providerId,
        mp4_height: upload.mp4Height,
        state: upload.state,
        storage_bytes: upload.storageBytes,
        duration_seconds: upload.durationSeconds,
      };
      await db
        .insertInto('managed_video_uploads')
        .values(values)
        .onConflict((oc) => oc.columns(['tenant_id', 'video_id']).doUpdateSet(values))
        .execute();
    },
    async usage(except) {
      let query = uploads();
      if (except) query = query.where('video_id', '!=', except);
      const row = await query
        .select(({ fn }) => [
          fn.sum('storage_bytes').as('bytes'),
          fn.sum('duration_seconds').as('seconds'),
        ])
        .executeTakeFirstOrThrow();
      return { storageBytes: Number(row.bytes ?? 0), durationSeconds: Number(row.seconds ?? 0) };
    },
    async used(id) {
      const ref = await db
        .selectFrom('content_block_refs')
        .select('ref_id')
        .where('tenant_id', '=', tenantId)
        .where('type', '=', 'video')
        .where('ref_id', '=', id)
        .limit(1)
        .executeTakeFirst();
      if (ref) return true;
      const pattern = await db
        .selectFrom('patterns')
        .select('id')
        .where('tenant_id', '=', tenantId)
        .where(
          sql<boolean>`jsonb_path_exists(blocks,
          '$.** ? (@.type == "video" && @.props.videoId == $id)',
          jsonb_build_object('id', ${id}::text))`
        )
        .executeTakeFirst();
      return !!pattern;
    },
  };
}
