#!/usr/bin/env node
// Runs the Playwright + axe gate (ADR 009 rule 3) when its infrastructure exists: a Postgres
// (DATABASE_URL + APP_DATABASE_URL) and an installed Chromium. Without them it prints why it
// skipped and exits 0, so `verify` stays usable on a laptop without a database; CI sets
// E2E_REQUIRED=1 so a missing service fails the build instead of skipping silently.
// Rejected: a separate CI-only command, which lets the gate drift out of `verify`.
//
// The signup flow needs more than the web app: the outbox worker sends the confirmation mail,
// and the spec reads that mail from a spool directory and checks the supporter over HTTP. So
// this script also starts the API process (worker in-process, console mailer with
// MAIL_SPOOL_DIR) on its own port and stops it afterwards. Rejected: a second webServer entry
// in playwright.config.ts, which cannot create the spool directory or share its path.
//
// The admin flow (TODO #7) logs in through scripts/mock-oidc.mjs, which this script starts too,
// and uses an API key: generated here before the seed, which stores its hash for tenant probe.
//
// The fronts run as in production (ADR 011 rule 1, TODO #20b): the API with MYCEL_WORKER=off and
// the web server both without DATABASE_URL, so neither can hold the schema owner's credentials;
// the worker is its own process and the only one with it. Fixtures that need the owner run in
// this script before the processes start.

import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const required = process.env.E2E_REQUIRED === '1';
const skip = (why) => {
  if (required) {
    console.error(`e2e: required but ${why}`);
    process.exit(1);
  }
  console.log(`e2e: skipped (${why}); set DATABASE_URL and APP_DATABASE_URL to run it`);
  process.exit(0);
};

for (const name of [
  'DATABASE_URL',
  'APP_DATABASE_URL',
  'AUTH_DATABASE_URL',
  'SIGNING_SECRET',
  'PUBLIC_BASE_URL',
  'PLATFORM_DOMAIN',
  'MAIL_FROM',
])
  if (!process.env[name]) skip(`${name} is not set`);

const { chromium } = await import('@playwright/test');
if (!existsSync(chromium.executablePath()))
  skip('Chromium is not installed (npx playwright install chromium)');
if (!existsSync(`${root}apps/web/build/index.js`)) skip('apps/web is not built (npm run build)');
if (!existsSync(`${root}packages/api/dist/server.js`)) skip('packages/api is not built');

const run = (cmd, args, cwd = root, env = process.env) => {
  const r = spawnSync(cmd, args, { cwd, stdio: 'inherit', env });
  if (r.status !== 0) process.exit(r.status ?? 1);
};
// The seed stores this token's hash as the `seed` key of tenant probe; API and spec use it.
const apiKey = process.env.MYCEL_API_KEY ?? `mycel_${randomBytes(32).toString('base64url')}`;
run('npm', ['run', '-s', 'migrate', '-w', '@mycel/db']);
// The e2e admin is its own address: the mock IdP here has another issuer (port) than the one
// `npm run dev` starts, so sharing admin@probe.test would let one claim the other's invitation.
run('npm', ['run', '-s', 'seed', '-w', '@mycel/db'], root, {
  ...process.env,
  MYCEL_API_KEY: apiKey,
  MYCEL_SEED_OPERATOR_EMAIL: 'e2e-admin@probe.test',
});

