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
import { isA11y, onlyA11y } from './lib/project';
import { callApi, requireApi } from './lib/api';

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
      javaScriptEnabled: isA11y(),
      baseURL: 'http://127.0.0.1:4173',
      extraHTTPHeaders: { 'x-forwarded-proto': 'http', 'x-forwarded-for': address() },
    });

  const slugFor = (what: string) =>
    `a1-${what}-${test.info().project.name}-${Date.now()}`.toLowerCase();

  /** Make a page in nl and en through the "new" form; returns its edit URL. */
  /** With JavaScript the edit screen's sections are tabs (#66 PR 3): show the one named. */
  async function showTab(page: Page, name: string) {
    if (isA11y()) await page.getByRole('tab', { name, exact: true }).click();
  }

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
    // One visible "Pagina's" (#87): the list heading and the table caption repeat the title for
    // screen readers only.
    expect(
      await page
        .locator('main :is(h1, h2, caption)', { hasText: 'Pagina’s' })
        .evaluateAll((nodes) => nodes.filter((n) => n.getBoundingClientRect().width > 1).length)
    ).toBe(1);
    await expect(page.getByRole('table', { name: 'Pagina’s' })).toBeVisible();
    expect(await page.locator('script:not([src="/_admin/nav.js"])').count()).toBe(0);
    await expectNoAxeViolations(page);

    await page.getByRole('link', { name: 'Nieuwe pagina' }).click();
    await expectNoAxeViolations(page);
    const slug = slugFor('edit');
    const edit = await newPage(page, slug, 'Over de buurt');
    await expect(page.getByRole('heading', { level: 1, name: 'Pagina bewerken' })).toBeVisible();
    await expect(page.locator('#title\\.nl')).toHaveValue('Over de buurt');
    await expect(page.locator('#publication-nl')).toContainText('Concept');
    await expectNoAxeViolations(page);

    await page.getByLabel('Titel (nl)').fill('Over onze buurt');
    // Search settings are a tab away with JavaScript, folded away without (skill
    // cms-inrichting); the tab opens its one fold itself (#66 PR 3).
    if (isA11y()) await page.getByRole('tab', { name: 'Zoeken en delen' }).click();
    else await page.locator('summary', { hasText: 'Zoeken en delen' }).click();
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

    // With JavaScript the bar's preview links give way to the toggle (#66 PR 3): the hook finds
    // them either way.
    const link = page.locator('a[data-preview-link="en"]');
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

  test('the edit screen shows its sections as tabs with JavaScript, all of them without', async ({
    page,
  }) => {
    await login(page, '/admin/probe');
    const edit = await newPage(page, slugFor('tabs'), 'Tabbladen');
    const titles = ['Inhoud', 'Uitgelicht', 'Zoeken en delen', 'Instellingen'];
    if (!isA11y()) {
      // No script: every section below the other, each under its own heading.
      for (const name of titles)
        await expect(page.getByRole('heading', { level: 2, name, exact: true })).toBeVisible();
      await expect(page.getByRole('tablist')).toBeHidden();
      return;
    }
    const list = page.getByRole('tablist', { name: 'Onderdelen van dit item' });
    await expect(list.getByRole('tab')).toHaveText(titles);
    await expect(page.getByRole('tabpanel')).toHaveCount(1);
    await expect(page.getByRole('tabpanel', { name: 'Inhoud' })).toBeVisible();
    await expect(page.locator('#title\\.nl')).toBeVisible();
    // The arrow keys of the ARIA tabs pattern: focus moves and shows its panel.
    await list.getByRole('tab', { name: 'Inhoud' }).focus();
    await page.keyboard.press('ArrowRight');
    await expect(list.getByRole('tab', { name: 'Uitgelicht' })).toBeFocused();
    // An empty featured field names what applies instead and where it comes from (#86 PR 2).
    await expect(page.getByLabel('Titel in overzichten (nl)')).toBeVisible();
    await expect(page.locator('#featuredTitle\\.nl-inherited')).toHaveText(
      'Standaard: de titel: “Tabbladen”'
    );
    await expect(page.locator('#featuredImageId-inherited')).toHaveText('Standaard: leeg');
    await page.keyboard.press('ArrowRight');
    await expect(list.getByRole('tab', { name: 'Zoeken en delen' })).toBeFocused();
    await expect(list.getByRole('tab', { name: 'Zoeken en delen' })).toHaveAttribute(
      'aria-selected',
      'true'
    );
    await expect(page.getByLabel('Titel in zoekresultaten (nl)')).toBeVisible();
    await expect(page.locator('#title\\.nl')).toBeHidden();
    await page.keyboard.press('End');
    await expect(page.getByRole('tabpanel', { name: 'Instellingen' })).toBeVisible();
    await page.keyboard.press('ArrowRight');
    await expect(page.getByRole('tabpanel', { name: 'Inhoud' })).toBeVisible();
    // The chosen tab is the hash: a reload comes back on it, and it is the same form.
    await list.getByRole('tab', { name: 'Zoeken en delen' }).click();
    await expect(page).toHaveURL(`${edit}#item-tabs-findability`);
    await page.getByLabel('Titel in zoekresultaten (nl)').fill('Getabd');
    await page.reload();
    await expect(page.getByRole('tabpanel', { name: 'Zoeken en delen' })).toBeVisible();
    await list.getByRole('tab', { name: 'Inhoud' }).click();
    await page.getByRole('button', { name: 'Opslaan' }).click();
    await expect(page.getByRole('status')).toContainText('Opgeslagen als nieuwe revisie');
    await expectNoAxeViolations(page);

    // B: a required field on a hidden tab. The browser refuses the submit and focuses the field,
    // so its panel shows first.
    await page.locator('#title\\.nl').fill('');
    await list.getByRole('tab', { name: 'Zoeken en delen' }).click();
    await page.getByRole('button', { name: 'Opslaan' }).click();
    await expect(page.getByRole('tabpanel', { name: 'Inhoud' })).toBeVisible();
    await expect(page.locator('#title\\.nl')).toBeFocused();
    await page.locator('#title\\.nl').fill('Tabbladen');

    // A: the server refuses a field on another tab. The page comes back on that tab, and the
    // summary's link shows it again from any tab and focuses the field.
    await list.getByRole('tab', { name: 'Zoeken en delen' }).click();
    await page.locator('[name="canonical"]').fill('geen url');
    await list.getByRole('tab', { name: 'Inhoud' }).click();
    await page.getByRole('button', { name: 'Opslaan' }).click();
    const summary = page.getByRole('alert');
    const link = summary.getByRole('link', {
      name: 'Canoniek adres (optioneel, begint met https://)',
    });
    await expect(summary).toContainText('Het canonieke adres moet beginnen met https://');
    await expect(page.getByRole('tabpanel', { name: 'Zoeken en delen' })).toBeVisible();
    await expect(page.locator('#canonical')).toHaveAttribute('aria-invalid', 'true');
    await list.getByRole('tab', { name: 'Inhoud' }).click();
    await link.click();
    await expect(page.getByRole('tabpanel', { name: 'Zoeken en delen' })).toBeVisible();
    await expect(page.locator('#canonical')).toBeFocused();
    await expectNoAxeViolations(page);
  });

  test('live preview shows unsaved fields, isolates tenants and opens a clicked block', async ({
    page,
    browser,
  }) => {
    onlyA11y('live preview is a JavaScript enhancement');
    await ensureLiveAdmin();
    await login(page, '/admin/probe', LIVE_ADMIN);
    const edit = await newPage(page, slugFor('live'), 'Saved title');

    // Give the preview a block to select. Its native details remains the keyboard route.
    await page.getByLabel('Soort', { exact: true }).last().selectOption({ label: 'Kop' });
    await page.getByRole('button', { name: 'Toevoegen', exact: true }).click();
    await page.getByLabel('Tekst (nl)').fill('Saved heading');
    await page.getByLabel('Tekst (en)').fill('Saved heading');
    await page.getByRole('button', { name: 'Toevoegen en opslaan' }).click();
    await expect(page).toHaveURL(/\?saved&block=/);

    // Closed by default (#66 PR 3): the eye in the bar takes the place of the saved-preview links,
    // which move into the preview itself.
    const toggle = page.getByRole('button', { name: 'Voorbeeld', exact: true });
    const panel = page.locator('[data-live-preview]');
    const side = page.locator('.ui-edit-side');
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await expect(panel).toBeHidden();
    await expect(page.locator('.ui-item-bar a[data-preview-link]')).toHaveCount(2);
    await expect(page.locator('.ui-item-bar a[data-preview-link]').first()).toBeHidden();
    await expect(side).toBeVisible();
    // Open on a wide screen: a column beside the text, the side column steps aside.
    await page.setViewportSize({ width: 1600, height: 900 });
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    await expect(panel).toBeVisible();
    await expect(side).toBeHidden();
    const main = (await page.locator('.ui-edit-main').boundingBox())!;
    const beside = (await panel.boundingBox())!;
    expect(beside.x).toBeGreaterThanOrEqual(main.x + main.width);
    expect(beside.y).toBeLessThan(main.y + 200);
    await expect(
      panel.getByRole('link', { name: 'Opgeslagen versie in nieuw tabblad (nl)' })
    ).toBeVisible();
    await expectNoAxeViolations(page);
    // The state in the bar points into the side column: following it closes the preview.
    await page.locator('.ui-item-bar-state').click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await expect(side).toBeVisible();
    // The browser remembers the choice.
    await toggle.click();
    await page.reload();
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    await page.setViewportSize({ width: 1280, height: 720 });

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
    await expect(details.locator(':scope > summary')).toBeFocused();
    await details.getByLabel('Tekst (nl)').fill('Unsaved heading');
    await expect(frame.getByRole('heading', { name: 'Unsaved heading' })).toBeVisible();
    await details.locator(':scope > summary').press('Enter');
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

  /** One entry of a paged directory by its slug, over the HTTP API. */
  async function bySlug<T>(
    request: APIRequestContext,
    name: string,
    key: string,
    slug: string
  ): Promise<T> {
    let after: string | null = null;
    do {
      const page: Record<string, unknown> & { next: string | null } = await callApi(request, name, {
        limit: 100,
        ...(after ? { after } : {}),
      });
      const found = (page[key] as (T & { slug: string })[]).find((x) => x.slug === slug);
      if (found) return found;
      after = page.next;
    } while (after);
    throw new Error(`${slug} is not seeded; run through scripts/e2e/e2e.mjs`);
  }

  // The pickers list one page of the directory (newest first, a hundred), so an
  // author or section beyond it, or authors in another order than the directory's, were lost or
  // reordered by a save that only changed the title.
  test('title-only and conflicting saves keep authors, their order and the off-page section', async ({
    page,
    request,
  }) => {
    requireApi();
    const run = slugFor('rel');
    const author = (name: string) =>
      callApi<{ id: string }>(request, 'content.author.create', {
        slug: name.toLowerCase().replace(/\W+/g, '-'),
        name,
      });
    // Seeded by scripts/e2e/e2e.mjs with 101 newer authors and sections after them.
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
    const { item } = await callApi<{ item: { id: string } }>(request, 'content.item.create', {
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
        await callApi<{
          revision: { document: { authorIds: string[]; sectionId: string | null } };
        }>(request, 'content.item.get', { itemId: item.id })
      ).revision.document;

    const fresh = await author(`Nieuw ${run}`);
    await login(page, `/admin/probe/content/${item.id}`);
    await expect(page.getByLabel('Ver Weg')).toBeChecked();
    await expect(page.getByLabel('Rubriek')).toHaveValue(oldSection.id);
    await page.locator('#title\\.nl').fill('Alleen de titel');
    await page.getByRole('button', { name: 'Opslaan' }).click();
    await expect(page).toHaveURL(new RegExp(`${item.id}\\?saved$`));
    expect(await saved()).toMatchObject({ authorIds, sectionId: oldSection.id });

    // Another editor removes every relation after this form was opened. Its latest document
    // and the directory page no longer contain the off-page choices in this editor's post.
    const { revision } = await callApi<{
      revision: { id: string; document: Record<string, unknown> };
    }>(request, 'content.item.get', { itemId: item.id });
    await page.locator('#title\\.nl').fill('Mijn artikel bij conflict');
    await callApi(request, 'content.item.update', {
      itemId: item.id,
      baseRevisionId: revision.id,
      document: { ...revision.document, authorIds: [], sectionId: null },
    });
    await page.getByRole('button', { name: 'Opslaan' }).click();
    await expect(page.getByRole('alert')).toContainText(
      'Iemand anders heeft dit item intussen opgeslagen'
    );
    await expect(page.locator('#title\\.nl')).toHaveValue('Mijn artikel bij conflict');
    for (const name of [`Eerste ${run}`, `Tweede ${run}`, 'Ver Weg'])
      await expect(page.getByLabel(name, { exact: true })).toBeChecked();
    await expect(page.getByLabel('Rubriek')).toHaveValue(oldSection.id);
    await expectNoAxeViolations(page);

    // A validation error on the new base must preserve the same choices too. They still
    // are not in the latest document, and the section/old author are outside the directory page.
    await showTab(page, 'Zoeken en delen');
    await page.locator('[name="canonical"]').fill('not-a-url');
    await page.getByRole('button', { name: 'Opslaan' }).click();
    await expect(page.getByRole('alert')).toBeVisible();
    await expect(page.getByRole('alert')).not.toContainText(
      'Iemand anders heeft dit item intussen opgeslagen'
    );
    for (const name of [`Eerste ${run}`, `Tweede ${run}`, 'Ver Weg'])
      await expect(page.getByLabel(name, { exact: true })).toBeChecked();
    await expect(page.getByLabel('Rubriek')).toHaveValue(oldSection.id);
    await expect(page.locator('#title\\.nl')).toHaveValue('Mijn artikel bij conflict');
    await showTab(page, 'Zoeken en delen');
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

  // Publication per locale (brief content-editor § A2, edit-screen § 4): core decides, the
  // status card of each locale shows what it decided, its state in words. Every action is a
  // button of the one edit form.
  const card = (page: Page, locale: string) => page.locator(`#publication-${locale}`);
  /** The schedule fold of a card, opened. */
  const scheduleFold = async (page: Page, locale: string) => {
    const fold = card(page, locale).locator('details', { hasText: `Inplannen (${locale})` });
    if ((await fold.getAttribute('open')) === null) await fold.locator('summary').click();
    return fold;
  };

  test('publishing puts a locale live; a later edit stays unpublished until published', async ({
    page,
    request,
  }) => {
    await login(page, '/admin/probe');
    const slug = slugFor('publish');
    const edit = await newPage(page, slug, 'Buurtfeest');
    await expect(card(page, 'nl')).toContainText('Concept');
    await expect(card(page, 'nl').getByRole('list')).toHaveCount(0);
    await card(page, 'nl').getByRole('button', { name: 'Publiceren (nl)' }).click();
    await expect(page).toHaveURL(`${edit}?done=publish&locale=nl`);
    await expect(page.getByRole('status')).toContainText('Gepubliceerd in nl.');
    await expect(card(page, 'nl')).toContainText(/Gepubliceerd op \d+ \w+ \d{4}/);
    await expect(card(page, 'nl').getByRole('button', { name: /publiceren/i })).toHaveCount(0);
    await expect(
      card(page, 'nl').getByRole('link', { name: /Bekijk op de site \(nl\)/ })
    ).toHaveAttribute('href', new RegExp(`/${slug}$`));
    await expectNoAxeViolations(page);
    expect((await request.get(`${SITE}/${slug}`)).status()).toBe(200);
    expect((await request.get(`${SITE}/en/${slug}`)).status()).toBe(404);

    // A new revision: the site keeps the old title until it is published.
    await page.getByLabel('Titel (nl)').fill('Buurtfeest verplaatst');
    await page.getByRole('button', { name: 'Opslaan' }).click();
    await expect(page).toHaveURL(`${edit}?saved`);
    await expect(card(page, 'nl')).toContainText('Gepubliceerd, sindsdien gewijzigd');
    await expect(
      card(page, 'nl').getByRole('button', { name: 'Wijzigingen publiceren (nl)' })
    ).toBeVisible();
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
    await expect(card(page, 'nl')).toContainText('Offline gehaald');
    expect((await request.get(`${SITE}/${slug}`)).status()).toBe(404);
  });

  test('a locale without its translation is refused by its label; publish saves what was typed', async ({
    page,
    request,
  }) => {
    // No slug typed: core derives it from the title (editor trial 2026-10-28).
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
    // Scheduling is folded away until asked for: no date field in view by default.
    await expect(nl.getByLabel('Publiceren op')).toBeHidden();
    await (await scheduleFold(page, 'nl')).getByLabel('Publiceren op').fill('2030-01-04T09:00');
    await nl.getByRole('button', { name: 'Inplannen (nl)' }).click();
    await expect(page).toHaveURL(`${edit}?done=schedule&locale=nl`);
    await expect(nl).toContainText('Ingepland voor 2030-01-04 09:00');

    // Edited after planning: the pin stays on the old revision until the editor moves it.
    await page.getByLabel('Titel (nl)').fill('Op vrijdagochtend');
    await page.getByRole('button', { name: 'Opslaan' }).click();
    await expect(page).toHaveURL(`${edit}?saved`);
    await expect(nl).toContainText('Ingepland voor 2030-01-04 09:00');
    await expect(nl).toContainText('Je bewerkt een nieuwere revisie');
    await expectNoAxeViolations(page);
    await nl.getByRole('button', { name: 'Deze versie op dat moment publiceren (nl)' }).click();
    await expect(page).toHaveURL(`${edit}?done=repin&locale=nl`);
    await expect(nl).toContainText('Ingepland voor 2030-01-04 09:00');
    await expect(nl).not.toContainText('Je bewerkt een nieuwere revisie');

    // A time in the past is core's refusal, worded in the panel's terms.
    await (await scheduleFold(page, 'nl')).getByLabel('Publiceren op').fill('2020-01-01T09:00');
    await nl.getByRole('button', { name: 'Inplannen (nl)' }).click();
    await expect(page.getByRole('alert')).toContainText(
      'Publiceren op: de tijd ligt niet in de toekomst'
    );

    await page.goto(edit);
    await nl.getByRole('button', { name: 'Planning intrekken (nl)' }).click();
    await expect(page.getByRole('status')).toContainText('Planning ingetrokken in nl.');
    await expect(nl).toContainText('Concept');
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
      ] as const) {
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
          .getByRole('button', { name: 'Deze versie op dat moment publiceren (nl)' })
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

  test('a restricted item says what visitors get before any publish button', async ({
    page,
    request,
  }) => {
    requireApi();
    await login(page, '/admin/probe');
    const edit = await newPage(page, slugFor('restricted'), 'Voor leden');
    // A public item shows no access fields: the site has no readers yet (#19, #66 PR 2).
    await expect(page.getByLabel('Wie het mag lezen')).toHaveCount(0);
    // An item that has restricted access keeps its fields, so it can be opened up again.
    const itemId = edit.split('/').at(-1)!;
    const { revision } = await callApi<{
      revision: { id: string; document: Record<string, unknown> };
    }>(request, 'content.item.get', { itemId });
    await callApi(request, 'content.item.update', {
      itemId,
      baseRevisionId: revision.id,
      document: { ...revision.document, access: { level: 'members', teaser: 'lead' } },
    });
    await page.goto(edit);
    await expect(page.getByLabel('Wie het mag lezen')).toHaveValue('members');
    const notice = card(page, 'nl').getByText('Bezoekers zonder account zien dit item niet');
    await expect(notice).toBeVisible();
    // Before the first button in document order, and no button closes it.
    const before = await notice.evaluate((el) => {
      const button = document.querySelector('.ui-status-card button')!;
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
    await page.goto('/admin/probe/leden');
    await page.getByRole('button', { name: 'Iemand uitnodigen' }).click();
    const invite = page.locator('form[action="?/invite"]');
    await invite.getByLabel('E-mailadres (verplicht)', { exact: true }).fill(email);
    // An author writes and does not publish (#101).
    await invite.getByRole('radio', { name: /^Auteur/ }).check();
    await invite.getByRole('button', { name: 'Uitnodigen' }).click();
    await expect(page.getByRole('status')).toContainText(email);
    try {
      await context.clearCookies();
      await login(page, edit, email);
      await expect(card(page, 'nl')).toContainText('Concept');
      await expect(
        card(page, 'nl').getByText('vragen de bevoegdheid content:publish')
      ).toBeVisible();
      await expect(page.locator('.ui-status-card button')).toHaveCount(0);
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

      // Publishing saves the edit form first (#65); a writer's own form, changed and posted to
      // the publish action, is refused before anything is saved (TODO #67).
      const posted = await page.locator('form#item-edit').evaluate((form) => {
        const data = new FormData(form as HTMLFormElement);
        data.set('title.nl', 'Door een schrijver gepubliceerd');
        data.set('locale', 'nl');
        return new URLSearchParams(
          [...data.entries()].map(([k, v]) => [k, String(v)] as [string, string])
        ).toString();
      });
      expect(posted).toContain('baseRevisionId=');
      const viaForm = await page.request.post(`${edit}?/publish`, {
        headers: {
          origin: 'http://127.0.0.1:4173',
          'content-type': 'application/x-www-form-urlencoded',
        },
        data: posted,
      });
      expect(viaForm.status()).toBe(403);
      await page.reload();
      await expect(page.locator('input[name="baseRevisionId"]')).toHaveValue(revisionId);
      await expect(page.locator('input[name="title.nl"]')).toHaveValue('Schrijverswerk');

      // Without content:publish, the other publication actions are refused before a save too.
      for (const action of ['schedule', 'unschedule', 'unpublish']) {
        const refused = await page.request.post(`${edit}?/${action}`, {
          headers: {
            origin: 'http://127.0.0.1:4173',
            'content-type': 'application/x-www-form-urlencoded',
          },
          data: posted,
        });
        expect(refused.status(), action).toBe(403);
      }
      await page.reload();
      await expect(page.locator('input[name="baseRevisionId"]')).toHaveValue(revisionId);
    } finally {
      await context.clearCookies();
      await login(page, '/admin/probe/leden');
      const member = page.getByRole('row', { name: new RegExp(email) });
      await member.locator('summary', { hasText: 'Verwijderen' }).click();
      await member.getByRole('button', { name: `Ja, verwijderen: ${email}` }).click();
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
          onlyA11y('measures the layout with a script');
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
    const card = page.locator('#publication-nl');
    await card.getByRole('button', { name: nl ? 'Publiceren (nl)' : 'Publish (nl)' }).click();
    await card.locator('details > summary').click();
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
// seeded page (`e2e-blokken-<project>`, scripts/e2e/e2e.mjs) with the first example of every type, so
// the bulk fixture is seeded once and not made here (the audit log the status part of admin.spec.ts reads).
test.describe('content-blocks', () => {
  test.use({ locale: 'nl-NL' });

  /** The seeded page of this project, by slug over the HTTP API. */
  async function seededPage(request: APIRequestContext): Promise<string> {
    const slug = `e2e-blokken-${test.info().project.name}`;
    const { items } = await callApi<{ items: { id: string }[] }>(request, 'content.item.list', {
      type: 'page',
      slug,
    });
    expect(items, `${slug} is seeded by scripts/e2e/e2e.mjs`).toHaveLength(1);
    return `/admin/probe/content/${items[0]!.id}`;
  }

  /** The card of block `n` (1-based): its head holds the block's actions (#66 PR 3). */
  const card = (page: Page, n: number): Locator => page.locator('section.ui-block-card').nth(n - 1);

  /** Block `n` (1-based) of the edit page, opened. */
  async function block(page: Page, n: number): Promise<Locator> {
    const details = page.locator('details.block').nth(n - 1);
    if ((await details.getAttribute('open')) === null)
      await details.locator(':scope > summary').click();
    return details;
  }

  /** Save the one edit form after editing block `n` (#66 PR 2: one form, one save). */
  async function save(page: Page, n: number) {
    await block(page, n);
    await page.getByRole('button', { name: 'Opslaan', exact: true }).click();
    await expect(page).toHaveURL(/\?saved/);
    await expect(page.getByRole('status')).toContainText('Opgeslagen als nieuwe revisie');
  }

  test('every block type is edited once through its form, without JavaScript', async ({
    page,
    request,
  }) => {
    requireApi();
    const edit = await seededPage(request);
    await login(page, edit);
    const stamp = String(Date.now());
    await expect(page.locator('.ui-block-card-title')).toHaveText([
      '1. Kop',
      '2. Inschrijfformulier (oud)',
      '3. Tekst',
      '4. Betaalmuur',
      '5. Afbeelding',
      '6. Opening',
      '7. Oproep',
      '8. Kader',
      '9. Vragen en antwoorden',
      '10. Citaat',
      '11. Video',
      '12. Formulier',
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
    const preview = await page.locator('a[data-preview-link="nl"]').getAttribute('href');
    await page.goto(preview!);
    await expect(page.locator('main strong', { hasText: 'tekst' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'een link' })).toHaveAttribute('href', /\/over$/);
    await expect(page.locator('main .faq.width-wide')).toContainText(`Wat? ${stamp}`);
    await page.goto(edit);
    if (isA11y()) {
      await page.getByRole('button', { name: 'Voorbeeld', exact: true }).click();
      await expect(
        page.frameLocator('iframe[data-live-preview-frame]').locator('.faq.width-wide')
      ).toBeVisible();
      // Closed again, the side column with the publish button comes back.
      await page.getByRole('button', { name: 'Voorbeeld', exact: true }).click();
    }
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

  /**
   * Choose a block of `type` at the end, or before or after block `n`: it shows empty at its
   * place in the same form (#66 PR 2) and is stored with the next save. Returns that card.
   */
  async function insert(page: Page, type: string, place: 'end' | 'before' | 'after', n?: number) {
    // The "+" above each card (#66 PR 3); after the last card that is the one at the end.
    const above = n && (place === 'before' ? n : n + 1);
    const folds = page.locator('details.ui-block-insert');
    if (above && above <= (await folds.count())) {
      const fold = folds.nth(above - 1);
      await fold.locator('summary').click();
      await fold.getByLabel('Soort').selectOption({ label: type });
      await fold.getByRole('button', { name: 'Hier invoegen' }).click();
    } else {
      await page.locator('#insert-type-end').selectOption({ label: type });
      await page.getByRole('button', { name: 'Toevoegen', exact: true }).click();
    }
    const fresh = page.locator('#block-new');
    await expect(fresh.getByRole('heading')).toHaveText(`Nieuw blok: ${type}`);
    return fresh;
  }

  /** Store the chosen block with everything else in the form. */
  async function add(page: Page) {
    await page.getByRole('button', { name: 'Toevoegen en opslaan' }).click();
  }

  test('a block is inserted, moved and removed in place, without losing what was typed', async ({
    page,
  }) => {
    await login(page, '/admin/probe');
    const edit = await newPage(page, 'ops');
    await expect(page.getByText('Dit item heeft nog geen blokken.')).toBeVisible();

    let fresh = await insert(page, 'Kop', 'end');
    await expect(page).toHaveURL(new RegExp(`${edit}\\?insert=heading&place=end#block-new$`));
    await expectNoAxeViolations(page);
    // Nothing typed: core refuses, the issue links to its field, the block stays at its place.
    await add(page);
    const summary = page.getByRole('alert');
    await expect(summary).toContainText('Het blok kon niet worden opgeslagen');
    await expect(summary.getByRole('link', { name: 'Tekst' })).toBeVisible();
    fresh = page.locator('#block-new');
    await fresh.getByLabel('Tekst (nl)').fill('Eerste kop');
    await fresh.getByLabel('Tekst (en)').fill('First heading');
    await add(page);
    await expect(page).toHaveURL(/\?saved&block=/);
    await expect(page.getByRole('status')).toContainText('Opgeslagen als nieuwe revisie');

    fresh = await insert(page, 'Tekst', 'before', 1);
    await fresh.getByLabel('Tekst (nl)').fill('Een [open link](https://example.org');
    await add(page);
    await expect(page.getByRole('alert')).toContainText('een link is niet afgesloten met )');
    fresh = page.locator('#block-new');
    await expect(fresh.getByLabel('Tekst (nl)')).toHaveValue('Een [open link](https://example.org');
    await fresh.getByLabel('Tekst (nl)').fill('Een _schuine_ inleiding.');
    await fresh.getByLabel('Tekst (en)').fill('An _italic_ introduction.');
    await add(page);
    await expect(page.getByRole('status')).toContainText('Opgeslagen als nieuwe revisie');
    const summaries = page.locator('.ui-block-card-title');
    await expect(summaries).toHaveText(['1. Tekst', '2. Kop']);
    await expect(page.locator('details.block > summary')).toHaveText([
      'Een schuine inleiding.',
      'Eerste kop',
    ]);

    // A block action saves what was typed elsewhere first (brief edit-screen § 1 point 4).
    await page.locator('#title\\.nl').fill('Blokkenproef bewaard');
    await card(page, 2).getByRole('button', { name: 'Omhoog' }).click();
    await expect(page.getByRole('status')).toContainText('Blok verplaatst.');
    await expect(summaries).toHaveText(['1. Kop', '2. Tekst']);
    await expect(page.locator('#title\\.nl')).toHaveValue('Blokkenproef bewaard');
    await expectNoAxeViolations(page);

    // A chosen block that is not wanted after all: the rest of the form is still saved.
    fresh = await insert(page, 'Citaat', 'end');
    await page.locator('#title\\.nl').fill('Blokkenproef zonder citaat');
    await fresh.getByRole('button', { name: 'Niet toevoegen' }).click();
    await expect(page.locator('#block-new')).toHaveCount(0);
    await expect(summaries).toHaveCount(2);
    await expect(page.locator('#title\\.nl')).toHaveValue('Blokkenproef zonder citaat');

    const first = card(page, 1);
    await first.locator('details.ui-confirm > summary').click();
    await expect(first).toContainText('Blok 1 verdwijnt');
    await expectNoAxeViolations(page);
    await first.getByRole('button', { name: 'Ja, verwijder dit blok' }).click();
    await expect(page).toHaveURL(new RegExp(`${edit}\\?done=blockRemoved`));
    await expect(page.getByRole('status')).toContainText('Blok verwijderd.');
    await expect(summaries).toHaveText(['1. Tekst']);
  });

  test('a block is duplicated right after itself, with its fields and a new id', async ({
    page,
  }) => {
    await login(page, '/admin/probe');
    const edit = await newPage(page, 'dup');
    const fresh = await insert(page, 'Kop', 'end');
    await fresh.getByLabel('Tekst (nl)').fill('Twee keer');
    await fresh.getByLabel('Tekst (en)').fill('Twice');
    await add(page);
    const original = await page.locator('details.block').first().getAttribute('id');
    // What was typed elsewhere is saved first, as with every block action.
    await page.locator('#title\\.nl').fill('Blokkenproef gedupliceerd');
    await card(page, 1).getByRole('button', { name: 'Dupliceren' }).click();
    await expect(page.getByRole('status')).toContainText('Blok gedupliceerd.');
    await expect(page.locator('#title\\.nl')).toHaveValue('Blokkenproef gedupliceerd');
    await expect(page.locator('.ui-block-card-title')).toHaveText(['1. Kop', '2. Kop']);
    const copy = page.locator('details.block').nth(1);
    await expect(copy).not.toHaveAttribute('id', original!);
    // The screen lands on the copy, open, with the same fields in both locales.
    await expect(page).toHaveURL(new RegExp(`${edit}\\?done=blockDuplicated&block=.+#block-`));
    await expect(copy).toHaveAttribute('open', '');
    await expect(copy.getByLabel('Tekst (en)')).toHaveValue('Twice');
    // A text block cannot stand next to its copy: it offers no duplicate.
    await insert(page, 'Tekst', 'end');
    await page.locator('#block-new').getByLabel('Tekst (nl)').fill('Los');
    await page.locator('#block-new').getByLabel('Tekst (en)').fill('Loose');
    await add(page);
    await expect(card(page, 3).getByRole('button', { name: 'Dupliceren' })).toHaveCount(0);
    await expectNoAxeViolations(page);
  });

  test('FAQ v2 inserts, moves and publishes through native forms in both locales', async ({
    page,
  }) => {
    await login(page, '/admin/probe');
    const edit = await newPage(page, 'faq-width');
    let fresh = await insert(page, 'Kop', 'end');
    await fresh.getByLabel('Tekst (nl)').fill('Vooraf');
    await fresh.getByLabel('Tekst (en)').fill('Before');
    await add(page);
    fresh = await insert(page, 'Vragen en antwoorden', 'after', 1);
    await fresh.getByLabel('Variant').selectOption('accordion');
    await fresh.getByLabel('Breedte').selectOption('full');
    await fresh.getByLabel('Vraag (nl)').first().fill('Waarom is dit belangrijk?');
    await fresh.getByLabel('Vraag (en)').first().fill('Why does this matter?');
    await fresh.getByLabel('Antwoord (nl)').first().fill('Omdat iedereen kan meedoen.');
    await fresh.getByLabel('Antwoord (en)').first().fill('Because everyone can take part.');
    await add(page);
    await expect(page.getByRole('status')).toContainText('Opgeslagen als nieuwe revisie');
    const id = await page.locator('details.block').nth(1).getAttribute('id');
    await card(page, 2).getByRole('button', { name: 'Omhoog' }).click();
    await expect(page.locator('details.block').first()).toHaveAttribute('id', id!);
    await page.reload();
    await expect((await block(page, 1)).getByLabel('Breedte')).toHaveValue('full');
    await expect((await block(page, 1)).getByLabel('Vraag (en)').first()).toHaveValue(
      'Why does this matter?'
    );
    for (const locale of ['nl', 'en']) {
      const preview = await page.locator(`a[data-preview-link="${locale}"]`).getAttribute('href');
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
    onlyA11y('the enhanced writer requires JavaScript');
    requireApi();
    const source = await callApi(request, 'content.item.list', {
      type: 'article',
      slug: 'quality-article-v3',
    });
    expect(source.items).toHaveLength(1);
    const fetched = await callApi(request, 'content.item.get', { itemId: source.items[0].id });
    const prose = fetched.revision.document.blocks.find(
      (entry: { type: string }) => entry.type === 'rich-text'
    );
    expect(prose).toBeTruthy();
    const document = {
      ...fetched.revision.document,
      title: { nl: 'Schrijfproef', en: 'Writer proof' },
      blocks: [prose],
    };
    const created = await callApi(request, 'content.item.create', {
      slug: `faq-writer-${Date.now()}`,
      document,
    });
    const edit = `/admin/probe/content/${created.item.id}`;
    await login(page, `${edit}/write`);
    await page.getByRole('link', { name: 'Kaart invoegen' }).click();
    await expect(page).toHaveURL(new RegExp(`${edit}#insert-type-end$`));
    const fresh = await insert(page, 'Vragen en antwoorden', 'end');
    await fresh.getByLabel('Variant').selectOption('accordion');
    await fresh.getByLabel('Breedte').selectOption('wide');
    await fresh.getByLabel('Titel (nl)').fill('Schrijfvragen');
    await fresh.getByLabel('Titel (en)').fill('Writing questions');
    await fresh.getByLabel('Vraag (nl)').first().fill('Blijft dit bewaard?');
    await fresh.getByLabel('Vraag (en)').first().fill('Does this survive?');
    await fresh.getByLabel('Antwoord (nl)').first().fill('Ja, in beide talen.');
    await fresh.getByLabel('Antwoord (en)').first().fill('Yes, in both languages.');
    await add(page);
    const faqId = await page.locator('details.block').nth(1).getAttribute('id');
    await card(page, 2).getByRole('button', { name: 'Omhoog' }).click();
    await expect(page.locator('details.block').first()).toHaveAttribute('id', faqId!);
    await card(page, 1).getByRole('button', { name: 'Omlaag' }).click();
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
    const preview = await page.locator('a[data-preview-link="en"]').getAttribute('href');
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
        onlyA11y('measures the layout with a script');
        const edit = await seededPage(request);
        await login(page, edit);
        // Every block open with its insert and remove folds: all actions of the one form.
        await page.evaluate(() =>
          document.querySelectorAll('details').forEach((d) => (d.open = true))
        );
        await setTextSize(page, text);
        await layoutGate(page, edit);
        // The block with the most fields, chosen but not stored, at its place.
        await page.goto(edit);
        await insert(page, 'Opening', 'after', 7);
        await setTextSize(page, text);
        await layoutGate(page, 'new hero');
      });
  });
});

// The enhanced article view and native block forms save the same core document. The browser
// proof covers autosave, axe and the action layout at 320 CSS px with 200% text; the no-JS
// project proves the adjacent form can write the same prose without hydrating the editor.
test.describe('article-writing', () => {
  async function article(request: APIRequestContext) {
    const slug = `writer-${test.info().project.name}-${Date.now()}`;
    const { item } = await callApi<{ item: { id: string } }>(request, 'content.item.create', {
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
                  content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Oude tekst' }] }],
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
    });
    return `/admin/probe/content/${item.id}`;
  }

  test('article prose saves through the native form or the enhanced editor', async ({
    page,
    request,
  }) => {
    requireApi();
    const edit = await article(request);
    await login(page, edit);
    if (!isA11y()) {
      const prose = page.locator('details.block').first();
      await prose.locator(':scope > summary').click();
      await prose.getByLabel(/^(Text|Tekst) \(nl\)$/).fill('Nieuwe tekst');
      await page.getByRole('button', { name: /^(Save|Opslaan)$/ }).click();
      await expect(page).toHaveURL(/\?saved&block=/);
      await expect(page.locator(`a[href="${edit}/write"]`)).toBeVisible();
    } else {
      const consoleErrors: string[] = [];
      page.on('console', (message) => {
        if (message.type() === 'error') consoleErrors.push(message.text());
      });
      await page.addInitScript(() => {
        window.writerCspViolations = [];
        window.addEventListener('securitypolicyviolation', (event) => {
          window.writerCspViolations.push(`${event.violatedDirective}: ${event.blockedURI}`);
        });
      });
      await page.locator(`a[href="${edit}/write"]`).click();
      const writing = page.locator('.writing-surface .ProseMirror');
      await expect(writing).toBeVisible();
      await writing.locator('p').first().fill('Nieuwe tekst');
      await expect(page.getByRole('status')).toContainText('Alle wijzigingen opgeslagen');
      expect(await page.evaluate(() => window.writerCspViolations)).toEqual([]);
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
    onlyA11y();
    requireApi();
    const edit = await article(request);
    await login(page, `${edit}/write`);
    // login() returns once the URL is the writer's, which can be before its markup is parsed;
    // measuring then finds no toolbar at all (flake on main, run 41097277041).
    await expect(page.getByRole('toolbar')).toBeVisible();
    await page.setViewportSize(NARROW);
    await setTextSize(page, '200%');
    await layoutGate(page, 'writer actions', '.writer-actions');
  });

  test('pasted blockquote becomes a structured quote card after attribution', async ({
    page,
    request,
  }) => {
    onlyA11y();
    requireApi();
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
    await expect(page.locator('.ui-block-card-title').nth(1)).toContainText(/Quote|Citaat/);
  });

  test('autosave reports a newer revision and preserves its unrelated fields on retry', async ({
    page,
    request,
  }) => {
    onlyA11y();
    requireApi();
    const edit = await article(request);
    const itemId = edit.split('/').at(-1)!;
    await login(page, `${edit}/write`);
    const { revision } = await callApi<{
      revision: { id: string; document: Record<string, unknown> };
    }>(request, 'content.item.get', { itemId });
    await callApi(request, 'content.item.update', {
      itemId,
      baseRevisionId: revision.id,
      document: {
        ...revision.document,
        title: { nl: 'Nieuwe kop van collega', en: 'An article' },
      },
    });
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
    onlyA11y();
    requireApi();
    const { items } = await callApi<{ items: { id: string }[] }>(request, 'content.item.list', {
      type: 'page',
      slug: 'e2e-blokken-a11y',
    });
    const { revision } = await callApi<{
      revision: { document: { blocks: { type: string; props: { mediaId?: string } }[] } };
    }>(request, 'content.item.get', { itemId: items[0]!.id });
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
    // The card's image comes from the shared media picker, not a typed id (brief media-picker).
    // The grid holds the newest hundred; this spec's other tests upload more, so search by name.
    const { filename } = await callApi<{ filename: string }>(request, 'media.get', { id: mediaId });
    await page.getByRole('button', { name: 'Beeld kiezen' }).click();
    const picker = page.getByRole('dialog', { name: 'Afbeelding' });
    await picker.getByLabel('Zoeken op naam of bijschrift').fill(filename);
    // A click, not check(): the hydrated picker then renders the choice as its own radio of the
    // same value, which unchecks the script's search result.
    await picker.locator(`input[type="radio"][value="${mediaId}"]`).click();
    await expect(page.locator('[data-picker-name]').first()).toHaveText(filename);
    await picker.getByRole('button', { name: 'Klaar' }).click();
    await expect(page.getByRole('button', { name: 'Ander beeld kiezen' })).toBeVisible();
    await expect(page.getByLabel('Alternatieve tekst')).toHaveValue('Een boom');
    await page.getByRole('button', { name: 'Kaart toevoegen' }).click();
    await expect(page.getByRole('status')).toContainText('Alle wijzigingen opgeslagen');
    await page.goto(edit);
    await expect(page.locator('details.block')).toHaveCount(2);
    await expect(page.locator('.ui-block-card-title').nth(1)).toContainText(/Image|Afbeelding/);
  });

  test('TipTap saves headings, lists, links and notes without changing stored structure', async ({
    page,
    request,
  }) => {
    onlyA11y();
    requireApi();
    const edit = await article(request);
    const itemId = edit.split('/').at(-1)!;
    const { revision } = await callApi<{ revision: { id: string; document: any } }>(
      request,
      'content.item.get',
      { itemId }
    );
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
    await callApi(request, 'content.item.update', {
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
    });
    await login(page, `${edit}/write`);
    await page.getByRole('button', { name: 'Nu opslaan' }).click();
    await expect(page.getByRole('status')).toContainText('Alle wijzigingen opgeslagen');
    const { revision: latest } = await callApi<{ revision: { document: any } }>(
      request,
      'content.item.get',
      { itemId }
    );
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
        const { revision: current } = await callApi<{ revision: { document: any } }>(
          request,
          'content.item.get',
          { itemId }
        );
        return current.document.blocks[0].props.content.nl.content[4].content[0].content[0].content
          .map((part: { text: string }) => part.text)
          .join('');
      })
      .toBe('Eerste punt aangevuld');
    await expect(page.getByRole('status')).toContainText('Alle wijzigingen opgeslagen');
    const { revision: afterEdit } = await callApi<{ revision: { document: any } }>(
      request,
      'content.item.get',
      { itemId }
    );
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
