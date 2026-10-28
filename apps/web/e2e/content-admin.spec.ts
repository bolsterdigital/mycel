// Content admin (TODO #11, brief content-editor § A1): an operator makes a page in two locales,
// edits it, reads its revisions and their diff, and opens a preview that the public site never
// serves. A save on an outdated revision is a conflict that keeps what was typed. The admin and
// the saved preview ship no script (`csr = false`); live preview adds a small optional script.
// The `no-js` project proves the native path; `a11y` runs axe and the UI gate.
//
// Tenant isolation of the item itself is the database's (RLS on content_items, asserted by
// rls.conformance); here the preview routes prove that a session without a membership of the
// site gets nothing, not even the theme.

import AxeBuilder from '@axe-core/playwright';
import { createApp } from '@mycel/api';
import { Invoker, UseCaseError, buildRegistry, systemPrincipal, useCases } from '@mycel/core';
import { FakeDns, FakeInputHasher, FakeSigner, memoryPlatform } from '@mycel/core/testing';
import { createDb, createTenantDirectory, createUnitOfWork, uuidv7Ids } from '@mycel/db';
import { expect, test, type APIRequestContext, type Browser, type Page } from '@playwright/test';

const WCAG = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const SITE = 'http://probe.localhost:4173';
const ADMIN = 'e2e-admin@probe.test';
const LIVE_ADMIN = 'live-preview-admin@probe.test';
const LIVE_READER = 'live-preview-reader@probe.test';

async function ensureLiveAdmin() {
  const owner = createDb(process.env['DATABASE_URL']!);
  const probe = await createTenantDirectory(owner).findBySlug('probe');
  if (!probe) throw new Error('probe tenant missing');
  const app = createDb(process.env['APP_DATABASE_URL']!);
  const uow = createUnitOfWork(app, {
    clock: { now: () => new Date() },
    ids: uuidv7Ids,
    signer: new FakeSigner(),
    inputHasher: new FakeInputHasher(process.env['AUDIT_HASH_KEY']),
    dns: new FakeDns(),
    platform: memoryPlatform,
  });
  try {
    const invoker = new Invoker(buildRegistry(), uow);
    for (const [email, capability] of [
      [LIVE_ADMIN, 'tenant:admin'],
      [LIVE_READER, 'content:read'],
    ] as const) {
      try {
        await invoker.run(useCases.inviteMember, systemPrincipal(probe.id, 'e2e'), {
          email,
          capabilities: [capability],
        });
      } catch (e) {
        if (!(e instanceof UseCaseError && e.code === 'conflict')) throw e;
      }
    }
  } finally {
    await app.destroy();
    await owner.destroy();
  }
}

async function expectNoAxeViolations(page: Page) {
  if (test.info().project.name !== 'a11y') return;
  const { violations } = await new AxeBuilder({ page }).withTags(WCAG).analyze();
  expect(
    violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)
  ).toEqual([]);
}

test.use({
  locale: 'nl-NL',
  extraHTTPHeaders: {
    'x-forwarded-proto': 'http',
    'x-forwarded-for': `198.51.100.${Math.floor(Math.random() * 250) + 1}`,
  },
});

const address = () => `198.51.100.${Math.floor(Math.random() * 250) + 1}`;

async function login(page: Page, email: string, path: string) {
  // A fresh address per login: the admin allows twenty logins per address in ten minutes, and
  // this file logs in more often than that per worker. IPv6 documentation space, so these never
  // count against the IPv4 addresses the other specs draw.
  const ip = `2001:db8::${Math.floor(Math.random() * 0xffffffff).toString(16)}`;
  await page.context().setExtraHTTPHeaders({ 'x-forwarded-proto': 'http', 'x-forwarded-for': ip });
  await page.goto(path);
  await expect(page.getByRole('heading', { name: 'Mock IdP' })).toBeVisible();
  await page.getByLabel('E-mail').fill(email);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(new RegExp(`${path.replace(/[/?]/g, '\\$&')}$`));
}

/** Another browser, as the test's own: same origin, headers and JavaScript setting. */
const freshContext = (
  browser: Browser,
  locale = 'nl-NL',
  viewport?: { width: number; height: number }
) =>
  browser.newContext({
    locale,
    ...(viewport ? { viewport } : {}),
    javaScriptEnabled: test.info().project.name === 'a11y',
    baseURL: 'http://127.0.0.1:4173',
    extraHTTPHeaders: { 'x-forwarded-proto': 'http', 'x-forwarded-for': address() },
  });

const slugFor = (what: string) =>
  `a1-${what}-${test.info().project.name}-${Date.now()}`.toLowerCase();