// A second, verified hostname of tenant probe for hostnames.spec.ts (a non-primary hostname is
// a 301 to the primary). Verification needs a real TXT record, so the fixture goes in through
// the repository as the use case would leave it, not through DNS.
//
// And a higher supporter cap for probe than the seed's 250: every run signs up new addresses, so
// a long-lived development database reaches 250 probe supporters after some sixty runs, while CI
// starts empty. The admin still shows used against the limit; the seed itself keeps 250. The
// document is replaced as a whole, so the credit stays on explicitly (review round 1, F).
{
  const { createDb, createTenantDirectory, createUnitOfWork, setEntitlements, uuidv7Ids } =
    await import('@mycel/db');
  const {
    BLOCK_DEFINITIONS,
    EXAMPLE_IDS,
    Invoker,
    appDelivery,
    buildRegistry,
    systemPrincipal,
    useCases,
  } = await import('@mycel/core');
  const { blobStoreFor, loadConfig } = await import('@mycel/api/compose');
  const { createSharpProcessor } = await import('@mycel/media-sharp');
  const { FakeDns, FakeInputHasher, FakeSigner, memoryPlatform } =
    await import('@mycel/core/testing');
  const operatorDb = createDb(process.env.DATABASE_URL);
  const probe = await createTenantDirectory(operatorDb).findBySlug('probe');
  await setEntitlements(
    operatorDb,
    probe.id,
    { remove_branding: false, 'supporters.max': 10000 },
    { actorId: 'e2e', hasher: new FakeInputHasher(process.env.AUDIT_HASH_KEY) }
  );
  // Tenant data as mycel_app, like a use case: since 0010 binds the tenant_hostnames policy to
  // that role, a schema owner that is not a superuser (managed Postgres, the Mac setup) cannot.
  const appDb = createDb(process.env.APP_DATABASE_URL);
  const uow = createUnitOfWork(appDb, {
    clock: { now: () => new Date() },
    ids: uuidv7Ids,
    signer: new FakeSigner(),
    inputHasher: new FakeInputHasher(),
    dns: new FakeDns(),
    platform: memoryPlatform,
    // The block fixtures below upload real images into the store the web server reads.
    media: {
      blobs: blobStoreFor(loadConfig()),
      images: createSharpProcessor(),
      delivery: appDelivery,
    },
  });
  await uow.run(systemPrincipal(probe.id, 'e2e'), async (ctx) => {
    const hostname = 'e2e-alias.example';
    if (
      await ctx.hostnames.insert({
        hostname,
        kind: 'custom',
        verificationToken: 'e2e-fixture',
        verifiedAt: null,
        createdAt: new Date(),
      })
    )
      await ctx.hostnames.setVerified(hostname, new Date());
  });
  // A page published in nl only whose English draft sits in the same revision: signup.spec.ts
  // asks for it in English and checks the draft never reaches the HTML (brief #8a, audit).
  const invoker = new Invoker(buildRegistry(), uow);
  const admin = systemPrincipal(probe.id, 'e2e');
  const draftCheck = { type: 'page', slug: 'draft-check' };
  if (!(await invoker.run(useCases.listItems, admin, draftCheck)).items.length) {
    const { item, revision } = await invoker.run(useCases.createItem, admin, {
      slug: draftCheck.slug,
      document: {
        type: 'page',
        defaultLocale: 'nl',
        locales: ['nl', 'en'],
        title: { nl: 'Alleen Nederlands live', en: 'EN-DRAFT-TITLE' },
        blocks: [
          { type: 'heading', version: 1, props: { text: { nl: 'Kop', en: 'EN-DRAFT-MARKER' } } },
        ],
      },
    });
    await invoker.run(useCases.publishItem, admin, {
      itemId: item.id,
      revisionId: revision.id,
      locale: 'nl',
    });
  }

  // An article with an author and a section, published in nl and en, for content-routes.spec.ts
  // (TODO #8c2): `/articles/<slug>`, its `/en/` twin, and the public metadata of the read route.
  const story = { type: 'article', slug: 'bomen-in-de-straat' };
  if (!(await invoker.run(useCases.listItems, admin, story)).items.length) {
    const [author, section] = await uow.run(admin, async (ctx) => [
      await ctx.authors.findBySlug('e2e-auteur'),
      await ctx.sections.findBySlug('e2e-stad'),
    ]);
    const authorId = (
      author ??
      (await invoker.run(useCases.createAuthor, admin, {
        slug: 'e2e-auteur',
        name: 'Sam de Vries',
        email: 'sam@probe.test',
      }))
    ).id;
    const sectionId = (
      section ??
      (await invoker.run(useCases.createSection, admin, {
        slug: 'e2e-stad',
        title: { nl: 'Stad', en: 'City' },
      }))
    ).id;
    const paragraph = (text) => ({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
    });
    const { item, revision } = await invoker.run(useCases.createItem, admin, {
      slug: story.slug,
      document: {
        type: 'article',
        defaultLocale: 'nl',
        locales: ['nl', 'en'],
        title: { nl: 'Bomen in de straat', en: 'Trees in the street' },
        lead: {
          nl: 'Waarom de buurt meer groen wil.',
          en: 'Why the neighbourhood wants more green.',
        },
        authorIds: [authorId],
        sectionId,
        blocks: [
          {
            type: 'rich-text',
            version: 1,
            props: {
              content: {
                nl: paragraph('Schaduw, koelte en ruimte voor water.'),
                en: paragraph('Shade, cool air and room for water.'),
              },
            },
          },
        ],
      },
    });
    for (const locale of ['nl', 'en'])
      await invoker.run(useCases.publishItem, admin, {
        itemId: item.id,
        revisionId: revision.id,
        locale,
      });
  }

  // Two composed pages for blocks.spec.ts (TODO #8c1): a campaign and an article, in nl and en,
  // built from the registry's own examples with the example ids swapped for real data: two
  // uploaded images, the signup page as the linked item and its form. `artikel` stays a page:
  // the block suite is about blocks, the article route has its own fixture above.
  const composed = {
    campagne: {
      title: { nl: 'Schone lucht, nu', en: 'Clean air, now' },
      blocks: [
        'hero-cover',
        'rich-text',
        'cta-card-two-actions',
        'image-wide-caption-credit',
        'faq-accordion',
        'form-card-wide',
      ],
    },
    artikel: {
      title: { nl: 'Een straat vol bomen', en: 'A street full of trees' },
      blocks: [
        'hero-split-long-label',
        'article-text',
        'quote-pullquote-wide',
        'image-float-right',
        'callout-warning',
        'video-vimeo-wide',
      ],
    },
  };
  // And one page per registry example for blocks-registry.spec.ts (TODO #30B): slug
  // `blok-<example name>`, the example alone, in nl and en. Walked from the registry, so a new
  // example is seeded and checked without a list here or in the spec. A paywall is only valid
  // with the marker teaser (ADR 016); the page stays public, so the boundary renders nothing.
  const pages = { ...composed };
  for (const [type, d] of Object.entries(BLOCK_DEFINITIONS))
    for (const e of d.examples)
      pages[`blok-${e.name}`] = {
        title: { nl: `Voorbeeld ${e.name}`, en: `Example ${e.name}` },
        blocks: [e.name],
        ...(type === 'paywall' && { access: { level: 'public', teaser: 'marker' } }),
      };
  const needed = [];
  for (const slug of Object.keys(pages))
    if (!(await invoker.run(useCases.listItems, admin, { type: 'page', slug })).items.length)
      needed.push(slug);
  if (needed.length) {
    const sharp = (await import('sharp')).default;
    // A landscape and a portrait with real pixels: shapes and a gradient, rendered from SVG.
    const picture = (width, height, hue) =>
      sharp(
        Buffer.from(
          `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">` +
            `<defs><linearGradient id="g" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue},55%,45%)"/>` +
            `<stop offset="1" stop-color="hsl(${hue + 60},60%,70%)"/></linearGradient></defs>` +
            `<rect width="100%" height="100%" fill="url(#g)"/>` +
            `<circle cx="${width * 0.3}" cy="${height * 0.6}" r="${Math.min(width, height) / 4}" fill="hsl(${hue + 180},50%,85%)"/></svg>`
        )
      )
        .jpeg({ quality: 80 })
        .toBuffer();
    const upload = async (filename, bytes, focal) =>
      invoker.run(useCases.uploadMedia, admin, {
        filename,
        contentType: 'image/jpeg',
        bytes: bytes.toString('base64'),
        caption: { nl: 'Op het Malieveld', en: 'On the Malieveld' },
        credit: { work: null, photographer: 'Mycel e2e' },
        focal,
      });
    const landscape = await upload('malieveld.jpg', await picture(1600, 900, 200), {
      x: 0.3,
      y: 0.6,
    });
    const portrait = await upload('bomen.jpg', await picture(800, 1000, 110), { x: 0.5, y: 0.5 });
    const [signupItem] = (
      await invoker.run(useCases.listItems, admin, { type: 'page', slug: 'signup' })
    ).items;
    const signup = await invoker.run(useCases.getItem, admin, { itemId: signupItem.id });
    const formId = signup.revision.document.blocks.find((b) => b.type === 'signup-form').props
      .formId;
    const examples = Object.fromEntries(
      Object.entries(BLOCK_DEFINITIONS).flatMap(([type, d]) =>
        d.examples.map((e) => [e.name, { type, version: 1, props: e.props }])
      )
    );
    // Rich text with section headings, a footnote and an item link: the article's body.
    examples['article-text'] = {
      type: 'rich-text',
      version: 1,
      props: {
        content: Object.fromEntries(
          [
            ['nl', 'Waarom bomen', 'Wat we vragen', 'Lees ook', 'de oproep'],
            ['en', 'Why trees', 'What we ask', 'Read also', 'the call'],
          ].map(([locale, h1, h2, before, link]) => [
            locale,
            {
              type: 'doc',
              content: [
                { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: h1 }] },
                {
                  type: 'paragraph',
                  content: [
                    {
                      type: 'text',
                      text: `${h1}: schaduw, koelte en ruimte voor water.`,
                      marks: [{ type: 'footnote_reference', attrs: { text: 'RIVM, 2025.' } }],
                    },
                  ],
                },
                { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: h2 }] },
                {
                  type: 'paragraph',
                  content: [
                    { type: 'text', text: `${before} ` },
                    {
                      type: 'text',
                      text: link,
                      marks: [{ type: 'link', attrs: { itemId: EXAMPLE_IDS.item } }],
                    },
                  ],
                },
              ],
            },
          ])
        ),
      },
    };
    const swap = (block) =>
      JSON.parse(
        JSON.stringify(block)
          .replaceAll(EXAMPLE_IDS.image, landscape.id)
          .replaceAll(EXAMPLE_IDS.portrait, portrait.id)
          .replaceAll(EXAMPLE_IDS.item, signupItem.id)
          .replaceAll(EXAMPLE_IDS.form, formId)
      );
    for (const slug of needed) {
      const { item, revision } = await invoker.run(useCases.createItem, admin, {
        slug,
        document: {
          type: 'page',
          defaultLocale: 'nl',
          locales: ['nl', 'en'],
          title: pages[slug].title,
          blocks: pages[slug].blocks.map((name) => swap(examples[name])),
          ...(pages[slug].access && { access: pages[slug].access }),
        },
      });
      for (const locale of ['nl', 'en'])
        await invoker.run(useCases.publishItem, admin, {
          itemId: item.id,
          revisionId: revision.id,
          locale,
        });
    }
  }
  await operatorDb.destroy();
  await appDb.destroy();
}

