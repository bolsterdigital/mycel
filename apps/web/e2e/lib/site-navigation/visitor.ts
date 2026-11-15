// The visitor's task on the chrome fixture (ADR 036 rule 12). Without JavaScript:
// at 320 px the header shows the logo, the first call to action and Menu; Menu opens the whole main
// menu with its sublink, a closed group and both calls to action, while the page behind it leaves
// the screen; at 200% text nothing in the open panel is clipped or under 44 px; the footer shows
// the main menu again as a column, its group open. With JavaScript (the a11y project) Menu opens
// the same panel as a modal dialog instead: focus on its close button, a sublink button beside the
// link, Escape back to Menu (`static/_site/navigation.js`). The caller is on the fixture's home page.
// Rejected: checking the markup alone, which says nothing about what a visitor can reach.
import { test, expect, type Locator, type Page } from '@playwright/test';
import { systemPrincipal, useCases } from '@mycel/core';
import { withInvoker } from '../invoker';
import { expectNoAxeViolations } from '../axe';
import { forcedColorsProblems, layoutGate, setTextSize } from '../layout';
import { isA11y } from '../project';

const COPY = {
  nl: {
    main: 'Hoofdnavigatie',
    footer: 'Voettekst',
    actions: ['Doneer nu', 'Doe mee'],
    menu: ['Welkom', 'Acties', 'English'],
    current: 'Welkom',
    close: 'Sluiten',
    sublinks: "Welkom: onderliggende pagina's",
    group: ['Over ons', 'Team', 'Geschiedenis'],
    columns: ['Contact', 'De site'],
    footerLinks: ['Hulp', 'Vraag', 'Welkom', 'Acties', 'English', 'Team', 'Geschiedenis'],
    legal: 'Privacyverklaring',
  },
  en: {
    main: 'Main navigation',
    footer: 'Footer',
    actions: ['Donate now', 'Join us'],
    menu: ['Home', 'Actions', 'English'],
    // The fixture's English link leads to /en/home, the page the test is on; Home is /home.
    current: 'English',
    close: 'Close',
    sublinks: 'Home: sublinks',
    group: ['About us', 'Team', 'History'],
    columns: ['Contact', 'This site'],
    footerLinks: ['Support', 'Help', 'Home', 'Actions', 'English', 'Team', 'History'],
    legal: 'Privacy policy',
  },
} as const;

export async function exerciseChromeMenus(page: Page, locale: 'nl' | 'en') {
  const copy = COPY[locale];
  const banner = page.getByRole('banner');
  const main = page.getByRole('navigation', { name: copy.main });
  const toggle = banner.locator('summary', { hasText: 'Menu' });
  // Closed: the first call to action stands in the bar, the rest waits in the panel.
  await expect(banner.getByRole('link', { name: copy.actions[0] })).toBeVisible();
  await expect(banner.getByRole('link', { name: copy.actions[1] })).toHaveCount(0);
  await expect(main).toBeHidden();

  if (isA11y()) await enhancedPanel(page, copy, toggle);
  else await nativePanel(page, copy, toggle, main);

  await expect(main).toBeHidden();
  await expect(page.locator('#public-main')).toBeVisible();
  const footer = page.getByRole('navigation', { name: copy.footer });
  await expect(footer.getByRole('heading', { level: 2 })).toHaveText([...copy.columns]);
  await expect(footer.locator('summary')).toHaveText(copy.group[0]);
  await expect(footer.getByRole('link')).toHaveText([...copy.footerLinks, copy.legal]);
  await searchAndLanguages(page, locale);
}

type Copy = (typeof COPY)[keyof typeof COPY];

/** Without JavaScript: Menu is a `details`, its panel takes the page and the footer away. */
async function nativePanel(page: Page, copy: Copy, toggle: Locator, main: Locator) {
  const banner = page.getByRole('banner');
  await toggle.click();
  await expect(main.getByRole('link')).toHaveText([...copy.menu]);
  await expect(main.getByRole('link', { name: copy.current })).toHaveAttribute(
    'aria-current',
    'page'
  );
  await expect(main.locator('[aria-current]')).toHaveCount(1);
  // The group is a disclosure, closed until opened; it never is a link of its own.
  const group = main.locator('summary', { hasText: copy.group[0] });
  await expect(group).toBeVisible();
  await group.click();
  await expect(main.getByRole('link')).toHaveText([...copy.menu, ...copy.group.slice(1)]);
  await expect(
    banner.locator('.site-panel').getByRole('link', { name: copy.actions[1] })
  ).toBeVisible();
  // Nothing the open panel could cover stays on the page (WCAG 2.4.11).
  await expect(page.locator('#public-main')).toBeHidden();
  await expect(page.getByRole('contentinfo')).toBeHidden();
  await setTextSize(page, '200%');
  await layoutGate(page, 'open menu at 320 px and 200% text');
  await expectNoAxeViolations(page, { label: 'open menu' });
  await setTextSize(page, ''); // back to the browser's size; '100%' leaves it as it is
  // Forced colours keep every action's shape and every focus ring in the open panel.
  await page.emulateMedia({ forcedColors: 'active' });
  expect(await forcedColorsProblems(page)).toEqual([]);
  await page.emulateMedia({ forcedColors: 'none' });

  await toggle.click();
}