/** Make a page in nl and en through the "new" form; returns its edit URL. */
async function newPage(page: Page, slug: string, title: string): Promise<string> {
  await page.goto('/admin/probe/content/new?type=page');
  await page.getByLabel('Slug').fill(slug);
  await page.getByLabel('Titel (nl)').fill(title);
  await page.getByLabel('Titel (en)').fill(`${title} (en)`);
  await page.getByRole('button', { name: 'Concept maken' }).click();
  await expect(page).toHaveURL(/\/admin\/probe\/content\/[0-9a-f-]{36}$/);
  return new URL(page.url()).pathname;
}

test('an operator makes a page, edits it, and compares its revisions', async ({ page }) => {
  await login(page, ADMIN, '/admin/probe');
  await page.getByRole('link', { name: 'Pagina’s en artikelen' }).click();
  await expect(
    page.getByRole('heading', { level: 1, name: 'Pagina’s en artikelen' })
  ).toBeVisible();
  expect(await page.locator('script').count()).toBe(0);
  await expectNoAxeViolations(page);

  await page.getByRole('link', { name: 'Nieuwe pagina of artikel' }).click();
  await expectNoAxeViolations(page);
  const slug = slugFor('edit');
  const edit = await newPage(page, slug, 'Over de buurt');
  await expect(page.getByRole('heading', { level: 1, name: 'Over de buurt' })).toBeVisible();
  await expect(page.getByText('nl: concept')).toBeVisible();
  await expectNoAxeViolations(page);

  await page.getByLabel('Titel (nl)').fill('Over onze buurt');
  // Search settings are folded away until asked for (skill cms-inrichting).
  await page.locator('summary', { hasText: 'Zoeken en delen' }).click();
  await page.getByLabel('Titel in zoekresultaten (nl)').fill('De buurt');
  await page.getByRole('button', { name: 'Opslaan' }).click();
  await expect(page).toHaveURL(`${edit}?saved`);
  await expect(page.getByRole('status')).toContainText('Opgeslagen als nieuwe revisie');
  await expect(page.getByLabel('Titel (nl)')).toHaveValue('Over onze buurt');

  await page.getByRole('link', { name: 'Revisies', exact: true }).click();
  const revisions = page.locator('ol.revisions > li');
  await expect(revisions).toHaveCount(2);
  await expect(revisions.first()).toContainText(ADMIN);
  await expect(revisions.first()).toContainText('nieuwste');
  await page.getByRole('button', { name: 'Vergelijken' }).click();
  const diff = page.getByRole('region', { name: 'Wijzigingen' });
  await expect(diff.getByRole('row', { name: /title\.nl/ })).toContainText('Over onze buurt');
  await expect(diff.getByRole('row', { name: /seo\.title/ })).toBeVisible();
  await expectNoAxeViolations(page);

  // In the list: the new page, as a draft in both locales.
  await page.goto('/admin/probe/content?type=page');
  const card = page.locator('#content-table tbody tr', { hasText: `/${slug}` });
  await expect(card).toContainText('nl: concept');
  await expect(card).toContainText('en: concept');
});

