// Dev seed, second step: a filled demo page and article for tenant probe, with the four
// public-domain photos in `../../demo-photos/` (sources and hashes in its README), after
// `@mycel/db`'s seed made the tenant, its form and its signup page. It lives here and not in
// that seed because uploading needs a BlobStore and an ImageProcessor, and `packages/db` may
// import only the core (scripts/gates/check-dependency-rules.mjs); this package's runtime already
// composes both from the same configuration the web app reads, so the files land where the dev
// server looks (BLOB_DIR). Idempotent: `seedDemoContent` keeps items that exist, and swaps the
// generated posters of an earlier seed for the photos once. Run by `npm run db:seed`; the e2e
// gate runs only the first step.
// Rejected: a second blob and sharp wiring inside packages/db, and a `mycel` CLI command (the CLI
// is operator tooling for production, where demo content does not belong).

import { readFile } from 'node:fs/promises';
import { contentPath, systemPrincipal, useCases } from '@mycel/core';
import { seedDemoContent } from '@mycel/core/testing';
import { createRuntime, loadConfig } from './compose.js';

const PHOTOS = new URL('../../demo-photos/', import.meta.url);

const runtime = createRuntime(loadConfig(), { service: 'cli' });
try {
  const tenant = await runtime.tenants.findBySlug('probe');
  if (!tenant) throw new Error('tenant probe does not exist: run the @mycel/db seed first');
  const admin = systemPrincipal(tenant.id, 'seed');

  // The probe's signup form, as the signup page of the first step references it.
  const [signup] = (
    await runtime.invoker.run(useCases.listItems, admin, { type: 'page', slug: 'signup' })
  ).items;
  const { revision } = await runtime.invoker.run(useCases.getItem, admin, {
    itemId: signup!.id,
  });
  const formId = revision.document.blocks.flatMap((b) =>
    b.type === 'signup-form' || b.type === 'form' ? [b.props.formId] : []
  )[0];
  if (!formId) throw new Error('the probe signup page references no form');

  const { page, article, created, upgraded } = await seedDemoContent(runtime.invoker, admin, {
    formId,
    load: async (image) => new Uint8Array(await readFile(new URL(image.filename, PHOTOS))),
  });
  for (const { item, published } of upgraded)
    console.log(
      `  ${item.type} ${item.slug}: posters replaced by photos${published ? ' and published' : ', a new revision waits for an editor'}`
    );
  const site = { slug: tenant.slug, primaryHostname: null };
  console.log(created ? 'seeded demo content:' : 'demo content already seeded:');
  for (const item of [page, article])
    for (const locale of item.locales)
      console.log(
        `  ${item.type} ${locale}: ${runtime.siteUrl(site, contentPath(item, locale, tenant.defaultLocale))}`
      );
  for (const item of [page, article])
    console.log(
      `  admin ${item.type}: ${runtime.platform.platformOrigin}/admin/${tenant.slug}/content/${item.id}`
    );
} finally {
  await runtime.close();
}
