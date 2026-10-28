// flow: publish
// An operator writes and publishes: the content admin, the block forms and the enhanced article
// writer save one core document. Each part below was a spec of its own until TODO #50 folded the
// suite to its budget (testing.md § End-to-end flows); each keeps its own fixtures.

import { createApp } from '@mycel/api';
import { UseCaseError, systemPrincipal, useCases } from '@mycel/core';
import {
  type APIRequestContext,
  type Browser,
  type Locator,
  type Page,
  expect,
  test,
} from '@playwright/test';
import { expectNoAxeViolations } from './lib/axe';
import { tenantId, withInvoker } from './lib/invoker';
import { NARROW, TEXT_SIZES, layoutGate, setTextSize } from './lib/layout';
import { ADMIN, login } from './lib/login';

// Content admin (TODO #11, brief content-editor § A1): an operator makes a page in two locales,
// edits it, reads its revisions and their diff, and opens a preview that the public site never
// serves. A save on an outdated revision is a conflict that keeps what was typed. The admin and
// the saved preview ship no script (`csr = false`); live preview adds a small optional script.
// The `no-js` project proves the native path; `a11y` runs axe and the UI gate.
//
// Tenant isolation of the item itself is the database's (RLS on content_items, asserted by
// rls.conformance); here the preview routes prove that a session without a membership of the
// site gets nothing, not even the theme.
test.describe('content-admin', () => {
  const SITE = 'http://probe.localhost:4173';
  const LIVE_ADMIN = 'live-preview-admin@probe.test';
  const LIVE_READER = 'live-preview-reader@probe.test';

  async function ensureLiveAdmin() {
    const probe = await tenantId();
    await withInvoker(async (invoker) => {
      for (const [email, capability] of [
        [LIVE_ADMIN, 'tenant:admin'],
        [LIVE_READER, 'content:read'],
      ] as const) {
        try {
          await invoker.run(useCases.inviteMember, systemPrincipal(probe, 'e2e'), {
            email,
            capabilities: [capability],
          });
        } catch (e) {
          if (!(e instanceof UseCaseError && e.code === 'conflict')) throw e;
        }
      }
    });
  }

  test.use({
    locale: 'nl-NL',
    extraHTTPHeaders: {
      'x-forwarded-proto': 'http',
      'x-forwarded-for': `198.51.100.${Math.floor(Math.random() * 250) + 1}`,
    },
  });

  const address = () => `198.51.100.${Math.floor(Math.random() * 250) + 1}`;

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
    await login(page, '/admin/probe');
    await page.getByRole('link', { name: 'Pagina’s' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Pagina’s' })).toBeVisible();
    expect(await page.locator('script').count()).toBe(0);
    await expectNoAxeViolations(page);

    await page.getByRole('link', { name: 'Nieuwe pagina' }).click();
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
    await login(page, '/admin/probe');
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
    await login(page, '/admin/probe', LIVE_ADMIN);
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
    await page.setViewportSize(NARROW);
    await setTextSize(page, '200%');
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
      await login(reader, '/admin/probe', LIVE_READER);
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
    await login(page, '/admin', 'nobody@probe.test');
    await fn(page);
    await context.close();
  }

  test('a save on an outdated revision is a conflict that keeps what was typed', async ({
    page,
    browser,
  }) => {
    await login(page, '/admin/probe');
    const edit = await newPage(page, slugFor('conflict'), 'Eerste versie');

    // A second editor opens the same revision and saves first.
    const context = await freshContext(browser);
    const other = await context.newPage();
    await login(other, edit);
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
    await login(page, `/admin/probe/content/${item.id}`);
    await expect(page.getByLabel('Ver Weg')).toBeChecked();
    await expect(page.getByLabel('Rubriek')).toHaveValue(oldSection.id);
    await page.getByLabel('Titel (nl)').fill('Alleen de titel');
    await page.getByRole('button', { name: 'Opslaan' }).click();
    await expect(page).toHaveURL(new RegExp(`${item.id}\\?saved$`));
    expect(await saved()).toMatchObject({ authorIds, sectionId: oldSection.id });

    // Another editor removes every relation after this form was opened. Its latest document
    // and the directory page no longer contain the off-page choices in this editor's post.
    const { revision } = await call<{
      revision: { id: string; document: Record<string, unknown> };
    }>(request, 'content.item.get', { itemId: item.id });
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
    await login(page, '/admin/probe/content/new');
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
    await login(page, '/admin/probe');
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

  test('a locale without its translation is refused by its label; publish saves what was typed', async ({
    page,
    request,
  }) => {
    // No slug typed: core derives it from the title (proef 4).
    const title = `Alleen NL ${slugFor('nl')}`;
    await login(page, '/admin/probe/content/new?type=page');
    await page.getByLabel('Titel (nl)').fill(title);
    await page.getByRole('button', { name: 'Concept maken' }).click();
    await expect(page).toHaveURL(/\/admin\/probe\/content\/[0-9a-f-]{36}$/);
    const edit = new URL(page.url()).pathname;
    const en = card(page, 'en');
    await expect(en).toContainText('Titel (en): de vertaling ontbreekt');
    await expect(en.getByRole('link', { name: 'Titel (en)' })).toHaveAttribute('href', '#title.en');

    await en.getByRole('button', { name: 'Publiceren (en)' }).click();
    const alert = page.getByRole('alert');
    await expect(alert).toContainText('Dit kan in en nog niet:');
    await expect(alert).toContainText('Titel (en): de vertaling ontbreekt');
    await expectNoAxeViolations(page);

    // Typed but not saved: the publish button saves it first.
    await page.getByLabel('Titel (en)').fill('Only Dutch, now English');
    await card(page, 'en').getByRole('button', { name: 'Publiceren (en)' }).click();
    await expect(page).toHaveURL(`${edit}?done=publish&locale=en`);
    const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    expect((await request.get(`${SITE}/en/${slug}`)).status()).toBe(200);
  });

  test('a schedule pins a revision; a newer one can take its place', async ({ page }) => {
    await login(page, '/admin/probe');
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
    await expect(page.getByRole('alert')).toContainText(
      'Publiceren op: de tijd ligt niet in de toekomst'
    );

    await page.goto(edit);
    await nl.getByRole('button', { name: 'Planning intrekken (nl)' }).click();
    await expect(page.getByRole('status')).toContainText('Planning ingetrokken in nl.');
    await expect(nl.getByRole('heading')).toContainText('concept');
  });

  test('repinning an HTTP schedule preserves the second autumn hour and seconds', async ({
    page,
  }) => {
    const probe = await tenantId();
    await withInvoker(async (invoker) => {
      const api = createApp({
        invoker,
        authenticate: async (authorization) =>
          authorization === 'Bearer e2e' ? systemPrincipal(probe, 'e2e') : null,
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
      await login(page, '/admin/probe');
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
    });
  });

  test('a restricted item says what visitors get before any publish button', async ({ page }) => {
    await login(page, '/admin/probe');
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
    await login(page, '/admin/probe');
    const edit = await newPage(page, slugFor('writer'), 'Schrijverswerk');
    await page.goto('/admin/probe');
    const invite = page.locator('form[action="?/invite"]');
    await invite.getByLabel('E-mailadres (verplicht)', { exact: true }).fill(email);
    await invite.getByLabel('content:read', { exact: true }).check();
    await invite.getByLabel('content:write', { exact: true }).check();
    await invite.getByRole('button', { name: 'Uitnodigen' }).click();
    await expect(page.getByRole('status')).toContainText(email);
    try {
      await context.clearCookies();
      await login(page, edit, email);
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
      await login(page, '/admin/probe');
      const member = page.locator('form', { has: page.getByRole('heading', { name: email }) });
      await member.locator('button[formaction="?/remove"]').click();
      await expect(page.getByRole('status')).toContainText('Lid verwijderd');
    }
  });

  test.describe('UI gate: the content admin at 320 CSS px and 200% text', () => {
    test.use({ viewport: NARROW });

    for (const locale of ['nl-NL', 'en-GB'])
      for (const text of TEXT_SIZES)
        test(`every control whole and no horizontal scroll, ${locale}, text ${text}`, async ({
          browser,
        }) => {
          test.skip(test.info().project.name !== 'a11y', 'measures the layout with a script');
          const context = await freshContext(browser, locale, NARROW);
          const page = await context.newPage();
          await login(page, '/admin/probe');
          const edit = await newPageIn(
            page,
            locale,
            slugFor(`gate-${locale}-${text.replace('%', '')}`)
          );
          await fourActions(page, locale);
          for (const path of [edit, `${edit}/revisions`]) {
            await page.goto(path);
            await setTextSize(page, text);
            await layoutGate(page, path);
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
});

// Block forms of the content admin (TODO #11, brief content-editor § B): every block type is
// edited once through its generated form, and a block is inserted, moved and removed, all with
// native forms. The admin ships no script, so the `no-js` project is the no-JavaScript proof and
// the `a11y` project runs axe and the UI gate (skill ui-action-layout). Each project edits its own
// seeded page (`e2e-blokken-<project>`, scripts/e2e.mjs) with the first example of every type, so
// the bulk fixture is seeded once and not made here (the audit log the status part of admin.spec.ts reads).
test.describe('content-blocks', () => {
  test.use({ locale: 'nl-NL' });

  /** The seeded page of this project, by slug over the HTTP API. */
  async function seededPage(request: APIRequestContext): Promise<string> {
    const slug = `e2e-blokken-${test.info().project.name}`;
    const res = await request.post(`${process.env['E2E_API_URL']}/v1/content.item.list`, {
      headers: { authorization: `Bearer ${process.env['MYCEL_API_KEY']}` },
      data: { type: 'page', slug },
    });
    expect(res.ok(), await res.text()).toBe(true);
    const { items } = (await res.json()) as { items: { id: string }[] };
    expect(items, `${slug} is seeded by scripts/e2e.mjs`).toHaveLength(1);
    return `/admin/probe/content/${items[0]!.id}`;
  }

  /** Block `n` (1-based) of the edit page, opened. */
  async function block(page: Page, n: number): Promise<Locator> {
    const details = page.locator('details.block').nth(n - 1);
    if ((await details.getAttribute('open')) === null)
      await details.locator(':scope > summary').click();
    return details;
  }

  /** Save block `n` and wait for the edit page to come back with it open. */
  async function save(page: Page, n: number) {
    await (await block(page, n)).getByRole('button', { name: 'Blok opslaan' }).click();
    await expect(page).toHaveURL(/\?done=blockSaved&block=/);
    await expect(page.getByRole('status')).toContainText('Blok opgeslagen.');
  }

  test('every block type is edited once through its form, without JavaScript', async ({
    page,
    request,
  }) => {
    test.skip(!process.env['E2E_API_URL'], 'run through scripts/e2e.mjs');
    const edit = await seededPage(request);
    await login(page, edit);
    const stamp = String(Date.now());
    const summaries = page.locator('details.block > summary');
    await expect(summaries).toHaveText([
      /^1\. Kop/,
      /^2\. Inschrijfformulier \(oud\)/,
      /^3\. Tekst/,
      /^4\. Betaalmuur/,
      /^5\. Afbeelding/,
      /^6\. Opening/,
      /^7\. Oproep/,
      /^8\. Kader/,
      /^9\. Vragen en antwoorden/,
      /^10\. Citaat/,
      /^11\. Video/,
      /^12\. Formulier/,
    ]);

    /** Fill one field of block `n`, save, and see the value back in the reopened form. */
    const edits: [number, string, string, string?][] = [
      [1, 'Tekst (nl)', `Kop ${stamp}`],
      [3, 'Tekst (nl)', `Nieuwe **tekst** met [een link](/over) ${stamp}`],
      [5, 'Beschrijving (alt-tekst) (nl)', `Een plein vol mensen ${stamp}`],
      [6, 'Titel (nl)', `Schone lucht ${stamp}`],
      [7, 'Titel (nl)', `Doe mee ${stamp}`],
      [8, 'Titel (nl)', `Let op ${stamp}`],
      [10, 'Naam', `Fatima ${stamp}`],
      [11, 'Titel (nl)', `Verslag ${stamp}`],
    ];
    for (const [n, label, value] of edits) {
      await (await block(page, n)).getByLabel(label, { exact: true }).fill(value);
      await save(page, n);
      await expect((await block(page, n)).getByLabel(label, { exact: true })).toHaveValue(value);
    }
    // A list row, a choice, and the two blocks without editable text: saved through their forms.
    await (
      await block(page, 9)
    )
      .getByLabel('Vraag (nl)', { exact: true })
      .first()
      .fill(`Wat? ${stamp}`);
    await save(page, 9);
    await expect(
      (await block(page, 9)).getByLabel('Vraag (nl)', { exact: true }).first()
    ).toHaveValue(`Wat? ${stamp}`);
    await (await block(page, 9)).getByLabel('Breedte').selectOption('wide');
    await save(page, 9);
    await page.reload();
    await expect((await block(page, 9)).getByLabel('Breedte')).toHaveValue('wide');
    await expect(
      (await block(page, 9)).getByLabel('Vraag (en)', { exact: true }).first()
    ).toHaveValue(/.+/);
    const width = (await block(page, 12)).getByLabel('Breedte');
    const next = (await width.inputValue()) === 'wide' ? 'Volle breedte' : 'Breed';
    await width.selectOption({ label: next });
    await save(page, 12);
    await expect((await block(page, 12)).getByLabel('Breedte')).toHaveValue(
      next === 'Breed' ? 'wide' : 'full'
    );
    for (const n of [2, 4]) await save(page, n);
    await expectNoAxeViolations(page);

    // The other locale of the rich text kept its item link, written as Markdown.
    await expect((await block(page, 3)).getByLabel('Tekst (en)', { exact: true })).toHaveValue(
      /^More about our work is in \[the annual report\]\(item:[0-9a-f-]{36}\)$/
    );
    // And the edited locale was read back from Markdown: the preview renders the bold and the link.
    const preview = await page.getByRole('link', { name: 'Voorbeeld (nl)' }).getAttribute('href');
    await page.goto(preview!);
    await expect(page.locator('main strong', { hasText: 'tekst' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'een link' })).toHaveAttribute('href', /\/over$/);
    await expect(page.locator('main .faq.width-wide')).toContainText(`Wat? ${stamp}`);
    await page.goto(edit);
    if (test.info().project.name === 'a11y')
      await expect(
        page.frameLocator('iframe[data-live-preview-frame]').locator('.faq.width-wide')
      ).toBeVisible();
    await page.getByRole('button', { name: 'Publiceren (nl)' }).click();
    await page.goto(`/probe/e2e-blokken-${test.info().project.name}`);
    await expect(page.locator('main .faq.width-wide')).toContainText(`Wat? ${stamp}`);
  });

  /** Make a page through the "new" form; returns its edit URL. */
  async function newPage(page: Page, what: string): Promise<string> {
    const slug = `b-${what}-${test.info().project.name}-${Date.now()}`;
    await page.goto('/admin/probe/content/new?type=page');
    await page.getByLabel('Slug').fill(slug);
    await page.getByLabel('Titel (nl)').fill('Blokkenproef');
    await page.getByLabel('Titel (en)').fill('Block test');
    await page.getByRole('button', { name: 'Concept maken' }).click();
    await expect(page).toHaveURL(/\/admin\/probe\/content\/[0-9a-f-]{36}$/);
    return new URL(page.url()).pathname;
  }

  /** Insert a block of `type` through the document's or block `n`'s insert form. */
  async function insert(page: Page, type: string, place: string, n?: number) {
    const form = n
      ? (await block(page, n)).locator('form.insert')
      : page.locator('section > form.insert');
    await form.getByLabel('Soort').selectOption({ label: type });
    await form.getByLabel('Waar').selectOption({ label: place });
    await form.getByRole('button', { name: 'Velden invullen' }).click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(`Nieuw blok: ${type}`);
  }

  test('a block is inserted, moved and removed, each through a form of its own', async ({
    page,
  }) => {
    await login(page, '/admin/probe');
    const edit = await newPage(page, 'ops');
    await expect(page.getByText('Dit item heeft nog geen blokken.')).toBeVisible();

    await insert(page, 'Kop', 'Onderaan');
    await expectNoAxeViolations(page);
    // Nothing typed: core refuses, the issue links to its field.
    await page.getByRole('button', { name: 'Blok invoegen' }).click();
    const summary = page.getByRole('alert');
    await expect(summary).toContainText('Het blok kon niet worden opgeslagen');
    await expect(summary.getByRole('link', { name: 'Tekst' })).toBeVisible();
    await page.getByLabel('Tekst (nl)').fill('Eerste kop');
    await page.getByLabel('Tekst (en)').fill('First heading');
    await page.getByRole('button', { name: 'Blok invoegen' }).click();
    await expect(page).toHaveURL(/\?done=blockInserted&block=/);
    await expect(page.getByRole('status')).toContainText('Blok ingevoegd.');

    await insert(page, 'Tekst', 'Voor dit blok', 1);
    await page.getByLabel('Tekst (nl)').fill('Een [open link](https://example.org');
    await page.getByRole('button', { name: 'Blok invoegen' }).click();
    await expect(page.getByRole('alert')).toContainText('een link is niet afgesloten met )');
    await expect(page.getByLabel('Tekst (nl)')).toHaveValue('Een [open link](https://example.org');
    await page.getByLabel('Tekst (nl)').fill('Een _schuine_ inleiding.');
    await page.getByLabel('Tekst (en)').fill('An _italic_ introduction.');
    await page.getByRole('button', { name: 'Blok invoegen' }).click();
    await expect(page.getByRole('status')).toContainText('Blok ingevoegd.');
    const summaries = page.locator('details.block > summary');
    await expect(summaries).toHaveText([
      /^1\. Tekst: Een schuine inleiding\./,
      /^2\. Kop: Eerste kop/,
    ]);

    await (await block(page, 2)).getByRole('button', { name: 'Omhoog' }).click();
    await expect(page.getByRole('status')).toContainText('Blok verplaatst.');
    await expect(summaries).toHaveText([/^1\. Kop/, /^2\. Tekst/]);
    await expectNoAxeViolations(page);

    await (await block(page, 1)).getByRole('link', { name: 'Blok verwijderen' }).click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Blok verwijderen?');
    await expect(page.locator('main')).toContainText('1. Kop: Eerste kop');
    await expectNoAxeViolations(page);
    await page.getByRole('button', { name: 'Ja, verwijder dit blok' }).click();
    await expect(page).toHaveURL(new RegExp(`${edit}\\?done=blockRemoved`));
    await expect(page.getByRole('status')).toContainText('Blok verwijderd.');
    await expect(summaries).toHaveText([/^1\. Tekst/]);
  });

  test('FAQ v2 inserts, moves and publishes through native forms in both locales', async ({
    page,
  }) => {
    await login(page, '/admin/probe');
    const edit = await newPage(page, 'faq-width');
    await insert(page, 'Kop', 'Onderaan');
    await page.getByLabel('Tekst (nl)').fill('Vooraf');
    await page.getByLabel('Tekst (en)').fill('Before');
    await page.getByRole('button', { name: 'Blok invoegen' }).click();
    await insert(page, 'Vragen en antwoorden', 'Na dit blok', 1);
    await page.getByLabel('Variant').selectOption('accordion');
    await page.getByLabel('Breedte').selectOption('full');
    await page.getByLabel('Vraag (nl)').first().fill('Waarom is dit belangrijk?');
    await page.getByLabel('Vraag (en)').first().fill('Why does this matter?');
    await page.getByLabel('Antwoord (nl)').first().fill('Omdat iedereen kan meedoen.');
    await page.getByLabel('Antwoord (en)').first().fill('Because everyone can take part.');
    await page.getByRole('button', { name: 'Blok invoegen' }).click();
    await expect(page.getByRole('status')).toContainText('Blok ingevoegd.');
    const id = await page.locator('details.block').nth(1).getAttribute('id');
    await (await block(page, 2)).getByRole('button', { name: 'Omhoog' }).click();
    await expect(page.locator('details.block').first()).toHaveAttribute('id', id!);
    await page.reload();
    await expect((await block(page, 1)).getByLabel('Breedte')).toHaveValue('full');
    await expect((await block(page, 1)).getByLabel('Vraag (en)').first()).toHaveValue(
      'Why does this matter?'
    );
    for (const locale of ['nl', 'en']) {
      const preview = await page
        .getByRole('link', { name: `Voorbeeld (${locale})` })
        .getAttribute('href');
      await page.goto(preview!);
      await expect(page.locator('main .faq-accordion.width-full')).toContainText(
        locale === 'nl' ? 'Waarom is dit belangrijk?' : 'Why does this matter?'
      );
      await page.goto(edit);
      await page.getByRole('button', { name: `Publiceren (${locale})` }).click();
    }
    await expectNoAxeViolations(page);
  });

  test('the enhanced article writer keeps a native FAQ card through autosave and locale changes', async ({
    page,
    request,
  }) => {
    test.skip(test.info().project.name !== 'a11y', 'the enhanced writer requires JavaScript');
    test.skip(!process.env['E2E_API_URL'], 'run through scripts/e2e.mjs');
    const api = async (name: string, data: unknown) => {
      const response = await request.post(`${process.env['E2E_API_URL']}/v1/${name}`, {
        headers: { authorization: `Bearer ${process.env['MYCEL_API_KEY']}` },
        data,
      });
      expect(response.ok(), await response.text()).toBe(true);
      return response.json();
    };
    const source = await api('content.item.list', { type: 'article', slug: 'quality-article-v3' });
    expect(source.items).toHaveLength(1);
    const fetched = await api('content.item.get', { itemId: source.items[0].id });
    const prose = fetched.revision.document.blocks.find(
      (entry: { type: string }) => entry.type === 'rich-text'
    );
    expect(prose).toBeTruthy();
    const document = {
      ...fetched.revision.document,
      title: { nl: 'Schrijfproef', en: 'Writer proof' },
      blocks: [prose],
    };
    const created = await api('content.item.create', {
      slug: `faq-writer-${Date.now()}`,
      document,
    });
    const edit = `/admin/probe/content/${created.item.id}`;
    await login(page, `${edit}/write`);
    await page.getByRole('link', { name: 'Kaart invoegen' }).click();
    await expect(page).toHaveURL(new RegExp(`${edit}#insert-document$`));
    await insert(page, 'Vragen en antwoorden', 'Onderaan');
    await page.getByLabel('Variant').selectOption('accordion');
    await page.getByLabel('Breedte').selectOption('wide');
    await page.getByLabel('Titel (nl)').fill('Schrijfvragen');
    await page.getByLabel('Titel (en)').fill('Writing questions');
    await page.getByLabel('Vraag (nl)').first().fill('Blijft dit bewaard?');
    await page.getByLabel('Vraag (en)').first().fill('Does this survive?');
    await page.getByLabel('Antwoord (nl)').first().fill('Ja, in beide talen.');
    await page.getByLabel('Antwoord (en)').first().fill('Yes, in both languages.');
    await page.getByRole('button', { name: 'Blok invoegen' }).click();
    const faqId = await page.locator('details.block').nth(1).getAttribute('id');
    await (await block(page, 2)).getByRole('button', { name: 'Omhoog' }).click();
    await expect(page.locator('details.block').first()).toHaveAttribute('id', faqId!);
    await (await block(page, 1)).getByRole('button', { name: 'Omlaag' }).click();
    await page.goto(`${edit}/write`);
    await expect(
      page.locator(`.writing-surface .editor-card[data-block-id="${faqId?.replace('block-', '')}"]`)
    ).toBeVisible();
    await page.locator('.writing-surface .editor-prose p').first().click();
    await page.keyboard.press('End');
    await page.keyboard.type(' A new sentence.');
    await expect(page.getByRole('status')).toHaveText('Alle wijzigingen opgeslagen.');
    await page.reload();
    await expect(
      page.locator(`.writing-surface .editor-card[data-block-id="${faqId?.replace('block-', '')}"]`)
    ).toBeVisible();
    await page.goto(edit);
    await (await block(page, 2)).getByLabel('Breedte').selectOption('full');
    await save(page, 2);
    await page.goto(`${edit}/write?locale=en`);
    await expect(
      page.locator(`.writing-surface .editor-card[data-block-id="${faqId?.replace('block-', '')}"]`)
    ).toBeVisible();
    await page.goto(edit);
    await expect((await block(page, 2)).getByLabel('Breedte')).toHaveValue('full');
    await expect((await block(page, 2)).getByLabel('Vraag (en)').first()).toHaveValue(
      'Does this survive?'
    );
    const preview = await page.getByRole('link', { name: 'Voorbeeld (en)' }).getAttribute('href');
    await page.goto(preview!);
    await expect(page.locator('main .faq.width-full')).toContainText('Does this survive?');
    await page.goto(edit);
    await page.getByRole('button', { name: 'Publiceren (en)' }).click();
    await expect(page.getByRole('status')).toContainText('Gepubliceerd in en.');
  });

  test.describe('UI gate: the block forms at 320 CSS px and 200% text', () => {
    test.use({ viewport: NARROW });

    for (const text of TEXT_SIZES)
      test(`every action whole and no horizontal scroll, text ${text}`, async ({
        page,
        request,
      }) => {
        test.skip(test.info().project.name !== 'a11y', 'measures the layout with a script');
        const edit = await seededPage(request);
        await login(page, edit);
        const remove = await page
          .locator('details.block')
          .nth(6)
          .locator('a', { hasText: 'Blok verwijderen' })
          .getAttribute('href');
        for (const path of [edit, remove!]) {
          await page.goto(path);
          await page.evaluate(() =>
            document.querySelectorAll('details').forEach((d) => (d.open = true))
          );
          await setTextSize(page, text);
          await layoutGate(page, path);
        }
        // The insert page of the block with the most fields.
        await page.goto(edit);
        await insert(page, 'Opening', 'Na dit blok', 7);
        await setTextSize(page, text);
        await layoutGate(page, 'new hero');
      });
  });
});

// The enhanced article view and native block forms save the same core document. The browser
// proof covers autosave, axe and the action layout at 320 CSS px with 200% text; the no-JS
// project proves the adjacent form can write the same prose without hydrating the editor.
test.describe('article-writing', () => {
  const api = () => `${process.env['E2E_API_URL']}/v1`;
  const headers = () => ({ authorization: `Bearer ${process.env['MYCEL_API_KEY']}` });

  async function article(request: APIRequestContext) {
    const slug = `writer-${test.info().project.name}-${Date.now()}`;
    const response = await request.post(`${api()}/content.item.create`, {
      headers: headers(),
      data: {
        slug,
        document: {
          type: 'article',
          defaultLocale: 'nl',
          locales: ['nl', 'en'],
          title: { nl: 'Een artikel', en: 'An article' },
          blocks: [
            {
              type: 'rich-text',
              version: 1,
              props: {
                content: {
                  nl: {
                    type: 'doc',
                    content: [
                      { type: 'paragraph', content: [{ type: 'text', text: 'Oude tekst' }] },
                    ],
                  },
                  en: {
                    type: 'doc',
                    content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Old text' }] }],
                  },
                },
              },
            },
          ],
        },
      },
    });
    expect(response.ok(), await response.text()).toBe(true);
    const { item } = (await response.json()) as { item: { id: string } };
    return `/admin/probe/content/${item.id}`;
  }

  test('article prose saves through the native form or the enhanced editor', async ({
    page,
    request,
  }) => {
    test.skip(!process.env['E2E_API_URL'], 'run through scripts/e2e.mjs');
    const edit = await article(request);
    await login(page, edit);
    if (test.info().project.name === 'no-js') {
      const prose = page.locator('details.block').first();
      await prose.locator(':scope > summary').click();
      await prose.getByLabel(/^(Text|Tekst) \(nl\)$/).fill('Nieuwe tekst');
      await prose.getByRole('button', { name: /^(Save block|Blok opslaan)$/ }).click();
      await expect(page).toHaveURL(/\?done=blockSaved/);
      await expect(page.locator(`a[href="${edit}/write"]`)).toBeVisible();
    } else {
      const consoleErrors: string[] = [];
      page.on('console', (message) => {
        if (message.type() === 'error') consoleErrors.push(message.text());
      });
      await page.addInitScript(() => {
        (window as Window & { writerCspViolations: string[] }).writerCspViolations = [];
        window.addEventListener('securitypolicyviolation', (event) => {
          (window as Window & { writerCspViolations: string[] }).writerCspViolations.push(
            `${event.violatedDirective}: ${event.blockedURI}`
          );
        });
      });
      await page.locator(`a[href="${edit}/write"]`).click();
      const writing = page.locator('.writing-surface .ProseMirror');
      await expect(writing).toBeVisible();
      await writing.locator('p').first().fill('Nieuwe tekst');
      await expect(page.getByRole('status')).toContainText('Alle wijzigingen opgeslagen');
      expect(
        await page.evaluate(
          () => (window as Window & { writerCspViolations: string[] }).writerCspViolations
        )
      ).toEqual([]);
      expect(consoleErrors).toEqual([]);
      await expectNoAxeViolations(page);
    }
    await page.goto(edit);
    const prose = page.locator('details.block').first();
    await prose.locator(':scope > summary').click();
    await expect(prose.getByLabel(/^(Text|Tekst) \(nl\)$/)).toHaveValue('Nieuwe tekst');
    await expect(prose.getByLabel(/^(Text|Tekst) \(en\)$/)).toHaveValue('Old text');
  });

  test('writer toolbar wraps whole actions at 320 CSS px and 200% text', async ({
    page,
    request,
  }) => {
    test.skip(test.info().project.name !== 'a11y' || !process.env['E2E_API_URL']);
    const edit = await article(request);
    await login(page, `${edit}/write`);
    await page.setViewportSize(NARROW);
    await setTextSize(page, '200%');
    await layoutGate(page, 'writer actions', '.writer-actions');
  });

  test('pasted blockquote becomes a structured quote card after attribution', async ({
    page,
    request,
  }) => {
    test.skip(test.info().project.name !== 'a11y' || !process.env['E2E_API_URL']);
    const edit = await article(request);
    await login(page, `${edit}/write`);
    const writing = page.locator('.writing-surface .ProseMirror');
    await writing.click();
    await writing.evaluate((element) => {
      const clipboardData = new DataTransfer();
      clipboardData.setData('text/html', '<blockquote><p>Een stem uit de buurt.</p></blockquote>');
      element.dispatchEvent(
        new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData })
      );
    });
    await expect(page.getByRole('heading', { name: 'Geplakt citaat' })).toBeVisible();
    await page.getByLabel('Naam voor bronvermelding').fill('Sam');
    await page.getByRole('button', { name: 'Kaart toevoegen' }).click();
    await expect(page.getByRole('status')).toContainText('Alle wijzigingen opgeslagen');
    await page.goto(edit);
    await expect(page.locator('details.block')).toHaveCount(2);
    await expect(page.locator('details.block').nth(1).locator(':scope > summary')).toContainText(
      /Quote|Citaat/
    );
  });

  test('autosave reports a newer revision and preserves its unrelated fields on retry', async ({
    page,
    request,
  }) => {
    test.skip(test.info().project.name !== 'a11y' || !process.env['E2E_API_URL']);
    const edit = await article(request);
    const itemId = edit.split('/').at(-1)!;
    await login(page, `${edit}/write`);
    const original = await request.post(`${api()}/content.item.get`, {
      headers: headers(),
      data: { itemId },
    });
    expect(original.ok(), await original.text()).toBe(true);
    const { revision } = (await original.json()) as {
      revision: { id: string; document: Record<string, unknown> };
    };
    const newer = await request.post(`${api()}/content.item.update`, {
      headers: headers(),
      data: {
        itemId,
        baseRevisionId: revision.id,
        document: {
          ...revision.document,
          title: { nl: 'Nieuwe kop van collega', en: 'An article' },
        },
      },
    });
    expect(newer.ok(), await newer.text()).toBe(true);
    await page.locator('.writing-surface .ProseMirror p').first().fill('Mijn nieuwe tekst');
    await expect(
      page.getByRole('heading', { name: 'Iemand anders heeft dit item intussen opgeslagen' })
    ).toBeVisible();
    await page.setViewportSize(NARROW);
    await setTextSize(page, '200%');
    await layoutGate(page, 'writer actions', '.writer-actions');
    await expect(page.getByText('Mijn nieuwe tekst').first()).toBeVisible();
    await page.getByRole('button', { name: 'Mijn tekst behouden' }).click();
    await expect(page.getByRole('status')).toContainText('Alle wijzigingen opgeslagen');
    await page.goto(edit);
    await expect(page.getByLabel('Title (nl)')).toHaveValue('Nieuwe kop van collega');
    const prose = page.locator('details.block').first();
    await prose.locator(':scope > summary').click();
    await expect(prose.getByLabel('Text (nl)')).toHaveValue('Mijn nieuwe tekst');
  });

  test('pasted image waits for media and alternative text before saving', async ({
    page,
    request,
  }) => {
    test.skip(test.info().project.name !== 'a11y' || !process.env['E2E_API_URL']);
    const listed = await request.post(`${api()}/content.item.list`, {
      headers: headers(),
      data: { type: 'page', slug: 'e2e-blokken-a11y' },
    });
    expect(listed.ok(), await listed.text()).toBe(true);
    const { items } = (await listed.json()) as { items: { id: string }[] };
    const source = await request.post(`${api()}/content.item.get`, {
      headers: headers(),
      data: { itemId: items[0]!.id },
    });
    const { revision } = (await source.json()) as {
      revision: { document: { blocks: { type: string; props: { mediaId?: string } }[] } };
    };
    const mediaId = revision.document.blocks.find((block) => block.type === 'image')?.props.mediaId;
    expect(mediaId).toBeTruthy();
    const edit = await article(request);
    await login(page, `${edit}/write`);
    const writing = page.locator('.writing-surface .ProseMirror');
    await writing.click();
    await writing.evaluate((element) => {
      const clipboardData = new DataTransfer();
      clipboardData.setData(
        'text/html',
        '<p><img src="https://example.org/photo.jpg" alt="Een boom"></p>'
      );
      element.dispatchEvent(
        new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData })
      );
    });
    await expect(page.getByRole('heading', { name: 'Geplakte afbeelding' })).toBeVisible();
    await page.setViewportSize(NARROW);
    await setTextSize(page, '200%');
    await layoutGate(page, 'writer actions', '.writer-actions');
    await expect(page.getByRole('status')).toContainText('Niet-opgeslagen wijzigingen');
    await page.getByLabel('ID van geüpload bestand').fill(mediaId!);
    await expect(page.getByLabel('Alternatieve tekst')).toHaveValue('Een boom');
    await page.getByRole('button', { name: 'Kaart toevoegen' }).click();
    await expect(page.getByRole('status')).toContainText('Alle wijzigingen opgeslagen');
    await page.goto(edit);
    await expect(page.locator('details.block')).toHaveCount(2);
    await expect(page.locator('details.block').nth(1).locator(':scope > summary')).toContainText(
      /Image|Afbeelding/
    );
  });

  test('TipTap saves headings, lists, links and notes without changing stored structure', async ({
    page,
    request,
  }) => {
    test.skip(test.info().project.name !== 'a11y' || !process.env['E2E_API_URL']);
    const edit = await article(request);
    const itemId = edit.split('/').at(-1)!;
    const original = await request.post(`${api()}/content.item.get`, {
      headers: headers(),
      data: { itemId },
    });
    const { revision } = (await original.json()) as { revision: { id: string; document: any } };
    const rich = {
      type: 'doc',
      content: [
        { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Tussenkop' }] },
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'Vet', marks: [{ type: 'bold' }] },
            {
              type: 'text',
              text: ' bron',
              marks: [{ type: 'link', attrs: { href: 'https://example.org' } }],
            },
            {
              type: 'text',
              text: ' noot',
              marks: [{ type: 'footnote_reference', attrs: { text: 'Bron 1' } }],
            },
          ],
        },
        {
          type: 'bullet_list',
          content: [
            {
              type: 'list_item',
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Punt' }] }],
            },
          ],
        },
        {
          type: 'ordered_list',
          attrs: { start: 3 },
          content: [
            {
              type: 'list_item',
              content: [
                {
                  type: 'paragraph',
                  content: [
                    { type: 'text', text: 'Derde', marks: [{ type: 'bold' }] },
                    { type: 'text', text: ' punt' },
                  ],
                },
              ],
            },
          ],
        },
        {
          type: 'ordered_list',
          attrs: { start: 1 },
          content: [
            {
              type: 'list_item',
              content: [
                {
                  type: 'paragraph',
                  content: [
                    { type: 'text', text: 'Eerste', marks: [{ type: 'bold' }] },
                    { type: 'text', text: ' punt' },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };
    const updated = await request.post(`${api()}/content.item.update`, {
      headers: headers(),
      data: {
        itemId,
        baseRevisionId: revision.id,
        document: {
          ...revision.document,
          blocks: [
            {
              ...revision.document.blocks[0],
              props: { content: { nl: rich, en: revision.document.blocks[0].props.content.en } },
            },
          ],
        },
      },
    });
    expect(updated.ok(), await updated.text()).toBe(true);
    await login(page, `${edit}/write`);
    await page.getByRole('button', { name: 'Nu opslaan' }).click();
    await expect(page.getByRole('status')).toContainText('Alle wijzigingen opgeslagen');
    const saved = await request.post(`${api()}/content.item.get`, {
      headers: headers(),
      data: { itemId },
    });
    const { revision: latest } = (await saved.json()) as { revision: { document: any } };
    expect(latest.document.blocks[0].id).toBe(revision.document.blocks[0].id);
    expect(latest.document.blocks[0].props.content.nl).toEqual(rich);
    expect(latest.document.blocks[0].props.content.en).toEqual(
      revision.document.blocks[0].props.content.en
    );
    const listItem = page.locator('.writing-surface .ProseMirror ol li p').last();
    await listItem.click();
    await page.keyboard.press('End');
    await page.keyboard.type(' aangevuld');
    await expect(listItem).toContainText('Eerste punt aangevuld');
    await expect
      .poll(async () => {
        const response = await request.post(`${api()}/content.item.get`, {
          headers: headers(),
          data: { itemId },
        });
        const { revision: current } = (await response.json()) as { revision: { document: any } };
        return current.document.blocks[0].props.content.nl.content[4].content[0].content[0].content
          .map((part: { text: string }) => part.text)
          .join('');
      })
      .toBe('Eerste punt aangevuld');
    await expect(page.getByRole('status')).toContainText('Alle wijzigingen opgeslagen');
    const edited = await request.post(`${api()}/content.item.get`, {
      headers: headers(),
      data: { itemId },
    });
    expect(edited.ok(), await edited.text()).toBe(true);
    const { revision: afterEdit } = (await edited.json()) as { revision: { document: any } };
    expect(afterEdit.document.blocks[0].id).toBe(revision.document.blocks[0].id);
    expect(afterEdit.document.blocks[0].props.content.nl).toEqual({
      ...rich,
      content: rich.content.map((node) =>
        node.type === 'ordered_list' && node.attrs?.start === 1
          ? {
              ...node,
              content: [
                {
                  type: 'list_item',
                  content: [
                    {
                      type: 'paragraph',
                      content: [
                        { type: 'text', text: 'Eerste', marks: [{ type: 'bold' }] },
                        { type: 'text', text: ' punt aangevuld' },
                      ],
                    },
                  ],
                },
              ],
            }
          : node
      ),
    });
    expect(afterEdit.document.blocks[0].props.content.en).toEqual(
      revision.document.blocks[0].props.content.en
    );
  });
});