test('the preview shows a draft that the site does not serve', async ({ page, request }) => {
  await login(page, ADMIN, '/admin/probe');
  const slug = slugFor('preview');
  await newPage(page, slug, 'Nog geheim');

  const link = page.getByRole('link', { name: 'Voorbeeld (en), opent een nieuw tabblad' });
  await expect(link).toHaveAttribute('target', '_blank');
  const href = (await link.getAttribute('href'))!;
  const response = await page.goto(href);
  expect(response!.status()).toBe(200);
  expect(response!.headers()['cache-control']).toBe('private, no-store');
  expect(response!.headers()['x-robots-tag']).toBe('noindex');
  await expect(page.getByRole('heading', { level: 1, name: 'Nog geheim (en)' })).toBeVisible();
  await expect(page.getByRole('heading', { level: 2, name: 'Voorbeeld' })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  expect(await page.locator('script').count()).toBe(0);
  // The site's own stylesheet, served on the admin origin to members only.
  const css = await page
    .locator('link[rel="stylesheet"][href*="/preview/_theme/"]')
    .getAttribute('href');
  expect((await page.request.get(css!)).status()).toBe(200);
  await expectNoAxeViolations(page);

  // A draft is never public: not on the site, not on the read route.
  expect((await request.get(`${SITE}/${slug}`)).status()).toBe(404);
  expect((await request.get(`${SITE}/en/${slug}`)).status()).toBe(404);

  // Without a session: to the login. Without a membership of this site: nothing.
  const anonymous = await request.get(href, { maxRedirects: 0 });
  expect(anonymous.status()).toBe(303);
  expect(anonymous.headers()['location']).toMatch(/^\/admin\/login\?return=/);
  await stranger(page.context().browser()!, async (other) => {
    expect((await other.goto(href))!.status()).toBe(403);
    expect((await other.request.get(css!)).status()).toBe(403);
  });
});

test('live preview shows unsaved fields, isolates tenants and opens a clicked block', async ({
  page,
  browser,
}) => {
  test.skip(test.info().project.name !== 'a11y', 'live preview is a JavaScript enhancement');
  await ensureLiveAdmin();
  await login(page, LIVE_ADMIN, '/admin/probe');
  const edit = await newPage(page, slugFor('live'), 'Saved title');

  // Give the preview a block to select. Its native details remains the keyboard route.
  const insert = page.locator('section > form.insert');
  await insert.getByLabel('Soort').selectOption({ label: 'Kop' });
  await insert.getByLabel('Waar').selectOption({ label: 'Onderaan' });
  await insert.getByRole('button', { name: 'Velden invullen' }).click();
  await page.getByLabel('Tekst (nl)').fill('Saved heading');
  await page.getByLabel('Tekst (en)').fill('Saved heading');
  await page.getByRole('button', { name: 'Blok invoegen' }).click();
  await expect(page).toHaveURL(/\?done=blockInserted&block=/);

  const frame = page.frameLocator('[data-live-preview-frame]');
  await expect(frame.getByRole('heading', { level: 1, name: 'Saved title' })).toBeVisible();
  const draft = await page.request.get('/admin/probe/preview/draft');
  expect(draft.headers()['content-security-policy']).toContain("frame-ancestors 'self'");
  expect(draft.headers()['cache-control']).toBe('private, no-store');
  expect(draft.headers()['x-robots-tag']).toBe('noindex');
  const normal = await page.request.get(edit);
  expect(normal.headers()['content-security-policy']).toContain("frame-ancestors 'none'");

  await page.getByLabel('Titel (nl)').fill('Unsaved title');
  await expect(frame.getByRole('heading', { level: 1, name: 'Unsaved title' })).toBeVisible();
  await frame.getByRole('heading', { name: 'Saved heading' }).click();
  const details = page.locator('details.block').first();
  await expect(details).toHaveAttribute('open', '');
  await expect(details.locator('summary')).toBeFocused();
  await details.getByLabel('Tekst (nl)').fill('Unsaved heading');
  await expect(frame.getByRole('heading', { name: 'Unsaved heading' })).toBeVisible();
  await details.locator('summary').press('Enter');
  await expect(details).not.toHaveAttribute('open');
  await expectNoAxeViolations(page);
  await page.setViewportSize({ width: 320, height: 900 });
  await page.evaluate(() => (document.documentElement.style.fontSize = '200%'));
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth
    )
  ).toBe(true);
  await expect(page.getByLabel('Taal van het live voorbeeld')).toBeVisible();
  await expect(frame.getByRole('heading', { name: 'Unsaved heading' })).toBeVisible();

  const itemId = edit.split('/').at(-1)!;
  const revisionId = await page
    .locator('[data-live-preview-source] [name="baseRevisionId"]')
    .inputValue();
  await stranger(browser, async (other) => {
    const denied = await other.request.post('/admin/probe/preview/draft', {
      headers: { origin: 'http://127.0.0.1:4173' },
      form: { itemId, baseRevisionId: revisionId, previewLocale: 'nl' },
    });
    expect(denied.status()).toBe(403);
    expect(await denied.text()).not.toContain('Unsaved title');
  });
  const readerContext = await freshContext(browser);
  try {
    const reader = await readerContext.newPage();
    await login(reader, LIVE_READER, '/admin/probe');
    const denied = await reader.request.post('/admin/probe/preview/draft', {
      headers: { origin: 'http://127.0.0.1:4173' },
      form: { itemId, baseRevisionId: revisionId, previewLocale: 'nl' },
    });
    expect(denied.status()).toBe(403);
  } finally {
    await readerContext.close();
  }
  await page.reload();
  await expect(page.getByLabel('Titel (nl)')).toHaveValue('Saved title');
  await expect(page.locator('details.block').first()).toContainText('Saved heading');
});

/** A second browser context logged in as an operator without a membership of probe. */
async function stranger(browser: Browser, fn: (page: Page) => Promise<void>) {
  const context = await freshContext(browser);
  const page = await context.newPage();
  await login(page, 'nobody@probe.test', '/admin');
  await fn(page);
  await context.close();
}

