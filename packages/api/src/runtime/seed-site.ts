// A demo site from `@mycel/core/testing` into a tenant of this installation (MY-264): makes the
// tenant when it is missing, invites an operator as its administrator when `--admin` names one,
// runs the site definition through the use cases (`seedSite`) and prints a manifest of every
// page, article, person, form, campaign and supporter with its admin and public address. With the
// fake payment provider it also makes the supporters: it drains the outbox itself so a signature
// counts before the next step, and pays their gifts at the fake provider. A second run adds what
// a newer definition has and keeps the rest, so a test server is brought up to date without a
// reseed. Development and test servers only: it lives beside `seed-demo.ts`, not in
// the `mycel` CLI, which is operator tooling for production where demo content does not belong.
//
//   npm run demo:site -w @mycel/api -- otterdam [--tenant <slug>] [--admin <e-mail>] [--manifest <file>]
//
// The definition also sets the theme, logo and footer text while the tenant still has the
// defaults; an editor's later choice is never overwritten.
//
// Rejected: a CLI command (see above), and requiring the tenant to exist first (two commands for
// what is always done together on a fresh server).

import { readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { contentPath, systemPrincipal, useCases } from '@mycel/core';
import {
  OTTERDAM,
  PODCAST_BASE64,
  reportPdf,
  seedSite,
  type MediaDef,
  type SiteDefinition,
} from '@mycel/core/testing';
import { createDb } from '@mycel/db';
import {
  createRuntime,
  inputHasherOf,
  loadConfig,
  missingMediaAdvice,
  missingMediaFiles,
  platformOf,
  platformOperations,
} from './compose.js';

const SITES: Record<string, { site: SiteDefinition; files: URL }> = {
  otterdam: { site: OTTERDAM, files: new URL('../../demo-sites/otterdam/', import.meta.url) },
};

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { tenant: { type: 'string' }, admin: { type: 'string' }, manifest: { type: 'string' } },
});
const chosen = SITES[positionals[0] ?? ''];
if (!chosen) {
  console.error(
    `usage: demo:site <${Object.keys(SITES).join('|')}> [--tenant <slug>] [--admin <e-mail>] [--manifest <file>]`
  );
  process.exit(2);
}
const { site, files } = chosen;
const slug = values.tenant ?? site.slug;

const config = loadConfig();
if (!config.DATABASE_URL) {
  console.error('demo:site: DATABASE_URL (the operator role) must be set to make the tenant');
  process.exit(1);
}
const db = createDb(config.DATABASE_URL);
const store = platformOperations(db, platformOf(config), () => ({
  actorId: 'demo-site',
  hasher: inputHasherOf(config),
}));
let tenant = await store.bySlug(slug);
if (!tenant) {
  tenant = await store.create({ slug, name: site.name, locales: site.locales });
  console.log(`created tenant ${tenant.slug}`);
}
if (values.admin) {
  await store.restoreAdmin(tenant.id, values.admin);
  console.log(`${values.admin} is administrator of ${tenant.slug} (active from the first login)`);
}

const load = async (media: MediaDef): Promise<Uint8Array> =>
  media.contentType === 'application/pdf'
    ? reportPdf()
    : media.contentType === 'audio/mpeg'
      ? new Uint8Array(Buffer.from(PODCAST_BASE64, 'base64'))
      : new Uint8Array(await readFile(new URL(media.filename, files)));

const runtime = createRuntime(config, { service: 'cli' });
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
try {
  const principal = systemPrincipal(tenant.id, 'seed');
  const where = { slug: tenant.slug, primaryHostname: null };
  const fake = runtime.fakePayments;
  if (!fake) console.log('no supporters or gifts: they need PAYMENT_PROVIDER=fake');
  const result = await seedSite(runtime.invoker, principal, site, {
    load,
    ...(fake && {
      activity: {
        origin: runtime.siteUrl(where, '/').replace(/\/$/, ''),
        uow: runtime.uow,
        // A running worker may hold an event of ours: a second pass after it had time to finish.
        deliver: async () => {
          await runtime.drainOutbox();
          await pause(300);
          await runtime.drainOutbox();
        },
        settle: async (ref) => void fake.settle(ref, 'paid'),
      },
    }),
  });
  const made = Object.entries(result.created).map(([kind, keys]) => `${keys.length} ${kind}`);
  console.log(made.length ? `made: ${made.join(', ')}` : 'nothing to make: the site was complete');

  const admin = `${runtime.platform.platformOrigin}/admin/${tenant.slug}`;
  const defaultLocale = site.defaultLocale;
  const manifest = {
    tenant: tenant.slug,
    admin,
    items: result.items.map(({ key, item }) => ({
      key,
      type: item.type,
      slug: item.slug,
      admin: `${admin}/content/${item.id}`,
      status: Object.fromEntries(item.publication.map((p) => [p.locale, p.status])),
      public: Object.fromEntries(
        item.publication
          .filter((p) => p.status === 'published')
          .map((p) => [
            p.locale,
            runtime.siteUrl(where, contentPath(item, p.locale, defaultLocale)),
          ])
      ),
    })),
    people: site.people.map((p) => ({
      key: p.key,
      admin: `${admin}/people/${result.refs.person(p.key)}`,
      public: p.person.kind === 'organisation' ? null : runtime.siteUrl(where, `/people/${p.slug}`),
    })),
    sections: site.sections.map((s) => ({
      key: s.key,
      // A section has a feed, not yet an archive page of its own.
      feed: runtime.siteUrl(where, `/sections/${s.slug}/feed.xml`),
    })),
    campaigns: site.campaigns.map((c) => ({
      key: c.key,
      admin: `${admin}/campaigns/${result.refs.campaign(c.key)}`,
    })),
    forms: site.forms.map((f) => ({
      key: f.key,
      admin: `${admin}/forms/${result.refs.form(f.key)}`,
    })),
    tiers: { admin: `${admin}/access` },
    donations: { admin: `${admin}/donations`, recurring: `${admin}/donations/recurring` },
    supporters: await Promise.all(
      (fake ? (site.supporters ?? []) : []).map(async (s) => {
        const { id } = await runtime.invoker.run(useCases.getSupporter, principal, {
          email: s.email,
        });
        return { key: s.key, email: s.email, admin: `${admin}/supporters/${id}` };
      })
    ),
  };
  if (values.manifest) {
    await writeFile(values.manifest, `${JSON.stringify(manifest, null, 2)}\n`);
    console.log(`manifest: ${values.manifest}`);
  } else console.log(`home: ${runtime.siteUrl(where, '/')}\nadmin: ${admin}`);

  // Reused rows are only as good as their files: say so here instead of in a screenshot.
  const missing = await missingMediaFiles(runtime.uow, runtime.blobs, principal);
  if (missing.length) {
    console.error(`\n${missingMediaAdvice(tenant.slug, missing)}`);
    process.exitCode = 1;
  }
} finally {
  await runtime.close();
  await db.destroy();
}
