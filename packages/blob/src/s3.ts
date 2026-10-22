// A `BlobStore` on any S3-compatible bucket (Hetzner, Scaleway, MinIO; ADR 008) with the AWS SDK
// v3 client (Apache-2.0). The bucket stays private: this adapter never produces a URL, delivery
// goes through the site (`MediaDelivery`). `forcePathStyle` is for MinIO and endpoints without
// virtual-hosted buckets. Rejected: a hand-written SigV4 client (200 lines we would have to keep
// right against every provider's quirks) and presigned URLs for delivery (the bucket would then
// decide cache headers and access, ADR 018 rules 7 and 8).

import {
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  NoSuchKey,
  NotFound,
  PutObjectCommand,
  S3Client,
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

export function createS3BlobStore(config: S3BlobStoreConfig): BlobStore {
  const client = new S3Client({
    region: config.region,
    ...(config.endpoint ? { endpoint: config.endpoint } : {}),
    forcePathStyle: config.forcePathStyle ?? false,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
  });
  const Bucket = config.bucket;

  return {
    async put(key, bytes, { contentType }) {
      assertKey(key);
      await client.send(
        new PutObjectCommand({ Bucket, Key: key, Body: bytes, ContentType: contentType })
      );
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
