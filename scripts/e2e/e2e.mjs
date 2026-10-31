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
// The admin flow (TODO #7) logs in through scripts/e2e/mock-oidc.mjs, which this script starts too,
// and uses an API key: generated here before the seed, which stores its hash for tenant probe.
//
// The fronts run as in production (ADR 011 rule 1, TODO #20b): the API with MYCEL_WORKER=off and
// the web server both without DATABASE_URL, so neither can hold the schema owner's credentials;
// the worker is its own process and the only one with it. Fixtures that need the owner run in
// this script before the processes start.

import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { blockExamples } from './e2e-block-examples.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const qualityCorpus = JSON.parse(
  readFileSync(new URL('../../apps/web/e2e/quality-corpus.json', import.meta.url), 'utf8')
);
const quality = process.argv.includes('--quality');
const required = quality || process.env.E2E_REQUIRED === '1';
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
if (!existsSync(`${root}packages/api/dist/runtime/server.js`)) skip('packages/api is not built');

const run = (cmd, args, cwd = root, env = process.env) => {
  const r = spawnSync(cmd, args, { cwd, stdio: 'inherit', env });
  if (r.status !== 0) process.exit(r.status ?? 1);
};
const fail = (why) => {
  console.error(`e2e: ${why}`);
  process.exit(1);
};

// Ports of the processes this script starts. The worker's default is not 8799: that is where
// `npm run dev` starts its mock IdP, and a running dev server used to push a run onto other
// ports, which forked the fixture operators below (TODO #27).
const API_PORT = process.env.E2E_API_PORT ?? '8797';
const OIDC_PORT = process.env.E2E_OIDC_PORT ?? '8798';
const WORKER_PORT = process.env.E2E_WORKER_PORT ?? '8796';
const ISSUER = `http://127.0.0.1:${OIDC_PORT}`;
for (const [name, port] of [
  ['web server', '4173'],
  ['API process', API_PORT],
  ['mock IdP', OIDC_PORT],
  ['worker', WORKER_PORT],
]) {
  const free = await new Promise((resolve) => {
    const probe = createServer()
      .once('error', () => resolve(false))
      .listen(Number(port), '127.0.0.1', () => probe.close(() => resolve(true)));
  });
  if (!free)
    fail(
      `port ${port} for the ${name} is in use (\`lsof -nP -iTCP:${port} -sTCP:LISTEN\` names ` +
        'the process); stop it, probably a leftover of an interrupted run, or set E2E_*_PORT'
    );
}

// The database this run works in, held for the whole run. The specs share fixtures in it
// (tenant probe, its entitlements, the operators below), so a second run on the same database
// at the same time changes them under the first. A session advisory lock ends with the process,
// also when it is killed. Rejected: a lock file, which a killed run leaves behind.
const pg = (await import('pg')).default;
const runLock = new pg.Client({ connectionString: process.env.DATABASE_URL });
await runLock.connect();
if (!(await runLock.query('select pg_try_advisory_lock(4242027) as ok')).rows[0].ok)
  fail(`another e2e run holds database ${runLock.database}; wait for it or use another database`);
// A schema ahead of this checkout (another branch migrated the shared local database) fails
// specs that have nothing to do with the diff; scripts/test-db-preflight.mjs explains it.
const { foreignSessions, migrationsAhead, sessionsWarning } = await import('@mycel/db');
const ahead = await migrationsAhead(runLock);
if (ahead.length)
  fail(
    `database ${runLock.database} has migration(s) this checkout does not know: ` +
      `${ahead.join(', ')}; use a database for this checkout (docs/architecture/testing.md ` +
      '§ Local database)'
  );
// Another API or worker on this database drains the outbox the signup specs wait on (TODO #27):
// named here, not refused, since `npm run dev` may run next to the gate.
{
  const warning = sessionsWarning(runLock.database, await foreignSessions(runLock));
  if (warning) console.warn(`e2e: ${warning}`);
}
// The seed stores this token's hash as the `seed` key of tenant probe; API and spec use it.
const apiKey = process.env.MYCEL_API_KEY ?? `mycel_${randomBytes(32).toString('base64url')}`;
// The synthetic webhook fixture needs the same installation-local key in the web and worker.
process.env.CONNECTION_CREDENTIAL_KEY ??= randomBytes(32).toString('hex');
run('npm', ['run', '-s', 'migrate', '-w', '@mycel/db']);

