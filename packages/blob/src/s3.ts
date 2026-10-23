// A `BlobStore` on any S3-compatible bucket (Hetzner, Scaleway, MinIO; ADR 008) with the AWS SDK
// v3 client (Apache-2.0). The bucket stays private: this adapter never produces a URL, delivery
// goes through the site (`MediaDelivery`). `forcePathStyle` is for MinIO and endpoints without
// virtual-hosted buckets. Rejected: a hand-written SigV4 client (200 lines we would have to keep
// right against every provider's quirks) and presigned URLs for delivery (the bucket would then
// decide cache headers and access, ADR 018 rules 7 and 8).

import { open } from 'node:fs/promises';
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateBucketCommand,
  CreateMultipartUploadCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  NoSuchKey,
  NotFound,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import type { BlobStore } from '@mycel/core';
import { assertKey } from './fs.js';

export interface S3BlobStoreConfig {
  endpoint?: string | undefined;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle?: boolean | undefined;
}

const notFound = (e: unknown) =>
  e instanceof NoSuchKey ||
  e instanceof NotFound ||
  (e as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404;

/** DeleteObjects takes at most a thousand keys per call. */
const BATCH = 1000;

/**
 * `putFile` uploads in parts of this size (S3's minimum is 5 MiB except for the last part): one
 * part in memory at a time, and 10,000 parts reach 160 GiB. Rejected: `@aws-sdk/lib-storage`
 * (a dependency for forty lines) and a single PutObject from a stream (capped at 5 GiB).
 */
const PART_BYTES = 16 * 1024 * 1024;

function clientOf(config: S3BlobStoreConfig): S3Client {
  return new S3Client({
    region: config.region,
    ...(config.endpoint ? { endpoint: config.endpoint } : {}),
    forcePathStyle: config.forcePathStyle ?? false,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
  });
}

/**
 * Create the bucket when it does not exist (`mycel blob init`, TODO #18a): for a bucket on the
 * same box (the `local-s3` compose profile), which starts empty. A provider's bucket is usually
 * made in its console; one that already exists and is ours is `exists`, anything else throws.
 */
export async function ensureS3Bucket(config: S3BlobStoreConfig): Promise<'created' | 'exists'> {
  const client = clientOf(config);
  try {
    await client.send(new CreateBucketCommand({ Bucket: config.bucket }));
    return 'created';
  } catch (e) {
    if (/BucketAlready(OwnedByYou|Exists)/.test((e as Error).name)) return 'exists';
    throw e;
  } finally {
    client.destroy();
  }
}

export function createS3BlobStore(config: S3BlobStoreConfig): BlobStore {
  const client = clientOf(config);
  const Bucket = config.bucket;

  return {
    async put(key, bytes, { contentType }) {
      assertKey(key);
      await client.send(
        new PutObjectCommand({ Bucket, Key: key, Body: bytes, ContentType: contentType })
      );
    },
    async putFile(key, path, { contentType }) {
      assertKey(key);
      const file = await open(path, 'r');
      let UploadId: string | undefined;
      try {
        const { size } = await file.stat();
        if (size <= PART_BYTES) {
          const Body = new Uint8Array(size);
          await file.read(Body, 0, size, 0);
          await client.send(new PutObjectCommand({ Bucket, Key: key, Body, ContentType: contentType }));
          return;
        }
        ({ UploadId } = await client.send(
          new CreateMultipartUploadCommand({ Bucket, Key: key, ContentType: contentType })
        ));
        const parts: { ETag: string; PartNumber: number }[] = [];
        const buffer = new Uint8Array(PART_BYTES);
        for (let at = 0, PartNumber = 1; at < size; at += PART_BYTES, PartNumber++) {
          const { bytesRead } = await file.read(buffer, 0, PART_BYTES, at);
          const out = await client.send(
            new UploadPartCommand({
              Bucket,
              Key: key,
              UploadId,
              PartNumber,
              Body: buffer.subarray(0, bytesRead),
            })
          );
          parts.push({ ETag: out.ETag ?? '', PartNumber });
        }
        await client.send(
          new CompleteMultipartUploadCommand({
            Bucket,
            Key: key,
            UploadId,
            MultipartUpload: { Parts: parts },
          })
        );
        UploadId = undefined;
      } catch (e) {
        // An unfinished upload is invisible but billed; abort it.
        if (UploadId)
          await client
            .send(new AbortMultipartUploadCommand({ Bucket, Key: key, UploadId }))
            .catch(() => {});
        throw e;
      } finally {
        await file.close();
      }
    },
    async getStream(key) {
      assertKey(key);
      try {
        const out = await client.send(new GetObjectCommand({ Bucket, Key: key }));
        // In Node the body is a Readable, which is an AsyncIterable of chunks.
        return (out.Body as AsyncIterable<Uint8Array> | undefined) ?? (async function* () {})();
      } catch (e) {
        if (notFound(e)) return null;
        throw e;
      }
    },
    async get(key) {
      assertKey(key);
      try {
        const out = await client.send(new GetObjectCommand({ Bucket, Key: key }));
        return out.Body ? await out.Body.transformToByteArray() : new Uint8Array();
      } catch (e) {
        if (notFound(e)) return null;
        throw e;
      }
    },
    async head(key) {
      assertKey(key);
      try {
        const out = await client.send(new HeadObjectCommand({ Bucket, Key: key }));
        return {
          size: out.ContentLength ?? 0,
          contentType: out.ContentType ?? 'application/octet-stream',
        };
      } catch (e) {
        if (notFound(e)) return null;
        throw e;
      }
    },
    async delete(keys) {
      keys.forEach(assertKey);
      for (let i = 0; i < keys.length; i += BATCH) {
        const out = await client.send(
          new DeleteObjectsCommand({
            Bucket,
            Delete: { Objects: keys.slice(i, i + BATCH).map((Key) => ({ Key })), Quiet: true },
          })
        );
        // A missing key is not an error (S3 reports none); anything else is.
        const failed = (out.Errors ?? []).filter((e) => e.Code !== 'NoSuchKey');
        if (failed.length)
          throw new Error(
            `S3 delete failed: ${failed.map((e) => `${e.Key} ${e.Code}`).join(', ')}`
          );
      }
    },
    async *list(prefix) {
      let ContinuationToken: string | undefined;
      do {
        const out = await client.send(
          new ListObjectsV2Command({ Bucket, Prefix: prefix, ContinuationToken })
        );
        for (const o of out.Contents ?? [])
          if (o.Key)
            yield { key: o.Key, size: o.Size ?? 0, modifiedAt: o.LastModified ?? new Date(0) };
        ContinuationToken = out.IsTruncated ? out.NextContinuationToken : undefined;
      } while (ContinuationToken);
    },
  };
}