test('a save on an outdated revision is a conflict that keeps what was typed', async ({
  page,
  browser,
}) => {
  await login(page, ADMIN, '/admin/probe');
  const edit = await newPage(page, slugFor('conflict'), 'Eerste versie');

  // A second editor opens the same revision and saves first.
  const context = await freshContext(browser);
  const other = await context.newPage();
  await login(other, ADMIN, edit);
  await page.getByLabel('Titel (nl)').fill('Mijn versie');
  await other.getByLabel('Titel (nl)').fill('Hun versie');
  await other.getByRole('button', { name: 'Opslaan' }).click();
  await expect(other).toHaveURL(`${edit}?saved`);
  await context.close();

  await page.getByRole('button', { name: 'Opslaan' }).click();
  const alert = page.getByRole('alert');
  await expect(alert).toContainText('Iemand anders heeft dit item intussen opgeslagen');
  await expect(alert).toContainText(ADMIN);
  await expect(alert.getByRole('row', { name: /title\.nl/ })).toContainText('Hun versie');
  await expect(page.getByLabel('Titel (nl)')).toHaveValue('Mijn versie');
  await expectNoAxeViolations(page);

  // Saving again is a deliberate choice on top of the newest revision.
  await page.getByRole('button', { name: 'Opslaan' }).click();
  await expect(page).toHaveURL(`${edit}?saved`);
  await expect(page.getByLabel('Titel (nl)')).toHaveValue('Mijn versie');
});

/** A use case over the HTTP API with the seed key of tenant probe (scripts/e2e.mjs). */
async function call<T>(request: APIRequestContext, name: string, data: unknown): Promise<T> {
  const res = await request.post(`${process.env['E2E_API_URL']}/v1/${name}`, {
    headers: { authorization: `Bearer ${process.env['MYCEL_API_KEY']}` },
    data,
  });
  expect(res.ok(), await res.text()).toBe(true);
  return res.json();
}

/** One entry of a paged directory by its slug, over the HTTP API. */
async function bySlug<T>(
  request: APIRequestContext,
  name: string,
  key: string,
  slug: string
): Promise<T> {
  let after: string | null = null;
  do {
    const page: Record<string, unknown> & { next: string | null } = await call(request, name, {
      limit: 100,
      ...(after ? { after } : {}),
    });
    const found = (page[key] as (T & { slug: string })[]).find((x) => x.slug === slug);
    if (found) return found;
    after = page.next;
  } while (after);
  throw new Error(`${slug} is not seeded; run through scripts/e2e.mjs`);
}

// Review of PR #45: the pickers list one page of the directory (newest first, a hundred), so an
// author or section beyond it, or authors in another order than the directory's, were lost or
// reordered by a save that only changed the title.
test('title-only and conflicting saves keep authors, their order and the off-page section', async ({
  page,
  request,
}) => {
  test.skip(!process.env['E2E_API_URL'], 'run through scripts/e2e.mjs');
  const run = slugFor('rel');
  const author = (name: string) =>
    call<{ id: string }>(request, 'content.author.create', {
      slug: name.toLowerCase().replace(/\W+/g, '-'),
      name,
    });
  // Seeded by scripts/e2e.mjs with 101 newer authors and sections after them.
  const old = await bySlug<{ id: string }>(
    request,
    'content.author.list',
    'authors',
    'e2e-ver-auteur'
  );
  const oldSection = await bySlug<{ id: string }>(
    request,
    'content.section.list',
    'sections',
    'e2e-ver-rubriek'
  );
  const first = await author(`Eerste ${run}`);
  const second = await author(`Tweede ${run}`);
  // The directory lists `second` before `first`; the document has them the other way round.
  const authorIds = [first.id, second.id, old.id];
  const { item } = await call<{ item: { id: string } }>(request, 'content.item.create', {
    slug: run,
    document: {
      type: 'article',
      title: { nl: 'Met auteurs' },
      defaultLocale: 'nl',
      locales: ['nl'],
      blocks: [],
      authorIds,
      sectionId: oldSection.id,
    },
  });
  const saved = async () =>
    (
      await call<{ revision: { document: { authorIds: string[]; sectionId: string | null } } }>(
        request,
        'content.item.get',
        { itemId: item.id }
      )
    ).revision.document;

  const fresh = await author(`Nieuw ${run}`);
  await login(page, ADMIN, `/admin/probe/content/${item.id}`);
  await expect(page.getByLabel('Ver Weg')).toBeChecked();
  await expect(page.getByLabel('Rubriek')).toHaveValue(oldSection.id);
  await page.getByLabel('Titel (nl)').fill('Alleen de titel');
  await page.getByRole('button', { name: 'Opslaan' }).click();
  await expect(page).toHaveURL(new RegExp(`${item.id}\\?saved$`));
  expect(await saved()).toMatchObject({ authorIds, sectionId: oldSection.id });

  // Another editor removes every relation after this form was opened. Its latest document
  // and the directory page no longer contain the off-page choices in this editor's post.
  const { revision } = await call<{ revision: { id: string; document: Record<string, unknown> } }>(
    request,
    'content.item.get',
    { itemId: item.id }
  );
  await page.getByLabel('Titel (nl)').fill('Mijn artikel bij conflict');
  await call(request, 'content.item.update', {
    itemId: item.id,
    baseRevisionId: revision.id,
    document: { ...revision.document, authorIds: [], sectionId: null },
  });
  await page.getByRole('button', { name: 'Opslaan' }).click();
  await expect(page.getByRole('alert')).toContainText(
    'Iemand anders heeft dit item intussen opgeslagen'
  );
  await expect(page.getByLabel('Titel (nl)')).toHaveValue('Mijn artikel bij conflict');
  for (const name of [`Eerste ${run}`, `Tweede ${run}`, 'Ver Weg'])
    await expect(page.getByLabel(name, { exact: true })).toBeChecked();
  await expect(page.getByLabel('Rubriek')).toHaveValue(oldSection.id);
  await expectNoAxeViolations(page);

  // A validation error on the new base must preserve the same choices too. They still
  // are not in the latest document, and the section/old author are outside the directory page.
  await page.locator('[name="canonical"]').fill('not-a-url');
  await page.getByRole('button', { name: 'Opslaan' }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.getByRole('alert')).not.toContainText(
    'Iemand anders heeft dit item intussen opgeslagen'
  );
  for (const name of [`Eerste ${run}`, `Tweede ${run}`, 'Ver Weg'])
    await expect(page.getByLabel(name, { exact: true })).toBeChecked();
  await expect(page.getByLabel('Rubriek')).toHaveValue(oldSection.id);
  await expect(page.getByLabel('Titel (nl)')).toHaveValue('Mijn artikel bij conflict');
  await page.locator('[name="canonical"]').fill('');
  await page.getByRole('button', { name: 'Opslaan' }).click();
  await expect(page).toHaveURL(new RegExp(`${item.id}\\?saved$`));
  expect(await saved()).toMatchObject({
    title: { nl: 'Mijn artikel bij conflict' },
    authorIds,
    sectionId: oldSection.id,
  });

  // An explicit change still works: one author off, one on, the rest keeps its order.
  await page.getByLabel(`Eerste ${run}`).uncheck();
  await page.getByLabel(`Nieuw ${run}`).check();
  await page.getByLabel('Rubriek').selectOption({ label: 'Geen rubriek' });
  await page.getByRole('button', { name: 'Opslaan' }).click();
  await expect(page).toHaveURL(new RegExp(`${item.id}\\?saved$`));
  const after = await saved();
  expect(after.authorIds).toEqual([second.id, old.id, fresh.id]);
  expect(after.sectionId).toBeNull();
});

