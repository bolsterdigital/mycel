// Boundary fixtures exercise the real navigation renderer through the existing public flow.
// Rejected: DOM replacement, which bypasses publication, logo processing and the no-JS fallback.
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { systemPrincipal, useCases } from '@mycel/core';
import { createBrandProcessor } from '@mycel/media-sharp';
import { withInvoker } from '../invoker';
import { expect, test, type Page } from '@playwright/test';
import { forcedColorsProblems, layoutGate, setTextSize } from '../layout';
import { expectNoAxeViolations } from '../axe';
import { isA11y } from '../project';
import { login } from '../login';
import { CLS_LIMIT, loadLayoutShift } from './cls';
import { publishMenus } from './seed';
import { seedSiteSettings } from './settings-fixture';

type Links = Parameters<typeof publishMenus>[2];
const label = {
  nl: 'Samen werken aan een rechtvaardige toekomst voor iedereen in onze dorpen en steden',
  en: 'Working together for a fair future for everyone in our villages and cities',
  de: 'Gemeinsam an einer gerechten Zukunft arbeiten',
};
// The schema allows 120 characters, including labels spanning several whole words.
const longest = Object.fromEntries(
  Object.entries(label).map(([locale, text]) => [locale, `${text} ${text}`.slice(0, 120)])
);
const link = (i: number) => ({ href: `/home?destination=${i}`, label: longest });
export const NAVIGATION_STATES: {
  name: string;
  links: Links;
  count: number;
  logo?: [number, number];
  fontFailure?: boolean;
}[] = [
  { name: 'empty', links: {}, count: 0 },
  { name: 'wide-logo', links: { main: [link(1)] }, count: 1, logo: [1200, 60] },
  {
    name: 'tall-logo-font-failure',
    links: { main: [link(1)], actions: [link(2)] },
    count: 2,
    logo: [60, 1200],
    fontFailure: true,
  },
  { name: 'one-action', links: { main: [link(1)], actions: [link(2)] }, count: 2 },
  { name: 'only-actions', links: { actions: [link(1), link(2)] }, count: 2 },
  {
    name: 'large-menu',
    links: {
      main: Array.from({ length: 100 }, (_, i) => link(i)),
      mainInFooter: { nl: 'Alle bestemmingen', en: 'All destinations', de: 'Alle Ziele' },
    },
    count: 100,
  },
];

export async function seedNavigationStress(state: (typeof NAVIGATION_STATES)[number]) {
  const slug = `nav-stress-${state.name}-${Math.random().toString(36).slice(2, 9)}`;
  const { tenantId, homeItemId } = await seedSiteSettings(slug, `${slug}-single`, state.links);
  if (state.logo)
    await withInvoker(
      async (invoker) => {
        const [width, height] = state.logo!;
        const principal = systemPrincipal(tenantId, 'e2e');
        await invoker.run(useCases.putBrandAsset, principal, {
          kind: 'logo',
          baseVersion: 0,
          contentType: 'image/svg+xml',
          bytes: Buffer.from(
            `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="${width}" height="${height}" fill="#123456"/></svg>`
          ).toString('base64'),
        });
        if (state.fontFailure)
          await invoker.run(useCases.putBrandAsset, principal, {
            kind: 'font',
            baseVersion: 0,
            contentType: 'font/woff2',
            licence: 'SIL Open Font License 1.1',
            bytes: (
              await readFile(
                new URL('../../../static/fonts/inter/inter-latin-roman.woff2', import.meta.url)
              )
            ).toString('base64'),
          });
      },
      { brandProcessor: createBrandProcessor() }
    );
  return {
    slug,
    homeItemId,
    hash: createHash('sha256').update(JSON.stringify(state)).digest('hex'),
  };
}

