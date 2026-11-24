// Floating pairs in the browser: the rendered overview, Cards CTA and byline name the parts
// that travel between pages in both directions. Names clear after each transition; reduced
// motion and disabled JavaScript still allow navigation.
// A probe added before the page's own script records what is named at each side in
// `sessionStorage`, which both pages of the tab share: in the old page it listens to `pageswap`
// from `load` on, so after `transitions.js`; in the new page it waits for the transition's
// `ready`, by which the page's `pagereveal` listener has run. Nothing in production code knows of
// the test. Rejected: a test hook in `transitions.js`, which would stay public.
// Called from ui-gate.spec.ts: the spec budget allows no new file.

import { expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { systemPrincipal, useCases } from '@mycel/core';
import { LONG, seedOverviewCards } from '../blocks/overview-cards';
import { tenantId, withInvoker } from '../invoker';
import { isA11y } from '../project';
import { transitionSettled } from './transition';

interface Side {
  transition: boolean;
  media: string[];
  title: string[];
  portrait: string[];
}

function probe() {
  const where = (el: Element) => {
    if (el.matches('.cards-item :is(h2, h3, h4, h5, h6)')) return 'cards-title';
    if (el.matches('.page-meta a')) return 'byline-link';
    if (el.matches('.person-portrait img')) return 'profile-portrait';
    if (el.closest('.overview-card')) return 'card';
    if (el.closest('.page-hero')) return 'header';
    return el.tagName.toLowerCase();
  };
  const named = (name: string) =>
    [...document.querySelectorAll('body *')]
      .filter((el) => getComputedStyle(el).viewTransitionName === name)
      .map(where);
  const record = (key: string, transition: boolean) =>
    sessionStorage.setItem(
      key,
      JSON.stringify({
        transition,
        media: named('doc-media'),
        title: named('doc-title'),
        portrait: named('person-portrait'),
      })
    );
  addEventListener('load', () =>
    addEventListener('pageswap', (event) => record('probe.swap', !!event.viewTransition))
  );
  addEventListener('pagereveal', (event) => {
    const transition = event.viewTransition;
    if (!transition) return record('probe.reveal', false);
    transition.ready.then(
      () => {
        const snapshots = document
          .getAnimations()
          .flatMap(({ effect }) =>
            effect instanceof KeyframeEffect && effect.pseudoElement ? [effect.pseudoElement] : []
          );
        sessionStorage.setItem('probe.snapshots', JSON.stringify(snapshots));
        record('probe.reveal', true);
      },
      () => record('probe.reveal', false)
    );
  });
}

/** What the probe saw on both sides of the last navigation; clears it for the next. */
async function sides(
  page: Page
): Promise<{ swap: Side | null; reveal: Side | null; snapshots: string[] }> {
  await expect
    .poll(() => page.evaluate(() => sessionStorage.getItem('probe.reveal')))
    .not.toBeNull();
  return page.evaluate(() => {
    const read = (key: string) => JSON.parse(sessionStorage.getItem(key) ?? 'null');
    const out = {
      swap: read('probe.swap'),
      reveal: read('probe.reveal'),
      snapshots: read('probe.snapshots') ?? [],
    };
    sessionStorage.removeItem('probe.swap');
    sessionStorage.removeItem('probe.reveal');
    sessionStorage.removeItem('probe.snapshots');
    return out;
  });
}

const one = (where: string, title: string): Side => ({
  transition: true,
  media: [where],
  title: [title],
  portrait: [],
});

const none: Side = { transition: false, media: [], title: [], portrait: [] };

async function expectSides(page: Page, swap: Side, reveal: Side) {
  if (isA11y()) {
    const observed = await sides(page);
    expect(observed.swap).toEqual(swap);
    expect(observed.reveal).toEqual(reveal);
    for (const [elements, name] of [
      [reveal.media, 'doc-media'],
      [reveal.title, 'doc-title'],
      [reveal.portrait, 'person-portrait'],
    ] as const) {
      if (!elements.length) continue;
      expect(observed.snapshots).toContain(`::view-transition-old(${name})`);
      expect(observed.snapshots).toContain(`::view-transition-new(${name})`);
    }
  }
  await transitionSettled(page);
  await expect(page.locator('[data-transition]')).toHaveCount(0);
}

async function openPairSource(page: Page, path: string) {
  if (isA11y()) await page.addInitScript(probe);
  expect((await page.goto(path))?.status()).toBe(200);
  // Consume the initial reveal before clicking. Otherwise sides() can read it before the
  // destination's view transition is ready and mistake it for that navigation's reveal.
  if (isA11y()) await sides(page);
}

export async function exerciseFloatingPairs(page: Page) {
  const path = await seedOverviewCards(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await openPairSource(page, path);
  await expect(page.locator('script[src="/_site/transitions.js"]')).toHaveAttribute(
    'blocking',
    'render'
  );
  const card = page.locator('.overview-card').filter({ hasText: LONG });

  // Card to article: the card's image and title fly to the header's.
  await card.getByRole('link').click();
  await expect(page.locator('h1')).toHaveText(LONG);
  await expectSides(page, one('card', 'card'), one('header', 'h1'));

  // Back: the header's fly back to the card that led there.
  await page.goBack();
  await expect(card).toBeVisible();
  await expectSides(page, one('header', 'h1'), one('card', 'card'));

  // Reduced motion: the theme's rule starts no transition, so nothing is named.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await card.getByRole('link').click();
  await expect(page.locator('h1')).toHaveText(LONG);
  await expectSides(page, none, none);
}

async function seedCardLinks(page: Page): Promise<string> {
  const suffix = randomUUID().slice(0, 8);
  const principal = systemPrincipal(await tenantId(), 'e2e');
  return withInvoker(async (invoker) => {
    const author = await invoker.run(useCases.createPerson, principal, {
      slug: `verborgen-auteur-${suffix}`,
      name: 'Bo de Vries',
      pagePolicy: 'never',
    });
    const content = { defaultLocale: 'nl', locales: ['nl'] };
    const publish = async (itemId: string, revisionId: string) =>
      invoker.run(useCases.publishItem, principal, { itemId, revisionId, locale: 'nl' });
    const article = await invoker.run(useCases.createItem, principal, {
      slug: `stadsnatuur-${suffix}`,
      document: {
        ...content,
        type: 'article',
        title: { nl: 'Stadsnatuur' },
        authorIds: [author.id],
        blocks: [],
      },
    });
    await publish(article.item.id, article.revision.id);
    const slug = `lees-verder-${suffix}`;
    const source = await invoker.run(useCases.createItem, principal, {
      slug,
      document: {
        ...content,
        type: 'page',
        title: { nl: 'Lees verder' },
        blocks: [
          {
            type: 'cards',
            version: 1,
            props: {
              cards: [
                {
                  title: { nl: 'Meer groen' },
                  actions: [
                    {
                      label: { nl: 'Lees over bomen' },
                      target: { kind: 'url', url: '/articles/bomen-in-de-straat' },
                    },
                  ],
                },
                {
                  title: { nl: 'Natuur in de stad' },
                  actions: [
                    {
                      label: { nl: 'Lees over stadsnatuur' },
                      target: { kind: 'item', itemId: article.item.id },
                    },
                  ],
                },
              ],
            },
          },
        ],
      },
    });
    await publish(source.item.id, source.revision.id);
    return `/probe/${slug}`;
  });
}

export async function exerciseCardsPair(page: Page) {
  const path = await seedCardLinks(page);
  await openPairSource(page, path);

  const cta = page.getByRole('link', { name: 'Lees over bomen', exact: true });
  const heading = page.locator('main h1');
  const cardTitle = { ...none, transition: true, title: ['cards-title'] };
  const articleTitle = { ...none, transition: true, title: ['h1'] };

  await cta.click();
  await expect(heading).toHaveText('Bomen in de straat');
  await expectSides(page, cardTitle, articleTitle);
  await page.goBack();
  await expect(cta).toBeVisible();
  await expectSides(page, articleTitle, cardTitle);

  // A text-only byline is still readable, without a link for the pairing script to pick up.
  await page.getByRole('link', { name: 'Lees over stadsnatuur' }).click();
  await expect(page.locator('.page-meta')).toContainText('Bo de Vries');
  await expect(page.locator('.page-meta a')).toHaveCount(0);
  await expectSides(page, cardTitle, articleTitle);
  await page.goBack();
  await expect(cta).toBeVisible();
  await expectSides(page, articleTitle, cardTitle);

  await page.emulateMedia({ reducedMotion: 'reduce' });
  await cta.click();
  await expect(heading).toHaveText('Bomen in de straat');
  await expectSides(page, none, none);
}

export async function exerciseBylinePair(page: Page) {
  await openPairSource(page, '/probe/articles/bomen-in-de-straat');

  const byline = page.locator('.page-meta').getByRole('link', { name: 'Sam de Vries' });
  const heading = page.locator('main h1');
  const authorLink = { ...none, transition: true, portrait: ['byline-link'] };
  const profilePortrait = { ...none, transition: true, portrait: ['profile-portrait'] };

  await byline.click();
  await expect(heading).toHaveText('Sam de Vries');
  await expectSides(page, authorLink, profilePortrait);
  await page.goBack();
  await expect(byline).toBeVisible();
  await expectSides(page, profilePortrait, authorLink);

  await page.emulateMedia({ reducedMotion: 'reduce' });
  await byline.click();
  await expect(heading).toHaveText('Sam de Vries');
  await expectSides(page, none, none);
}
