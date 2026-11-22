// A full campaign card's text (ADR 038 rules 3 and 4, and the amendment of 2026-11-22; MY-276 PR
// 2): open, its heading one level under the card's title. Without JavaScript the whole text
// stands there, without a fade and without a button. With it a long text is shortened and gets
// a real button after it, `aria-expanded` and `aria-controls`: "Lees verder" shows everything
// with the focus still on the button, "Lees minder" shortens it again and brings the start of the
// text back into view. Two cards of one campaign on a page share no element id.
// Rejected: a check per spec, which drifted when the card's text left `<details>`.
// A compact card at least 34rem wide (MY-277) has its image area beside the text: in its own
// column, at the card's top, bottom and start edges, at least 3:2, and never over the text.

import { expect, type Locator, type Page } from '@playwright/test';
import { headingOutlineProblems } from './landing';
import { isA11y } from '../project';

/** Whether the text is cut off: its content is taller than the box it shows. */
const cut = (text: Locator) => text.evaluate((t) => t.scrollHeight > t.clientHeight + 1);

export async function exerciseCardText(page: Page, card: Locator) {
  const text = card.locator('.campaign-text');
  await expect(text.getByRole('heading', { level: 3, name: 'Wij constateren' })).toBeVisible();
  await expect(card.getByRole('heading', { level: 2 })).toHaveCount(1);
  const more = card.getByRole('button', { name: 'Lees verder' });
  if (!isA11y()) {
    await expect(card.locator('button.campaign-more')).toHaveCount(0);
    expect(await cut(text)).toBe(false);
  } else {
    await expect(more).toHaveAttribute('aria-expanded', 'false');
    await expect(more).toHaveAttribute('aria-controls', (await text.getAttribute('id'))!);
    expect(await cut(text)).toBe(true);
    expect((await more.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await more.focus();
    await page.keyboard.press('Enter');
    const less = card.getByRole('button', { name: 'Lees minder' });
    await expect(less).toHaveAttribute('aria-expanded', 'true');
    await expect(less).toBeFocused();
    expect(await cut(text)).toBe(false);
    await page.keyboard.press('Enter');
    await expect(more).toHaveAttribute('aria-expanded', 'false');
    await expect(more).toBeFocused();
    expect(await cut(text)).toBe(true);
    expect(await text.evaluate((t) => t.getBoundingClientRect().top)).toBeGreaterThanOrEqual(0);
  }
  expect(await headingOutlineProblems(page)).toEqual([]);
  const ids = await page.locator('[id]').evaluateAll((all) => all.map((e) => e.id));
  expect(ids.filter((id, i) => ids.indexOf(id) !== i)).toEqual([]);
}

/** A compact card side by side: image area in its column at the card's edges, the text uncovered. */
export async function exerciseCompactCardColumns(card: Locator) {
  const g = await card.evaluate((c) => {
    const rect = (sel: string) => c.querySelector(sel)!.getBoundingClientRect();
    const [inner, area, text] = [
      rect('.campaign-card-inner'),
      rect('.campaign-card-inner > .campaign-card-image'),
      rect('.campaign-card-text'),
    ];
    // elementFromPoint sees only the viewport: the title first scrolls into it.
    const link = c.querySelector('.campaign-card-text :is(h2, h3, h4, h5, h6) a')!;
    link.scrollIntoView({ block: 'center' });
    const title = link.getBoundingClientRect();
    const hit = document.elementFromPoint(title.x + title.width / 2, title.y + title.height / 2);
    const rem = parseFloat(getComputedStyle(document.documentElement).fontSize);
    return {
      wide: c.getBoundingClientRect().width >= 34 * rem,
      edges: [area.top - inner.top, inner.bottom - area.bottom, area.left - inner.left].map((d) =>
        Math.abs(Math.round(d))
      ),
      beside: area.right <= text.left + 1,
      ratio: area.height >= (area.width * 2) / 3 - 1,
      titleOnTop: !!hit?.closest('.campaign-card-text'),
    };
  });
  expect(g.wide, 'the compact card is wide enough to stand side by side').toBe(true);
  expect(g.edges, 'image area at the top, bottom and start edges').toEqual([0, 0, 0]);
  expect(g.beside, 'image area in its own column, beside the text').toBe(true);
  expect(g.ratio, 'image area at least 3:2').toBe(true);
  expect(g.titleOnTop, 'the title is not covered').toBe(true);
}
