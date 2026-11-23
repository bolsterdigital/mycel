// Floating pairs in the browser (MY-269 PR 2, brief view-transitions Klaar als 2): a click on an
// overview card names exactly one element `doc-media` and one `doc-title` on each side, the
// card's on the list and the header's on the article, and going back names them the other way
// round; the names are gone when the transition ends, and with reduced motion nothing starts.
// A probe added before the page's own script records what is named at each side in
// `sessionStorage`, which both pages of the tab share: in the old page it listens to `pageswap`
// from `load` on, so after `transitions.js`; in the new page it waits for the transition's
// `ready`, by which the page's `pagereveal` listener has run. Nothing in production code knows of
// the test. Rejected: a test hook in `transitions.js`, which would stay public.
// Called from ui-gate.spec.ts: the spec budget allows no new file.

import { expect, type Page } from '@playwright/test';
import { LONG, seedOverviewCards } from '../blocks/overview-cards';
import { transitionSettled } from './transition';

interface Side {
  transition: boolean;
  media: string[];
  title: string[];
}

function probe() {
  const where = (el: Element) =>
    el.closest('.overview-card')
      ? 'card'
      : el.closest('.page-hero')
        ? 'header'
        : el.tagName.toLowerCase();
  const named = (name: string) =>
    [...document.querySelectorAll('body *')]
      .filter((el) => getComputedStyle(el).viewTransitionName === name)
      .map(where);
  const record = (key: string, transition: boolean) =>
    sessionStorage.setItem(
      key,
      JSON.stringify({ transition, media: named('doc-media'), title: named('doc-title') })
    );
  addEventListener('load', () =>
    addEventListener('pageswap', (event) => record('probe.swap', !!event.viewTransition))
  );
  addEventListener('pagereveal', (event) => {
    const transition = event.viewTransition;
    if (!transition) return record('probe.reveal', false);
    transition.ready.then(
      () => record('probe.reveal', true),
      () => record('probe.reveal', false)
    );
  });
}

/** What the probe saw on both sides of the last navigation; clears it for the next. */
async function sides(page: Page): Promise<{ swap: Side | null; reveal: Side | null }> {
  await expect
    .poll(() => page.evaluate(() => sessionStorage.getItem('probe.reveal')))
    .not.toBeNull();
  return page.evaluate(() => {
    const read = (key: string) => JSON.parse(sessionStorage.getItem(key) ?? 'null');
    const out = { swap: read('probe.swap'), reveal: read('probe.reveal') };
    sessionStorage.removeItem('probe.swap');
    sessionStorage.removeItem('probe.reveal');
    return out;
  });
}

const one = (where: string, title: string): Side => ({
  transition: true,
  media: [where],
  title: [title],
});

export async function exerciseFloatingPairs(page: Page) {
  const path = await seedOverviewCards(page);
  await page.addInitScript(probe);
  await page.setViewportSize({ width: 1280, height: 900 });
  expect((await page.goto(path))?.status()).toBe(200);
  await expect(page.locator('script[src="/_site/transitions.js"]')).toHaveAttribute(
    'blocking',
    'render'
  );
  const card = page.locator('.overview-card').filter({ hasText: LONG });

  // Card to article: the card's image and title fly to the header's.
  await card.getByRole('link').click();
  await expect(page.locator('h1')).toHaveText(LONG);
  expect(await sides(page)).toEqual({ swap: one('card', 'card'), reveal: one('header', 'h1') });
  await transitionSettled(page);
  await expect(page.locator('[data-transition]')).toHaveCount(0);

  // Back: the header's fly back to the card that led there.
  await page.goBack();
  await expect(card).toBeVisible();
  expect(await sides(page)).toEqual({ swap: one('header', 'h1'), reveal: one('card', 'card') });
  await transitionSettled(page);
  await expect(page.locator('[data-transition]')).toHaveCount(0);

  // Reduced motion: the theme's rule starts no transition, so nothing is named.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await card.getByRole('link').click();
  await expect(page.locator('h1')).toHaveText(LONG);
  const none: Side = { transition: false, media: [], title: [] };
  expect(await sides(page)).toEqual({ swap: none, reveal: none });
}
