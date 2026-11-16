// The navigation boundary fixtures in an item's preview (brief site-navigation § 10): the saved
// preview an editor opens from the editor, and the live preview of the unsaved form, both render
// the site's header and footer through the same chrome model as the public page.
// Rejected: measuring only the editor's narrow live-preview frame, which fixes one width; the
// draft route is posted to the top-level page so the matrix sets the viewport itself.
import { createHash } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { expectNoAxeViolations } from '../axe';
import { postDraftPreview } from '../editor';
import { layoutGate, setTextSize } from '../layout';
import { login } from '../login';
import { isA11y } from '../project';
import { NAVIGATION_STATES, attachJson } from './stress';

type State = (typeof NAVIGATION_STATES)[number];

/**
 * The fixture's site editor opens the home item's `saved` preview (no-js and a11y) or posts the
 * editor's form to its `live` preview (a11y; the live preview is an enhancement), in nl and en at
 * 320 and 1440 px with ordinary and 200% text. Per cell: the banner says it is a preview, the
 * layout gate holds for header, open menu and footer, the menu lists the fixture's destinations,
 * every site link stays under the preview prefix, the logo has loaded, and in a11y the page passes
 * axe. At 320 px and 200% text the keyboard reaches the last destination.
 * The preview runs no navigation script: its menu is the native disclosure in both projects.
 */
export async function exerciseItemPreviewStress(
  page: Page,
  state: State,
  slug: string,
  itemId: string,
  kind: 'saved' | 'live'
) {
  const base = `/admin/${slug}/preview`;
  const edit = `/admin/${slug}/content/${itemId}`;
  let failedFonts = 0;
  if (state.fontFailure)
    await page.route('**/*.woff2', async (route) => {
      failedFonts++;
      await route.abort('failed');
    });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const cells: { cell: string; links: number }[] = [];
  for (const locale of ['nl', 'en'])
    for (const width of [320, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      for (const text of ['', '200%']) {
        const cell = `${kind}-item-preview/${state.name}/${locale}/${width}/${text || '100%'}`;
        if (!cells.length) {
          await login(page, edit, `site-editor-${slug}@probe.test`);
          // The route under test is the one the editor links to.
          expect(await page.locator('a[data-preview-link]').getAttribute('href')).toContain(
            `${base}/item/${itemId}`
          );
        }
        if (kind === 'saved') await page.goto(`${base}/item/${itemId}?locale=${locale}`);
        else {
          if (cells.length) await page.goto(edit);
          await postDraftPreview(page, itemId, slug, locale);
          await expect(page.locator('main[data-live-preview-rendered]')).toBeAttached();
        }
        await page.waitForLoadState('load');
        await expect(page.locator('.preview-banner')).toBeVisible();
        await setTextSize(page, text);
        const header = page.locator('.site-header');
        if (state.logo)
          expect(
            await header
              .locator('img')
              .evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)
          ).toBe(true);
        await layoutGate(page, cell, '.site-header');
        await layoutGate(page, cell, '.site-footer');
        const narrowest = width === 320 && text === '200%';
        const shot = (part: string) =>
          page.screenshot({
            path: test.info().outputPath(`${cell.replaceAll('/', '-')}-${part}.png`),
          });
        if (narrowest) await shot('header');
        const toggle = header.locator('.site-menu-toggle');
        await toggle.focus();
        await page.keyboard.press('Enter');
        const panel = header.locator('.site-panel');
        await expect(panel).toBeVisible();
        const links = panel.locator('.site-tree a, .site-panel-actions a');
        await expect(links, cell).toHaveCount(state.count);
        await layoutGate(page, cell, '.site-header');
        const outside = await page
          .locator('.site-header a, .site-footer a')
          .evaluateAll(
            (els, base) =>
              els
                .map((a) => a.getAttribute('href') ?? '')
                .filter((href) => href.startsWith('/') && !new RegExp(`^${base}(/|$)`).test(href)),
            base
          );
        expect(outside, `${cell}: site links outside the preview`).toEqual([]);
        if (narrowest && state.count) {
          // The last destination stays keyboard reachable below a long scroll area.
          for (let step = 0; step < state.count + 12; step++) {
            if (await links.last().evaluate((el) => el === document.activeElement)) break;
            await page.keyboard.press('Tab');
          }
          await expect(links.last()).toBeFocused();
          await shot('links');
        }
        if (isA11y()) await expectNoAxeViolations(page, { label: cell });
        cells.push({ cell, links: await links.count() });
      }
    }
  if (state.fontFailure) {
    expect(failedFonts).toBeGreaterThan(0);
    await page.unroute('**/*.woff2');
  }
  await attachJson(`item-preview-${kind}-${state.name}.json`, {
    state,
    kind,
    project: test.info().project.name,
    browser: page.context().browser()?.version(),
    fixtureHash: createHash('sha256').update(JSON.stringify(state)).digest('hex'),
    reducedMotion: 'reduce',
    cells,
  });
}
