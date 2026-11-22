// The language switch and the menu panel (MY-266 PR C, brief public-chrome-polish § Klaar als 1,
// 2, 4, 5): Language in the bar is a globe plus the visible word; the language choices in the open
// list and in the panel are pills (a border in the text colour, no underline at rest) with the
// current language filled as the body pair inverted and `aria-current`; the panel is at most
// 24rem wide; its search row is compact (small visible label, magnifier plus word on the button);
// language switching and search work as links and a form, so in the `no-js` project too; axe
// light and dark with the open list and the open panel; 320 px at 200% text without sideways
// scroll. Assertions compare elements with each other and with the page's own colours; the only
// length is the 24rem bound the brief names.
// Rejected: a new spec file (the spec budget is full; ui-gate.spec.ts calls this) and reusing the
// chrome-paint tenant (its test walks the theme while this one measures).
import { type Locator, type Page, expect } from '@playwright/test';
import { expectNoAxeViolations } from '../../axe';
import { layoutGate, setTextSize } from '../../layout';
import { isA11y } from '../../project';

/** How each language choice is drawn, against the body pair the list stands on. */
const pills = (list: Locator) =>
  list.evaluate((nav) => {
    const body = getComputedStyle(document.body);
    return [...nav.querySelectorAll('a')].map((a) => {
      const s = getComputedStyle(a);
      const r = a.getBoundingClientRect();
      return {
        text: a.textContent!.trim(),
        current: a.getAttribute('aria-current'),
        lang: a.getAttribute('lang'),
        hreflang: a.getAttribute('hreflang'),
        line: s.textDecorationLine,
        border: s.borderTopStyle !== 'none' && s.borderTopColor === s.color,
        filled: s.backgroundColor === body.color && s.color === body.backgroundColor,
        tall: r.height >= 44,
      };
    });
  });

async function expectPills(list: Locator, locale: string, where: string) {
  const seen = await pills(list);
  expect(
    seen.map((p) => p.text),
    where
  ).toEqual(['Nederlands', 'English']);
  for (const pill of seen) {
    const current = pill.hreflang === locale;
    expect(pill, `${where}: ${pill.text}`).toEqual({
      ...pill,
      current: current ? 'true' : null,
      lang: pill.hreflang,
      line: 'none',
      border: true,
      filled: current,
      tall: true,
    });
  }
}

const settle = (page: Page) =>
  page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished)));

async function openPanel(page: Page): Promise<Locator> {
  await page.locator('.site-menu-toggle').click();
  const panel = page.locator(isA11y() ? '.site-dialog .site-panel' : '.site-panel');
  await expect(panel).toBeVisible();
  await settle(page);
  return panel;
}

export async function exerciseLanguagePanel(page: Page, slug: string) {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`/${slug}/home`);
  const banner = page.getByRole('banner');

  // Language in the bar: a globe for whoever cannot read the page's language, and the word.
  const summary = banner.locator('.site-languages > summary');
  await expect(summary).toHaveText('Taal');
  await expect(summary.locator('svg.site-icon[aria-hidden="true"]')).toHaveCount(1);
  await summary.click();
  const list = banner.locator('.site-languages > nav');
  await expectPills(list, 'nl', 'open language list');
  await expectNoAxeViolations(page, { label: 'open language list', dark: true });
  await summary.click();

  // The panel: at most 24rem, the compact search row, the same pills.
  const panel = await openPanel(page);
  const frame = page.locator(isA11y() ? '.site-dialog' : '.site-panel');
  const widths = await frame.evaluate((el) => ({
    width: el.getBoundingClientRect().width,
    bound: 24 * parseFloat(getComputedStyle(document.documentElement).fontSize),
  }));
  expect(widths.width).toBeLessThanOrEqual(widths.bound + 0.5);
  const row = await panel.locator('search').evaluate((search) => {
    const box = (s: string) => search.querySelector(s)!.getBoundingClientRect();
    const size = (s: string) => parseFloat(getComputedStyle(search.querySelector(s)!).fontSize);
    const input = box('input');
    const button = box('button');
    return {
      smallLabel: size('label') < size('input'),
      oneRow: button.top < input.bottom && input.top < button.bottom,
      icon: !!search.querySelector('button svg.site-icon[aria-hidden="true"]'),
      word: search.querySelector('button')!.textContent!.trim(),
    };
  });
  expect(row).toEqual({ smallLabel: true, oneRow: true, icon: true, word: 'Zoeken' });
  await expectPills(panel.locator('.site-language-links'), 'nl', 'panel');
  await expectNoAxeViolations(page, { label: 'open panel', dark: true });

  // Search from the panel, then switch language from the panel: a form and a link, no script.
  await panel.getByRole('searchbox').fill('Welkom');
  await panel.getByRole('button', { name: 'Zoeken' }).click();
  await expect(page).toHaveURL(/\/search\?q=Welkom$/);
  await expect(page.locator('main').getByRole('searchbox')).toHaveValue('Welkom');
  await page.goto(`/${slug}/home`);
  await (await openPanel(page)).getByRole('link', { name: 'English' }).click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(summary).toHaveText('Language');
  await summary.click();
  await expectPills(list, 'en', 'English list');

  // On a phone Menu stands after Language, so a list hung from Language's end would pass the
  // start edge, which no sideways scroll reveals. At 320 px and 200% text the open list and the
  // open panel reflow without sideways scroll too.
  await page.goto(`/${slug}/home`);
  for (const [width, text] of [
    [375, ''],
    [320, '200%'],
  ] as const) {
    await page.setViewportSize({ width, height: 900 });
    await setTextSize(page, text);
    await summary.click();
    const edges = await list.evaluate((nav) => {
      const r = nav.getBoundingClientRect();
      return { start: r.left >= 0, end: r.right <= document.documentElement.clientWidth };
    });
    expect(edges, `open language list at ${width} px ${text}`).toEqual({ start: true, end: true });
    await layoutGate(page, `open language list at ${width} px ${text}`, '.site-header');
    await summary.click();
  }
  await openPanel(page);
  await layoutGate(
    page,
    'open panel at 320 px and 200% text',
    isA11y() ? '.site-dialog' : '.site-header'
  );
  await setTextSize(page, '');
}