/** With JavaScript: the same panel in a modal dialog, the page behind it inert. */
async function enhancedPanel(page: Page, copy: Copy, toggle: Locator) {
  await toggle.click();
  const dialog = page.getByRole('dialog', { name: 'Menu' });
  await expect(dialog).toBeVisible();
  expect(await dialog.evaluate((d) => d.matches(':modal'))).toBe(true);
  await expect(dialog.getByRole('button', { name: copy.close })).toBeFocused();
  const main = dialog.getByRole('navigation', { name: copy.main });
  await expect(main.getByRole('link', { name: copy.current })).toHaveAttribute(
    'aria-current',
    'page'
  );
  await expect(main.locator('[aria-current]')).toHaveCount(1);
  // The current branch is open, another folded; the button beside a link toggles its sublinks.
  // On the Dutch home page the first link is the current page, on the English one it is not.
  const sub = main.getByRole('button', { name: copy.sublinks });
  const open = copy.current === copy.menu[0];
  await expect(sub).toHaveAttribute('aria-expanded', String(open));
  if (open) await sub.click();
  await expect(main.getByRole('link')).toHaveText([copy.menu[0], copy.menu[2]]);
  await sub.click();
  await expect(sub).toHaveAttribute('aria-expanded', 'true');
  await expect(main.getByRole('link')).toHaveText([...copy.menu]);
  await main.locator('summary', { hasText: copy.group[0] }).click();
  await expect(main.getByRole('link')).toHaveText([...copy.menu, ...copy.group.slice(1)]);
  await expect(dialog.getByRole('link', { name: copy.actions[1] })).toBeVisible();
  await setTextSize(page, '200%');
  await layoutGate(page, 'open menu dialog at 320 px and 200% text', '.site-dialog');
  await expectNoAxeViolations(page, { label: 'open menu dialog' });
  await setTextSize(page, '');
  await page.emulateMedia({ forcedColors: 'active' });
  expect(await forcedColorsProblems(page, '.site-dialog')).toEqual([]);
  await page.emulateMedia({ forcedColors: 'none' });
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(toggle).toBeFocused();
}

/**
 * The measured bar at a wide viewport (a11y project): every bar candidate fits beside the logo,
 * without calls to action; a link's sublinks and a group open as a dropdown, Escape
 * closes it onto its button. At 200% text fewer fit, and what does not is neither shown nor
 * focusable; every shown candidate stays in the logo's row.
 */
export async function exerciseEnhancedBar(page: Page, tenantId: string) {
  // A separate zero-CTA state leaves space for both kinds of dropdown beside the new reserved
  // search/language tools. The two-CTA state above proves that overflow stays in the panel.
  await withInvoker(async (invoker) => {
    const principal = systemPrincipal(tenantId, 'e2e');
    const original = await invoker.run(useCases.getNavigation, principal, {});
    const save = async (document: typeof original.document) => {
      const current = await invoker.run(useCases.getNavigation, principal, {});
      const saved = await invoker.run(useCases.updateNavigation, principal, {
        baseRevisionId: current.revisionId,
        document,
      });
      await invoker.run(useCases.publishNavigation, principal, {
        revisionId: saved.revisionId!,
        locale: 'nl',
      });
    };
    await save({
      ...original.document,
      placements: { ...original.document.placements, actions: null },
    });
    try {
      await page.reload();
      await measuredBar(page);
    } finally {
      await save(original.document);
    }
  });
}