test('a reserved slug comes back as a message with what was typed', async ({ page }) => {
  await login(page, ADMIN, '/admin/probe/content/new');
  await page.getByLabel('Slug').fill('admin');
  await page.getByLabel('Titel (nl)').fill('Mag niet');
  await page.getByRole('button', { name: 'Concept maken' }).click();
  await expect(page.getByRole('alert')).toContainText('De site gebruikt deze slug zelf');
  await expect(page.getByLabel('Titel (nl)')).toHaveValue('Mag niet');
  await expectNoAxeViolations(page);
});

// Publication per locale (brief content-editor § A2): core decides, the panel shows what it
// decided. One card per locale; every action is its own native form.
const card = (page: Page, locale: string) =>
  page.locator('.publication', {
    has: page.getByRole('heading', { name: new RegExp(`^Taal ${locale}:`) }),
  });

test('publishing puts a locale live; a later edit stays unpublished until published', async ({
  page,
  request,
}) => {
  await login(page, ADMIN, '/admin/probe');
  const slug = slugFor('publish');
  const edit = await newPage(page, slug, 'Buurtfeest');
  await expect(card(page, 'nl')).toContainText('Klaar om te publiceren.');
  await card(page, 'nl').getByRole('button', { name: 'Publiceren (nl)' }).click();
  await expect(page).toHaveURL(`${edit}?done=publish&locale=nl`);
  await expect(page.getByRole('status')).toContainText('Gepubliceerd in nl.');
  await expect(card(page, 'nl')).toContainText('Live staat de revisie die je bewerkt.');
  await expect(card(page, 'nl').getByRole('button', { name: 'Publiceren (nl)' })).toHaveCount(0);
  await expectNoAxeViolations(page);
  expect((await request.get(`${SITE}/${slug}`)).status()).toBe(200);
  expect((await request.get(`${SITE}/en/${slug}`)).status()).toBe(404);

  // A new revision: the site keeps the old title until it is published.
  await page.getByLabel('Titel (nl)').fill('Buurtfeest verplaatst');
  await page.getByRole('button', { name: 'Opslaan' }).click();
  await expect(page).toHaveURL(`${edit}?saved`);
  await expect(card(page, 'nl').getByRole('heading')).toContainText(
    'gepubliceerd, ongepubliceerde wijzigingen'
  );
  await expect(card(page, 'nl')).toContainText(`opgeslagen door ${ADMIN}`);
  const live = await (await request.get(`${SITE}/${slug}`)).text();
  expect(live).toContain('Buurtfeest');
  expect(live).not.toContain('Buurtfeest verplaatst');
  await page.goto('/admin/probe/content?type=page');
  await expect(page.locator('#content-table tbody tr', { hasText: `/${slug}` })).toContainText(
    'nl: gepubliceerd, ongepubliceerde wijzigingen'
  );

  // Offline again: the address is gone, the card says it was live once.
  await page.goto(edit);
  await card(page, 'nl').getByRole('button', { name: 'Offline halen (nl)' }).click();
  await expect(page.getByRole('status')).toContainText('Offline gehaald in nl.');
  await expect(card(page, 'nl').getByRole('heading')).toContainText('offline');
  expect((await request.get(`${SITE}/${slug}`)).status()).toBe(404);
});

