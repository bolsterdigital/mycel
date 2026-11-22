// A campaign's landing page in the campaign layout (ADR 038 rules 2, 3 and 9; MY-267 PR 2), on
// the quality corpus's campaign route in both locales: the header image is the first element of
// `main`, loads eagerly and is the page's largest image; one h1 and an outline without skipped
// levels; from the container threshold the action area (count and form) stands beside intro and
// body, below it one column in the order intro, action, body; nothing scrolls sideways or clips at
// 320 CSS px with default and 200% text; axe clean. The outline check is shared: any page can ask
// it. Rejected: a pixel comparison, which says nothing about order or outline.

import { expect, type Page } from '@playwright/test';
import { expectNoAxeViolations } from '../axe';
import { NARROW, TEXT_SIZES, layoutGate, setTextSize } from '../layout';
import { isA11y } from '../project';

/** One h1, and no heading more than one level below the one before it. */
export async function headingOutlineProblems(page: Page, within = 'body'): Promise<string[]> {
  const levels = await page
    .locator(`${within} :is(h1, h2, h3, h4, h5, h6)`)
    .evaluateAll((hs) =>
      hs
        .filter((h) => h.getClientRects().length > 0 || h.closest('details'))
        .map((h) => ({ level: Number(h.tagName[1]), text: (h.textContent ?? '').trim() }))
    );
  const out: string[] = [];
  const ones = levels.filter((h) => h.level === 1).length;
  if (ones !== 1) out.push(`${ones} h1 elements`);
  levels.forEach((h, i) => {
    const before = i === 0 ? 0 : levels[i - 1]!.level;
    if (h.level > before + 1) out.push(`h${h.level} "${h.text}" after h${before}`);
  });
  return out;
}

const box = async (page: Page, selector: string) =>
  (await page.locator(selector).first().boundingBox())!;

export async function exerciseCampaignLanding(page: Page, paths: readonly string[]) {
  for (const path of paths) {
    await page.setViewportSize({ width: 1440, height: 900 });
    await setTextSize(page, '16px');
    const response = await page.goto(path);
    expect(response?.status(), path).toBe(200);
    // The header image first, eager, with its alt; the form is the campaign's, in the action area.
    const first = page.locator('main > :first-child');
    await expect(first).toHaveClass(/campaign-hero/);
    await expect(first.locator('img')).not.toHaveAttribute('loading', 'lazy');
    await expect(first.locator('img')).toHaveAttribute('alt', /\S/);
    await expect(page.locator('main form[method="post"]')).toHaveCount(1);
    await expect(page.locator('.campaign-action form[method="post"]')).toHaveCount(1);
    await expect(page.locator('.campaign-action progress')).toHaveCount(1);
    expect(await headingOutlineProblems(page, 'main'), path).toEqual([]);

    // Wide: the action area to the right of intro and body, its top level with the intro's.
    const [intro, action, body] = [
      await box(page, '.campaign-intro'),
      await box(page, '.campaign-action'),
      await box(page, '.campaign-body'),
    ];
    expect(action.x, `${path}: action beside the intro`).toBeGreaterThanOrEqual(
      intro.x + intro.width
    );
    expect(Math.abs(action.y - intro.y)).toBeLessThan(2);
    expect(body.y).toBeGreaterThan(intro.y);

    // Narrow: one column in DOM order, whole at default and 200% text.
    await page.setViewportSize(NARROW);
    for (const size of TEXT_SIZES) {
      await setTextSize(page, size === '100%' ? '16px' : size);
      const [i, a, b] = [
        await box(page, '.campaign-intro'),
        await box(page, '.campaign-action'),
        await box(page, '.campaign-body'),
      ];
      expect(a.y, `${path} ${size}: action under the intro`).toBeGreaterThanOrEqual(i.y + i.height);
      expect(b.y, `${path} ${size}: body under the action`).toBeGreaterThanOrEqual(a.y + a.height);
      await layoutGate(page, `${path} at 320 px and ${size} text`, 'main');
    }
    await setTextSize(page, '16px');
    if (isA11y()) await expectNoAxeViolations(page, { label: `campaign landing ${path}` });
  }
}
