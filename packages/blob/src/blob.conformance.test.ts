// The BlobStore contract (TODO #10), run over every implementation: the directory store always,
// the S3 store against a real bucket when `BLOB_S3_*` is set (a local MinIO, `docker compose -f
// compose.dev.yml --profile blob up -d`, or the MinIO service in CI). Like the database suites it
// skips locally without the service and fails in CI (`E2E_REQUIRED=1`).

import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CreateBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { afterAll, describe, expect, it } from 'vitest';
import type { BlobStore } from '@mycel/core';
import { MemoryBlobStore } from '@mycel/core/testing';
import { createFsBlobStore, createS3BlobStore } from './index.js';

const env = process.env;
const s3Config = env['BLOB_S3_BUCKET']
  ? {
      endpoint: env['BLOB_S3_ENDPOINT'],
      region: env['BLOB_S3_REGION'] ?? 'us-east-1',
      bucket: env['BLOB_S3_BUCKET'],
      accessKeyId: env['BLOB_S3_ACCESS_KEY_ID'] ?? '',
      secretAccessKey: env['BLOB_S3_SECRET_ACCESS_KEY'] ?? '',
      forcePathStyle: env['BLOB_S3_FORCE_PATH_STYLE'] === '1',
    }
  : null;
if (env['E2E_REQUIRED'] === '1' && !s3Config)
  throw new Error('E2E_REQUIRED=1 but BLOB_S3_BUCKET is not set: the S3 contract cannot run');

const bytes = (s: string) => new TextEncoder().encode(s);
const text = (b: Uint8Array | null) => (b ? new TextDecoder().decode(b) : null);
const collect = async (it: AsyncIterable<{ key: string; size: number; modifiedAt: Date }>) => {
  const out = [];
  for await (const x of it) out.push(x);
  return out;
};