export async function exerciseNavigationStress(
  page: Page,
  state: (typeof NAVIGATION_STATES)[number],
  slug: string,
  locale: string,
  widths: number[] = [320, 768, 1440],
  colorModes: readonly ('none' | 'active')[] = ['none', 'active']
) {
  let failedFonts = 0;
  if (state.fontFailure)
    await page.route('**/*.woff2', async (route) => {
      failedFonts++;
      await route.abort('failed');
    });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const cls: ({ cell: string } & Awaited<ReturnType<typeof loadLayoutShift>>)[] = [];
  for (const colors of colorModes) {
    await page.emulateMedia({ forcedColors: colors });
    expect(await page.evaluate(() => matchMedia('(forced-colors: active)').matches)).toBe(
      colors === 'active'
    );
    for (const width of widths) {
      if (width) await page.setViewportSize({ width, height: 900 });
      for (const text of ['', '200%']) {
        await page.goto(`http://127.0.0.1:4173/${slug}/${locale === 'en' ? 'en/' : ''}home`);
        const description = `${state.name}/${locale}/${width || 'browser-zoom'}/${text || '100%'}/${colors}`;
        const header = page.locator('.site-header');
        if (width && !text) {
          // The load's own shifts, before the test resizes text, focuses or clicks.
          if (isA11y()) await expect(header).toHaveAttribute('data-enhanced', '');
          const shift = await loadLayoutShift(page, isA11y());
          cls.push({ cell: description, ...shift });
          expect
            .soft(shift.value, `${description}: CLS ${JSON.stringify(shift)}`)
            .toBeLessThanOrEqual(CLS_LIMIT);
        }
        await setTextSize(page, text);
        if (isA11y()) await expect(header).toHaveAttribute('data-enhanced', '');
        else {
          await expect(header).not.toHaveAttribute('data-enhanced', '');
          await expect(page.locator('.site-dialog')).toHaveCount(0);
        }
        await layoutGate(page, description, '.site-header');
        await layoutGate(page, description, '.site-footer');
        if (colors === 'active')
          expect(await forcedColorsProblems(page, '.site-header'), description).toEqual([]);
        if (width === widths[0] && text === '200%') {
          // The focus audit may scroll past the logo; capture the complete header again.
          await header.scrollIntoViewIfNeeded();
          await screenshot(page, `${state.name}-${locale}-${colors}-header`, width);
        }
        const toggle = header.locator('.site-menu-toggle');
        await toggle.focus();
        await page.keyboard.press('Enter');
        const panel = page.locator('.site-panel');
        await expect(panel).toBeVisible();
        if (isA11y())
          await page.locator('.site-dialog').evaluate(async (d) => {
            await Promise.all(d.getAnimations().map((a) => a.finished));
          });
        if (state.logo)
          expect(
            await header
              .locator('img')
              .evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)
          ).toBe(true);
        const links = panel.locator('.site-tree a, .site-panel-actions a');
        await expect(links).toHaveCount(state.count);
        await attachJson(
          `geometry-${state.name}-${locale}-${width}-${text || 'normal'}-${colors}.json`,
          await page.locator('.site-identity, .site-tree a').evaluateAll((els) =>
            els
              .filter((e) => e.checkVisibility())
              .slice(0, 3)
              .map((e) => ({
                text: e.textContent,
                width: e.clientWidth,
                scroll: e.scrollWidth,
                font: getComputedStyle(e).fontSize,
                html: e.outerHTML,
              }))
          )
        );
        await layoutGate(page, description, isA11y() ? '.site-dialog' : '.site-header');
        if (colors === 'active') {
          // The colour audit walks focus; resume the original opener-to-destination path.
          const focused = await page.locator(':focus').elementHandle();
          expect(focused).not.toBeNull();
          expect(
            await forcedColorsProblems(page, isA11y() ? '.site-dialog' : '.site-panel'),
            description
          ).toEqual([]);
          await focused!.focus();
        }
        if (width === widths[0] && text === '200%') {
          await expectNoAxeViolations(page, { label: description });
          await screenshot(page, `${state.name}-${locale}-${colors}-panel`, width);
          if (state.count) {
            await links.first().scrollIntoViewIfNeeded();
            await screenshot(page, `${state.name}-${locale}-${colors}-links`, width);
          }
        }
        expect(
          await panel.evaluate((el) =>
            [el, ...el.querySelectorAll('*')].every((node) => {
              const style = getComputedStyle(node);
              return (
                style.transitionDuration.split(',').every((value) => parseFloat(value) === 0) &&
                style.animationName === 'none'
              );
            })
          )
        ).toBe(true);
        if (state.count) {
          // The final destination must remain keyboard reachable even below a long scroll area.
          for (let step = 0; step < state.count + 12; step++) {
            if (await links.last().evaluate((el) => el === document.activeElement)) break;
            await page.keyboard.press('Tab');
          }
          await expect(links.last()).toBeFocused();
          if (colors === 'active')
            expect(
              await links.last().evaluate((el) => {
                const style = getComputedStyle(el);
                return style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0;
              }),
              `${description}: final destination focus outline`
            ).toBe(true);
          await page.keyboard.press('Enter');
          await expect(page).toHaveURL(/\/home\?destination=\d+$/);
        } else if (isA11y()) {
          await page.keyboard.press('Escape');
          await expect(toggle).toBeFocused();
        } else {
          await toggle.focus();
          await page.keyboard.press('Enter');
          await expect(panel).toBeHidden();
        }
      }
    }
  }
  await page.emulateMedia({ forcedColors: 'none' });
  if (state.fontFailure) {
    expect(failedFonts).toBeGreaterThan(0);
    await page.unroute('**/*.woff2');
  }
  // 200% text and real browser zoom set the size after the load, so their shift is the test's own.
  const unmeasured = '200% text and real browser zoom resize after load: CLS not measured';
  if (cls.length)
    await attachJson('navigation-cls.json', { limit: CLS_LIMIT, unmeasured, cells: cls });
  await attachJson(`navigation-${state.name}-${locale}.json`, {
    state,
    locale,
    widths,
    browser: page.context().browser()?.version(),
    project: test.info().project.name,
    fixtureHash: createHash('sha256').update(JSON.stringify(state)).digest('hex'),
    route: `/${slug}/${locale === 'en' ? 'en/' : ''}home`,
    reducedMotion: 'reduce',
    forcedColors: colorModes,
    cls: cls.length ? 'navigation-cls.json' : unmeasured,
  });
}