async function measuredBar(page: Page) {
  const copy = COPY.nl;
  const banner = page.getByRole('banner');
  const bar = banner.getByRole('navigation', { name: copy.main });
  await expect(bar.getByRole('link')).toHaveText([copy.menu[0], copy.menu[2]]);
  await expect(banner.getByRole('link', { name: copy.actions[1] })).toHaveCount(0);
  const group = bar.getByRole('button', { name: copy.group[0] });
  await group.click();
  await expect(bar.getByRole('link')).toHaveText([
    copy.menu[0],
    copy.menu[2],
    ...copy.group.slice(1),
  ]);
  await page.keyboard.press('Escape');
  await expect(group).toHaveAttribute('aria-expanded', 'false');
  await expect(group).toBeFocused();
  const sub = bar.getByRole('button', { name: copy.sublinks });
  await sub.click();
  await expect(bar.getByRole('link', { name: copy.menu[1] })).toBeVisible();
  // Opening the other closes this one: one dropdown at a time.
  await group.click();
  await expect(sub).toHaveAttribute('aria-expanded', 'false');
  await expect(bar.getByRole('link', { name: copy.menu[1] })).toBeHidden();
  await page.keyboard.press('Escape');
  await expect(group).toBeFocused();
  await layoutGate(page, 'enhanced bar at 1440 px', '.site-header');

  // At 200% text Over ons, which holds the focus, no longer fits: the focus moves to Menu.
  await setTextSize(page, '200%');
  const row = async () =>
    page.evaluate(() => {
      const identity = document.querySelector('.site-identity')!.getBoundingClientRect();
      const shown = [
        ...document.querySelectorAll('.site-bar li[data-shown], [data-site-candidate][data-shown]'),
      ];
      return {
        shown: shown.length,
        inRow: shown.every((el) => el.getBoundingClientRect().top < identity.bottom),
        hiddenFocusable: [
          ...document.querySelectorAll('.site-bar a, .site-bar button, [data-site-candidate]'),
        ]
          .filter((el) => !el.closest('[data-shown]') && !el.hasAttribute('data-shown'))
          .some((el) => (el as HTMLElement).checkVisibility()),
      };
    });
  await expect.poll(async () => (await row()).shown).toBeLessThan(3);
  expect(await row()).toMatchObject({ inRow: true, hiddenFocusable: false });
  await expect(banner.locator('.site-menu-toggle')).toBeFocused();
  await layoutGate(page, 'enhanced bar at 1440 px and 200% text', '.site-header');
  await setTextSize(page, '');
  await expect.poll(async () => (await row()).shown).toBe(3);
}

/** Complete visitor task: switch to a published translation, search in the panel, follow a
 * result. The German tenant locale has no published home translation and must not be offered. */
async function searchAndLanguages(page: Page, locale: 'nl' | 'en') {
  const start = page.url();
  const search = locale === 'nl' ? 'Zoeken' : 'Search';
  const query = locale === 'nl' ? 'Welkom' : 'Welcome';
  const banner = page.getByRole('banner');
  await expect(banner.locator('.site-search-link')).toHaveText(search);
  await banner.locator('.site-languages summary').click();
  const languages = banner.locator('.site-languages nav');
  await expect(languages.getByRole('link')).toHaveText(['Nederlands', 'English']);
  await expect(languages.locator('[aria-current]')).toHaveAttribute('hreflang', locale);
  // Keyboard activation of a real link, not a scripted language replacement.
  const other = languages.getByRole('link', { name: locale === 'nl' ? 'English' : 'Nederlands' });
  await other.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('html')).toHaveAttribute('lang', locale === 'nl' ? 'en' : 'nl');
  await page.goto(start);

  // Widths are CSS widths; 320 px also proves reflow at a 1280 px window’s 400% browser zoom.
  for (const width of [1440, 768, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await layoutGate(page, `search/language tools at ${width}px`, '.site-header');
  }
  await setTextSize(page, '200%');
  await banner.locator('.site-languages summary').click();
  await layoutGate(page, 'language choices at 320px and 200% text', '.site-header');
  await page.screenshot({
    path: test.info().outputPath(`languages-${locale}.png`),
    fullPage: true,
  });
  await banner.locator('.site-languages summary').click();
  await banner.locator('.site-menu-toggle').click();
  if (isA11y())
    await page.locator('.site-dialog').evaluate(async (d) => {
      await Promise.all(d.getAnimations().map((a) => a.finished));
    });
  const panel = page.locator('.site-panel');
  if (isA11y()) {
    const close = page.locator('.site-dialog-close');
    expect(await close.evaluate((el) => el.getBoundingClientRect().top)).toBeLessThan(200);
    await expect(panel.getByRole('searchbox')).toBeInViewport();
  }
  await layoutGate(
    page,
    'panel search at 320px and 200% text',
    isA11y() ? '.site-dialog' : '.site-header'
  );
  await expectNoAxeViolations(page, { label: 'panel search and languages' });
  await page.screenshot({
    path: test.info().outputPath(`search-panel-${locale}.png`),
  });
  const field = panel.getByRole('searchbox');
  await field.fill(query);
  await panel.getByRole('button', { name: search, exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/search\\?q=${query}$`));
  await expect(
    page.locator('main .search-results').getByRole('link', { name: query, exact: true })
  ).toBeVisible();
  await banner.locator('.site-languages summary').click();
  await banner
    .locator('.site-languages nav')
    .getByRole('link', { name: locale === 'nl' ? 'English' : 'Nederlands' })
    .click();
  await expect(page).toHaveURL(new RegExp(`/search\\?q=${query}$`));
  await expect(page.locator('main').getByRole('searchbox')).toHaveValue(query);
  await page.goto(start);
  await setTextSize(page, '');
  // A monolingual publication (the action page) has no language selector, even though its site
  // supports three locales. This guards against links to unpublished translations.
  await page.goto(start.replace(/(?:en\/)?home$/, 'acties'));
  await expect(banner.locator('.site-languages')).toHaveCount(0);
  await page.goto(start);
}
