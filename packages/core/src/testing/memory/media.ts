// The media ports in memory: a shared blob bucket, a codec-free image processor and the
// tenant's media rows with their usages.

import type { MediaRecord } from '../../media/model.js';
import type { BlobStore, ImageProbe, ImageProcessor, MediaRepository } from '../../media/ports.js';
import type { Clock } from '../../ports.js';
import { FakeClock } from './fakes.js';
import type { StoredMedia, TenantStore } from './store.js';

/**
 * A `BlobStore` in a Map, shared by every tenant like a bucket. `modifiedAt` comes from the clock
 * so the orphan sweep's age test can be driven by `FakeClock.advance`.
 */
export class MemoryBlobStore implements BlobStore {
  readonly blobs = new Map<string, { bytes: Uint8Array; contentType: string; modifiedAt: Date }>();
  /**
   * `readFile` serves `putFile`: the core may not touch the file system, so a suite that streams
   * a file into this store hands over `node:fs/promises`' readFile itself.
   */
  constructor(
    readonly clock: Clock = new FakeClock(),
    readonly readFile?: (path: string) => Promise<Uint8Array>
  ) {}
  async put(key: string, bytes: Uint8Array, { contentType }: { contentType: string }) {
    // The contract of the real stores (packages/blob): a key never escapes the store.
    if (!key || key.startsWith('/') || key.split('/').some((p) => ['', '.', '..'].includes(p)))
      throw new Error(`invalid blob key: ${key}`);
    this.blobs.set(key, {
      bytes: new Uint8Array(bytes),
      contentType,
      modifiedAt: this.clock.now(),
    });
  }
  async putFile(key: string, path: string, options: { contentType: string }) {
    if (!this.readFile) throw new Error('MemoryBlobStore.putFile needs a readFile');
    await this.put(key, await this.readFile(path), options);
  }
  async get(key: string) {
    const b = this.blobs.get(key);
    return b ? new Uint8Array(b.bytes) : null;
  }
  async getStream(key: string) {
    const b = this.blobs.get(key);
    if (!b) return null;
    const bytes = new Uint8Array(b.bytes);
    // In chunks, as the real stores deliver, so a consumer that assumes one chunk fails here.
    return (async function* () {
      for (let i = 0; i < bytes.length; i += 64 * 1024) yield bytes.subarray(i, i + 64 * 1024);
    })();
  }
  async head(key: string) {
    const b = this.blobs.get(key);
    return b ? { size: b.bytes.length, contentType: b.contentType } : null;
  }
  async delete(keys: readonly string[]) {
    for (const key of keys) this.blobs.delete(key);
  }
  async *list(prefix: string) {
    for (const [key, b] of [...this.blobs].sort(([a], [z]) => a.localeCompare(z)))
      if (key.startsWith(prefix)) yield { key, size: b.bytes.length, modifiedAt: b.modifiedAt };
  }
}

const sniff = (b: Uint8Array, at: number, text: string) =>
  [...text].every((c, i) => b[at + i] === c.charCodeAt(0));

/**
 * An `ImageProcessor` without a codec: `probe` recognises the five formats by their magic bytes
 * and reads the size from a PNG's IHDR or a GIF's header (anything else is 1x1); `render` returns
 * the bytes unchanged with the requested width. Enough for the core's rules; real decoding is
 * `@mycel/media-sharp`'s contract test.
 */
export const memoryImageProcessor: ImageProcessor = {
  async probe(b) {
    const be32 = (at: number) =>
      ((b[at]! << 24) | (b[at + 1]! << 16) | (b[at + 2]! << 8) | b[at + 3]!) >>> 0;
    let found: Omit<ImageProbe, 'pages'> | null = null;
    if (b.length >= 24 && b[0] === 0x89 && sniff(b, 1, 'PNG'))
      found = { format: 'png', width: be32(16), height: be32(20) };
    else if (b.length >= 10 && sniff(b, 0, 'GIF8'))
      found = { format: 'gif', width: b[6]! | (b[7]! << 8), height: b[8]! | (b[9]! << 8) };
    else if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff)
      found = { format: 'jpeg', width: 1, height: 1 };
    else if (b.length >= 12 && sniff(b, 0, 'RIFF') && sniff(b, 8, 'WEBP'))
      found = { format: 'webp', width: 1, height: 1 };
    else if (b.length >= 12 && sniff(b, 4, 'ftypavif'))
      found = { format: 'avif', width: 1, height: 1 };
    // A GIF header does not say how many frames follow; a test that needs frames stubs `probe`.
    return found && found.width > 0 && found.height > 0 ? { ...found, pages: 1 } : null;
  },
  async render(bytes, { width }) {
    return { bytes: new Uint8Array(bytes), width, height: width };
  },
};

/** `ctx.media`; `lock` is the tenant's media lock of the current run (TODO #8b2). */
export function memoryMedia(s: TenantStore, lock: () => Promise<void>): MediaRepository {
  const usageCount = (id: string) =>
    [...s.mediaUsages.values()].filter((u) => u.mediaId === id).length;
  const mediaRecord = (m: StoredMedia): MediaRecord => ({
    ...structuredClone(m),
    usageCount: usageCount(m.id),
  });
  return {
    lock,
    get: async (id) => {
      const m = s.media.get(id);
      return m ? mediaRecord(m) : null;
    },
    async list({ kind, cursor, limit }) {
      const all = [...s.media.values()]
        .filter((m) => !m.deletedAt && (!kind || m.kind === kind))
        .sort((a, b) => +b.createdAt - +a.createdAt || b.id.localeCompare(a.id));
      const from = cursor ? all.findIndex((m) => m.id === cursor) + 1 : 0;
      return all.slice(from, from + limit).map(mediaRecord);
    },
    async insert(m) {
      s.media.set(m.id, { ...structuredClone(m), deletedAt: null });
    },
    async update(id, patch, at) {
      const m = s.media.get(id);
      if (!m || m.deletedAt) return false;
      Object.assign(m, structuredClone(patch), { updatedAt: new Date(at) });
      return true;
    },
    async softDelete(id, at) {
      const m = s.media.get(id);
      if (!m || m.deletedAt) return false;
      m.deletedAt = new Date(at);
      return true;
    },
    async hardDelete(id) {
      const m = s.media.get(id);
      if (!m?.deletedAt) return false;
      for (const [k, u] of s.mediaUsages) if (u.mediaId === id) s.mediaUsages.delete(k);
      return s.media.delete(id);
    },
    async replaceUsages(ref, usages) {
      for (const [k, u] of s.mediaUsages) if (u.ref === ref) s.mediaUsages.delete(k);
      let n = 0;
      for (const { mediaId, blockId } of usages) {
        const key = `${mediaId} ${ref} ${blockId}`;
        if (!s.media.get(mediaId) || s.media.get(mediaId)!.deletedAt || s.mediaUsages.has(key))
          continue;
        s.mediaUsages.set(key, { mediaId, ref, blockId });
        n += 1;
      }
      return n;
    },
    idsOf: async () => [...s.media.keys()],
  };
}
