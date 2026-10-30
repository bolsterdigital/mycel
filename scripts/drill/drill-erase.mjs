#!/usr/bin/env node
// The erasure of the restore drill (TODO #18d, scripts/drill/drill-run.sh): register one supporter of a
// tenant in the erasure register, as mycel_app through the unit of work, the way the
// `supporters.erase` use case will (phase 2). Applying is the worker's: `mycel erasures
// apply` runs next, in the image, on the owner's connection.
//
//   node scripts/drill/drill-erase.mjs drill-a supporter-drill-a@example.org
//
// Reads DATABASE_URL (the owner, only to find the tenant) and APP_DATABASE_URL; drill-run.sh sets
// both. Rejected: inserting the register row as the owner, which forced RLS refuses since 0018.

import { createDb, createTenantDirectory, createUnitOfWork, uuidv7Ids } from '@mycel/db';
import { systemPrincipal } from '@mycel/core';
import { FakeDns, FakeInputHasher, FakeSigner, memoryPlatform } from '@mycel/core/testing';

const [slug, email] = process.argv.slice(2);
if (!slug || !email) {
  console.error('usage: drill-erase.mjs <tenant-slug> <e-mail>');
  process.exit(64);
}

const operatorDb = createDb(process.env.DATABASE_URL);
const appDb = createDb(process.env.APP_DATABASE_URL);
try {
  const tenant = await createTenantDirectory(operatorDb).findBySlug(slug);
  if (!tenant) throw new Error(`no tenant ${slug}`);
  const uow = createUnitOfWork(appDb, {
    clock: { now: () => new Date() },
    ids: uuidv7Ids,
    signer: new FakeSigner(),
    inputHasher: new FakeInputHasher(),
    dns: new FakeDns(),
    platform: memoryPlatform,
  });
  const id = await uow.run(systemPrincipal(tenant.id, 'drill'), async (ctx) => {
    const supporter = await ctx.supporters.getProjection(email);
    if (!supporter) throw new Error(`no supporter ${email} in ${slug}`);
    await ctx.erasures.register(supporter.id, email);
    return supporter.id;
  });
  console.log(`drill-erase: registered supporter ${id} of ${slug}`);
} finally {
  await operatorDb.destroy();
  await appDb.destroy();
}
