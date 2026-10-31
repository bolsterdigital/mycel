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
import { NARROW, TEXT_SIZES, layoutGate, setTextSize, setTextSpacing } from './lib/layout';
import { ADMIN, login } from './lib/login';
import { isA11y, onlyA11y } from './lib/project';
import { callApi, postUseCase, requireApi } from './lib/api';
import { expectPixels } from './lib/images';

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

  test('new content opens a draft immediately and chooses a pattern in the empty column', async ({
    page,
    request,
  }) => {
    const pattern = await callApi(request, 'content.pattern.create', {
      name: { nl: `Start ${Date.now()}` },
      intendedType: 'page',
      blocks: [
        {
          type: 'heading',
          version: 1,
          props: { text: { nl: 'Patrooninhoud', en: 'Pattern content' } },
        },
      ],
    });
    await login(page, '/admin/probe/content?type=page');
    await page.getByRole('button', { name: 'Nieuwe pagina' }).click();
    await expect(page).toHaveURL(/\/content\/[0-9a-f-]{36}$/);
    const itemId = new URL(page.url()).pathname.split('/').at(-1)!;
    const initial = await callApi(request, 'content.item.get', { itemId });
    expect(initial.revision.document.title).toEqual({ nl: '(geen titel)' });
    expect(initial.revision.document.blocks).toEqual([]);
    // A programmatic select-all during hydration can append instead of replace (Notities, #66
    // PR 6); wait for the screen script like the other editor tests do.
    if (isA11y())
      await expect(page.locator('form#item-edit')).toHaveAttribute('data-edit-screen', '');
    await page.locator('#title\\.nl').fill('Meteen in het document');
    await page.getByLabel('Begin met een patroon').selectOption(pattern.id);
    await page.getByRole('button', { name: 'Begin met een patroon', exact: true }).click();
    await expect(page).toHaveURL(/#blocks$/);
    const saved = await callApi(request, 'content.item.get', { itemId });
    expect(saved.revision.document.title.nl).toBe('Meteen in het document');
    expect(saved.revision.document.blocks[0].id).not.toBe(pattern.blocks[0].id);
    expect(saved.revision.document.blocks[0].props).toEqual(pattern.blocks[0].props);
    expect(saved.item.publication.every((p: { status: string }) => p.status === 'draft')).toBe(
      true
    );
    await expect(page.getByLabel('Begin met een patroon')).toHaveCount(0);
    await expectNoAxeViolations(page);
  });

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

    await page.getByRole('button', { name: 'Nieuwe pagina' }).click();
    await expectNoAxeViolations(page);
    const slug = slugFor('edit');
    const edit = await newPage(page, slug, 'Over de buurt');
    await expect(page.getByRole('heading', { level: 1, name: 'Pagina bewerken' })).toBeVisible();
    await expect(page.locator('#title\\.nl')).toHaveValue('Over de buurt');
    await expect(page.locator('#publication-nl')).toContainText('Concept');
    await expectNoAxeViolations(page);

    await page.locator('#title\\.nl').fill('Over onze buurt');
    // Search settings are a tab away with JavaScript, folded away without (skill
    // cms-inrichting); the tab opens its one fold itself (#66 PR 3).
    if (isA11y()) await page.getByRole('tab', { name: 'Zoeken en delen' }).click();
    else await page.locator('summary', { hasText: 'Zoeken en delen' }).click();
    await page.getByLabel('Titel in zoekresultaten').fill('De buurt');
    await page.getByRole('button', { name: 'Opslaan' }).click();
    await expect(page).toHaveURL(`${edit}?saved`);
    await expect(page.getByRole('status')).toContainText('Opgeslagen als nieuwe revisie');
    await expect(page.locator('#title\\.nl')).toHaveValue('Over onze buurt');

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

    // In the list: the new page, a draft in the content locale; English as a code without a dot,
    // as its translation is complete (#66 PR 4).
    await page.goto('/admin/probe/content?type=page');
    const card = page.locator('#content-table tbody tr', { hasText: `/${slug}` });
    await expect(card.locator('.ui-badge')).toHaveText('concept');
    await expect(card.locator('.ui-locale-codes')).toHaveText('en');
  });

  test('the preview shows a draft that the site does not serve', async ({ page, request }) => {
    await login(page, '/admin/probe');
    const slug = slugFor('preview');
    const edit = await newPage(page, slug, 'Nog geheim');

    // With JavaScript the bar's preview links give way to the toggle (#66 PR 3): the hook finds
    // them either way. The bar previews the locale the screen shows (#66 PR 4).
    await page.goto(`${edit}?locale=en`);
    const link = page.locator('a[data-preview-link="en"]');
    await expect(link).toHaveAttribute('target', '_blank');
    const href = (await link.getAttribute('href'))!;
    const response = await page.goto(href);
    expect(response!.status()).toBe(200);
    expect(response!.headers()['cache-control']).toBe('private, no-store');
    expect(response!.headers()['x-robots-tag']).toBe('noindex');
    await expect(page.getByRole('heading', { level: 1, name: 'Nog geheim (en)' })).toBeVisible();
    // It says which version it is (#66 PR 6d): the saved draft, not what visitors see.
    await expect(page.getByRole('heading', { level: 2, name: 'Voorbeeld: Concept' })).toBeVisible();
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
    await expect(page.getByLabel('Titel in overzichten')).toBeVisible();
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
    await expect(page.getByLabel('Titel in zoekresultaten')).toBeVisible();
    await expect(page.locator('#title\\.nl')).toBeHidden();
    await page.keyboard.press('End');
    await expect(page.getByRole('tabpanel', { name: 'Instellingen' })).toBeVisible();
    await page.keyboard.press('ArrowRight');
    await expect(page.getByRole('tabpanel', { name: 'Inhoud' })).toBeVisible();
    // The chosen tab is the hash: a reload comes back on it, and it is the same form.
    await list.getByRole('tab', { name: 'Zoeken en delen' }).click();
    await expect(page).toHaveURL(`${edit}#item-tabs-findability`);
    await page.getByLabel('Titel in zoekresultaten').fill('Getabd');
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
    await page.getByLabel('Tekst', { exact: true }).fill('Saved heading');
    await page.getByRole('button', { name: 'Toevoegen en opslaan' }).click();
    await expect(page).toHaveURL(/\?saved&block=/);

    // Closed by default (#66 PR 3): the eye in the bar takes the place of the saved-preview links,
    // which move into the preview itself.
    const toggle = page.getByRole('button', { name: 'Voorbeeld', exact: true });
    const panel = page.locator('[data-live-preview]');
    const side = page.locator('.ui-edit-side');
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await expect(panel).toBeHidden();
    await expect(page.locator('.ui-item-bar a[data-preview-link]')).toHaveCount(1);
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
      panel.getByRole('link', { name: 'Opgeslagen versie in nieuw tabblad' })
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

    await page.locator('#title\\.nl').fill('Unsaved title');
    await expect(frame.getByRole('heading', { level: 1, name: 'Unsaved title' })).toBeVisible();
    await frame.getByRole('heading', { name: 'Saved heading' }).click();
    const details = page.locator('details.block').first();
    await expect(details).toHaveAttribute('open', '');
    await expect(details.locator(':scope > summary')).toBeFocused();
    await details.getByLabel('Tekst', { exact: true }).fill('Unsaved heading');
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
    await expect(page.locator('#title\\.nl')).toHaveValue('Saved title');
    await expect(page.locator('[data-block-rest]').first()).toContainText('Saved heading');
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
    await page.locator('#title\\.nl').fill('Mijn versie');
    // The stale tab asks for a new address too: it moves nothing until the conflict is resolved.
    const side = page.locator('section[aria-labelledby="this-item"]');
    await side.locator('details', { hasText: 'Adres wijzigen' }).locator('summary').click();
    const moved = slugFor('conflict-moved');
    await side.getByLabel('Slug').fill(moved);
    await other.locator('#title\\.nl').fill('Hun versie');
    await other.getByRole('button', { name: 'Opslaan' }).click();
    await expect(other).toHaveURL(`${edit}?saved`);
    await context.close();

    await page.getByRole('button', { name: 'Opslaan' }).click();
    const alert = page.getByRole('alert');
    await expect(alert).toContainText('Iemand anders heeft dit item intussen opgeslagen');
    await expect(alert).toContainText(ADMIN);
    await expect(alert.getByRole('row', { name: /title\.nl/ })).toContainText('Hun versie');
    await expect(page.locator('#title\\.nl')).toHaveValue('Mijn versie');
    await expect(side.getByLabel('Slug')).toHaveValue(moved);
    await expect(side).not.toContainText(`/${moved}`);
    await expectNoAxeViolations(page);

    // Saving again is a deliberate choice on top of the newest revision, the address with it.
    await page.getByRole('button', { name: 'Opslaan' }).click();
    await expect(page).toHaveURL(`${edit}?saved`);
    await expect(page.locator('#title\\.nl')).toHaveValue('Mijn versie');
    await expect(side).toContainText(`/${moved}`);
  });

  // The #207 review's gap: a tab that never touched the address posts the slug it was rendered
  // with; comparing that with the item read it as a request to move the address back.
  test("a stale tab's title save keeps the address another tab gave the draft", async ({
    page,
    browser,
  }) => {
    await login(page, '/admin/probe');
    const edit = await newPage(page, slugFor('stale-from'), 'Oud tabblad');
    const side = page.locator('section[aria-labelledby="this-item"]');

    // Tab B moves the address and saves; tab A still shows the old one.
    const context = await freshContext(browser);
    const other = await context.newPage();
    await login(other, edit);
    const moved = slugFor('stale-to');
    const theirs = other.locator('section[aria-labelledby="this-item"]');
    await theirs.locator('details', { hasText: 'Adres wijzigen' }).locator('summary').click();
    await theirs.getByLabel('Slug').fill(moved);
    await other.getByRole('button', { name: 'Opslaan' }).click();
    await expect(other).toHaveURL(`${edit}?saved`);
    await expect(theirs).toContainText(`/${moved}`);
    await context.close();

    // Tab A saves a title: a conflict that names the address, and A's field now shows B's.
    await page.locator('#title\\.nl').fill('Nieuwe titel');
    await page.getByRole('button', { name: 'Opslaan' }).click();
    const alert = page.getByRole('alert');
    await expect(alert).toContainText('Iemand anders heeft dit item intussen opgeslagen');
    await expect(alert).not.toContainText('Geen verschillen');
    await expect(alert.getByRole('row', { name: /^slug/ })).toContainText(moved);
    await expect(side.getByLabel('Slug')).toHaveValue(moved);

    // Saving again keeps B's address and A's title.
    await page.getByRole('button', { name: 'Opslaan' }).click();
    await expect(page).toHaveURL(`${edit}?saved`);
    await expect(page.locator('#title\\.nl')).toHaveValue('Nieuwe titel');
    await expect(side).toContainText(`/${moved}`);
  });

  // The #208 review's F2: the address moves in its own transaction before the revision, so a
  // revision core refuses after a move leaves the address moved. The form that comes back must
  // then be based on the new address, or moving it back reads as "unchanged" and is ignored.
  test('a refused save after a moved address comes back on the new address', async ({ page }) => {
    // The refusal is the server's; the folded sections without JavaScript add nothing here.
    onlyA11y('the tabs show the canonical field in one click');
    await login(page, '/admin/probe');
    const from = slugFor('refused-from');
    const edit = await newPage(page, from, 'Geweigerd');
    const side = page.locator('section[aria-labelledby="this-item"]');
    await side.locator('details', { hasText: 'Adres wijzigen' }).locator('summary').click();
    const moved = slugFor('refused-to');
    await side.getByLabel('Slug').fill(moved);
    await page.getByRole('tab', { name: 'Zoeken en delen' }).click();
    await page.locator('[name="canonical"]').fill('geen url');
    await page.getByRole('button', { name: 'Opslaan', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText(
      'Het canonieke adres moet beginnen met https://'
    );
    await expect(side).toContainText(`/${moved}`);
    await expect(page.locator('[name="baseSlug"]')).toHaveValue(moved);

    // Moving it back is a change again, saved with the corrected field.
    await side.locator('details', { hasText: 'Adres wijzigen' }).locator('summary').click();
    await side.getByLabel('Slug').fill(from);
    await page.locator('[name="canonical"]').fill('');
    await page.getByRole('button', { name: 'Opslaan', exact: true }).click();
    await expect(page).toHaveURL(`${edit}?saved`);
    await expect(side).toContainText(`/${from}`);
  });

  /** A page of 24 blocks, heading and paragraph by turn, over the HTTP API (#66 PR 6d). */
  async function longPage(request: APIRequestContext): Promise<string> {
    const prose = (text: string) => ({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
    });
    const words = 'De buurt praat mee over elke straat, elk plein en elke boom die erbij komt. ';
    const blocks = Array.from({ length: 12 }, (_, i) => [
      {
        type: 'heading',
        version: 1,
        props: { text: { nl: `Hoofdstuk ${i + 1}`, en: `Chapter ${i + 1}` } },
      },
      {
        type: 'rich-text',
        version: 1,
        props: {
          content: { nl: prose(words.repeat(8)), en: prose(`Paragraph ${i + 1}.`) },
        },
      },
    ]).flat();
    const { item } = await callApi<{ item: { id: string } }>(request, 'content.item.create', {
      slug: slugFor('long'),
      document: {
        type: 'page',
        defaultLocale: 'nl',
        locales: ['nl', 'en'],
        title: { nl: 'Lange pagina', en: 'Long page' },
        blocks,
      },
    });
    return `/admin/probe/content/${item.id}`;
  }

  test('on a long page the open preview starts below the bar that stays in view', async ({
    page,
    request,
  }) => {
    onlyA11y('the sticky bar and the live preview need JavaScript');
    await ensureLiveAdmin();
    const edit = await longPage(request);
    await page.setViewportSize({ width: 1700, height: 900 });
    await login(page, edit, LIVE_ADMIN);
    await expect(page.locator('#item-edit')).toHaveAttribute('data-edit-screen', '');
    await page.getByRole('button', { name: 'Voorbeeld', exact: true }).click();
    const panel = page.locator('[data-live-preview]');
    await expect(panel).toBeVisible();
    // The #208 review's F1: scrolled, the sticky preview started 73px under the sticky bar.
    await page.evaluate(() => window.scrollTo(0, 1500));
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(1000);
    const bar = (await page.locator('.ui-item-bar').boundingBox())!;
    const beside = (await panel.boundingBox())!;
    expect(bar.y).toBeLessThanOrEqual(1);
    expect(beside.y).toBeGreaterThanOrEqual(bar.y + bar.height);
    expect(beside.y + beside.height).toBeLessThanOrEqual(900);
  });

  // The compact table of contents (#66 PR 6d): a long page is a fold of one line per card,
  // fragments that work without JavaScript and land below the bar that stays in view.
  test('a long page has a compact table of contents that leads to every card', async ({
    page,
    request,
  }) => {
    const edit = await longPage(request);
    await login(page, edit);
    const outline = page.getByRole('navigation', { name: 'Inhoudsopgave' });
    await expect(outline.locator('summary')).toHaveText('Inhoudsopgave 24 blokken');
    await outline.locator('summary').click();
    const links = outline.getByRole('link');
    await expect(links).toHaveCount(24);
    await expect(links.nth(14)).toHaveText(/^Kop\s+Hoofdstuk 8$/);
    await expect(links.nth(15)).toContainText('De buurt praat mee');
    await links.nth(14).click();
    await expect(page).toHaveURL(/#block-[0-9a-f-]{36}$/);
    const target = page.locator('details.block').nth(14);
    await expect(target).toBeInViewport();
    if (isA11y()) {
      const bar = (await page.locator('.ui-item-bar').boundingBox())!;
      expect((await target.boundingBox())!.y).toBeGreaterThanOrEqual(bar.y + bar.height);
    }
    await expectNoAxeViolations(page);
    await page.setViewportSize(NARROW);
    await setTextSize(page, '200%');
    await layoutGate(page, 'document outline', '.ui-outline');
    await outline.screenshot({ path: test.info().outputPath('outline-320-200.png') });
    // A short page has none: eight closed cards fit about two screens.
    const short = await newPage(page, slugFor('short'), 'Kort');
    await page.goto(short);
    await expect(page.getByRole('navigation', { name: 'Inhoudsopgave' })).toHaveCount(0);
  });

  // The labels on a preview (#66 PR 6d): the live preview says it shows what is typed now, and a
  // draft the server refuses leaves the last good image in view with a note that it is behind.
  test('a preview says what it shows, and a refused draft keeps the last image and says so', async ({
    page,
  }) => {
    onlyA11y('the live preview is a JavaScript enhancement');
    await ensureLiveAdmin();
    await login(page, '/admin/probe', LIVE_ADMIN);
    await newPage(page, slugFor('behind'), 'Eerste');
    await page.setViewportSize({ width: 1600, height: 900 });
    await page.getByRole('button', { name: 'Voorbeeld', exact: true }).click();
    const panel = page.locator('[data-live-preview]');
    const shows = panel.getByRole('status');
    const frame = page.frameLocator('[data-live-preview-frame]');
    await expect(frame.getByRole('heading', { level: 1, name: 'Eerste' })).toBeVisible();
    const current = shows.getByText('Actuele invoer');
    const behind = shows.getByText('Dit voorbeeld loopt achter');
    await expect(current).toBeVisible();
    await expect(behind).toBeHidden();
    await page.locator('#title\\.nl').fill('Tweede');
    await expect(frame.getByRole('heading', { level: 1, name: 'Tweede' })).toBeVisible();

    // A canonical address the document refuses: the preview cannot render this input.
    await page.getByRole('tab', { name: 'Zoeken en delen' }).click();
    await page.locator('[name="canonical"]').fill('geen url');
    await page.getByRole('tab', { name: 'Inhoud' }).click();
    await page.locator('#title\\.nl').fill('Derde');
    await expect(behind).toBeVisible();
    await expect(current).toBeHidden();
    await expect(frame.getByRole('heading', { level: 1, name: 'Tweede' })).toBeVisible();
    await expect(page.locator('iframe[data-live-preview-frame]')).toHaveCount(1);
    await expectNoAxeViolations(page);
    await panel.screenshot({ path: test.info().outputPath('preview-behind.png') });

    // Corrected: the preview catches up and says so.
    await page.getByRole('tab', { name: 'Zoeken en delen' }).click();
    await page.locator('[name="canonical"]').fill('');
    await expect(current).toBeVisible();
    await expect(behind).toBeHidden();
    await expect(frame.getByRole('heading', { level: 1, name: 'Derde' })).toBeVisible();
    await expect(page.locator('iframe[data-live-preview-frame]')).toBeVisible();
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
    const fold = card(page, locale).locator('details', { hasText: 'Inplannen' });
    if ((await fold.getAttribute('open')) === null) await fold.locator('summary').click();
    return fold;
  };

  // The address of a draft (#66 PR 6b): "This item" changes it until a locale goes live, with
  // the save of the one form; a taken slug comes back on the field with what was typed.
  test('the address of a draft changes with Save until the first publication', async ({
    page,
    request,
  }) => {
    await login(page, '/admin/probe');
    const taken = slugFor('slug-taken');
    await newPage(page, taken, 'Bezet');
    const edit = await newPage(page, slugFor('slug-from'), 'Verhuizing');
    const side = page.locator('section[aria-labelledby="this-item"]');
    const fold = side.locator('details', { hasText: 'Adres wijzigen' });
    await fold.locator('summary').click();
    const field = side.getByLabel('Slug');
    await expectNoAxeViolations(page);
    await page.setViewportSize(NARROW);
    await setTextSize(page, '200%');
    await layoutGate(page, 'address fold', 'section[aria-labelledby="this-item"]');
    await side.screenshot({ path: test.info().outputPath('address-fold-320-200.png') });
    // With wider text the ⓘ wraps under "Slug (verplicht)" and still starts at the edge.
    await setTextSpacing(page);
    await layoutGate(
      page,
      'address fold with WCAG text spacing',
      'section[aria-labelledby="this-item"]'
    );
    await setTextSize(page, '100%');
    await page.setViewportSize({ width: 1280, height: 900 });

    // Taken: nothing is saved, the field says why and keeps what was typed.
    await page.locator('#title\\.nl').fill('Verhuizing gepland');
    await field.fill(taken);
    await page.getByRole('button', { name: 'Opslaan', exact: true }).click();
    const alert = page.getByRole('alert');
    await expect(alert).toContainText('Dit kon niet worden opgeslagen.');
    await expect(alert.getByRole('link', { name: 'Slug' })).toHaveAttribute('href', '#slug');
    await expect(alert).toContainText('Er is al een item van deze soort met deze slug.');
    await expect(side.getByLabel('Slug')).toHaveValue(taken);
    await expect(side.getByLabel('Slug')).toHaveAttribute('aria-invalid', 'true');
    await expect(page.locator('#title\\.nl')).toHaveValue('Verhuizing gepland');
    await expectNoAxeViolations(page);

    const moved = slugFor('slug-to');
    await side.getByLabel('Slug').fill(moved);
    await page.getByRole('button', { name: 'Opslaan', exact: true }).click();
    await expect(page).toHaveURL(`${edit}?saved`);
    await expect(side).toContainText(`/${moved}`);
    await expect(page.locator('#title\\.nl')).toHaveValue('Verhuizing gepland');

    // The same use case over HTTP: a taken slug is a 409 Problem.
    const itemId = edit.split('/').at(-1)!;
    const conflict = await postUseCase(request, 'content.slug.update', { itemId, slug: taken });
    expect(conflict.status()).toBe(409);
    expect(await conflict.json()).toMatchObject({ code: 'conflict' });

    // Live once: the address stays, also over the API.
    await card(page, 'nl').getByRole('button', { name: 'Publiceren', exact: true }).click();
    await expect(page).toHaveURL(`${edit}?done=publish&locale=nl`);
    await expect(side.locator('details', { hasText: 'Adres wijzigen' })).toHaveCount(0);
    await expect(side).toContainText('Het adres ligt vast sinds de eerste publicatie');
    expect((await request.get(`${SITE}/${moved}`)).status()).toBe(200);
    const refused = await postUseCase(request, 'content.slug.update', {
      itemId,
      slug: slugFor('slug-late'),
    });
    expect(refused.status()).toBe(400);
    expect(await refused.json()).toMatchObject({
      issues: [{ path: 'slug', message: 'content.slug.published' }],
    });
  });

  test('publishing puts a locale live; a later edit stays unpublished until published', async ({
    page,
    request,
  }) => {
    await login(page, '/admin/probe');
    const slug = slugFor('publish');
    const edit = await newPage(page, slug, 'Buurtfeest');
    await expect(card(page, 'nl')).toContainText('Concept');
    await expect(card(page, 'nl').getByRole('list')).toHaveCount(0);
    await card(page, 'nl').getByRole('button', { name: 'Publiceren', exact: true }).click();
    await expect(page).toHaveURL(`${edit}?done=publish&locale=nl`);
    await expect(page.getByRole('status')).toContainText('Gepubliceerd in nl.');
    await expect(card(page, 'nl')).toContainText(/Gepubliceerd op \d+ \w+ \d{4}/);
    await expect(card(page, 'nl').getByRole('button', { name: /publiceren/i })).toHaveCount(0);
    await expect(card(page, 'nl').getByRole('link', { name: /Bekijk op de site/ })).toHaveAttribute(
      'href',
      new RegExp(`/${slug}$`)
    );
    await expectNoAxeViolations(page);
    expect((await request.get(`${SITE}/${slug}`)).status()).toBe(200);
    expect((await request.get(`${SITE}/en/${slug}`)).status()).toBe(404);
    // The saved preview of the published revision says it is the live one (#66 PR 6d).
    const preview = (await page.locator('a[data-preview-link="nl"]').first().getAttribute('href'))!;
    await page.goto(preview);
    await expect(page.getByRole('heading', { level: 2, name: 'Voorbeeld: Live' })).toBeVisible();
    await expect(page.locator('.preview-banner')).toContainText('De versie die bezoekers nu zien');
    await page.goto(edit);

    // A new revision: the site keeps the old title until it is published.
    await page.locator('#title\\.nl').fill('Buurtfeest verplaatst');
    await page.getByRole('button', { name: 'Opslaan' }).click();
    await expect(page).toHaveURL(`${edit}?saved`);
    await expect(card(page, 'nl')).toContainText('Gepubliceerd, sindsdien gewijzigd');
    await expect(
      card(page, 'nl').getByRole('button', { name: 'Wijzigingen publiceren', exact: true })
    ).toBeVisible();
    const live = await (await request.get(`${SITE}/${slug}`)).text();
    expect(live).toContain('Buurtfeest');
    expect(live).not.toContain('Buurtfeest verplaatst');
    await page.goto('/admin/probe/content?type=page');
    await expect(
      page.locator('#content-table tbody tr', { hasText: `/${slug}` }).locator('.ui-badge')
    ).toHaveText('gewijzigd');

    // Offline again: the address is gone, the card says it was live once.
    await page.goto(edit);
    await card(page, 'nl').getByRole('button', { name: 'Offline halen', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('Offline gehaald in nl.');
    await expect(card(page, 'nl')).toContainText('Offline gehaald');
    expect((await request.get(`${SITE}/${slug}`)).status()).toBe(404);
  });

  // One content locale at a time (#66 PR 4): the screen shows one locale, the bar's switch saves
  // and shows another, the choice holds for the lists too, and a save in one locale leaves the
  // other exactly as it was (the property in edit-form.locale.test.ts; here the real path).
  test('one locale at a time: a translation behind, switched, published, and the lists follow', async ({
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
    const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    // Only the Dutch fields; English is one line in the side column, behind.
    await expect(page.locator('[name="title.en"]')).toHaveCount(0);
    await expect(page.locator('.item-locales')).toContainText('vertaling loopt achter');
    const bar = page.locator('.ui-item-bar');
    const switchTo = (l: string) =>
      bar.getByRole('group', { name: 'Taal van de inhoud' }).getByRole('button', { name: l });
    await expect(switchTo('nl')).toHaveAttribute('aria-pressed', 'true');
    await expect(switchTo('en')).toHaveAccessibleName('en (vertaling loopt achter)');
    await expectNoAxeViolations(page);

    // The switch saves what was typed first, then shows English.
    await page.locator('#title\\.nl').fill(`${title}!`);
    await switchTo('en').click();
    await expect(page).toHaveURL(`${edit}?locale=en`);
    await expect(switchTo('en')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('[name="title.nl"]')).toHaveCount(0);
    const en = card(page, 'en');
    await expect(en).toContainText('Titel (en): de vertaling ontbreekt');
    await expect(en.getByRole('link', { name: 'Titel (en)' })).toHaveAttribute('href', '#title.en');
    await en.getByRole('button', { name: 'Publiceren', exact: true }).click();
    const alert = page.getByRole('alert');
    await expect(alert).toContainText('Dit kan in en nog niet:');
    await expect(alert).toContainText('Titel (en): de vertaling ontbreekt');

    // Typed but not saved: the publish button saves it first; Dutch stays as it was saved.
    await page.locator('#title\\.en').fill('Only Dutch, now English');
    await card(page, 'en').getByRole('button', { name: 'Publiceren', exact: true }).click();
    await expect(page).toHaveURL(`${edit}?done=publish&locale=en`);
    expect((await request.get(`${SITE}/en/${slug}`)).status()).toBe(200);
    await page.goto(`${edit}?locale=nl`);
    await expect(page.locator('#title\\.nl')).toHaveValue(`${title}!`);

    // The choice holds for the list: English titles and states, Dutch as a code.
    await page.goto('/admin/probe/content?type=page');
    const row = page.locator('#content-table tbody tr', { hasText: `/${slug}` });
    await expect(row.locator('th')).toHaveText('Only Dutch, now English');
    await expect(row.locator('.ui-badge')).toHaveText('gepubliceerd');
    await expect(row.locator('.ui-locale-codes')).toHaveText('nl');
    // The shell switches back; the list follows.
    await page
      .locator('.admin-content-locale')
      .getByRole('button', { name: 'nl', exact: true })
      .click();
    await expect(page).toHaveURL('/admin/probe/content?type=page');
    await expect(row.locator('th')).toHaveText(`${title}!`);
    await expect(row.locator('.ui-badge')).toHaveText('concept');
    await expectNoAxeViolations(page);
  });

  test('a locale the item lacks starts as a copy of another; the other stays as it is', async ({
    page,
  }) => {
    const title = `Begin vanuit nl ${slugFor('copy')}`;
    await login(page, '/admin/probe/content/new?type=page');
    await page.getByLabel('Titel (nl)').fill(title);
    await page.getByRole('checkbox', { name: 'en', exact: true }).uncheck();
    await page.getByRole('button', { name: 'Concept maken' }).click();
    await expect(page).toHaveURL(/\/admin\/probe\/content\/[0-9a-f-]{36}$/);
    const edit = new URL(page.url()).pathname;
    await page.locator('#lead\\.nl').fill('Een korte kern.');
    await page.getByRole('button', { name: 'Opslaan' }).click();
    await expect(page).toHaveURL(`${edit}?saved`);

    await page.goto(`${edit}?locale=en`);
    await expect(page.getByRole('heading', { name: 'Nog geen versie in en' })).toBeVisible();
    await expect(page.locator('[name^="title."]')).toHaveCount(0);
    await expectNoAxeViolations(page);
    // The new action group and the bar's switch whole at 320 CSS px and 200% text (UI gate).
    await page.setViewportSize(NARROW);
    await setTextSize(page, '200%');
    await layoutGate(page, 'start the translation', '#translate');
    await layoutGate(page, 'locale switch', '.ui-item-bar');
    await setTextSize(page, '100%');
    await page.locator('.ui-edit-side button[name="to"][value="nl"]').click();
    await expect(page).toHaveURL(`${edit}?locale=nl`);
    await expect(page.locator('#title\\.nl')).toHaveValue(title);
    await expect(page.locator('#lead\\.nl')).toHaveValue('Een korte kern.');
    await page.goto(`${edit}?locale=en`);
    await page.getByRole('button', { name: 'Begin vanuit nl' }).click();
    await expect(page).toHaveURL(`${edit}?saved&locale=en`);
    await expect(page.locator('#title\\.en')).toHaveValue(title);
    await expect(page.locator('#lead\\.en')).toHaveValue('Een korte kern.');
    await page.locator('#title\\.en').fill('Start from Dutch');
    await page.getByRole('button', { name: 'Opslaan' }).click();
    await page.goto(`${edit}?locale=nl`);
    await expect(page.locator('#title\\.nl')).toHaveValue(title);
    await expect(page.locator('#lead\\.nl')).toHaveValue('Een korte kern.');
  });

  test('a schedule pins a revision; a newer one can take its place', async ({ page }) => {
    await login(page, '/admin/probe');
    const edit = await newPage(page, slugFor('schedule'), 'Op vrijdag');
    const nl = card(page, 'nl');
    // Scheduling is folded away until asked for: no date field in view by default.
    await expect(nl.getByLabel('Publiceren op')).toBeHidden();
    await (await scheduleFold(page, 'nl')).getByLabel('Publiceren op').fill('2030-01-04T09:00');
    await nl.getByRole('button', { name: 'Inplannen', exact: true }).click();
    await expect(page).toHaveURL(`${edit}?done=schedule&locale=nl`);
    await expect(nl).toContainText('Ingepland voor 2030-01-04 09:00');

    // Edited after planning: the pin stays on the old revision until the editor moves it.
    await page.locator('#title\\.nl').fill('Op vrijdagochtend');
    await page.getByRole('button', { name: 'Opslaan' }).click();
    await expect(page).toHaveURL(`${edit}?saved`);
    await expect(nl).toContainText('Ingepland voor 2030-01-04 09:00');
    await expect(nl).toContainText('Je bewerkt een nieuwere revisie');
    await expectNoAxeViolations(page);
    await nl
      .getByRole('button', { name: 'Deze versie op dat moment publiceren', exact: true })
      .click();
    await expect(page).toHaveURL(`${edit}?done=repin&locale=nl`);
    await expect(nl).toContainText('Ingepland voor 2030-01-04 09:00');
    await expect(nl).not.toContainText('Je bewerkt een nieuwere revisie');

    // A time in the past is core's refusal, worded in the panel's terms.
    await (await scheduleFold(page, 'nl')).getByLabel('Publiceren op').fill('2020-01-01T09:00');
    await nl.getByRole('button', { name: 'Inplannen', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText(
      'Publiceren op: de tijd ligt niet in de toekomst'
    );

    await page.goto(edit);
    await nl.getByRole('button', { name: 'Planning intrekken', exact: true }).click();
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
        await page.locator('#title\\.nl').fill(`Updated ${label}`);
        await page.getByRole('button', { name: 'Opslaan' }).click();
        const newRevisionId = await page.locator('input[name="baseRevisionId"]').inputValue();
        expect(newRevisionId).not.toBe(oldRevisionId);
        await card(page, 'nl')
          .getByRole('button', { name: 'Deze versie op dat moment publiceren', exact: true })
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

  test.describe('session restore: input typed when the session expired comes back (#83)', () => {
    /** Expire the session in the browser, the way it ends: the cookie is gone. */
    const expire = async (page: Page) => {
      const context = page.context();
      const others = (await context.cookies()).filter((c) => c.name !== 'mycel_session');
      await context.clearCookies();
      await context.addCookies(others);
    };
    /** From the login page an admin post sent us to, through the mock IdP as `email`. */
    const loginAgain = async (page: Page, email = ADMIN) => {
      await page.locator('main a[href*="start=1"]').click();
      await page.getByLabel('E-mail').fill(email);
      await page.getByRole('button', { name: 'Sign in' }).click();
    };
    const title = (page: Page) => page.locator('input[name="title.nl"]');
    const saveState = (page: Page) => page.locator('[data-save-state]');
    const typeAndExpire = async (page: Page, edit: string, typed: string) => {
      await page.goto(edit);
      await expect(page.locator('form#item-edit')).toHaveAttribute('data-edit-screen', '');
      await title(page).fill(typed);
      await expect(page.locator('form#item-edit')).toHaveAttribute('data-has-unsaved', '');
      await expire(page);
      await page.locator('.ui-item-bar').getByRole('button', { name: 'Opslaan' }).click();
      await expect(page.locator('main')).toContainText('of je sessie is verlopen');
    };

    test('the same operator gets it back, unsaved, and can discard it', async ({ page }) => {
      onlyA11y('the restore needs JavaScript; without it the login page is the whole answer');
      await login(page, '/admin/probe');
      const edit = await newPage(page, slugFor('restore'), 'Herstel');
      await typeAndExpire(page, edit, 'Herstel na inloggen');
      await loginAgain(page);

      const notice = page.getByText('Niet-opgeslagen invoer van vóór het opnieuw inloggen');
      await expect(notice).toBeVisible();
      await expect(page).toHaveURL(new RegExp(`${edit}\\?`));
      await expect(title(page)).toHaveValue('Herstel na inloggen');
      await expect(saveState(page)).toHaveAttribute('data-current', 'done');
      await expect(saveState(page)).toContainText('Niet opgeslagen wijzigingen');
      await expectNoAxeViolations(page);

      // Nothing was saved, and Discard opens the stored item without asking to leave.
      await page.getByRole('link', { name: 'Weggooien' }).click();
      await expect(notice).toHaveCount(0);
      await expect(title(page)).toHaveValue('Herstel');
      // The record went with the restore: a reload brings nothing back.
      await page.reload();
      await expect(notice).toHaveCount(0);
    });

    test('saved after the restore, the input is the new revision', async ({ page }) => {
      onlyA11y('the restore needs JavaScript');
      await login(page, '/admin/probe');
      const edit = await newPage(page, slugFor('restore-save'), 'Herstel');
      await typeAndExpire(page, edit, 'Teruggezet en bewaard');
      await loginAgain(page);
      await expect(title(page)).toHaveValue('Teruggezet en bewaard');
      await page.locator('.ui-item-bar').getByRole('button', { name: 'Opslaan' }).click();
      await expect(page.getByRole('status').filter({ hasText: 'Opgeslagen' })).toBeVisible();
      await page.goto(edit);
      await expect(title(page)).toHaveValue('Teruggezet en bewaard');
    });

    test('someone saving in between makes it a conflict, with the input kept', async ({
      page,
      browser,
    }) => {
      onlyA11y('the restore needs JavaScript');
      await login(page, '/admin/probe');
      const edit = await newPage(page, slugFor('restore-conflict'), 'Herstel');
      const before = await page.locator('input[name="baseRevisionId"]').inputValue();
      await typeAndExpire(page, edit, 'Mijn versie');

      const other = await browser.newContext();
      const second = await other.newPage();
      await login(second, edit);
      await title(second).fill('Andermans versie');
      await second.locator('.ui-item-bar').getByRole('button', { name: 'Opslaan' }).click();
      await expect(second.getByRole('status').filter({ hasText: 'Opgeslagen' })).toBeVisible();
      const newest = await second.locator('input[name="baseRevisionId"]').inputValue();
      await other.close();
      expect(newest).not.toBe(before);

      await loginAgain(page);
      await expect(
        page.getByText('Iemand anders heeft dit item intussen opgeslagen')
      ).toBeVisible();
      await expect(
        page.getByText('Niet-opgeslagen invoer van vóór het opnieuw inloggen')
      ).toBeVisible();
      await expect(title(page)).toHaveValue('Mijn versie');
      // As after a conflict save: the form now carries the newest revision, saving is a choice.
      await expect(page.locator('input[name="baseRevisionId"]')).toHaveValue(newest);
    });

    test('someone without access to the site gets nothing back', async ({ page }) => {
      onlyA11y('the restore needs JavaScript');
      await login(page, '/admin/probe');
      const edit = await newPage(page, slugFor('restore-stranger'), 'Herstel');
      await typeAndExpire(page, edit, 'Niet voor vreemden');
      await loginAgain(page, `stranger-${Date.now()}@probe.test`);
      await expect(page.locator('input[name="title.nl"]')).toHaveCount(0);
      await expect(page.locator('main')).not.toContainText('Niet voor vreemden');
    });

    test('without JavaScript the login page says why and returns to the item', async ({ page }) => {
      test.skip(isA11y(), 'the no-js project shows the path without the restore');
      await login(page, '/admin/probe');
      const edit = await newPage(page, slugFor('restore-nojs'), 'Herstel');
      await title(page).fill('Zonder script');
      await expire(page);
      await page.locator('.ui-item-bar').getByRole('button', { name: 'Opslaan' }).click();
      await expect(page.locator('main')).toContainText('of je sessie is verlopen');
      await loginAgain(page);
      await expect(page).toHaveURL(new RegExp(`${edit}\\?/save$`));
      // No claim that the input survived: the post never reached the form action.
      await expect(title(page)).toHaveValue('Herstel');
    });
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
      await expect(page.getByRole('status')).toContainText('Uit het team verwijderd');
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
    await card.getByRole('button', { name: nl ? 'Publiceren' : 'Publish', exact: true }).click();
    await card.locator('details > summary').click();
    await card.locator('input[type="datetime-local"]').fill('2030-01-04T09:00');
    await card.getByRole('button', { name: nl ? 'Inplannen' : 'Schedule', exact: true }).click();
    await page.locator('#title\\.nl').fill('Poort 2');
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

  /** Block `n` (1-based) of the edit page, opened, with its Display and Source folds open. */
  async function block(page: Page, n: number): Promise<Locator> {
    const details = page.locator('details.block').nth(n - 1);
    if ((await details.getAttribute('open')) === null)
      await details.locator(':scope > summary').click();
    const closed = details.locator('details.ui-block-group:not([open])');
    while ((await closed.count()) > 0) await closed.first().locator(':scope > summary').click();
    return details;
  }

  /** Opens "More actions" of block `n` (MY-110 A) and returns its card. */
  async function more(page: Page, n: number): Promise<Locator> {
    const menu = card(page, n).locator('details.ui-block-card-more');
    if ((await menu.getAttribute('open')) === null) await menu.locator(':scope > summary').click();
    return card(page, n);
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
      [1, 'Tekst', `Kop ${stamp}`],
      [3, 'Tekst', `Nieuwe **tekst** met [een link](/over) ${stamp}`],
      [5, 'Beschrijving (alt-tekst)', `Een plein vol mensen ${stamp}`],
      [6, 'Titel', `Schone lucht ${stamp}`],
      [7, 'Titel', `Doe mee ${stamp}`],
      [8, 'Titel', `Let op ${stamp}`],
      [10, 'Naam', `Fatima ${stamp}`],
      [11, 'Titel', `Verslag ${stamp}`],
    ];
    // The first field of that name: a hero also has the title of its image's work, in the
    // credit fieldset further down.
    for (const [n, label, value] of edits) {
      const current = await block(page, n);
      if (n === 3 && isA11y()) {
        const surface = current.locator('.writing-surface .ProseMirror');
        await surface.locator('p').first().fill('');
        await surface.evaluate((element, source) => {
          const clipboardData = new DataTransfer();
          clipboardData.setData('text/plain', source);
          element.dispatchEvent(
            new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData })
          );
        }, value);
      } else await current.getByLabel(label, { exact: true }).first().fill(value);
      await save(page, n);
      await expect((await block(page, n)).getByLabel(label, { exact: true }).first()).toHaveValue(
        value
      );
    }
    // A list row, a choice, and the two blocks without editable text: saved through their forms.
    await (await block(page, 9)).getByLabel('Vraag', { exact: true }).first().fill(`Wat? ${stamp}`);
    await save(page, 9);
    await expect((await block(page, 9)).getByLabel('Vraag', { exact: true }).first()).toHaveValue(
      `Wat? ${stamp}`
    );
    await (await block(page, 9)).getByLabel('Breedte').selectOption('wide');
    await save(page, 9);
    await page.reload();
    await expect((await block(page, 9)).getByLabel('Breedte')).toHaveValue('wide');
    const width = (await block(page, 12)).getByLabel('Breedte');
    const next = (await width.inputValue()) === 'wide' ? 'Volle breedte' : 'Breed';
    await width.selectOption({ label: next });
    await save(page, 12);
    await expect((await block(page, 12)).getByLabel('Breedte')).toHaveValue(
      next === 'Breed' ? 'wide' : 'full'
    );
    for (const n of [2, 4]) await save(page, n);
    await expectNoAxeViolations(page);

    // The other locale, shown on its own (#66 PR 4), kept its values: the FAQ's questions, and
    // the rich text its item link, written as Markdown.
    await page.goto(`${edit}?locale=en`);
    await expect((await block(page, 9)).getByLabel('Vraag', { exact: true }).first()).toHaveValue(
      /.+/
    );
    await expect((await block(page, 3)).getByLabel('Tekst', { exact: true })).toHaveValue(
      /^More about our work is in \[the annual report\]\(item:[0-9a-f-]{36}\)$/
    );
    await page.goto(edit);
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
    await page.getByRole('button', { name: /^(Wijzigingen )?publiceren$/i }).click();
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
    // With the script, its landing moves focus into the new block once it is ready; a fill
    // before that loses its first characters to the focus change (a verify flake, 2026-10-31).
    if (isA11y())
      await expect(page.locator('form#item-edit')).toHaveAttribute('data-edit-screen', '');
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
    await fresh.getByLabel('Tekst', { exact: true }).fill('Eerste kop');
    await add(page);
    await expect(page).toHaveURL(/\?saved&block=/);
    await expect(page.getByRole('status')).toContainText('Opgeslagen als nieuwe revisie');

    fresh = await insert(page, 'Tekst', 'before', 1);
    await fresh.getByLabel('Tekst', { exact: true }).fill('Een [open link](https://example.org');
    await add(page);
    await expect(page.getByRole('alert')).toContainText('een link is niet afgesloten met )');
    fresh = page.locator('#block-new');
    await expect(fresh.getByLabel('Tekst', { exact: true })).toHaveValue(
      'Een [open link](https://example.org'
    );
    await fresh.getByLabel('Tekst', { exact: true }).fill('Een _schuine_ inleiding.');
    await add(page);
    await expect(page.getByRole('status')).toContainText('Opgeslagen als nieuwe revisie');
    const summaries = page.locator('.ui-block-card-title');
    await expect(summaries).toHaveText(['1. Tekst', '2. Kop']);
    // At rest each card shows what it says, beside a named Edit (MY-110 A).
    await expect(page.locator('[data-block-rest]')).toHaveText([
      'Een schuine inleiding.',
      'Eerste kop',
    ]);
    for (const fold of await page.locator('details.block').all())
      await expect(fold.locator(':scope > summary')).toHaveAccessibleName(
        (await fold.getAttribute('open')) === null ? 'Bewerken' : 'Gereed'
      );

    // A block action saves what was typed elsewhere first (brief edit-screen § 1 point 4).
    await page.locator('#title\\.nl').fill('Blokkenproef bewaard');
    await (await more(page, 2)).getByRole('button', { name: 'Omhoog' }).click();
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

    // Remove asks nothing: the notice after it offers Undo, which puts the block back in place.
    await (await more(page, 1)).getByRole('button', { name: 'Verwijderen' }).click();
    await expect(page).toHaveURL(new RegExp(`${edit}\\?done=blockRemoved`));
    const status = page.getByRole('status');
    await expect(status).toContainText('Blok verwijderd.');
    await expect(summaries).toHaveText(['1. Tekst']);
    await expectNoAxeViolations(page);
    await page.locator('#title\\.nl').fill('Blokkenproef na ongedaan maken');
    await status.getByRole('button', { name: 'Ongedaan maken' }).click();
    await expect(page.getByRole('status')).toContainText('Blok teruggezet.');
    await expect(summaries).toHaveText(['1. Kop', '2. Tekst']);
    await expect(page.locator('#title\\.nl')).toHaveValue('Blokkenproef na ongedaan maken');
    await expect(page.getByRole('button', { name: 'Ongedaan maken' })).toHaveCount(0);
  });

  // #66 PR 6c: with JavaScript the block type list has a search field (Enter adds the first
  // match), `?` opens the shortcuts panel and the bar stays in view; the undo notice and the
  // search keep whole labels at 320 px and 200% text (skill ui-action-layout).
  test('the block type search, the shortcuts panel and the bar that stays in view', async ({
    page,
  }) => {
    onlyA11y('the search, the panel and the keys are the screen script');
    await login(page, '/admin/probe');
    await newPage(page, 'search');
    await expect(page.locator('form#item-edit')).toHaveAttribute('data-edit-screen', '');
    const search = page.getByLabel('Zoek een bloktype');
    await search.fill('cita');
    await expect(page.locator('#insert-type-end option')).toHaveText(['Citaat']);
    // Typing in the search is not a change of the document.
    await expect(page.locator('[data-save-state]')).not.toHaveAttribute('data-current', 'unsaved');
    await search.fill('zzz');
    await expect(page.getByRole('button', { name: 'Toevoegen', exact: true })).toBeDisabled();
    await search.fill('kop');
    await search.press('Enter');
    await expect(page.locator('#block-new').getByRole('heading')).toHaveText('Nieuw blok: Kop');
    await page.locator('#block-new').getByLabel('Tekst', { exact: true }).fill('Gevonden');
    await add(page);
    await expect(page.locator('[data-block-rest]')).toHaveText(['Gevonden']);

    // `?` outside a text field opens the shortcuts; Escape closes them again.
    await page.locator('#blocks').click();
    await page.keyboard.press('?');
    const keys = page.locator('details[data-shortcuts]');
    await expect(keys).toHaveAttribute('open', '');
    await expect(keys).toContainText('Opslaan');
    await page.keyboard.press('Escape');
    await expect(keys).not.toHaveAttribute('open', '');
    await page.locator('#title\\.nl').press('?');
    await expect(keys).not.toHaveAttribute('open', '');
    await page.locator('#title\\.nl').fill('Blokkenproef');

    // On a wide screen the bar stays at the top while the page scrolls.
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.mouse.wheel(0, 2000);
    await expect
      .poll(() => page.locator('.ui-item-bar').evaluate((e) => e.getBoundingClientRect().top))
      .toBeLessThan(2);
    await expectNoAxeViolations(page);

    // Remove, then the notice with Undo and the search, narrow and at 200% text.
    await (await more(page, 1)).getByRole('button', { name: 'Verwijderen' }).click();
    await expect(page.getByRole('button', { name: 'Ongedaan maken' })).toBeVisible();
    await page.setViewportSize(NARROW);
    for (const text of TEXT_SIZES) {
      await setTextSize(page, text);
      await layoutGate(page, `undo notice and type search at ${text}`);
    }
  });

  test('a block is duplicated right after itself, with its fields and a new id', async ({
    page,
  }) => {
    await login(page, '/admin/probe');
    const edit = await newPage(page, 'dup');
    const fresh = await insert(page, 'Kop', 'end');
    await fresh.getByLabel('Tekst', { exact: true }).fill('Twee keer');
    await add(page);
    const original = await page.locator('details.block').first().getAttribute('id');
    // What was typed elsewhere is saved first, as with every block action.
    await page.locator('#title\\.nl').fill('Blokkenproef gedupliceerd');
    await (await more(page, 1)).getByRole('button', { name: 'Dupliceren' }).click();
    await expect(page.getByRole('status')).toContainText('Blok gedupliceerd.');
    await expect(page.locator('#title\\.nl')).toHaveValue('Blokkenproef gedupliceerd');
    await expect(page.locator('.ui-block-card-title')).toHaveText(['1. Kop', '2. Kop']);
    const copy = page.locator('details.block').nth(1);
    await expect(copy).not.toHaveAttribute('id', original!);
    // The screen lands on the copy at rest (it is complete), with the same fields.
    await expect(page).toHaveURL(new RegExp(`${edit}\\?done=blockDuplicated#block-`));
    await expect(copy).not.toHaveAttribute('open', '');
    await expect((await block(page, 2)).getByLabel('Tekst', { exact: true })).toHaveValue(
      'Twee keer'
    );
    // A text block cannot stand next to its copy: it offers no duplicate.
    await insert(page, 'Tekst', 'end');
    await page.locator('#block-new').getByLabel('Tekst', { exact: true }).fill('Los');
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
    await fresh.getByLabel('Tekst', { exact: true }).fill('Vooraf');
    await add(page);
    fresh = await insert(page, 'Vragen en antwoorden', 'after', 1);
    await fresh.getByLabel('Variant').selectOption('accordion');
    await fresh.getByLabel('Breedte').selectOption('full');
    await fresh.getByLabel('Vraag').first().fill('Waarom is dit belangrijk?');
    await fresh.getByLabel('Antwoord').first().fill('Omdat iedereen kan meedoen.');
    await add(page);
    await expect(page.getByRole('status')).toContainText('Opgeslagen als nieuwe revisie');
    const id = await page.locator('details.block').nth(1).getAttribute('id');
    await (await more(page, 2)).getByRole('button', { name: 'Omhoog' }).click();
    await expect(page.locator('details.block').first()).toHaveAttribute('id', id!);
    await page.reload();
    await expect((await block(page, 1)).getByLabel('Breedte')).toHaveValue('full');
    // English on its own screen (#66 PR 4): the same blocks, their English fields.
    await page.goto(`${edit}?locale=en`);
    await (await block(page, 1)).getByLabel('Vraag').first().fill('Why does this matter?');
    await (
      await block(page, 1)
    )
      .getByLabel('Antwoord')
      .first()
      .fill('Because everyone can take part.');
    await (await block(page, 2)).getByLabel('Tekst', { exact: true }).fill('Before');
    await save(page, 2);
    await expect((await block(page, 1)).getByLabel('Vraag').first()).toHaveValue(
      'Why does this matter?'
    );
    for (const locale of ['nl', 'en']) {
      await page.goto(`${edit}?locale=${locale}`);
      const preview = await page.locator(`a[data-preview-link="${locale}"]`).getAttribute('href');
      await page.goto(preview!);
      await expect(page.locator('main .faq-accordion.width-full')).toContainText(
        locale === 'nl' ? 'Waarom is dit belangrijk?' : 'Why does this matter?'
      );
      await page.goto(`${edit}?locale=${locale}`);
      await page.getByRole('button', { name: 'Publiceren', exact: true }).click();
      await expect(page.getByRole('status')).toContainText(`Gepubliceerd in ${locale}.`);
    }
    await expectNoAxeViolations(page);
  });

  test('the integrated article keeps its structured card, identity and other locale in one save', async ({
    page,
    request,
  }) => {
    onlyA11y();
    const source = await callApi(request, 'content.item.list', {
      type: 'article',
      slug: 'quality-article-v3',
    });
    const fetched = await callApi(request, 'content.item.get', { itemId: source.items[0].id });
    const prose = fetched.revision.document.blocks.find(
      (b: { type: string }) => b.type === 'rich-text'
    );
    const faqSource = await callApi(request, 'content.item.list', {
      type: 'page',
      slug: 'e2e-blokken-a11y',
    });
    const fixture = await callApi(request, 'content.item.get', { itemId: faqSource.items[0].id });
    const faq = fixture.revision.document.blocks.find((b: { type: string }) => b.type === 'faq');
    const created = await callApi(request, 'content.item.create', {
      slug: `integrated-${Date.now()}`,
      document: { ...fetched.revision.document, blocks: [prose, faq] },
    });
    const edit = `/admin/probe/content/${created.item.id}`;
    await login(page, edit);
    const surface = page.locator('.writing-surface .ProseMirror').first();
    await expect(surface).toBeVisible();
    await surface.locator('.editor-prose p').first().fill('Artikeltekst in één scherm');
    await page.locator('#title\\.nl').fill('Een nieuwe kop');
    const card = surface.locator('details.block');
    await card.locator(':scope > summary').click();
    await card.locator('details.ui-block-group > summary').click();
    await card.getByLabel('Breedte').selectOption('full');
    await page.getByRole('button', { name: 'Opslaan', exact: true }).click();
    await expect(page).toHaveURL(/saved/);
    const saved = await callApi(request, 'content.item.get', { itemId: created.item.id });
    expect(saved.revision.document.title.nl).toBe('Een nieuwe kop');
    expect(saved.revision.document.blocks.map((b: { id: string }) => b.id)).toEqual([
      prose.id,
      faq.id,
    ]);
    expect(saved.revision.document.blocks[0].props.content.en).toEqual(prose.props.content.en);
    expect(saved.revision.document.blocks[1].props.width).toBe('full');
    await expectNoAxeViolations(page);
  });

  test('Enter in a text field saves in the locale on screen, not the first locale of the switch', async ({
    page,
  }) => {
    // The bar's locale switch comes before Save in the document; without a script Enter would
    // post the first submit button, "nl", and switch away (#66 PR 6). Both projects.
    await login(page, '/admin/probe');
    const edit = await newPage(page, 'enter');
    await page.goto(`${edit}?locale=en`);
    await page.locator('#title\\.en').fill('Saved with Enter');
    await page.locator('#title\\.en').press('Enter');
    await expect(page).toHaveURL(`${edit}?saved&locale=en`);
    await expect(page.locator('#title\\.en')).toHaveValue('Saved with Enter');
  });

  test('the screen says what is unsaved, saves with Ctrl+S and warns before leaving', async ({
    page,
  }) => {
    onlyA11y('the save state, the shortcut and the leave warning are the script');
    await login(page, '/admin/probe');
    const edit = await newPage(page, 'keys');
    const state = page.locator('[data-save-state]');
    await expect(page.locator('form#item-edit')).toHaveAttribute('data-edit-screen', '');
    await expect(state).toHaveAttribute('data-current', 'none');
    await page.locator('#title\\.nl').fill('Nog niet bewaard');
    await expect(state).toHaveAttribute('data-current', 'unsaved');
    await expect(state.locator('[data-save-live]')).toHaveText('Niet opgeslagen wijzigingen');
    // Leaving asks first; staying keeps what was typed.
    page.once('dialog', (dialog) => {
      expect(dialog.type()).toBe('beforeunload');
      void dialog.dismiss();
    });
    await page.locator('.ui-item-bar-back').click();
    await expect(page).toHaveURL(edit);
    await expect(page.locator('#title\\.nl')).toHaveValue('Nog niet bewaard');
    await page.locator('#title\\.nl').press('ControlOrMeta+s');
    await expect(page).toHaveURL(`${edit}?saved`);
    await expect(page.locator('#title\\.nl')).toHaveValue('Nog niet bewaard');
    await expect(state).toHaveAttribute('data-current', 'done');
    await expect(state.locator('[data-save-live]')).toHaveText('Alles opgeslagen');
    // Choosing a block type to insert is no change to the document: leaving does not ask.
    await page.locator('#insert-type-end').selectOption({ label: 'Kop' });
    await expect(state).toHaveAttribute('data-current', 'done');
  });

  test('a block rests until Edit, Escape and Done close it with what was typed, and focus follows actions', async ({
    page,
  }) => {
    onlyA11y('Escape, Done and the focus after a round trip are the script');
    await login(page, '/admin/probe');
    const edit = await newPage(page, 'rest');
    for (const text of ['Eerste', 'Tweede', 'Derde']) {
      const fresh = await insert(page, 'Kop', 'end');
      await expect(fresh.getByLabel('Tekst', { exact: true })).toBeFocused();
      await fresh.getByLabel('Tekst', { exact: true }).fill(text);
      await add(page);
    }
    await page.goto(edit);
    await expect(page.locator('form#item-edit')).toHaveAttribute('data-edit-screen', '');
    const folds = page.locator('details.block');
    await expect(folds.locator(':scope[open]')).toHaveCount(0);
    await expect(page.locator('[data-block-rest]')).toHaveText(['Eerste', 'Tweede', 'Derde']);

    // Edit opens the fields; Escape closes only this block and keeps what was typed.
    const second = folds.nth(1);
    await second.locator(':scope > summary').click();
    await second.getByLabel('Tekst', { exact: true }).fill('Tweede, gewijzigd');
    await page.keyboard.press('Escape');
    await expect(second).not.toHaveAttribute('open', '');
    await expect(second.locator(':scope > summary')).toBeFocused();
    await expect(page.locator('[data-save-state]')).toHaveAttribute('data-current', 'unsaved');
    // A click on the block at rest opens it too; Done under the fields closes it again.
    await card(page, 2).locator('[data-block-rest]').click();
    await expect(second).toHaveAttribute('open', '');
    await expect(second.getByLabel('Tekst', { exact: true })).toHaveValue('Tweede, gewijzigd');
    await second.locator('[data-block-done] button').click();
    await expect(second).not.toHaveAttribute('open', '');
    await expect(second.locator(':scope > summary')).toBeFocused();

    // Move: focus lands on the moved block's More actions, the edit is saved with it.
    await (await more(page, 2)).getByRole('button', { name: 'Omhoog' }).click();
    await expect(page).toHaveURL(/done=blockMoved#block-/);
    await expect(page.locator('[data-block-rest]')).toHaveText([
      'Tweede, gewijzigd',
      'Eerste',
      'Derde',
    ]);
    await expect(card(page, 1).locator('details.ui-block-card-more > summary')).toBeFocused();
    // Escape closes an open More actions and returns to its summary.
    await (await more(page, 1)).locator('details.ui-block-card-more > summary').focus();
    await page.keyboard.press('Escape');
    await expect(card(page, 1).locator('details.ui-block-card-more')).not.toHaveAttribute(
      'open',
      ''
    );
    // Remove: focus lands on the block that took its place.
    const removed = await more(page, 2);
    await removed.getByRole('button', { name: 'Verwijderen' }).click();
    await expect(page).toHaveURL(/done=blockRemoved&undo=[^#]+#block-/);
    await expect(page.locator('[data-block-rest]')).toHaveText(['Tweede, gewijzigd', 'Derde']);
    await expect(folds.nth(1).locator(':scope > summary')).toBeFocused();
    await expectNoAxeViolations(page);
  });

  test('an image block shows its picture with caption and credit at rest, its layout under Display', async ({
    page,
    request,
  }) => {
    const edit = await seededPage(request);
    await login(page, edit);
    const image = card(page, 5);
    await expect(image.locator('.ui-block-card-title')).toHaveText('5. Afbeelding');
    await expectPixels(image.locator('[data-block-rest] img'), 'the image block at rest');
    const fields = page.locator('details.block').nth(4);
    await fields.locator(':scope > summary').click();
    // Content first; layout and credit folded until asked for.
    await expect(fields.getByLabel('Plaatsing')).toBeHidden();
    await fields.locator('details.ui-block-group > summary', { hasText: 'Weergave' }).click();
    await expect(fields.getByLabel('Plaatsing')).toBeVisible();
    await expect(
      fields.locator('details.ui-block-group > summary', { hasText: 'Bron en credits' })
    ).toBeVisible();
    // Evidence for the PR's UI gate: the card at rest and opened, at 320 CSS px and 200% text.
    if (isA11y()) {
      await page.setViewportSize(NARROW);
      await setTextSize(page, '200%');
      await layoutGate(page, 'image card opened', '#item-edit');
      await image.screenshot({ path: test.info().outputPath('image-card-open-320-200.png') });
      await fields.locator(':scope > summary').click();
      await (await more(page, 5)).locator('details.ui-block-card-more > summary').focus();
      await layoutGate(page, 'image card at rest with more actions', '#item-edit');
      await image.screenshot({ path: test.info().outputPath('image-card-rest-320-200.png') });
    }
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
        // A committed URL can precede the HTML body. Throttled delivery keeps that window
        // observable without sleeps; restore normal networking once the document is parsed.
        const network = await page.context().newCDPSession(page);
        await network.send('Network.enable');
        await network.send('Network.emulateNetworkConditions', {
          offline: false,
          latency: 20,
          downloadThroughput: 128 * 1024,
          uploadThroughput: 128 * 1024,
        });
        await login(page, edit);
        const form = page.locator('form#item-edit');
        await expect(form).toBeVisible();
        await expect(form.locator('input[name="baseRevisionId"]')).toHaveValue(/.+/);
        await page.waitForLoadState('domcontentloaded');
        await network.detach();
        // Mounting the prose editor and the tab enhancement is observable readiness, unlike
        // the URL or body alone. Open folds afterwards so hydration cannot replace the state.
        await expect(form.locator('details.block').nth(2).locator('.ProseMirror')).toHaveCount(1);
        await expect(form.locator('.ui-tabs')).toHaveAttribute('data-tabs', '');
        await page.evaluate(() =>
          document.querySelectorAll('details').forEach((d) => (d.open = true))
        );
        const blocks = form.locator('details.block');
        await expect(blocks).toHaveCount(12);
        await expect(form.locator('details.block:not([open])')).toHaveCount(0);
        await expect(blocks.nth(2).locator('.ProseMirror')).toBeVisible();
        await expect(blocks.nth(8).getByLabel('Vraag', { exact: true }).first()).toBeVisible();
        await setTextSize(page, text);
        await expect(page).toHaveURL(new RegExp(`${edit}$`));
        await layoutGate(page, edit);
        // The block with the most fields, chosen but not stored, at its place.
        await page.goto(edit);
        await insert(page, 'Opening', 'after', 7);
        await expect(form.locator('.ui-tabs')).toHaveAttribute('data-tabs', '');
        await expect(
          page.locator('#block-new').getByLabel('Titel', { exact: true }).first()
        ).toBeVisible();
        await setTextSize(page, text);
        await layoutGate(page, 'new hero');
      });
  });
});

// The enhanced article view and native block forms save the same core document. The browser
// proof covers explicit saving, axe and the action layout at 320 CSS px with 200% text; the no-JS
// project proves the adjacent form can write the same prose without hydrating the editor.
test.describe('article-writing', () => {
  test.use({ locale: 'nl-NL' });

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

  test('article prose and title save together, while the native form and other locale remain lossless', async ({
    page,
    request,
  }) => {
    const edit = await article(request);
    await login(page, edit);
    // This proves the save, not input during hydration (the early-input test below does): a fill
    // whose select-all lands while hydration sets the title's value would append to it.
    if (isA11y())
      await expect(page.locator('form#item-edit')).toHaveAttribute('data-edit-screen', '');
    await page.locator('#title\\.nl').fill('Gewijzigde kop');
    if (isA11y()) {
      await expect(page.locator('.writing-surface .ProseMirror').first()).toBeVisible();
      await page.locator('.writing-surface .editor-prose p').first().fill('Nieuwe tekst');
    } else {
      const prose = page.locator('details.block').first();
      await prose.locator(':scope > summary').click();
      await prose.getByLabel('Tekst', { exact: true }).fill('Nieuwe tekst');
    }
    await page.getByRole('button', { name: 'Opslaan', exact: true }).click();
    await expect(page).toHaveURL(/saved/);
    const { revision } = await callApi(request, 'content.item.get', {
      itemId: edit.split('/').at(-1)!,
    });
    expect(revision.document.title.nl).toBe('Gewijzigde kop');
    expect(revision.document.blocks[0].props.content.nl.content[0].content[0].text).toBe(
      'Nieuwe tekst'
    );
    expect(revision.document.blocks[0].props.content.en.content[0].content[0].text).toBe(
      'Old text'
    );
    if (isA11y()) await expectNoAxeViolations(page);
    await page.goto(`${edit}/write?locale=en`);
    await expect(page).toHaveURL(`${edit}?locale=en#blocks`);
  });

  test('native input typed while the editor bundle loads survives enhancement', async ({
    page,
    request,
  }) => {
    onlyA11y();
    const edit = await article(request);
    await login(page, edit);
    let release!: () => void;
    const ready = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route('**/_app/immutable/**/*.js', async (route) => {
      await ready;
      await route.continue();
    });
    await page.reload({ waitUntil: 'commit' });
    await page.locator('#title\\.nl').fill('Voor de enhancement');
    const native = page.locator('details.block').first();
    await native.locator(':scope > summary').click();
    await native.getByLabel('Tekst', { exact: true }).fill('Native invoer voor het laden');
    release();
    await page.waitForFunction(
      () => !!document.head.querySelector('script[src="/_admin/tabs.js"]')
    );
    await expect(page.locator('#title\\.nl')).toHaveValue('Voor de enhancement');
    await expect(native.getByLabel('Tekst', { exact: true })).toBeVisible();
    await expect(native.getByLabel('Tekst', { exact: true })).toHaveValue(
      'Native invoer voor het laden'
    );
    await page.getByRole('button', { name: 'Opslaan', exact: true }).click();
    await expect(page).toHaveURL(/saved/);
    const saved = await callApi(request, 'content.item.get', { itemId: edit.split('/').at(-1)! });
    expect(saved.revision.document.title.nl).toBe('Voor de enhancement');
    expect(saved.revision.document.blocks[0].props.content.nl.content[0].content[0].text).toBe(
      'Native invoer voor het laden'
    );
  });

  test('page prose edits inline and saves in the same form as its title', async ({
    page,
    request,
  }) => {
    onlyA11y();
    const source = await article(request);
    const original = await callApi(request, 'content.item.get', {
      itemId: source.split('/').at(-1)!,
    });
    const {
      type: _type,
      authorIds: _authors,
      sectionId: _section,
      tags: _tags,
      corrections: _corrections,
      delivery: _delivery,
      ...document
    } = original.revision.document;
    const created = await callApi(request, 'content.item.create', {
      document: { ...document, type: 'page' },
    });
    await login(page, `/admin/probe/content/${created.item.id}`);
    const native = page.locator('details.block').first();
    await native.locator(':scope > summary').click();
    const prose = native.locator('.writing-surface .ProseMirror');
    await expect(prose).toBeVisible();
    await prose.locator('p').first().fill('Inline pagina-inhoud');
    await page.locator('#title\\.nl').fill('Pagina met schrijfvlak');
    await page.getByRole('button', { name: 'Opslaan', exact: true }).click();
    await expect(page).toHaveURL(/saved/);
    const saved = await callApi(request, 'content.item.get', { itemId: created.item.id });
    expect(saved.revision.document.title.nl).toBe('Pagina met schrijfvlak');
    expect(saved.revision.document.blocks[0].props.content.nl.content[0].content[0].text).toBe(
      'Inline pagina-inhoud'
    );
    expect(saved.revision.document.blocks[0].props.content.en).toEqual(
      original.revision.document.blocks[0].props.content.en
    );
    await expectNoAxeViolations(page);
  });

  test('typing in an empty article saves and reopens with stable block identity', async ({
    page,
    request,
  }) => {
    onlyA11y();
    requireApi();
    const { item } = await callApi<{ item: { id: string } }>(request, 'content.item.create', {
      slug: `empty-writer-${Date.now()}`,
      document: {
        type: 'article',
        defaultLocale: 'nl',
        locales: ['nl'],
        title: { nl: 'Leeg artikel' },
        blocks: [],
      },
    });
    const route = `/admin/probe/content/${item.id}/write`;
    await login(page, `/admin/probe/content/${item.id}`);
    await page.goto(route);
    const writing = page.locator('.writing-surface .ProseMirror');
    await expect(writing).toBeVisible();
    await writing.click();
    await page.keyboard.type('Eerste tekst');
    await page.getByRole('button', { name: 'Opslaan', exact: true }).click();
    await expect(page).toHaveURL(/saved/);
    const id = await writing.locator('[data-mycel-prose]').getAttribute('data-block-id');
    expect(id).toBeTruthy();
    await page.reload();
    await expect(writing).toContainText('Eerste tekst');
    await expect(writing.locator('[data-mycel-prose]')).toHaveAttribute('data-block-id', id!);
    await writing.locator('p').first().fill('Tweede tekst');
    await page.getByRole('button', { name: 'Opslaan', exact: true }).click();
    await expect(page).toHaveURL(/saved/);
    await page.reload();
    await expect(writing).toContainText('Tweede tekst');
    await expect(writing.locator('[data-mycel-prose]')).toHaveAttribute('data-block-id', id!);
  });

  test('writer toolbar wraps whole actions at 320 CSS px and 200% text', async ({
    browser,
    request,
  }) => {
    onlyA11y();
    requireApi();
    const edit = await article(request);
    // Chromium's context locale owns Accept-Language too; changing only the request header
    // left both screenshots in Dutch. Use real locale contexts and assert the rendered language.
    for (const locale of ['nl-NL', 'en-GB']) {
      const context = await browser.newContext({ locale, viewport: NARROW });
      try {
        const page = await context.newPage();
        await login(page, edit);
        await expect(page.locator('html')).toHaveAttribute('lang', locale.slice(0, 2));
        await expect(page.locator('.writing-actions').first()).toBeVisible();
        await setTextSize(page, '200%');
        await layoutGate(page, `writer actions ${locale}`, '.writing-actions');
        const screenshot = test.info().outputPath(`integrated-editor-${locale}-320-200.png`);
        await page.screenshot({ path: screenshot, fullPage: true });
        await test.info().attach(`integrated-editor-${locale}-320-200`, {
          path: screenshot,
          contentType: 'image/png',
        });
      } finally {
        await context.close();
      }
    }
  });

  test('pasted blockquote becomes a structured quote card after attribution', async ({
    page,
    request,
  }) => {
    onlyA11y();
    requireApi();
    const edit = await article(request);
    await login(page, edit);
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
    await page.getByRole('button', { name: 'Opslaan', exact: true }).click();
    await expect(page).toHaveURL(/saved/);
    await page.goto(edit);
    await expect(page.locator('details.block')).toHaveCount(2);
    await expect(page.locator('.writing-surface .ui-block-card-title')).toContainText(
      /Quote|Citaat/
    );
  });

  test('an integrated prose conflict retains input and never overwrites the newer revision', async ({
    page,
    request,
  }) => {
    onlyA11y();
    const edit = await article(request);
    const itemId = edit.split('/').at(-1)!;
    await login(page, edit);
    await expect(page.locator('.writing-surface .ProseMirror').first()).toBeVisible();
    const { revision } = await callApi(request, 'content.item.get', { itemId });
    await callApi(request, 'content.item.update', {
      itemId,
      baseRevisionId: revision.id,
      document: { ...revision.document, title: { nl: 'Kop van collega', en: 'An article' } },
    });
    await page.locator('.writing-surface .editor-prose p').first().fill('Mijn nieuwe tekst');
    await page.getByRole('button', { name: 'Opslaan', exact: true }).click();
    await expect(
      page
        .getByRole('alert')
        .filter({ hasText: 'Iemand anders heeft dit item intussen opgeslagen' })
    ).toBeVisible();
    await expect(page.locator('.writing-surface .ProseMirror').first()).toContainText(
      'Mijn nieuwe tekst'
    );
    const saved = await callApi(request, 'content.item.get', { itemId });
    expect(saved.revision.document.title.nl).toBe('Kop van collega');
    expect(saved.revision.document.blocks[0].props.content.nl).toEqual(
      revision.document.blocks[0].props.content.nl
    );
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
    await login(page, edit);
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
    await layoutGate(page, 'writer actions', '.writing-actions');
    await expect(page.getByRole('alert')).toContainText('Vul de velden van de geplakte kaarten in');
    // The card's image comes from the shared media picker, not a typed id (brief media-picker).
    // The grid holds the newest hundred; this spec's other tests upload more, so search by name.
    const { filename } = await callApi<{ filename: string }>(request, 'media.get', { id: mediaId });
    await page.locator('.writing .pending').getByRole('button', { name: 'Beeld kiezen' }).click();
    const picker = page.getByRole('dialog', { name: 'Afbeelding' });
    await picker.getByLabel('Zoeken op naam of bijschrift').fill(filename);
    // A click, not check(): the hydrated picker then renders the choice as its own radio of the
    // same value, which unchecks the script's search result.
    await picker.locator(`input[type="radio"][value="${mediaId}"]`).click();
    await expect(page.locator('.writing .pending [data-picker-name]').first()).toHaveText(filename);
    await picker.getByRole('button', { name: 'Klaar' }).click();
    await expect(page.getByRole('button', { name: 'Ander beeld kiezen' })).toBeVisible();
    await expect(page.getByLabel('Alternatieve tekst')).toHaveValue('Een boom');
    await page.getByRole('button', { name: 'Kaart toevoegen' }).click();
    await page.getByRole('button', { name: 'Opslaan', exact: true }).click();
    await expect(page).toHaveURL(/saved/);
    await page.goto(edit);
    await expect(page.locator('details.block')).toHaveCount(2);
    await expect(page.locator('.writing-surface .ui-block-card-title')).toContainText(
      /Image|Afbeelding/
    );
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
    await login(page, edit);

    await page.getByRole('button', { name: 'Opslaan', exact: true }).click();
    await expect(page).toHaveURL(/saved/);
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
    await page.getByRole('button', { name: 'Opslaan', exact: true }).click();
    await expect(page).toHaveURL(/saved/);
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
    await page.getByRole('button', { name: 'Opslaan', exact: true }).click();
    await expect(page).toHaveURL(/saved/);
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
