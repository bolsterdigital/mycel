#!/usr/bin/env node
// Tenant data for the restore drill (TODO #18c, scripts/drill-run.sh): for each tenant slug on the
// command line, which `mycel setup` created, a published page with its signup form, a supporter
// through ingest with the submission behind it, an API key, an author and an uploaded image with
// real bytes in the bucket. Everything through the invoker as mycel_app, as a use case writes it
// (the pattern of scripts/e2e.mjs), so the drill restores what production holds and not rows a
// test inserted past the policies.
//
//   node scripts/drill-fixture.mjs drill-a drill-b
//
// Reads DATABASE_URL (the owner, only to find the tenants), APP_DATABASE_URL and the BLOB_S3_*
// keys of the drill's bucket, plus what loadConfig requires; drill-run.sh sets them all.
// Rejected: SQL inserts as the owner, which forced RLS refuses since 0018 and which would skip
// the media variants and the event log a real upload and signup produce.

import { createDb, createTenantDirectory, createUnitOfWork, uuidv7, uuidv7Ids } from '@mycel/db';
import {
  Invoker,
  appDelivery,
  buildRegistry,
  supporterIngestSubscriber,
  systemPrincipal,
  useCases,
} from '@mycel/core';
import {
  FakeDns,
  FakeInputHasher,
  FakeSigner,
  memoryPlatform,
  probeForm,
  publishProbePage,
} from '@mycel/core/testing';
import { blobStoreFor, loadConfig } from '@mycel/api/compose';
import { createSharpProcessor } from '@mycel/media-sharp';
import sharp from 'sharp';

const slugs = process.argv.slice(2);
if (!slugs.length) {
  console.error('usage: drill-fixture.mjs <tenant-slug>...');
  process.exit(64);
}

const operatorDb = createDb(process.env.DATABASE_URL);
const appDb = createDb(process.env.APP_DATABASE_URL);
const uow = createUnitOfWork(appDb, {
  clock: { now: () => new Date() },
  ids: uuidv7Ids,
  signer: new FakeSigner(),
  inputHasher: new FakeInputHasher(),
  dns: new FakeDns(),
  platform: memoryPlatform,
  media: {
    blobs: blobStoreFor(loadConfig()),
    images: createSharpProcessor(),
    delivery: appDelivery,
  },
});
const invoker = new Invoker(buildRegistry(), uow);
const directory = createTenantDirectory(operatorDb);

for (const [n, slug] of slugs.entries()) {
  const tenant = await directory.findBySlug(slug);
  if (!tenant) throw new Error(`no tenant ${slug}; run mycel setup first`);
  const admin = systemPrincipal(tenant.id, 'drill');

  const formId = uuidv7();
  await uow.run(admin, (ctx) => ctx.forms.insert(probeForm(formId)));
  await publishProbePage(invoker, admin, formId);
  await invoker.run(useCases.createAuthor, admin, { slug: 'redactie', name: `Redactie ${slug}` });
  await invoker.run(useCases.createKey, admin, { name: 'drill', capabilities: ['content:read'] });

  // A supporter the way a signup makes one: the submission, then ingest of its event. The
  // subscriber is called directly; no worker runs during the drill's fixture and backup.
  const email = `supporter-${slug}@example.org`;
  const submitted = await invoker.run(useCases.submitForm, admin, {
    formId,
    values: { email, consent: true },
    locale: 'nl',
  });
  if (submitted.status !== 'accepted') throw new Error(`signup for ${slug}: ${submitted.status}`);
  await supporterIngestSubscriber(uow).handle({
    id: uuidv7(),
    type: 'newsletter.subscribed',
    tenantId: tenant.id,
    occurredAt: new Date(),
    actor: { kind: 'system', job: 'drill' },
    props: {
      email,
      list: 'newsletter',
      formId,
      submissionId: submitted.submissionId,
      locale: 'nl',
      pageUrl: null,
      consentTextVersion: 'newsletter-2026-10',
      confirmed: false,
    },
  });

  // A photograph-sized JPEG with real pixels, different per tenant, so the variants are real
  // files in the bucket and a lost or swapped object changes the fingerprint.
  const hue = 40 + n * 140;
  const bytes = await sharp(
    Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800">` +
        `<rect width="100%" height="100%" fill="hsl(${hue},55%,45%)"/>` +
        `<circle cx="400" cy="450" r="220" fill="hsl(${hue + 180},50%,80%)"/></svg>`
    )
  )
    .jpeg({ quality: 80 })
    .toBuffer();
  const media = await invoker.run(useCases.uploadMedia, admin, {
    filename: `${slug}.jpg`,
    contentType: 'image/jpeg',
    bytes: bytes.toString('base64'),
    caption: { nl: `Beeld van ${slug}`, en: `Picture of ${slug}` },
    credit: { work: null, photographer: 'Mycel drill' },
  });
  console.log(`drill-fixture: ${slug} has a page, a supporter, a key and image ${media.id}`);
}

await operatorDb.destroy();
await appDb.destroy();
