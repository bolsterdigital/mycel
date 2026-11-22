// An overview card as a visitor uses it (MY-266 PR E, brief public-chrome-polish § 5, Klaar als 4
// and 6): the title is the card's one link, stretched over the card, so a click on the image or
// on the text under the title opens the item; the title is not underlined at rest, is sized to
// the card and keeps "faunapassages" inside it at 1280 px and at 320 px with 200% text; a mouse
// hover and the keyboard focus invert the card to the primary pair at once (no transition, no
// movement), and the focus adds a ring around the card. The generic block suite renders every
// example; this task proves the states in a browser.
// Assertions are relational (fits, same colour as the primary pair), never a pixel size: CI's
// font is wider than a Mac's. Rejected: a new spec file (the spec budget is full; ui-gate.spec.ts
// calls this).
import { expect, type Locator, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { systemPrincipal, useCases } from '@mycel/core';
import { withInvoker, tenantId } from '../invoker';
import { callApi } from '../api';
import { isA11y } from '../project';
import { expectNoAxeViolations } from '../axe';
import { NARROW, layoutGate, setTextSize } from '../layout';

const LONG = 'Zes nieuwe faunapassages in één jaar';

/** A section with two articles, the newest with a featured image and the long title, and a page
 *  with an overview of that section; its public path. */
async function seed(page: Page): Promise<string> {
  const suffix = randomUUID().slice(0, 8);
  const principal = systemPrincipal(await tenantId(), 'e2e');
  // Through the API: the e2e invoker has no image processor.
  const image = await callApi(page.request, 'media.upload', {
    ...useCases.uploadMedia.examples[0]!.input,
    filename: `kaart-${suffix}.png`,
  });
  return withInvoker(async (invoker) => {
    const section = await invoker.run(useCases.createSection, principal, {
      slug: `kaarten-${suffix}`,
      title: { nl: `Kaarten ${suffix}` },
    });
    const publish = async (itemId: string, revisionId: string) =>
      invoker.run(useCases.publishItem, principal, { itemId, revisionId, locale: 'nl' });
    for (const [slug, title, featuredImageId] of [
      ['vrijwilliger', 'Een dag met een vrijwilliger', undefined],
      ['fauna', LONG, image.id as string],
    ] as const) {
      const { item, revision } = await invoker.run(useCases.createItem, principal, {
        slug: `${slug}-${suffix}`,
        document: {
          type: 'article',
          defaultLocale: 'nl',
          locales: ['nl'],
          title: { nl: title },
          lead: { nl: `Kort over ${title.toLowerCase()}.` },
          sectionId: section.id,
          ...(featuredImageId ? { featuredImageId } : {}),
          blocks: [],
        },
      });
      await publish(item.id, revision.id);
    }
    const { item, revision } = await invoker.run(useCases.createItem, principal, {
      slug: `kaarten-${suffix}`,
      document: {
        type: 'page',
        defaultLocale: 'nl',
        locales: ['nl'],
        title: { nl: 'Kaarten' },
        blocks: [{ type: 'overview', version: 1, props: { sectionId: section.id } }],
      },
    });
    await publish(item.id, revision.id);
    return `/probe/kaarten-${suffix}`;
  });
}

/** The card's colours, and those of the primary pair as this page's theme resolves them. */
const paint = (card: Locator) =>
  card.evaluate((c) => {
    const probe = document.createElement('i');
    probe.style.color = 'var(--color-primary-fg)';
    probe.style.background = 'var(--color-primary-bg)';
    c.parentElement!.append(probe);
    const primary = getComputedStyle(probe);
    const own = getComputedStyle(c);
    const link = getComputedStyle(c.querySelector('a')!);
    const out = {
      inverted: own.color === primary.color && own.backgroundColor === primary.backgroundColor,
      ring: own.outlineStyle !== 'none' && own.outlineWidth !== '0px',
      underline: link.textDecorationLine,
      transition: own.transitionDuration.split(',').every((d) => parseFloat(d) === 0),
      transform: own.transform,
    };
    probe.remove();
    return out;
  });

/** The middle of an element, for the mouse: Playwright's own hover and click would wait for the
 *  element itself to receive the pointer, and the stretched link lies over it on purpose. */
async function middle(target: Locator) {
  const box = (await target.boundingBox())!;
  return [box.x + box.width / 2, box.y + box.height / 2] as const;
}

/** Every card title, link and all, inside its card. */
const titlesFit = (page: Page) =>
  page.locator('.overview-card-title').evaluateAll((titles) =>
    titles.map((h) => ({
      title: h.textContent!.trim(),
      fits:
        h.scrollWidth <= h.clientWidth &&
        h.getBoundingClientRect().right <=
          h.closest('.overview-card')!.getBoundingClientRect().right,
    }))
  );

export async function exerciseOverviewCards(page: Page) {
  const path = await seed(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  expect((await page.goto(path))?.status()).toBe(200);
  const cards = page.locator('.overview-card');
  await expect(cards).toHaveCount(2);
  const fauna = cards.filter({ hasText: LONG });

  // One link per card, its name the title; at rest not underlined, the surface pair.
  for (const card of await cards.all()) await expect(card.locator('a')).toHaveCount(1);
  await expect(fauna.getByRole('link')).toHaveAccessibleName(LONG);
  expect(await paint(fauna)).toMatchObject({ inverted: false, ring: false, underline: 'none' });

  // The title fits its card, at 1280 px and at 320 px with 200% text.
  for (const { title, fits } of await titlesFit(page))
    expect(fits, `${title} at 1280 px`).toBe(true);
  await page.setViewportSize(NARROW);
  await setTextSize(page, '200%');
  for (const { title, fits } of await titlesFit(page))
    expect(fits, `${title} at 320 px and 200% text`).toBe(true);
  await layoutGate(page, 'overview cards at 320 px and 200% text', 'main');
  await setTextSize(page, '16px');
  await page.setViewportSize({ width: 1280, height: 900 });

  // A mouse over the card inverts it at once and underlines the title; nothing moves.
  await page.mouse.move(...(await middle(fauna.locator('.campaign-card-image'))));
  expect(await paint(fauna)).toMatchObject({
    inverted: true,
    ring: false,
    underline: 'underline',
    transition: true,
    transform: 'none',
  });
  await page.mouse.move(0, 0);

  // The keyboard: the same inversion plus a ring around the card.
  await page.locator('h1').click();
  for (
    let i = 0;
    i < 40 && !(await fauna.locator('a').evaluate((a) => a === document.activeElement));
    i++
  )
    await page.keyboard.press('Tab');
  await expect(fauna.locator('a')).toBeFocused();
  expect(await paint(fauna)).toMatchObject({ inverted: true, ring: true, underline: 'underline' });
  if (isA11y()) await expectNoAxeViolations(page, { label: 'overview card in focus' });

  // A click on the image or on the text under the title opens the item.
  await page.mouse.move(0, 0);
  await page.mouse.click(...(await middle(fauna.locator('.campaign-card-image'))));
  await expect(page.locator('h1')).toHaveText(LONG);
  await page.goBack();
  await page.mouse.click(...(await middle(fauna.locator('.campaign-card-text > p').last())));
  await expect(page.locator('h1')).toHaveText(LONG);
}
