#!/usr/bin/env node
// Media changes during a backup, for the restore drill (TODO #29A, scripts/drill-run.sh): upload
// an unused image, delete it the way an editor does (the purge waits MEDIA_PURGE_DELAY_MS), or
// purge it now, as a worker whose clock is past that delay would. Through the invoker and the
// unit of work as mycel_app, like scripts/drill-fixture.mjs.
//
//   node scripts/drill-media.mjs upload drill-a          prints the new media id
//   node scripts/drill-media.mjs delete drill-a <id>
//   node scripts/drill-media.mjs purge drill-a <id>      deletes the files and the row now
//
// Reads DATABASE_URL (the owner, only to find the tenant), APP_DATABASE_URL and the BLOB_S3_*
// keys; drill-run.sh sets them. Rejected: running the worker with a shifted clock (the drill
// would wait on its tick, and the worker also drains every other job).

import { createDb, createTenantDirectory, createUnitOfWork, uuidv7Ids } from '@mycel/db';
import {
  Invoker,
  appDelivery,
  buildRegistry,
  mediaPrefix,
  purgeMedia,
  systemPrincipal,
  useCases,
} from '@mycel/core';
import { FakeDns, FakeInputHasher, FakeSigner, memoryPlatform } from '@mycel/core/testing';
import { blobStoreFor, loadConfig } from '@mycel/api/compose';
import { createSharpProcessor } from '@mycel/media-sharp';
import sharp from 'sharp';

const [command, slug, id] = process.argv.slice(2);
if (!slug || !['upload', 'delete', 'purge'].includes(command) || (command !== 'upload' && !id)) {
  console.error('usage: drill-media.mjs upload <tenant-slug> | delete|purge <tenant-slug> <id>');
  process.exit(64);
}

const operatorDb = createDb(process.env.DATABASE_URL);
const appDb = createDb(process.env.APP_DATABASE_URL);
const blobs = blobStoreFor(loadConfig());
const uow = createUnitOfWork(appDb, {
  clock: { now: () => new Date() },
  ids: uuidv7Ids,
  signer: new FakeSigner(),
  inputHasher: new FakeInputHasher(),
  dns: new FakeDns(),
  platform: memoryPlatform,
  media: { blobs, images: createSharpProcessor(), delivery: appDelivery },
});
const invoker = new Invoker(buildRegistry(), uow);
try {
  const tenant = await createTenantDirectory(operatorDb).findBySlug(slug);
  if (!tenant) throw new Error(`no tenant ${slug}`);
  const admin = systemPrincipal(tenant.id, 'drill');
  if (command === 'upload') {
    const bytes = await sharp({
      create: { width: 700, height: 400, channels: 3, background: { r: 30, g: 90, b: 60 } },
    })
      .png()
      .toBuffer();
    const media = await invoker.run(useCases.uploadMedia, admin, {
      filename: 'during-backup.png',
      contentType: 'image/png',
      bytes: bytes.toString('base64'),
    });
    console.log(media.id);
  } else if (command === 'delete') {
    await invoker.run(useCases.deleteMedia, admin, { id });
    console.error(`drill-media: deleted ${id} of ${slug}, purge planned`);
  } else {
    const keys = [];
    for await (const { key } of blobs.list(`${mediaPrefix(tenant.id)}${id}/`)) keys.push(key);
    await uow.run(admin, (ctx) => purgeMedia(ctx, { mediaId: id, keys }));
    console.error(`drill-media: purged ${id} of ${slug}, ${keys.length} files`);
  }
} finally {
  await operatorDb.destroy();
  await appDb.destroy();
}
