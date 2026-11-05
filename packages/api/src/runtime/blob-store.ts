// The media blob store of a configuration, and the development checks around a shared store:
// which root a relative BLOB_DIR is taken from, and which media rows have no file in it. Split
// from compose.ts; `compose.ts` re-exports it. Rejected: keeping it in the
// composition root, where the worktree and seed logic hid the wiring it serves.

import { readFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mediaKeys, type BlobStore, type Principal, type UnitOfWork } from '@mycel/core';
import { createFsBlobStore, createS3BlobStore } from '@mycel/blob';
import { s3ConfigOf, type RuntimeConfig } from './config.js';

/**
 * The directory a relative BLOB_DIR is taken from: `repoRoot`, or, when `repoRoot` is a linked git
 * worktree, the root of the main checkout it belongs to. Every worktree of a clone reads one
 * development database (`.env`), so they share one store too: with a store per worktree, a row
 * written from one checkout had no file in the others, and the e2e seed, which reuses the fixture
 * pages it finds in the database, served images that did not exist. Read from the `.git`
 * file and the worktree's `commondir`, without running git; anything else (a plain checkout, a
 * submodule, a bare clone, production without `.git`) keeps `repoRoot`.
 * Rejected: `git rev-parse --git-common-dir` (a process spawn in the runtime for a development
 * path), and an absolute BLOB_DIR prescribed per worktree (every new worktree red until set).
 */
export function blobRoot(repoRoot: string): string {
  try {
    const pointer = /^gitdir:\s*(.+)$/m.exec(readFileSync(join(repoRoot, '.git'), 'utf8'));
    if (!pointer?.[1]) return repoRoot;
    const worktreeDir = resolve(repoRoot, pointer[1].trim());
    const common = resolve(
      worktreeDir,
      readFileSync(join(worktreeDir, 'commondir'), 'utf8').trim()
    );
    return basename(common) === '.git' ? dirname(common) : repoRoot;
  } catch {
    // `.git` is a directory (a plain checkout) or absent, or the pointer has no commondir.
    return repoRoot;
  }
}

/**
 * The filenames of the live media of a tenant that have a row but no file in `store`: rows another
 * checkout wrote into this database with its own store. Every one of them is a broken image in
 * the admin and on the site (404, logged as "in the register but not in the store"). The e2e
 * gate and the dev seed both ask this before they trust the media they find.
 * Rejected: re-uploading or deleting a row on a miss (the file still exists in the other store,
 * and its references and history belong to that row).
 */
export async function missingMediaFiles(
  uow: UnitOfWork,
  store: BlobStore,
  principal: Principal
): Promise<string[]> {
  const missing: string[] = [];
  for (let cursor: string | undefined; ;) {
    const page = await uow.run(principal, (ctx) => ctx.media.list({ cursor, limit: 100 }));
    for (const m of page)
      for (const key of mediaKeys(principal.tenantId, m))
        if (!(await store.head(key))) {
          missing.push(m.filename);
          break;
        }
    if (page.length < 100) return missing;
    cursor = page[page.length - 1]!.id;
  }
}

/** Why `missingMediaFiles` found anything, and the two ways out. */
export const missingMediaAdvice = (tenant: string, missing: readonly string[]) =>
  `${missing.length} live media of tenant ${tenant} have no files in this checkout's blob ` +
  `store (${missing.slice(0, 5).join(', ')}${missing.length > 5 ? ', ...' : ''}).\n` +
  'They were written by a checkout with another store on this same database. Point BLOB_DIR ' +
  "at that checkout's store (an absolute path), or give this checkout its own database " +
  '(docs/architecture/testing.md § Local database). A linked git worktree already shares ' +
  "the main checkout's .scratch/blob.";

/** The BlobStore the configuration names; S3 credentials were checked by `loadConfig`. */
export function blobStoreFor(config: RuntimeConfig): BlobStore {
  const s3 = s3ConfigOf(config);
  return s3
    ? createS3BlobStore(s3)
    : createFsBlobStore(
        isAbsolute(config.BLOB_DIR)
          ? config.BLOB_DIR
          : resolve(
              blobRoot(fileURLToPath(new URL('../../../..', import.meta.url))),
              config.BLOB_DIR
            )
      );
}
