// Every article card style a site's theme can choose (`cardStyle`, with `cardImage`), in a
// browser on a site of its own: the pair the card stands in at rest and when pointed at, in the
// light and the dark palette, the shape of its image area, axe on every style at rest and in
// focus (the facts line is the caption colour of the background it stands on, which only a
// rendered page can measure), and the layout at 320 px with 200% text. tokens.test.ts holds the
// lines each choice adds; this proves the stylesheet that reads them.
// Rejected: switching the theme of the shared `probe` tenant, which repaints every other test's
// cards while it runs.
import {
  CARD_IMAGES,
  CARD_STYLES,
  DEFAULT_THEME,
  systemPrincipal,
  useCases,
  type CardStyle,
  type Palette,
} from '@mycel/core';
import { testTenant } from '@mycel/db/testing';
import { expect, type Page } from '@playwright/test';
import { expectNoAxeViolations } from '../axe';
import { asOwner, withInvoker } from '../invoker';
import { NARROW, layoutGate, setTextSize } from '../layout';
import { isA11y } from '../project';

const rgb = (hex: string) =>
  `rgb(${[1, 3, 5].map((offset) => parseInt(hex.slice(offset, offset + 2), 16)).join(', ')})`;
const NONE = 'rgba(0, 0, 0, 0)';

type Paint = { color: string; background: string; title: string };

/** What each style paints at rest and when pointed at, from the palette's own pairs. */
function expected(style: CardStyle, p: Palette): { rest: Paint; hover: Paint } {
  const pair = (fg: string, bg: string, title = fg): Paint => ({
    color: rgb(fg),
    background: bg === NONE ? NONE : rgb(bg),
    title: rgb(title),
  });
  const primary = pair(p.primary.foreground, p.primary.background);
  switch (style) {
    case 'surface':
      return { rest: pair(p.surface.foreground, p.surface.background), hover: primary };
    case 'outline':
      return { rest: pair(p.body.foreground, p.body.background), hover: primary };
    case 'plain':
      return {
        rest: pair(p.body.foreground, NONE),
        hover: pair(p.body.foreground, NONE, p.link),
      };
    case 'primary':
      return { rest: primary, hover: pair(p.primary.background, p.primary.foreground) };
  }
}

export async function exerciseCardStyles(page: Page, stamp: string) {
  const slug = `cards-${stamp}`;
  const tenant = await asOwner((owner) =>
    testTenant(owner, slug, {
      name: 'Card styles',
      locales: ['nl'],
      platformDomain: process.env['PLATFORM_DOMAIN']!,
    })
  );
  const principal = systemPrincipal(tenant.id, 'e2e');
  await withInvoker(async (invoker) => {
    const section = await invoker.run(useCases.createSection, principal, {
      slug: 'nieuws',
      title: { nl: 'Nieuws' },
    });
    const publish = (itemId: string, revisionId: string) =>
      invoker.run(useCases.publishItem, principal, { itemId, revisionId, locale: 'nl' });
    for (const [itemSlug, title] of [
      ['vrijwilliger', 'Een dag met een vrijwilliger'],
      ['fauna', 'Zes nieuwe faunapassages in één jaar'],
    ] as const) {
      const { item, revision } = await invoker.run(useCases.createItem, principal, {
        slug: itemSlug,
        document: {
          type: 'article',
          defaultLocale: 'nl',
          locales: ['nl'],
          title: { nl: title },
          lead: { nl: `Kort over ${title.toLowerCase()}, in één zin die op een kaart past.` },
          sectionId: section.id,
          blocks: [],
        },
      });
      await publish(item.id, revision.id);
    }
    const { item, revision } = await invoker.run(useCases.createItem, principal, {
      slug: 'kaarten',
      document: {
        type: 'page',
        defaultLocale: 'nl',
        locales: ['nl'],
        title: { nl: 'Kaarten' },
        blocks: [{ type: 'overview', version: 1, props: { sectionId: section.id } }],
      },
    });
    await publish(item.id, revision.id);
  });

  const card = page.locator('.overview-card').first();
  const paint = (): Promise<Paint> =>
    card.evaluate((c) => {
      const own = getComputedStyle(c);
      return {
        color: own.color,
        background: own.backgroundColor,
        title: getComputedStyle(c.querySelector('.overview-card-title')!).color,
      };
    });

  for (const [index, cardStyle] of CARD_STYLES.entries()) {
    // Both image shapes pass by, each under two styles.
    const cardImage = CARD_IMAGES[index % CARD_IMAGES.length]!;
    await withInvoker(async (invoker) => {
      const { version } = await invoker.run(useCases.getSiteTheme, principal, {});
      await invoker.run(useCases.updateSiteTheme, principal, {
        baseVersion: version,
        theme: { ...DEFAULT_THEME, cardStyle, cardImage },
      });
    });
    const label = `${cardStyle}, ${cardImage}`;
    for (const mode of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: mode });
      await page.mouse.move(0, 0);
      // A query of its own: the page may stay fresh in the browser for a minute, with the
      // previous style's stylesheet in it.
      expect((await page.goto(`/${slug}/kaarten?style=${cardStyle}-${mode}`))?.status()).toBe(200);
      await expect(page.locator('.overview-card')).toHaveCount(2);
      const want = expected(cardStyle, DEFAULT_THEME.palettes[mode]);
      expect(await paint(), `${label}, ${mode}, at rest`).toEqual(want.rest);
      const box = (await card.boundingBox())!;
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      expect(await paint(), `${label}, ${mode}, pointed at`).toEqual(want.hover);
    }
    await page.emulateMedia({ colorScheme: 'light' });
    await page.mouse.move(0, 0);

    // The image area has the site's one shape, here on the placeholder of a card without image.
    const [w, h] = cardImage.split(':').map(Number) as [number, number];
    const area = (await card.locator('.campaign-card-image').boundingBox())!;
    expect(Math.abs(area.width / area.height - w / h), `${label}: image area`).toBeLessThan(0.02);

    await expectNoAxeViolations(page, { label: `card style ${label}`, dark: true });
    if (isA11y()) {
      await card.locator('a').focus();
      await expectNoAxeViolations(page, { label: `card style ${label} in focus`, dark: true });
    }
    await page.setViewportSize(NARROW);
    await setTextSize(page, '200%');
    await layoutGate(page, `card style ${label} at 320 px and 200% text`, 'main');
    await setTextSize(page, '16px');
    await page.setViewportSize({ width: 1280, height: 900 });
  }
}
