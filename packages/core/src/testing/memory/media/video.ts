// Behaves like the tenant-scoped video repository, including references from old revisions.
import { allBlocks } from '../../../content/blocks.js';
import type { VideoRepository } from '../../../media/ports.js';
import type { TenantStore } from '../store.js';

export function memoryVideos(store: TenantStore): VideoRepository {
  return {
    async get(id) {
      return store.videos.get(id) ?? null;
    },
    async list() {
      return [...store.videos.values()].filter((row) => !row.trashedAt);
    },
    async insert(row) {
      store.videos.set(row.id, row);
    },
    async update(id, patch) {
      const row = store.videos.get(id);
      if (row) store.videos.set(id, { ...row, ...patch });
    },
    async upload(id) {
      return store.videoUploads.get(id) ?? null;
    },
    async byUploadKey(key) {
      return [...store.videoUploads.values()].find((row) => row.uploadKey === key) ?? null;
    },
    async saveUpload(row) {
      store.videoUploads.set(row.videoId, row);
    },
    async usage(except) {
      const uploads = [...store.videoUploads.values()].filter((row) => row.videoId !== except);
      return {
        storageBytes: uploads.reduce((sum, row) => sum + row.storageBytes, 0),
        durationSeconds: uploads.reduce((sum, row) => sum + row.durationSeconds, 0),
      };
    },
    async used(id) {
      const trees = [
        ...[...store.revisions.values()].map((revision) => revision.document.blocks),
        ...[...store.patterns.values()].map((pattern) => pattern.blocks),
      ];
      return trees.some((blocks) =>
        allBlocks(blocks).some((block) => block.type === 'video' && block.props.videoId === id)
      );
    },
  };
}