test('a locale without its translation is refused with the path', async ({ page }) => {
  await login(page, ADMIN, '/admin/probe/content/new?type=page');
  await page.getByLabel('Slug').fill(slugFor('untranslated'));
  await page.getByLabel('Titel (nl)').fill('Alleen Nederlands');
  await page.getByRole('button', { name: 'Concept maken' }).click();
  await expect(page).toHaveURL(/\/admin\/probe\/content\/[0-9a-f-]{36}$/);
  const en = card(page, 'en');
  await expect(en).toContainText('title.en: de vertaling ontbreekt');
  await expect(en.getByRole('link', { name: 'title.en' })).toHaveAttribute('href', '#title.en');

  await en.getByRole('button', { name: 'Publiceren (en)' }).click();
  const alert = page.getByRole('alert');
  await expect(alert).toContainText('Dit kan in en nog niet:');
  await expect(alert).toContainText('title.en: de vertaling ontbreekt');
  await expectNoAxeViolations(page);
});

test('a schedule pins a revision; a newer one can take its place', async ({ page }) => {
  await login(page, ADMIN, '/admin/probe');
  const edit = await newPage(page, slugFor('schedule'), 'Op vrijdag');
  const nl = card(page, 'nl');
  await nl.getByLabel('Publiceren op').fill('2030-01-04T09:00');
  await nl.getByRole('button', { name: 'Inplannen (nl)' }).click();
  await expect(page).toHaveURL(`${edit}?done=schedule&locale=nl`);
  await expect(nl.getByRole('heading')).toContainText('ingepland');
  await expect(nl).toContainText(
    'De revisie die je bewerkt gaat op 2030-01-04 09:00 (Europe/Amsterdam) live.'
  );

  // Edited after planning: the pin stays on the old revision until the editor moves it.
  await page.getByLabel('Titel (nl)').fill('Op vrijdagochtend');
  await page.getByRole('button', { name: 'Opslaan' }).click();
  await expect(page).toHaveURL(`${edit}?saved`);
  await expect(nl).toContainText('gaat op 2030-01-04 09:00 (Europe/Amsterdam) live.');
  await expect(nl).toContainText('Je bewerkt een nieuwere revisie');
  await expectNoAxeViolations(page);
  await nl.getByRole('button', { name: 'Deze revisie op dat moment publiceren (nl)' }).click();
  await expect(nl).toContainText(
    'De revisie die je bewerkt gaat op 2030-01-04 09:00 (Europe/Amsterdam) live.'
  );

  // A time in the past is core's refusal, worded in the panel's terms.
  await nl.getByLabel('Publiceren op').fill('2020-01-01T09:00');
  await nl.getByRole('button', { name: 'Inplannen (nl)' }).click();
  await expect(page.getByRole('alert')).toContainText('at: de tijd ligt niet in de toekomst');

  await page.goto(edit);
  await nl.getByRole('button', { name: 'Planning intrekken (nl)' }).click();
  await expect(page.getByRole('status')).toContainText('Planning ingetrokken in nl.');
  await expect(nl.getByRole('heading')).toContainText('concept');
});