// Real browser zoom needs a physical-viewport capture; Playwright's CSS clip crops it.
async function screenshot(page: Page, name: string, width: number) {
  const path = test.info().outputPath(`${name}.png`);
  if (width) await page.screenshot({ path });
  else {
    const cdp = await page.context().newCDPSession(page);
    try {
      const result = await cdp.send('Page.captureScreenshot', { captureBeyondViewport: false });
      await writeFile(path, Buffer.from(result.data, 'base64'));
    } finally {
      await cdp.detach();
    }
  }
}

export async function attachJson(name: string, value: unknown) {
  const path = test.info().outputPath(name);
  await writeFile(path, JSON.stringify(value, null, 2));
  await test.info().attach(name, { path, contentType: 'application/json' });
}

/** The cards the preview lists for a fixture: each placed item, the main menu again as a column. */
const previewCards = ({ links }: (typeof NAVIGATION_STATES)[number]) =>
  (links.main?.length ?? 0) * (links.mainInFooter ? 2 : 1) + (links.actions?.length ?? 0);

/**
 * The same boundary fixture in the editor's navigation preview (brief site-navigation
 * § 10): its site editor opens `/admin/<site>/navigation/preview/<locale>` in nl and en at 320
 * and 1440 px with ordinary and 200% text. Per cell the layout gate measures the preview's
 * placements, every card keeps its text inside, a link there stays in the admin or is whole, and
 * in a11y the whole page passes axe. The preview renders no logo; a font fixture still fails its
 * fonts, so the admin's own fallback is what is measured.
 * Rejected: measuring the whole admin page with the gate, which would test the admin shell (its
 * own suites do) and hide which part of the preview broke.
 */
export async function exerciseNavigationPreviewStress(
  page: Page,
  state: (typeof NAVIGATION_STATES)[number],
  slug: string
) {
  const scope = '[id^="preview-"]';
  if (state.fontFailure) await page.route('**/*.woff2', (route) => route.abort('failed'));
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const cells: { cell: string; cards: number }[] = [];
  for (const locale of ['nl', 'en']) {
    const path = `/admin/${slug}/navigation/preview/${locale}`;
    for (const width of [320, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      for (const text of ['', '200%']) {
        if (cells.length) await page.goto(path);
        else await login(page, path, `site-editor-${slug}@probe.test`);
        const cell = `preview/${state.name}/${locale}/${width}/${text || '100%'}`;
        await setTextSize(page, text);
        await expect(page.locator('#preview-main')).toBeVisible();
        const cards = page.locator(`:is(${scope}) .ui-menu-item`);
        await expect(cards, cell).toHaveCount(previewCards(state));
        await layoutGate(page, cell, scope);
        const problems = await page.evaluate(
          ({ scope, admin }) => {
            const whole = (el: Element) =>
              el.checkVisibility() && el.scrollWidth <= el.clientWidth + 1;
            const out = [
              ...document.querySelectorAll(
                `:is(${scope}) :is(.ui-menu-item, .ui-menu-item-label, .ui-menu-item-facts, h3)`
              ),
            ]
              .filter((el) => !whole(el))
              .map((el) => `card text past its box: ${el.textContent?.trim().slice(0, 60)}`);
            for (const a of document.querySelectorAll<HTMLAnchorElement>(`:is(${scope}) a`))
              if (!new URL(a.href).pathname.startsWith(admin) && !whole(a))
                out.push(`link leaves the preview and is not whole: ${a.href}`);
            return out;
          },
          { scope, admin: `/admin/${slug}/` }
        );
        expect(problems, cell).toEqual([]);
        if (width === 320 && text === '200%') {
          await page.locator('#preview-main').scrollIntoViewIfNeeded();
          await page.screenshot({
            path: test.info().outputPath(`${cell.replaceAll('/', '-')}.png`),
          });
        }
        await expectNoAxeViolations(page, { label: cell });
        cells.push({ cell, cards: await cards.count() });
      }
    }
  }
  if (state.fontFailure) await page.unroute('**/*.woff2');
  await attachJson(`navigation-preview-${state.name}.json`, {
    state,
    project: test.info().project.name,
    fixtureHash: createHash('sha256').update(JSON.stringify(state)).digest('hex'),
    scope,
    cells,
  });
}