function contract(
  name: string,
  make: () => Promise<{ store: BlobStore; done?: () => Promise<void> }>
) {
  describe(`BlobStore contract: ${name}`, () => {
    // Every run writes under its own prefix, so runs and implementations never see each other.
    const run = `contract-${Math.random().toString(36).slice(2, 10)}`;
    const k = (path: string) => `${run}/${path}`;
    let ready: Promise<{ store: BlobStore; done?: () => Promise<void> }> | undefined;
    const store = async () => (await (ready ??= make())).store;

    afterAll(async () => {
      const s = await store();
      await s.delete((await collect(s.list(`${run}/`))).map((x) => x.key));
      await (await ready)?.done?.();
    });

    it('puts, gets and heads a blob; a missing key is null', async () => {
      const s = await store();
      await s.put(k('a/one.png'), bytes('hello'), { contentType: 'image/png' });
      expect(text(await s.get(k('a/one.png')))).toBe('hello');
      expect(await s.head(k('a/one.png'))).toEqual({ size: 5, contentType: 'image/png' });
      expect(await s.get(k('a/missing.png'))).toBeNull();
      expect(await s.head(k('a/missing.png'))).toBeNull();
    });

    it('is idempotent on the key: a second put replaces, never duplicates', async () => {
      const s = await store();
      await s.put(k('b/x.webp'), bytes('first'), { contentType: 'image/webp' });
      await s.put(k('b/x.webp'), bytes('first'), { contentType: 'image/webp' });
      expect((await collect(s.list(k('b/')))).map((x) => x.key)).toEqual([k('b/x.webp')]);
    });

    it('lists by prefix with size and a recent modification time', async () => {
      const s = await store();
      const before = Date.now() - 60_000;
      await s.put(k('c/1/a.avif'), bytes('12'), { contentType: 'image/avif' });
      await s.put(k('c/1/b.avif'), bytes('123'), { contentType: 'image/avif' });
      await s.put(k('c/2/a.avif'), bytes('1'), { contentType: 'image/avif' });
      await s.put(k('cx/a.avif'), bytes('1'), { contentType: 'image/avif' });
      const listed = await collect(s.list(k('c/1/')));
      expect(listed.map((x) => [x.key, x.size])).toEqual([
        [k('c/1/a.avif'), 2],
        [k('c/1/b.avif'), 3],
      ]);
      expect(listed.every((x) => x.modifiedAt.getTime() > before)).toBe(true);
      expect((await collect(s.list(k('c/')))).map((x) => x.key)).toEqual([
        k('c/1/a.avif'),
        k('c/1/b.avif'),
        k('c/2/a.avif'),
      ]);
      expect(await collect(s.list(k('nothing/')))).toEqual([]);
    });

    it('deletes several keys; a missing key is not an error', async () => {
      const s = await store();
      await s.put(k('d/a.png'), bytes('a'), { contentType: 'image/png' });
      await s.put(k('d/b.png'), bytes('b'), { contentType: 'image/png' });
      await s.delete([k('d/a.png'), k('d/b.png'), k('d/never.png')]);
      expect(await collect(s.list(k('d/')))).toEqual([]);
      await s.delete([]);
    });

    // TODO #28: an export archive goes in and out without being held in memory. The file is over
    // one S3 part (16 MiB), so the multipart path runs; reading must arrive in several chunks.
    it('streams a file in with putFile and out with getStream; a missing key is null', async () => {
      const s = await store();
      const dir = await mkdtemp(join(tmpdir(), 'mycel-blob-file-'));
      try {
        const file = join(dir, 'archive.tar');
        const data = randomBytes(17 * 1024 * 1024 + 123);
        await writeFile(file, data);
        await s.putFile(k('e/archive.tar'), file, { contentType: 'application/x-tar' });
        expect(await s.head(k('e/archive.tar'))).toEqual({
          size: data.length,
          contentType: 'application/x-tar',
        });
        const stream = await s.getStream(k('e/archive.tar'));
        const hash = createHash('sha256');
        let chunks = 0;
        let size = 0;
        for await (const chunk of stream!) {
          hash.update(chunk);
          size += chunk.length;
          chunks++;
        }
        expect(size).toBe(data.length);
        expect(hash.digest('hex')).toBe(createHash('sha256').update(data).digest('hex'));
        expect(chunks).toBeGreaterThan(1);
        expect(await s.getStream(k('e/missing.tar'))).toBeNull();
        await expect(
          s.putFile(k('e/never.tar'), join(dir, 'no-such-file'), { contentType: 'application/x-tar' })
        ).rejects.toThrow();
        expect(await s.head(k('e/never.tar'))).toBeNull();
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('refuses a key that could escape the store', async () => {
      const s = await store();
      for (const key of ['../x.png', '/abs.png', 'a//b.png', 'a/./b.png', ''])
        await expect(s.put(key, bytes('x'), { contentType: 'image/png' })).rejects.toThrow(
          'invalid blob key'
        );
    });
  });
}

contract('memory', async () => ({
  store: new MemoryBlobStore(
    { now: () => new Date() },
    async (path) => new Uint8Array(await readFile(path))
  ),
}));

contract('fs', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mycel-blob-'));
  return { store: createFsBlobStore(dir), done: () => rm(dir, { recursive: true, force: true }) };
});

describe('fs store writes atomically', () => {
  it('leaves no temporary file behind and never lists one', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mycel-blob-'));
    try {
      const store = createFsBlobStore(dir);
      await Promise.all(
        Array.from({ length: 20 }, (_, i) =>
          store.put('t/same.png', bytes(`writer ${i}`.padEnd(64, '.')), {
            contentType: 'image/png',
          })
        )
      );
      expect(await readdir(join(dir, 't'))).toEqual(['same.png']);
      // Whichever writer won, the file is one writer's whole content, never a mix.
      expect(text(await store.get('t/same.png'))).toMatch(/^writer \d+\.+$/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe.skipIf(!s3Config)('s3', () => {
  contract('s3', async () => {
    const c = s3Config!;
    const client = new S3Client({
      region: c.region,
      ...(c.endpoint ? { endpoint: c.endpoint } : {}),
      forcePathStyle: c.forcePathStyle,
      credentials: { accessKeyId: c.accessKeyId, secretAccessKey: c.secretAccessKey },
    });
    // MinIO starts empty; an existing bucket (owned by us) is fine.
    await client.send(new CreateBucketCommand({ Bucket: c.bucket })).catch((e: Error) => {
      if (!/BucketAlready(OwnedByYou|Exists)/.test(e.name)) throw e;
    });
    client.destroy();
    return { store: createS3BlobStore(c) };
  });
});