test('repinning an HTTP schedule preserves the second autumn hour and seconds', async ({
  page,
}) => {
  const { createDb, createTenantDirectory, createUnitOfWork, uuidv7Ids } =
    await import('@mycel/db');
  const { FakeDns, FakeInputHasher, FakeSigner, memoryPlatform } =
    await import('@mycel/core/testing');
  const operatorDb = createDb(process.env['DATABASE_URL']!);
  const appDb = createDb(process.env['APP_DATABASE_URL']!);
  try {
    const probe = await createTenantDirectory(operatorDb).findBySlug('probe');
    const invoker = new Invoker(
      buildRegistry(),
      createUnitOfWork(appDb, {
        clock: { now: () => new Date() },
        ids: uuidv7Ids,
        signer: new FakeSigner(),
        inputHasher: new FakeInputHasher(),
        dns: new FakeDns(),
        platform: memoryPlatform,
      })
    );
    const api = createApp({
      invoker,
      authenticate: async (authorization) =>
        authorization === 'Bearer e2e' ? systemPrincipal(probe!.id, 'e2e') : null,
    });
    const call = async (name: string, input: Record<string, string>) => {
      const response = await api.request(`/v1/${name}`, {
        method: 'POST',
        headers: { authorization: 'Bearer e2e', 'content-type': 'application/json' },
        body: JSON.stringify(input),
      });
      expect(response.status, response.status === 200 ? '' : await response.text()).toBe(200);
      return response.json();
    };
    await login(page, ADMIN, '/admin/probe');
    for (const [label, at] of [
      ['autumn', '2030-10-27T01:30:00.000Z'],
      ['seconds', '2030-01-04T08:00:45.123Z'],
    ]) {
      const edit = await newPage(page, slugFor(`repin-${label}`), `Planned ${label}`);
      const itemId = edit.split('/').at(-1)!;
      const oldRevisionId = await page.locator('input[name="baseRevisionId"]').inputValue();
      const before = await call('content.item.schedule', {
        itemId,
        revisionId: oldRevisionId,
        locale: 'nl',
        at,
      });
      expect(
        before.publication.find((state: { locale: string }) => state.locale === 'nl')
      ).toMatchObject({
        scheduledRevisionId: oldRevisionId,
        scheduledFor: at,
      });

      await page.goto(edit);
      await page.getByLabel('Titel (nl)').fill(`Updated ${label}`);
      await page.getByRole('button', { name: 'Opslaan' }).click();
      const newRevisionId = await page.locator('input[name="baseRevisionId"]').inputValue();
      expect(newRevisionId).not.toBe(oldRevisionId);
      await card(page, 'nl')
        .getByRole('button', { name: 'Deze revisie op dat moment publiceren (nl)' })
        .click();
      await expect(page).toHaveURL(`${edit}?done=repin&locale=nl`);
      const after = await call('content.item.get', { itemId });
      expect(
        after.item.publication.find((state: { locale: string }) => state.locale === 'nl')
      ).toMatchObject({
        scheduledRevisionId: newRevisionId,
        scheduledFor: at,
      });
    }
  } finally {
    await Promise.all([operatorDb.destroy(), appDb.destroy()]);
  }
});

test('a restricted item says what visitors get before any publish button', async ({ page }) => {
  await login(page, ADMIN, '/admin/probe');
  await newPage(page, slugFor('restricted'), 'Voor leden');
  await page.getByLabel('Wie het mag lezen').selectOption({ label: 'Lezers met een account' });
  await page.getByRole('button', { name: 'Opslaan' }).click();
  const panel = page.getByRole('region', { name: 'Publicatie' });
  const notice = panel.getByText('Bezoekers zonder account zien dit item niet');
  await expect(notice).toBeVisible();
  // Before the first button in document order, and no button closes it.
  const before = await notice.evaluate((el) => {
    const button = document.querySelector('.publication button')!;
    return !!(el.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING);
  });
  expect(before).toBe(true);
  await expectNoAxeViolations(page);
});

test('a writer without content:publish sees the state, no buttons, and gets a 403', async ({
  page,
  context,
}) => {
  const email = `writer-${test.info().project.name}-${Date.now()}@probe.test`;
  await login(page, ADMIN, '/admin/probe');
  const edit = await newPage(page, slugFor('writer'), 'Schrijverswerk');
  await page.goto('/admin/probe');
  const invite = page.locator('form[action="?/invite"]');
  await invite.getByLabel('E-mailadres', { exact: true }).fill(email);
  await invite.getByLabel('content:read', { exact: true }).check();
  await invite.getByLabel('content:write', { exact: true }).check();
  await invite.getByRole('button', { name: 'Uitnodigen' }).click();
  await expect(page.getByRole('status')).toContainText(email);
  try {
    await context.clearCookies();
    await login(page, email, edit);
    await expect(card(page, 'nl').getByRole('heading')).toContainText('concept');
    await expect(page.getByText('vragen de bevoegdheid content:publish')).toBeVisible();
    await expect(page.locator('.publication button')).toHaveCount(0);
    await expectNoAxeViolations(page);

    // The registry refuses, whatever the page showed.
    const revisionId = await page.locator('input[name="baseRevisionId"]').inputValue();
    const res = await page.request.post(`${edit}?/publish`, {
      headers: { origin: 'http://127.0.0.1:4173' },
      form: { locale: 'nl', revisionId },
    });
    expect(res.status()).toBe(403);
    const repin = await page.request.post(`${edit}?/repin`, {
      headers: { origin: 'http://127.0.0.1:4173' },
      form: { locale: 'nl', revisionId },
    });
    expect(repin.status()).toBe(403);
  } finally {
    await context.clearCookies();
    await login(page, ADMIN, '/admin/probe');
    const member = page.locator('form', { has: page.getByRole('heading', { name: email }) });
    await member.locator('button[formaction="?/remove"]').click();
    await expect(page.getByRole('status')).toContainText('Lid verwijderd');
  }
});

