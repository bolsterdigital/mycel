// BlobStore adapters (TODO #10): `createFsBlobStore` for development, the e2e gate and a small
// self-host, `createS3BlobStore` for any S3-compatible bucket. One package with both, so one
// contract suite runs over both; sharp is a separate package because its native build should not
// come with a store. Rejected: a package per store (two packages for one contract and one test).
export { createFsBlobStore, contentTypeOfKey } from './fs.js';
export { createS3BlobStore, type S3BlobStoreConfig } from './s3.js';