// The web app under test listens on 4173 (playwright.config.ts); links in the mail must point
// there, so the API process gets the same origin regardless of what .env says. Both processes
// run with SITE_URL_MODE=hostnames and PLATFORM_DOMAIN=localhost: the seed gives tenant probe
// the hostname probe.localhost, Chromium resolves it to loopback, and the specs cover both the
// hostname form (hostnames.spec.ts) and the development path form (signup.spec.ts).
const WEB_ORIGIN = 'http://127.0.0.1:4173';
const API_PORT = process.env.E2E_API_PORT ?? '8797';
const OIDC_PORT = process.env.E2E_OIDC_PORT ?? '8798';
const WORKER_PORT = process.env.E2E_WORKER_PORT ?? '8799';
const spool = mkdtempSync(join(tmpdir(), 'mycel-e2e-mail-'));
const env = {
  ...process.env,
  PUBLIC_BASE_URL: WEB_ORIGIN,
  PLATFORM_DOMAIN: 'localhost',
  SITE_URL_MODE: 'hostnames',
  MAILER: 'console',
  MAIL_SPOOL_DIR: spool,
  MYCEL_API_KEY: apiKey,
  OIDC_ISSUER: `http://127.0.0.1:${OIDC_PORT}`,
  OIDC_CLIENT_ID: 'mycel-e2e',
  E2E_API_URL: `http://127.0.0.1:${API_PORT}`,
};
// The mock is a public client; a secret from .env would make the token request differ.
delete env.OIDC_CLIENT_SECRET;
// What the fronts get: everything but the owner's connection (playwright.config.ts drops it for
// the web server the same way). The spec process itself keeps it for its own fixtures.
const { DATABASE_URL: _owner, ...frontEnv } = env;

