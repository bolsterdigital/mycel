// flow: publish
// An operator writes and publishes: the content lifecycle, revisions, conflicts and preview.

import { createApp } from '@mycel/api';
import { randomUUID } from 'node:crypto';
import { UseCaseError, systemPrincipal, useCases } from '@mycel/core';
import { type APIRequestContext, type Browser, type Page, expect, test } from '@playwright/test';
import { expectNoAxeViolations } from './lib/axe';
import { newPage } from './lib/editor';
import { tenantId, withInvoker } from './lib/invoker';
import { NARROW, TEXT_SIZES, layoutGate, setTextSize, setTextSpacing } from './lib/layout';
import { ADMIN, login } from './lib/login';
import { isA11y, onlyA11y } from './lib/project';
import { callApi, postUseCase, requireApi } from './lib/api';
import {
  openPublication,
  takeOffline,
  closePublication,
  exercisePublicationDrawer,
  fourActions,
  newPageIn,
} from './lib/publication';

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
    `a1-${what}-${test.info().project.name}-${randomUUID()}`.toLowerCase();

  /** With JavaScript the edit screen's sections are tabs (#66 PR 3): show the one named. */
  async function showTab(page: Page, name: string) {
    if (isA11y()) await page.getByRole('tab', { name, exact: true }).click();
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
    // The list heading is the sole visible title (#87).
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
    await page
      .locator('[data-block-picker]')
      .last()
      .getByRole('button', { name: 'Kop', exact: true })
      .click();
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
    // Publication is independent of the live preview and closes back to its opener.
    await openPublication(page);
    await expect(page.locator('#publication-panel')).toBeVisible();
    await closePublication(page);
    await expect(page.locator('a[href="#publication-panel"]')).toBeFocused();
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    // The browser remembers the choice.
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
    // Hydration resets native disclosures opened before the editor has mounted.
    if (isA11y()) await expect(other.locator('form#item-edit[data-edit-screen]')).toBeVisible();
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
    // Hydration restores the outline's closed default. Click only once it has claimed the
    // form, as in the Enter-save test; the no-script project uses the native fold directly.
    if (isA11y())
      await expect(page.locator('form#item-edit')).toHaveAttribute('data-edit-screen', '');
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

  // An expired session answers the draft POST with a redirect to the login page, which refuses
  // to be framed (`frame-ancestors 'none'`): the frame lands on a document the editor cannot
  // read. The last image stays, and the label must not keep claiming it is the current input.
  test('a draft that lands on an unreadable page keeps the last image and says it is behind', async ({
    page,
  }) => {
    onlyA11y('the live preview is a JavaScript enhancement');
    await ensureLiveAdmin();
    await login(page, '/admin/probe', LIVE_ADMIN);
    await newPage(page, slugFor('expired'), 'Eerste');
    await page.setViewportSize({ width: 1600, height: 900 });
    await page.getByRole('button', { name: 'Voorbeeld', exact: true }).click();
    const shows = page.locator('[data-live-preview]').getByRole('status');
    const frame = page.frameLocator('[data-live-preview-frame]');
    const current = shows.getByText('Actuele invoer');
    const behind = shows.getByText('Dit voorbeeld loopt achter');
    await expect(frame.getByRole('heading', { level: 1, name: 'Eerste' })).toBeVisible();
    await expect(current).toBeVisible();

    await page.route('**/preview/draft', (route) =>
      route.request().method() === 'POST'
        ? route.fulfill({ status: 303, headers: { location: '/admin/login' } })
        : route.continue()
    );
    await page.locator('#title\\.nl').fill('Tweede');
    await expect(behind).toBeVisible();
    await expect(current).toBeHidden();
    await expect(frame.getByRole('heading', { level: 1, name: 'Eerste' })).toBeVisible();
    await expect(page.locator('iframe[data-live-preview-frame]')).toHaveCount(1);
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

  // A redaction with a hundred authors (the seed has that many): the list is a box, the chosen stand
  // first, and what follows it in the column stays on the screen. Without a script it is the same
  // box without the search.
  test('a long author list stays one screen, with the chosen first and a search', async ({
    page,
    request,
  }) => {
    requireApi();
    const run = slugFor('authors');
    const author = (name: string) =>
      callApi<{ id: string }>(request, 'content.author.create', {
        slug: `${run}-${name.toLowerCase().replace(/\W+/g, '-')}`,
        name: `${name} ${run}`,
      });
    const old = await bySlug<{ id: string }>(
      request,
      'content.author.list',
      'authors',
      'e2e-ver-auteur'
    );
    const fresh = await author('Müller');
    const { item } = await callApi<{ item: { id: string } }>(request, 'content.item.create', {
      slug: run,
      document: {
        type: 'article',
        title: { nl: 'Veel auteurs' },
        defaultLocale: 'nl',
        locales: ['nl'],
        blocks: [],
        authorIds: [old.id],
      },
    });
    await page.setViewportSize({ width: 1280, height: 720 });
    await login(page, `/admin/probe/content/${item.id}`);

    const authors = page.locator('#authors');
    await expect(authors.locator('.ui-choice').first()).toContainText('Ver Weg');
    expect(await authors.locator('.ui-choice').count()).toBeGreaterThan(100);
    const top = (await authors.boundingBox())!.y;
    const section = (await page.getByLabel('Rubriek').boundingBox())!;
    expect(section.y + section.height - top).toBeLessThan(720);

    const search = authors.getByRole('searchbox', { name: 'Zoeken' });
    const name = `Müller ${run}`;
    if (isA11y()) {
      await expect(authors.getByText('Gekozen: Ver Weg')).toBeVisible();
      await search.fill(`muller ${run}`);
      await expect(authors.locator('.ui-choice:visible')).toHaveCount(1);
      await expect(authors.getByRole('status')).toContainText('1 van ');
      await search.press('Enter');
      await expect(page).not.toHaveURL(/saved/);
      await authors.getByLabel(name).check();
      await expect(authors.getByText(`Gekozen: Ver Weg, ${name}`)).toBeVisible();
      await search.press('Escape');
      await expect(search).toHaveValue('');
      expect(await authors.locator('.ui-choice:visible').count()).toBeGreaterThan(100);
    } else {
      await expect(search).toBeHidden();
      await authors.getByLabel(name).check();
    }

    await expectNoAxeViolations(page);
    await page.setViewportSize(NARROW);
    await setTextSize(page, '200%');
    await layoutGate(page, 'author list', '#authors');
    await authors.screenshot({ path: test.info().outputPath('authors-320-200.png') });

    await page.getByRole('button', { name: 'Opslaan' }).click();
    await expect(page).toHaveURL(new RegExp(`${item.id}\\?saved$`));
    const { revision } = await callApi<{ revision: { document: { authorIds: string[] } } }>(
      request,
      'content.item.get',
      { itemId: item.id }
    );
    expect(revision.document.authorIds).toEqual([old.id, fresh.id]);
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

  // Publication per locale stays in the one edit form (brief content-editor § A2).
  const card = (page: Page, locale: string) => page.locator(`#publication-${locale}`);
  /** The schedule fold of a card, opened. */
  const scheduleFold = async (page: Page, locale: string) => {
    await openPublication(page);
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
    await closePublication(page);
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
    await openPublication(page);
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
    await openPublication(page);
    await expect(card(page, 'nl')).toContainText('Concept');
    await expect(card(page, 'nl').getByRole('list')).toHaveCount(0);
    await card(page, 'nl').getByRole('button', { name: 'Publiceren', exact: true }).click();
    await expect(page).toHaveURL(`${edit}?done=publish&locale=nl`);
    await expect(page.getByRole('status')).toContainText('Gepubliceerd in nl.');
    await openPublication(page);
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
    await closePublication(page);
    await page.locator('#title\\.nl').fill('Buurtfeest verplaatst');
    await page.getByRole('button', { name: 'Opslaan' }).click();
    await expect(page).toHaveURL(`${edit}?saved`);
    await openPublication(page);
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
    await openPublication(page);
    await takeOffline(page, 'nl', 'Offline halen');
    await expect(page.getByRole('status')).toContainText('Offline gehaald in nl.');
    await openPublication(page);
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
    await closePublication(page);
    await page.locator('#title\\.nl').fill(`${title}!`);
    await switchTo('en').click();
    await expect(page).toHaveURL(`${edit}?locale=en`);
    await expect(switchTo('en')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('[name="title.nl"]')).toHaveCount(0);
    await openPublication(page);
    const en = card(page, 'en');
    await expect(en).toContainText('Titel (en): de vertaling ontbreekt');
    await expect(en.getByRole('link', { name: 'Titel (en)' })).toHaveAttribute('href', '#title.en');
    await openPublication(page);
    await en.getByRole('button', { name: 'Publiceren', exact: true }).click();
    const alert = page.getByRole('alert');
    await expect(alert).toContainText('Dit kan in en nog niet:');
    await expect(alert).toContainText('Titel (en): de vertaling ontbreekt');

    // Typed but not saved: the publish button saves it first; Dutch stays as it was saved.
    await closePublication(page);
    await page.locator('#title\\.en').fill('Only Dutch, now English');
    await openPublication(page);
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
    await openPublication(page);
    await page.locator('.ui-edit-side button[name="to"][value="nl"]').click();
    await expect(page).toHaveURL(`${edit}?locale=nl`);
    await expect(page.locator('#title\\.nl')).toHaveValue(title);
    await expect(page.locator('#lead\\.nl')).toHaveValue('Een korte kern.');
    await page.goto(`${edit}?locale=en`);
    await page.getByRole('button', { name: 'Begin vanuit nl' }).click();
    await expect(page).toHaveURL(`${edit}?saved&locale=en`);
    await expect(page.locator('#title\\.en')).toHaveValue(title);
    await expect(page.locator('#lead\\.en')).toHaveValue('Een korte kern.');
    await closePublication(page);
    await page.locator('#title\\.en').fill('Start from Dutch');
    await page.getByRole('button', { name: 'Opslaan' }).click();
    await page.goto(`${edit}?locale=nl`);
    await expect(page.locator('#title\\.nl')).toHaveValue(title);
    await expect(page.locator('#lead\\.nl')).toHaveValue('Een korte kern.');
  });

  test('publication opens without saving or moving the editor and restores focus on close', async ({
    page,
  }) => {
    onlyA11y('checks the enhanced modal, focus and stored navigation choice');
    await login(page, '/admin/probe');
    await page.evaluate(() => localStorage.removeItem('mycel.admin.nav'));
    const edit = await newPage(page, slugFor('drawer'), 'Paneel');
    await exercisePublicationDrawer(page, edit);
  });

  test('a schedule pins a revision; a newer one can take its place', async ({ page }) => {
    await login(page, '/admin/probe');
    const edit = await newPage(page, slugFor('schedule'), 'Op vrijdag');
    const nl = card(page, 'nl');
    // Scheduling is folded away until asked for: no date field in view by default.
    await expect(nl.getByLabel('Publiceren op')).toBeHidden();
    await (await scheduleFold(page, 'nl')).getByLabel('Publiceren op').fill('2030-01-04T09:00');
    await openPublication(page);
    await nl.getByRole('button', { name: 'Inplannen', exact: true }).click();
    await expect(page).toHaveURL(`${edit}?done=schedule&locale=nl`);
    await openPublication(page);
    await expect(nl).toContainText('Ingepland voor 2030-01-04 09:00');

    // Edited after planning: the pin stays on the old revision until the editor moves it.
    await closePublication(page);
    await page.locator('#title\\.nl').fill('Op vrijdagochtend');
    await page.getByRole('button', { name: 'Opslaan' }).click();
    await expect(page).toHaveURL(`${edit}?saved`);
    await openPublication(page);
    await expect(nl).toContainText('Ingepland voor 2030-01-04 09:00');
    await openPublication(page);
    await expect(nl).toContainText('Je bewerkt een nieuwere revisie');
    await expectNoAxeViolations(page);
    await openPublication(page);
    await nl
      .getByRole('button', { name: 'Deze versie op dat moment publiceren', exact: true })
      .click();
    await expect(page).toHaveURL(`${edit}?done=repin&locale=nl`);
    await openPublication(page);
    await expect(nl).toContainText('Ingepland voor 2030-01-04 09:00');
    await expect(nl).not.toContainText('Je bewerkt een nieuwere revisie');

    // A time in the past is core's refusal, worded in the panel's terms.
    await (await scheduleFold(page, 'nl')).getByLabel('Publiceren op').fill('2020-01-01T09:00');
    await openPublication(page);
    await nl.getByRole('button', { name: 'Inplannen', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText(
      'Publiceren op: de tijd ligt niet in de toekomst'
    );

    await page.goto(edit);
    await openPublication(page);
    await nl.getByRole('button', { name: 'Planning intrekken', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('Planning ingetrokken in nl.');
    await openPublication(page);
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
        await closePublication(page);
        await page.locator('#title\\.nl').fill(`Updated ${label}`);
        await page.getByRole('button', { name: 'Opslaan' }).click();
        const newRevisionId = await page.locator('input[name="baseRevisionId"]').inputValue();
        expect(newRevisionId).not.toBe(oldRevisionId);
        await openPublication(page);
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
    await openPublication(page);
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

  test('a legacy hero moves into the header, or says why not (ADR 025, MY-110 B4)', async ({
    page,
    request,
  }) => {
    const suffix = `${isA11y() ? 'a11y' : 'no-js'}-${Date.now()}`;
    const create = async (slug: string, title: string, blocks: object[]) =>
      callApi(request, 'content.item.create', {
        slug: `e2e-hero-b4-${slug}-${suffix}`,
        document: {
          type: 'page',
          defaultLocale: 'nl',
          locales: ['nl'],
          title: { nl: title },
          blocks,
        },
      });
    const hero = {
      id: 'legacy-hero',
      type: 'hero',
      version: 1,
      props: {
        title: { nl: 'Schone lucht' },
        body: { nl: 'Doe mee met de buurt.' },
        actions: [
          { label: { nl: 'Lees meer' }, target: { kind: 'url', url: 'https://example.org/' } },
        ],
      },
    };
    const rest = { id: 'rest', type: 'heading', version: 1, props: { text: { nl: 'Verder' } } };

    // A conflict shows why, offers no action, and the block stays.
    const blocked = await create('conflict', 'Iets anders', [hero, rest]);
    await login(page, `/admin/probe/content/${blocked.item.id}`);
    const notice = page.locator('.item-header .ui-notice');
    await expect(notice).toContainText('Dit kan nog niet');
    await expect(notice).toContainText('Schone lucht');
    await expect(notice.getByRole('button')).toHaveCount(0);
    await expect(page.locator('#block-legacy-hero')).toHaveCount(1);

    // A match shows source and target, then one click makes one draft revision.
    const { item, revision } = await create('ready', 'Schone lucht', [hero, rest]);
    await page.goto(`/admin/probe/content/${item.id}`);
    await expect(notice).toContainText('Gaat naar de kop');
    await expect(notice).toContainText('Doe mee met de buurt.');
    await expect(notice).toContainText('Lees meer');
    if (isA11y()) {
      await expectNoAxeViolations(page);
      await page.setViewportSize(NARROW);
      for (const size of TEXT_SIZES) {
        await setTextSize(page, size);
        await layoutGate(page, `hero conversion at ${size}`, '.item-header');
      }
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.reload();
    }
    await notice.getByRole('button', { name: 'Verplaats naar de kop' }).click();
    await expect(page.getByRole('status').first()).toContainText('De hero staat nu in de kop');
    await expect(notice).toHaveCount(0);
    await expect(page.locator('[name="lead.nl"]')).toHaveValue('Doe mee met de buurt.');
    const after = await callApi(request, 'content.item.get', { itemId: item.id });
    expect(after.revision.document.blocks.map((b: { type: string }) => b.type)).toEqual([
      'cta',
      'heading',
    ]);
    const before = await callApi(request, 'content.item.get', {
      itemId: item.id,
      revisionId: revision.id,
    });
    expect(before.revision.document.blocks[0].id).toBe('legacy-hero');

    // New content gets no hero (ADR 025 rule 4): not in the choice, not through the address.
    await expect(page.locator('select[name^="insertType"] option[value="hero"]')).toHaveCount(0);
    await page.goto(`/admin/probe/content/${item.id}?insert=hero&place=end#block-new`);
    await expect(page.locator('[data-pending-block], [name="new.type"]')).toHaveCount(0);
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
    // Not the hidden copy session-restore.js posts to `recover` for a moment during the restore.
    const title = (page: Page) => page.locator('input[name="title.nl"]:not([type="hidden"])');
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
      await expect(page).toHaveURL(new RegExp(`${edit}\\?/save&locale=nl$`));
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
      await openPublication(page);
      await expect(card(page, 'nl')).toContainText('Concept');
      await openPublication(page);
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
            if (path === edit) {
              await page.screenshot({
                path: test.info().outputPath(`editor-${locale}-${text}.png`),
                fullPage: true,
              });
              await openPublication(page);
              await layoutGate(page, 'publication drawer', '#publication-panel');
              await expectNoAxeViolations(page);
              await page.screenshot({
                path: test.info().outputPath(`publication-${locale}-${text}.png`),
              });
              await closePublication(page);
            }
          }
          await context.close();
        });
  });
});
