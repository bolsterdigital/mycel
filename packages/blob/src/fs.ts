// A `BlobStore` in a local directory: development, the e2e gate and a small self-host. A key is a
// relative path under `dir`; a write goes to a temporary file in the same directory and is renamed
// into place, so a reader never sees half a file and a crash leaves at most a `.tmp-*` file,
// which `list` skips. The content type is not stored: it follows from the extension, which every
// media key carries. Rejected: a sidecar file per blob for the type (twice the files for a value
// the key already says).

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import type { BlobStore } from '@mycel/core';

const TYPES: Record<string, string> = {
  jpg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  avif: 'image/avif',
  gif: 'image/gif',
  pdf: 'application/pdf',
};
export const contentTypeOfKey = (key: string): string =>
  TYPES[key.slice(key.lastIndexOf('.') + 1).toLowerCase()] ?? 'application/octet-stream';

/** A key may not escape the store: no absolute paths, no `..`, no empty segments. */
export function assertKey(key: string): void {
  if (
    !key ||
    key.startsWith('/') ||
    key.split('/').some((s) => s === '' || s === '.' || s === '..')
  )
    throw new Error(`invalid blob key: ${key}`);
}

const missing = (e: unknown) => (e as NodeJS.ErrnoException).code === 'ENOENT';

export function createFsBlobStore(dir: string): BlobStore {
  const root = resolve(dir);
  const path = (key: string) => {
    assertKey(key);
    const full = resolve(root, key);
    if (!full.startsWith(root + sep)) throw new Error(`invalid blob key: ${key}`);
    return full;
  };

  async function* walk(at: string): AsyncGenerator<string> {
    let entries;
    try {
      entries = await readdir(at, { withFileTypes: true });
    } catch (e) {
      if (missing(e)) return;
      throw e;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const full = join(at, entry.name);
      if (entry.isDirectory()) yield* walk(full);
      else if (entry.isFile() && !entry.name.startsWith('.tmp-')) yield full;
    }
  }

  return {
    async put(key, bytes) {
      const target = path(key);
      await mkdir(dirname(target), { recursive: true });
      const tmp = join(dirname(target), `.tmp-${randomUUID()}`);
      try {
        await writeFile(tmp, bytes);
        await rename(tmp, target);
      } catch (e) {
        await rm(tmp, { force: true });
        throw e;
      }
    },
    async get(key) {
      try {
        return new Uint8Array(await readFile(path(key)));
      } catch (e) {
        if (missing(e)) return null;
        throw e;
      }
    },
    async head(key) {
      try {
        const s = await stat(path(key));
        return s.isFile() ? { size: s.size, contentType: contentTypeOfKey(key) } : null;
      } catch (e) {
        if (missing(e)) return null;
        throw e;
      }
    },
    async delete(keys) {
      for (const key of keys) await rm(path(key), { force: true });
    },
    async *list(prefix) {
      // Walk the deepest directory the prefix names, then filter on the full prefix.
      const base = prefix.includes('/') ? prefix.slice(0, prefix.lastIndexOf('/')) : '';
      if (base) assertKey(base);
      for await (const full of walk(base ? join(root, base) : root)) {
        const key = relative(root, full).split(sep).join('/');
        if (!key.startsWith(prefix)) continue;
        const s = await stat(full).catch((e) => (missing(e) ? null : Promise.reject(e)));
        if (s) yield { key, size: s.size, modifiedAt: s.mtime };
      }
    },
  };
}
