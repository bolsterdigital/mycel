// The axe floor of ADR 009 rule 3: zero violations of the WCAG 2.2 AA rule set. Axe injects a
// script, so it runs in the `a11y` project only; the `no-js` project proves the same document
// works without one (playwright.config.ts).
// Rejected: a copy per spec (ten of them), which let the tag list drift between files.

import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

export const WCAG = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

/**
 * Fail with every violation and its targets; a no-op outside the `a11y` project. With `dark` the
 * page is analysed in the light and the dark scheme, and left in the light one.
 */
export async function expectNoAxeViolations(
  page: Page,
  { label, dark = false }: { label?: string; dark?: boolean } = {}
) {
  if (test.info().project.name !== 'a11y') return;
  for (const colorScheme of dark ? (['light', 'dark'] as const) : [null]) {
    if (colorScheme) await page.emulateMedia({ colorScheme });
    const { violations } = await new AxeBuilder({ page }).withTags(WCAG).analyze();
    expect(
      violations.map(
        (v) =>
          `${colorScheme ? `${colorScheme}: ` : ''}${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`
      ),
      label
    ).toEqual([]);
  }
  if (dark) await page.emulateMedia({ colorScheme: 'light' });
}
