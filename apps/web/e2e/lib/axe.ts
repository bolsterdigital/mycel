// The axe floor of ADR 009 rule 3: zero violations of the WCAG 2.2 AA rule set. Axe injects a
// script, so axe runs in the `a11y` project only; the `no-js` project proves the same document
// works without one (playwright.config.ts). Native semantics are checked in both projects:
// WCAG axe accepts an accessible custom button and redundant role, but ADR 004 prefers HTML.
// Rejected: a copy per spec (ten of them), which let the tag list drift between files.

import AxeBuilder from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';
import { isA11y } from './project';

export const WCAG = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

/**
 * Check native semantics in both projects, then WCAG violations in `a11y`. With `dark` the
 * page is analysed in the light and the dark scheme, and left in the light one.
 */
export async function expectNoAxeViolations(
  page: Page,
  { label, dark = false }: { label?: string; dark?: boolean } = {}
) {
  expect(await nativeSemanticsProblems(page), label).toEqual({
    redundantRoles: [],
    nonnativeControls: [],
  });
  if (!isA11y()) return;
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

/**
 * ADR 004/009's native-first rule for six simple control roles with direct HTML equivalents.
 * Inspect the live DOM, including hidden controls, so a later enhancement cannot hide a copy.
 * https://www.w3.org/TR/html-aria/#avoid-specifying-redundant-roles
 * Rejected: forbidding all ARIA (tabs, status, expanded state and rich-text editors need it).
 * Not a complete role resolver: fallback role lists and other widgets retain manual review.
 */
export async function nativeSemanticsProblems(page: Page) {
  return page.evaluate(() => {
    const redundantRoles: string[] = [];
    const nonnativeControls: string[] = [];
    const native: Record<string, string> = {
      button: 'button, input:is([type="button" i], [type="submit" i], [type="reset" i])',
      link: 'a[href], area[href]',
      checkbox: 'input[type="checkbox" i]',
      radio: 'input[type="radio" i]',
      slider: 'input[type="range" i]',
      spinbutton: 'input[type="number" i]',
    };
    for (const node of document.querySelectorAll('[role]')) {
      const role = node.getAttribute('role')!.trim();
      if (!Object.hasOwn(native, role)) continue;
      const selector = native[role]!;
      const problem = `${node.localName}${node.id ? `#${node.id}` : ''}: ${role}`;
      if (node.matches(selector)) redundantRoles.push(problem);
      else nonnativeControls.push(problem);
    }
    return { redundantRoles, nonnativeControls };
  });
}
