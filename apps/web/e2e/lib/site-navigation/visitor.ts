// The visitor's task on the chrome fixture (ADR 036 rule 12), without JavaScript:
// at 320 px the header shows the logo, the first call to action and Menu; Menu opens the whole main
// menu with its sublink, a closed group and both calls to action, while the page behind it leaves
// the screen; at 200% text nothing in the open panel is clipped or under 44 px; the footer shows
// the main menu again as a column, its group open. The caller is on the fixture's home page.
// Rejected: checking the markup alone, which says nothing about what a visitor can reach.
import { expect, type Page } from '@playwright/test';
import { expectNoAxeViolations } from '../axe';
import { forcedColorsProblems, layoutGate, setTextSize } from '../layout';

const COPY = {
  nl: {
    main: 'Hoofdnavigatie',
    footer: 'Voettekst',
    actions: ['Doneer nu', 'Doe mee'],
    menu: ['Welkom', 'Acties', 'English'],
    current: 'Welkom',
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
  await expect(main).toBeHidden();
  await expect(page.locator('#public-main')).toBeVisible();
  const footer = page.getByRole('navigation', { name: copy.footer });
  await expect(footer.getByRole('heading', { level: 2 })).toHaveText([...copy.columns]);
  await expect(footer.locator('summary')).toHaveText(copy.group[0]);
  await expect(footer.getByRole('link')).toHaveText([...copy.footerLinks, copy.legal]);
}