test.describe('UI gate: the content admin at 320 CSS px and 200% text', () => {
  test.use({ viewport: { width: 320, height: 900 } });

  for (const locale of ['nl-NL', 'en-GB'])
    for (const text of ['100%', '200%'])
      test(`every control whole and no horizontal scroll, ${locale}, text ${text}`, async ({
        browser,
      }) => {
        test.skip(test.info().project.name !== 'a11y', 'measures the layout with a script');
        const context = await freshContext(browser, locale, { width: 320, height: 900 });
        const page = await context.newPage();
        await login(page, ADMIN, '/admin/probe');
        const edit = await newPageIn(
          page,
          locale,
          slugFor(`gate-${locale}-${text.replace('%', '')}`)
        );
        await fourActions(page, locale);
        for (const path of [
          edit,
          `${edit}/revisions`,
          '/admin/probe/content?type=page',
          '/admin/probe/content/new',
        ]) {
          await page.goto(path);
          if (text !== '100%')
            await page.evaluate((size) => (document.documentElement.style.fontSize = size), text);
          const problems = await page.evaluate(layoutProblems);
          if (path === edit) {
            await page.locator('form.item-fields > .ui-actions-host').screenshot({
              path: test
                .info()
                .outputPath(`content-edit-320-${locale}-${text.replace('%', '')}.png`),
            });
            await page
              .locator('.publication')
              .first()
              .screenshot({
                path: test
                  .info()
                  .outputPath(`content-publication-320-${locale}-${text.replace('%', '')}.png`),
              });
            await expect(page.locator('.publication').first().locator('button')).toHaveCount(5);
          }
          expect(problems, path).toEqual([]);
        }
        await context.close();
      });
});

/** Live, pinned to an older revision: all four actions of the nl card, plus the schedule. */
async function fourActions(page: Page, locale: string) {
  const nl = locale.startsWith('nl');
  const card = page.locator('.publication').first();
  await card.getByRole('button', { name: nl ? 'Publiceren (nl)' : 'Publish (nl)' }).click();
  await card.locator('input[type="datetime-local"]').fill('2030-01-04T09:00');
  await card.getByRole('button', { name: nl ? 'Inplannen (nl)' : 'Schedule (nl)' }).click();
  await page.getByLabel(nl ? 'Titel (nl)' : 'Title (nl)').fill('Poort 2');
  await page.getByRole('button', { name: nl ? 'Opslaan' : 'Save' }).click();
  await expect(page).toHaveURL(/\?saved$/);
}

/** `newPage` in either admin language. */
async function newPageIn(page: Page, locale: string, slug: string): Promise<string> {
  const nl = locale.startsWith('nl');
  await page.goto('/admin/probe/content/new?type=page');
  await page.getByLabel('Slug').fill(slug);
  await page.getByLabel(nl ? 'Titel (nl)' : 'Title (nl)').fill('Poort');
  await page.getByRole('button', { name: nl ? 'Concept maken' : 'Create draft' }).click();
  await expect(page).toHaveURL(/\/admin\/probe\/content\/[0-9a-f-]{36}$/);
  return new URL(page.url()).pathname;
}

/** The checks of the media gate (media.spec.ts), over every action on the page. */
function layoutProblems(): string[] {
  const out: string[] = [];
  const width = document.documentElement.clientWidth;
  if (document.documentElement.scrollWidth > width) {
    out.push(`page scrolls sideways: ${document.documentElement.scrollWidth} > ${width}`);
    for (const el of document.querySelectorAll('body *'))
      if (el.getBoundingClientRect().right > width + 1 && el.children.length === 0)
        out.push(
          `past the edge: <${el.tagName.toLowerCase()}> ${el.textContent?.trim().slice(0, 40)}`
        );
  }
  for (const b of document.querySelectorAll('button, a.button, a.ui-button')) {
    const r = b.getBoundingClientRect();
    const label = b.textContent?.trim() ?? '';
    if (b.scrollWidth > b.clientWidth + 1) out.push(`clipped: ${label}`);
    if (r.right > width + 1 || r.left < -1) out.push(`outside the viewport: ${label}`);
    if (r.height < 44 || r.width < 44) out.push(`tap target under 44px: ${label}`);
  }
  for (const l of document.querySelectorAll(
    ':is(.card, .ui-card, .ui-panel, .ui-fieldset) :is(label, legend)'
  )) {
    const card = l.closest('.card, .ui-card, .ui-panel, .ui-fieldset')!.getBoundingClientRect();
    const range = document.createRange();
    range.selectNodeContents(l);
    if (range.getBoundingClientRect().right > card.right + 1)
      out.push(`past its card: ${l.textContent?.trim()}`);
  }
  return out;
}