// The fixture operators belong to this run's mock IdP. An operator is its issuer plus subject,
// and the issuer carries the port, so one run with E2E_OIDC_PORT set claimed the invitations of
// e2e-admin@probe.test and the others under that port; every later run on the default port then
// logged in as a new operator without a membership ("Geen toegang tot deze site", TODO #27), and
// the invitation could no longer repair it (two verified operators: ambiguous). Production keeps
// that rule; here a mock subject is one synthetic person whatever the port. Per subject: drop the
// rows without a membership (a foreign key refuses the others), then move a remaining one onto
// this issuer. The dev operator (`npm run dev`, its own port) is left alone.
{
  const devOperator = process.env.MYCEL_SEED_OPERATOR_EMAIL ?? 'admin@probe.test';
  const { rows } = await runLock.query(
    `select id, issuer, subject, email from operators o
     where subject like 'mock-%' and issuer ~ '^http://127\\.0\\.0\\.1:[0-9]+$'
       and email like '%@probe.test' and email <> $1
       and exists (select 1 from operators x where x.subject = o.subject
                   and x.issuer ~ '^http://127\\.0\\.0\\.1:[0-9]+$' and x.issuer <> $2)
     order by subject, (issuer = $2) desc, last_login_at desc nulls last`,
    [devOperator, ISSUER]
  );
  const bySubject = Map.groupBy(rows, (r) => r.subject);
  for (const group of bySubject.values()) {
    const kept = [];
    for (const row of group) {
      try {
        await runLock.query('delete from operators where id = $1', [row.id]);
      } catch (e) {
        if (e.code !== '23503') throw e;
        kept.push(row);
      }
    }
    const current = kept.find((r) => r.issuer === ISSUER) ?? kept[0];
    if (current && current.issuer !== ISSUER)
      await runLock.query('update operators set issuer = $2 where id = $1', [current.id, ISSUER]);
    const others = kept.length - (current ? 1 : 0);
    console.log(
      `e2e: fixture operator ${group[0].email} ` +
        (current ? `is now ${ISSUER}'s` : 'had no membership; its invitations start over') +
        (others ? ` (${others} other row(s) keep memberships: invitations are ambiguous)` : '')
    );
  }
}
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
  const { blobStoreFor, loadConfig, missingMediaAdvice, missingMediaFiles } =
    await import('@mycel/api/compose');
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

  // An article with an author and a section, published in nl and en, for public-site.spec.ts
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

  // Two composed pages for public-site.spec.ts (TODO #8c1): a campaign and an article, in nl and en,
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
    [qualityCorpus.public.article.slug]: {
      type: 'article',
      title: { nl: 'De straat die ruimte maakt', en: 'A street making room' },
      lead: {
        nl: 'Een synthetisch lang verhaal over bomen, water en toegankelijkheid.',
        en: 'A synthetic long read about trees, water and access.',
      },
      blocks: [
        'hero-split-long-label',
        'quality-long-read',
        'image-wide-caption-credit',
        'quote-blockquote',
        'image-float-left',
        'image-float-right',
        'image-full-decorative',
      ],
    },
  };
  // And one page per registry example for ui-gate.spec.ts (TODO #30B): slug
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
  // And one page per Playwright project with the first example of every type, for
  // content-admin.spec.ts (TODO #11 B): each block edited once without JavaScript. One per
  // project, because both projects run that spec at the same time and would conflict on one page.
  for (const project of ['no-js', 'a11y'])
    pages[`e2e-blokken-${project}`] = {
      title: { nl: `Blokken ${project}`, en: `Blocks ${project}` },
      blocks: Object.values(BLOCK_DEFINITIONS).map((d) => d.examples[0].name),
      access: { level: 'public', teaser: 'marker' },
    };
  const needed = [];
  for (const slug of Object.keys(pages))
    if (
      !(await invoker.run(useCases.listItems, admin, { type: pages[slug].type ?? 'page', slug }))
        .items.length
    )
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
    const square = await upload('plein.jpg', await picture(1000, 1000, 45), { x: 0.5, y: 0.5 });
    const panorama = await upload('water.jpg', await picture(1800, 750, 175), { x: 0.5, y: 0.5 });
    const [signupItem] = (
      await invoker.run(useCases.listItems, admin, { type: 'page', slug: 'signup' })
    ).items;
    const signup = await invoker.run(useCases.getItem, admin, { itemId: signupItem.id });
    const formId = signup.revision.document.blocks.find((b) => b.type === 'signup-form').props
      .formId;
    const examples = blockExamples(BLOCK_DEFINITIONS);
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
    // A stable long read makes image loading, lists, links, headings and text layout measurable.
    // The short registry examples remain the per-block edge cases, never the quality benchmark.
    const paragraph = (sentences) => ({
      type: 'paragraph',
      content: [{ type: 'text', text: sentences.join(' ') }],
    });
    const list = (type, labels) => ({
      type,
      content: labels.map((label) => ({ type: 'list_item', content: [paragraph([label])] })),
    });
    const longRead = (locale) => {
      const nl = locale === 'nl';
      const sentences = nl
        ? [
            'Bewoners bespreken de schaduw van bomen, veilige stoepen en ruimte om elkaar te ontmoeten.',
            'Een brede oversteek helpt kinderen en ouderen om de drukke straat zelfstandig te gebruiken.',
            'Op warme dagen zoeken wandelaars koelte terwijl regenwater langzaam naar de nieuwe plantvakken stroomt.',
            'De buurt telt bestaande bomen en noteert zorgvuldig waar wortels en leidingen elkaar raken.',
            'Vrijwilligers spreken met winkeliers over laden, lossen, fietsparkeren en een toegankelijke ingang.',
            'De gemeente legt de tekeningen op tafel zodat iedereen de gevolgen per straatdeel kan zien.',
            'Na iedere bijeenkomst verschijnt een samenvatting met open vragen en een datum voor reactie.',
            'Het voorstel combineert onderhoud, veilig verkeer en meer groen zonder de doorgang te blokkeren.',
          ]
        : [
            'Neighbours discuss tree shade, safe pavements and space to meet each other in the street.',
            'A broad crossing helps children and older people use the busy road without assistance.',
            'On hot days walkers find shade while rainwater flows slowly towards the new planting beds.',
            'Residents count existing trees and carefully note where roots and underground pipes meet.',
            'Volunteers ask shopkeepers about deliveries, bicycle parking and an entrance everyone can use.',
            'The council lays out the drawings so everyone can see the effect on each block.',
            'Every meeting is followed by a summary with open questions and a date for responses.',
            'The proposal combines maintenance, safe movement and more greenery without blocking the route.',
          ];
      return {
        type: 'doc',
        content: [
          {
            type: 'heading',
            attrs: { level: 2 },
            content: [{ type: 'text', text: nl ? 'Een gedeelde straat' : 'A shared street' }],
          },
          ...Array.from({ length: 9 }, (_, i) =>
            paragraph([...sentences.slice(i % 4), ...sentences.slice(0, i % 4)])
          ),
          list('bullet_list', sentences.slice(0, 2)),
          {
            type: 'heading',
            attrs: { level: 2 },
            content: [{ type: 'text', text: nl ? 'Wat verandert' : 'What changes' }],
          },
          ...Array.from({ length: 9 }, (_, i) =>
            paragraph([...sentences.slice(i % 4), ...sentences.slice(0, i % 4)])
          ),
          list('ordered_list', sentences.slice(2, 4)),
          {
            type: 'heading',
            attrs: { level: 2 },
            content: [{ type: 'text', text: nl ? 'Lees verder' : 'Read more' }],
          },
          ...Array.from({ length: 5 }, (_, i) =>
            paragraph([...sentences.slice(i % 4), ...sentences.slice(0, i % 4)])
          ),
          {
            type: 'paragraph',
            content: [
              {
                type: 'text',
                text: nl ? 'Bekijk het formulier' : 'See the form',
                marks: [{ type: 'link', attrs: { itemId: EXAMPLE_IDS.item } }],
              },
            ],
          },
        ],
      };
    };
    examples['quality-long-read'] = {
      type: 'rich-text',
      version: 1,
      props: { content: { nl: longRead('nl'), en: longRead('en') } },
    };
    const swap = (block) =>
      JSON.parse(
        JSON.stringify(block)
          .replaceAll(EXAMPLE_IDS.image, landscape.id)
          .replaceAll(EXAMPLE_IDS.portrait, portrait.id)
          .replaceAll(EXAMPLE_IDS.item, signupItem.id)
          .replaceAll(EXAMPLE_IDS.form, formId)
      );
    const qualityImages = [landscape.id, portrait.id, square.id, panorama.id];
    const qualityAuthor = await uow.run(admin, (ctx) => ctx.authors.findBySlug('e2e-auteur'));
    const qualitySection = await uow.run(admin, (ctx) => ctx.sections.findBySlug('e2e-stad'));
    for (const slug of needed) {
      const blocks = pages[slug].blocks.map((name) => swap(examples[name]));
      if (slug === qualityCorpus.public.article.slug) {
        let image = 0;
        for (const block of blocks)
          if (block.type === 'image') block.props.mediaId = qualityImages[image++];
      }
      const { item, revision } = await invoker.run(useCases.createItem, admin, {
        slug,
        document: {
          type: pages[slug].type ?? 'page',
          defaultLocale: 'nl',
          locales: ['nl', 'en'],
          title: pages[slug].title,
          blocks,
          ...(pages[slug].lead && { lead: pages[slug].lead }),
          ...(pages[slug].type === 'article' && {
            authorIds: [qualityAuthor.id],
            sectionId: qualitySection.id,
          }),
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
  // The #46A information composition reuses the published campaign's resolved blocks.
  // Keep its existing identity: no hero/form, the same prose repeated as a distinct closing block.
  const information = qualityCorpus.public.information;
  if (
    !(await invoker.run(useCases.listItems, admin, { type: 'page', slug: information.slug })).items
      .length
  ) {
    const { items } = await invoker.run(useCases.listItems, admin, {
      type: 'page',
      slug: qualityCorpus.public.campaign.slug,
    });
    const source = await invoker.run(useCases.getItem, admin, { itemId: items[0].id });
    const document = structuredClone(source.revision.document);
    document.title = Object.fromEntries(
      Object.entries(information.locales).map(([locale, entry]) => [locale, entry.title])
    );
    document.blocks = document.blocks.filter((block) => !['hero', 'form'].includes(block.type));
    const prose = document.blocks.find((block) => block.type === 'rich-text');
    if (!prose) throw new Error('information composition requires campaign prose');
    document.blocks.push({ ...structuredClone(prose), id: 'information-closing' });
    const created = await invoker.run(useCases.createItem, admin, {
      slug: information.slug,
      document,
    });
    for (const locale of Object.keys(information.locales))
      await invoker.run(useCases.publishItem, admin, {
        itemId: created.item.id,
        revisionId: created.revision.id,
        locale,
      });
  }
  // The demo page and article that `npm run db:seed` gives a development database, for the
  // quality corpus's `demo` scope: the photos and blocks an editor judges first. Only with
  // --quality, so the other specs keep their list sizes; the seed is idempotent like the rest.
  // Rejected: a separate demo fixture here (it would measure something editors never see).
  if (quality) {
    const { seedDemoContent } = await import('@mycel/core/testing');
    const [signup] = (
      await invoker.run(useCases.listItems, admin, { type: 'page', slug: 'signup' })
    ).items;
    const { revision } = await invoker.run(useCases.getItem, admin, { itemId: signup.id });
    const formId = revision.document.blocks.flatMap((b) =>
      b.type === 'signup-form' || b.type === 'form' ? [b.props.formId] : []
    )[0];
    if (!formId) fail('the probe signup page references no form');
    const photos = new URL('../../packages/api/demo-photos/', import.meta.url);
    await seedDemoContent(invoker, admin, {
      formId,
      load: async (image) => new Uint8Array(readFileSync(new URL(image.filename, photos))),
    });
  }
  // An author and a section beyond the first page of the admin's pickers (a hundred, newest
  // first), with 101 newer ones after them, for content-admin.spec.ts. Seeded
  // once: every later author or section is newer still. Here and not in the spec, so a run does
  // not flood the audit log that the status part of admin.spec.ts reads.
  if (!(await uow.run(admin, (ctx) => ctx.authors.findBySlug('e2e-ver-auteur')))) {
    await invoker.run(useCases.createAuthor, admin, { slug: 'e2e-ver-auteur', name: 'Ver Weg' });
    await invoker.run(useCases.createSection, admin, {
      slug: 'e2e-ver-rubriek',
      title: { nl: 'Verre rubriek', en: 'Distant section' },
    });
    for (let i = 0; i < 101; i++) {
      await invoker.run(useCases.createAuthor, admin, { slug: `e2e-vul-${i}`, name: `Vul ${i}` });
      await invoker.run(useCases.createSection, admin, {
        slug: `e2e-vul-${i}`,
        title: { nl: `Vul ${i}` },
      });
    }
  }
  // Every live medium of probe needs its files in the store this run serves. The fixture pages
  // above are reused when the database has them, so their images, and anything else seeded into
  // probe (`npm run db:seed`'s demo content), were written by whichever checkout ran first. A
  // store that does not hold them shows up as some twenty red specs (export, every block, the
  // quality corpus) that say nothing about the diff; stop here and say why instead.
  // Rejected: re-uploading on a miss (the export spec would still meet rows of another checkout).
  const missing = await missingMediaFiles(uow, blobStoreFor(loadConfig()), admin);
  if (missing.length) fail(missingMediaAdvice('probe', missing));
  await operatorDb.destroy();
  await appDb.destroy();
}

// The web app under test listens on 4173 (playwright.config.ts); links in the mail must point
// there, so the API process gets the same origin regardless of what .env says. Both processes
// run with SITE_URL_MODE=hostnames and PLATFORM_DOMAIN=localhost: the seed gives tenant probe
// the hostname probe.localhost, Chromium resolves it to loopback, and the specs cover both the
// hostname form (hostnames.spec.ts) and the development path form (signup.spec.ts).
const WEB_ORIGIN = quality ? 'https://localhost:4443' : 'http://127.0.0.1:4173';
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

const idp = spawn('node', ['scripts/e2e/mock-oidc.mjs'], {
  cwd: root,
  stdio: ['ignore', 'inherit', 'inherit'],
  env: { ...env, MOCK_OIDC_PORT: OIDC_PORT },
});
const api = spawn('node', ['packages/api/dist/runtime/server.js'], {
  cwd: root,
  stdio: ['ignore', 'inherit', 'inherit'],
  env: { ...frontEnv, PORT: API_PORT, MYCEL_WORKER: 'off' },
});
const worker = spawn('node', ['packages/api/dist/runtime/worker.js'], {
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
if (quality) {
  run(
    'node',
    ['scripts/quality/run.mjs', ...process.argv.slice(2).filter((arg) => arg !== '--quality')],
    root,
    env
  );
} else {
  run('npx', ['playwright', 'test', ...process.argv.slice(2)], `${root}apps/web`, env);
}
stop();
// The worker planned a `mail.reconcile` per confirmation it sent, RECONCILE_LAG_MS ahead, and is
// gone before they fall due. Close probe's so they neither wait for the next run's worker nor
// crowd recovery.test's claim (TODO #32); its other jobs, hostname checks, stay.
{
  const { createDb, createTenantDirectory } = await import('@mycel/db');
  const { closeTenantWork } = await import('@mycel/db/testing');
  const operatorDb = createDb(process.env.DATABASE_URL);
  const probe = await createTenantDirectory(operatorDb).findBySlug('probe');
  if (probe) await closeTenantWork(operatorDb, [probe.id], { jobTypes: ['mail.reconcile'] });
  await operatorDb.destroy();
}
process.exit(0);