const idp = spawn('node', ['scripts/mock-oidc.mjs'], {
  cwd: root,
  stdio: ['ignore', 'inherit', 'inherit'],
  env: { ...env, MOCK_OIDC_PORT: OIDC_PORT },
});
const api = spawn('node', ['packages/api/dist/server.js'], {
  cwd: root,
  stdio: ['ignore', 'inherit', 'inherit'],
  env: { ...frontEnv, PORT: API_PORT, MYCEL_WORKER: 'off' },
});
const worker = spawn('node', ['packages/api/dist/worker.js'], {
  cwd: root,
  stdio: ['ignore', 'inherit', 'inherit'],
  env: { ...env, PORT: WORKER_PORT },
});
const stop = () => {
  if (api.exitCode === null) api.kill('SIGTERM');
  if (worker.exitCode === null) worker.kill('SIGTERM');
  if (idp.exitCode === null) idp.kill('SIGTERM');
  rmSync(spool, { recursive: true, force: true });
};
process.on('exit', stop);
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => process.exit(1));

async function waitFor(name, child, url) {
  const deadline = Date.now() + 30_000;
  while (true) {
    if (child.exitCode !== null) {
      console.error(`e2e: ${name} exited with ${child.exitCode}`);
      process.exit(1);
    }
    const ok = await fetch(url)
      .then((r) => r.ok)
      .catch(() => false);
    if (ok) return;
    if (Date.now() > deadline) {
      console.error(`e2e: ${name} did not become healthy in 30s`);
      process.exit(1);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}
await waitFor('API process', api, `${env.E2E_API_URL}/healthz`);
await waitFor('worker', worker, `http://127.0.0.1:${WORKER_PORT}/healthz`);
await waitFor('mock IdP', idp, `${env.OIDC_ISSUER}/.well-known/openid-configuration`);

// The children keep the event loop alive; stop them explicitly once the tests are done.
run('npx', ['playwright', 'test', ...process.argv.slice(2)], `${root}apps/web`, env);
stop();
// The worker planned a `mail.reconcile` per confirmation it sent, RECONCILE_LAG_MS ahead, and is
// gone before they fall due. Close probe's so they neither wait for the next run's worker nor
// crowd recovery.conformance's claim (TODO #32); its other jobs, hostname checks, stay.
{
  const { createDb, createTenantDirectory } = await import('@mycel/db');
  const { closeTenantWork } = await import('@mycel/db/testing');
  const operatorDb = createDb(process.env.DATABASE_URL);
  const probe = await createTenantDirectory(operatorDb).findBySlug('probe');
  if (probe) await closeTenantWork(operatorDb, [probe.id], { jobTypes: ['mail.reconcile'] });
  await operatorDb.destroy();
}
process.exit(0);
