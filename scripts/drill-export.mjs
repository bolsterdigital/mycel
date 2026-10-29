#!/usr/bin/env node
// An export archive in the bucket, for the restore drill (TODO #28, scripts/drill-run.sh): ask for
// one through the invoker as a site administrator would, and run the `tenant.export` job now, as
// the worker would, so the archive lands under `exports/<tenant>/<id>.tar`. The drill then shows
// that a backup leaves it out. Prints the archive's key.
//
//   node scripts/drill-export.mjs drill-a
//
// Reads DATABASE_URL (the owner: the job builds the archive on the operator connection),
// APP_DATABASE_URL and the BLOB_S3_* keys; drill-run.sh sets them. Rejected: putting a file under
// `exports/` by hand (it would prove the exclude, not that the job writes where it excludes).

import {
  claimJobs,
  completeJob,
  createDb,
  createTenantDirectory,
  createUnitOfWork,
  runExportJob,
  uuidv7Ids,
} from '@mycel/db';
import { Invoker, buildRegistry, exportArchiveKey, systemPrincipal, useCases } from '@mycel/core';
import { FakeDns, FakeInputHasher, FakeSigner, memoryPlatform } from '@mycel/core/testing';
import { blobStoreFor, loadConfig } from '@mycel/api/compose';

const [slug, key] = process.argv.slice(2);
if (!slug || (slug === 'absent' && !key)) {
  console.error('usage: drill-export.mjs <tenant-slug> | absent <key>');
  process.exit(64);
}
if (slug === 'absent') {
  const found = await blobStoreFor(loadConfig()).head(key);
  if (found) {
    console.error(`drill-export: ${key} is still in the bucket`);
    process.exit(1);
  }
  console.error(`drill-export: ${key} is gone`);
  process.exit(0);
}

const operatorDb = createDb(process.env.DATABASE_URL);
const appDb = createDb(process.env.APP_DATABASE_URL);
const blobs = blobStoreFor(loadConfig());
const clock = { now: () => new Date() };
const uow = createUnitOfWork(appDb, {
  clock,
  ids: uuidv7Ids,
  signer: new FakeSigner(),
  inputHasher: new FakeInputHasher(),
  dns: new FakeDns(),
  platform: memoryPlatform,
});
try {
  const tenant = await createTenantDirectory(operatorDb).findBySlug(slug);
  if (!tenant) throw new Error(`no tenant ${slug}`);
  const { id } = await new Invoker(buildRegistry(), uow).run(
    useCases.requestExport,
    systemPrincipal(tenant.id, 'drill'),
    {}
  );
  // What the worker does for this one job: claim, run, complete.
  const [job] = (await claimJobs(operatorDb, { types: ['tenant.export'] })).filter(
    (j) => j.key === `tenant.export:${id}`
  );
  if (!job) throw new Error(`no open tenant.export job for ${id}`);
  await completeJob(
    operatorDb,
    job,
    await runExportJob(
      { operatorDb, blobs, clock, mycelVersion: 'drill', retentionDays: 7 },
      job,
      id
    )
  );
  const archive = exportArchiveKey(tenant.id, id);
  if (!(await blobs.head(archive))) throw new Error(`the export job did not write ${archive}`);
  console.log(archive);
} finally {
  await operatorDb.destroy();
  await appDb.destroy();
}
