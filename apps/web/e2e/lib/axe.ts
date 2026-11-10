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
 * The elements where the outline skips a level. A best practice, so the WCAG floor above does not
 * ask for it and Lighthouse would be the only one to see it. Needs the `a11y` project.
 */
export async function headingOrderProblems(page: Page): Promise<string[]> {
  const { violations } = await new AxeBuilder({ page }).withRules(['heading-order']).analyze();
  return violations.flatMap((v) => v.nodes.map((n) => n.target.join(' ')));
}

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
    const remeasured = await remeasureTargets(
      page,
      violations
        .filter((v) => v.id === 'target-size')
        .flatMap((v) => v.nodes.map((n) => n.target.join(' ')))
    );
    expect(
      violations
        .map((v) => ({
          id: v.id,
          targets: v.nodes
            .map((n) => n.target.join(' '))
            .filter((target) => v.id !== 'target-size' || !remeasured.includes(target)),
        }))
        .filter((v) => v.targets.length)
        .map((v) => `${colorScheme ? `${colorScheme}: ` : ''}${v.id}: ${v.targets.join(', ')}`),
      label
    ).toEqual([]);
  }
  if (dark) await page.emulateMedia({ colorScheme: 'light' });
}

/**
 * A sticky bar can leave only a slice of a full-sized target visible. Never infer an axe
 * exemption from overlapping rectangles: fixed backgrounds overlap controls too. Instead,
 * scroll each reported target into view and run the same rule again. Only a target axe now
 * accepts can be cleared. Keep all other original violations and restore every scroll container.
 * Rejected: disabling target-size, or accepting geometry without a second axe measurement.
 */
async function remeasureTargets(page: Page, targets: string[]): Promise<string[]> {
  if (!targets.length) return [];
  const scrolls = await page.evaluateHandle(() =>
    [...document.querySelectorAll('*')].map((element) => ({
      element,
      left: element.scrollLeft,
      top: element.scrollTop,
    }))
  );
  const accepted: string[] = [];
  try {
    for (const target of targets) {
      const control = page.locator(target);
      // A small control must still fail even if scrolling changes its neighbours' visibility.
      const box = await control.boundingBox();
      if (!box || box.width < 24 || box.height < 24) continue;
      await control.evaluate((element) =>
        element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' })
      );
      const exposed = await control.evaluate((element) => {
        const box = element.getBoundingClientRect();
        return (
          box.top >= 0 &&
          box.left >= 0 &&
          box.bottom <= innerHeight &&
          box.right <= innerWidth &&
          [
            [box.left + box.width / 4, box.top + box.height / 4],
            [box.right - box.width / 4, box.bottom - box.height / 4],
            [box.left + box.width / 2, box.top + box.height / 2],
          ].every(([x, y]) => element.contains(document.elementFromPoint(x!, y!)))
        );
      });
      if (!exposed) continue;
      const { passes } = await new AxeBuilder({ page }).withRules(['target-size']).analyze();
      if (passes.some((v) => v.nodes.some((node) => node.target.join(' ') === target)))
        accepted.push(target);
    }
  } finally {
    await scrolls.evaluate((positions) => {
      for (const { element, left, top } of positions)
        element.scrollTo({ left, top, behavior: 'instant' });
    });
    await scrolls.dispose();
  }
  return accepted;
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
