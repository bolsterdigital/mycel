// One row on a phone and a sticky header (MY-266 PR D, brief public-chrome-polish § Klaar als 3
// and 4). With JavaScript the bar's candidates leave for the panel in a fixed order as the screen
// narrows (the links, the second call to action, Language, Search), so a phone keeps one row; a
// header of one row that takes at most a fifth of the viewport stays at the top, any other stays
// in the flow, and an anchor, the skip link's target and the keyboard focus land below it (WCAG
// 2.4.11). Without JavaScript nothing is sticky and Search and Language stay in the bar. The first
// call to action is Otterdam's long one, so on CI's font a 375 px phone keeps its row only with
// the label wrapping inside the button (`data-tight`).
// The site has a logo (MY-266 PR F): the name beside it leaves after the links and before the
// second call to action, the link keeps the name as its accessible name, and at 1280 px the header
// is no taller than its logo (at most 3rem) or a tap target, plus 0.75rem above and below. A logo
// that carries the name stands alone (MY-275).
// Assertions are relational (a prefix of the order, one row, below the header), never a count of
// links or a pixel width: CI's font is wider than a Mac's.
// Rejected: a new spec file (the spec budget is full; ui-gate.spec.ts calls this) and checking
// only that focus is not entirely hidden (`focusObscuredProblems`), which a link half under the
// header passes.
import { systemPrincipal, useCases } from '@mycel/core';
import { testTenant } from '@mycel/db/testing';
import { createBrandProcessor } from '@mycel/media-sharp';
import { type Page, expect } from '@playwright/test';
import { asOwner, withInvoker } from '../../invoker';
import { expectNoAxeViolations } from '../../axe';
import { layoutGate, setTextSize } from '../../layout';
import { isA11y } from '../../project';
import { publishMenus } from '../seed';

const doc = (content: object[]) => ({ type: 'doc' as const, content });
const linked = (i: number) => ({
  type: 'paragraph',
  content: [
    { type: 'text', text: `Alinea ${i} met ` },
    { type: 'text', text: `link ${i}`, marks: [{ type: 'link', attrs: { href: `/x${i}` } }] },
    { type: 'text', text: '.' },
  ],
});
const prose = (from: number) => doc(Array.from({ length: 12 }, (_, i) => linked(from + i)));

/** A Dutch and English home page long enough to scroll, with links above and below a heading
 *  `doel`, a logo, and every candidate the bar has: two links, two calls to action, Search,
 *  Language, the name beside the logo. Returns the tenant's id. */
export async function seedSticky(slug: string) {
  const tenant = await asOwner((owner) =>
    testTenant(owner, slug, {
      name: 'Kopbalk',
      locales: ['nl', 'en'],
      platformDomain: process.env['PLATFORM_DOMAIN']!,
    })
  );
  await withInvoker(async (invoker) => {
    const principal = systemPrincipal(tenant.id, 'e2e');
    const text = (id: string, from: number) => ({
      id,
      type: 'rich-text' as const,
      version: 1 as const,
      props: { content: { nl: prose(from), en: prose(from) } },
    });
    const ids: string[] = [];
    for (const [type, itemSlug, locales, blocks] of [
      [
        'page',
        'home',
        ['nl', 'en'],
        [
          text('voor', 0),
          {
            id: 'doel',
            type: 'heading' as const,
            version: 1 as const,
            props: { text: { nl: 'Het doel', en: 'The goal' } },
          },
          text('na', 12),
        ],
      ],
      ['article', 'verslag', ['nl'], []],
    ] as const) {
      const { item, revision } = await invoker.run(useCases.createItem, principal, {
        slug: itemSlug,
        document: {
          type,
          defaultLocale: 'nl',
          locales: [...locales],
          title: locales.length > 1 ? { nl: 'Welkom', en: 'Welcome' } : { nl: 'Verslag' },
          blocks: [...blocks],
        },
      });
      for (const locale of locales)
        await invoker.run(useCases.publishItem, principal, {
          itemId: item.id,
          revisionId: revision.id,
          locale,
        });
      ids.push(item.id);
    }
    const label = (nl: string) => ({ nl, en: nl });
    await publishMenus(
      invoker,
      principal,
      {
        main: [
          { itemId: ids[0]!, label: label('Welkom') },
          { itemId: ids[1]!, label: label('Verslag') },
        ],
        actions: [
          { href: 'https://example.org/teken', label: label('Teken de petitie') },
          { href: 'https://example.org/doe-mee', label: label('Doe mee') },
        ],
        footer: [{ itemId: ids[0]!, label: label('Voorpagina') }],
      },
      ['nl', 'en']
    );
  });
  // A landscape logo, 2.5 : 1 like Otterdam's mark with its name beside it.
  await withInvoker(
    (invoker) =>
      invoker.run(useCases.putBrandAsset, systemPrincipal(tenant.id, 'e2e'), {
        kind: 'logo',
        baseVersion: 0,
        contentType: 'image/svg+xml',
        bytes: Buffer.from(
          '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="80"><rect width="200" height="80" fill="#123456"/></svg>'
        ).toString('base64'),
      }),
    { brandProcessor: createBrandProcessor() }
  );
  return tenant.id;
}

/** The header as the script left it, measured independently of the script's own rule. */
const header = (page: Page) =>
  page.evaluate(() => {
    const el = document.querySelector('.site-header')!;
    const tools = el.querySelector('.site-tools')!;
    const order = [
      tools.querySelector(':scope > .site-search-link'),
      tools.querySelector(':scope > .site-languages'),
      tools.querySelector(':scope > [data-site-candidate]'),
      el.querySelector('.site-identity > [data-site-name]'),
      ...el.querySelectorAll('.site-bar > ul > li'),
    ];
    const parts = [
      el.querySelector('.site-identity'),
      el.querySelector('.site-bar'),
      ...tools.children,
    ]
      .filter((p) => p?.getClientRects().length)
      .map((p) => p!.getBoundingClientRect());
    const r = el.getBoundingClientRect();
    const css = getComputedStyle(el);
    const px = (v: string) => parseFloat(v) || 0;
    const rem = px(getComputedStyle(document.documentElement).fontSize);
    return {
      // In rem: the header's padding and logo, and its height against the tallest of the logo
      // and the tools beside it (tap targets), plus that padding and the borders.
      pad: [px(css.paddingBlockStart) / rem, px(css.paddingBlockEnd) / rem],
      logo: (el.querySelector('.site-identity img')?.getBoundingClientRect().height ?? 0) / rem,
      excess:
        (r.height -
          Math.max(
            el.querySelector('.site-identity img')?.getBoundingClientRect().height ?? 0,
            ...[...tools.children]
              .filter((c) => c.getClientRects().length)
              .map((c) => c.getBoundingClientRect().height)
          ) -
          px(css.paddingBlockStart) -
          px(css.paddingBlockEnd) -
          px(css.borderBlockStartWidth) -
          px(css.borderBlockEndWidth)) /
        rem,
      shown: order.map((c) => !!c?.checkVisibility()),
      oneRow: Math.max(...parts.map((p) => p.top)) < Math.min(...parts.map((p) => p.bottom)),
      share: r.height / innerHeight,
      sticky: el.hasAttribute('data-sticky'),
      position: getComputedStyle(el).position,
      top: r.top,
      bottom: r.bottom,
    };
  });

/** The focused element, unless it is in the header, with how far its top lies below the header. */
const focusBelowHeader = (page: Page) =>
  page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el || el === document.body || el.closest('.site-header')) return null;
    const bottom = document.querySelector('.site-header')!.getBoundingClientRect().bottom;
    return {
      name: el.textContent!.trim().slice(0, 30),
      gap: el.getBoundingClientRect().top - bottom,
    };
  });

async function scrollDown(page: Page) {
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight / 2));
}

export async function exerciseSticky(page: Page, slug: string, tenantId: string) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/${slug}/home`);

  if (!isA11y()) {
    // Without JavaScript the baseline: in the flow, Search and Language in the bar.
    const seen = await header(page);
    expect(seen).toMatchObject({ sticky: false, position: 'relative' });
    // Without JavaScript: Search, Language and the name beside the logo; the second call to
    // action only in the panel.
    expect(seen.shown.slice(0, 4)).toEqual([true, true, false, true]);
    await scrollDown(page);
    expect((await header(page)).bottom).toBeLessThan(0);
    return;
  }

  // From wide to narrow the candidates leave in order: what the bar shows is always a prefix of
  // Search, Language, the second call to action, the name beside the logo, the links, and it only
  // shrinks. Sticky exactly
  // when the header is one row of at most a fifth of the viewport.
  await expect(page.locator('.site-header')).toHaveAttribute('data-enhanced', '');
  let before = Infinity;
  const counts: number[] = [];
  for (let width = 1440; width >= 320; width -= 16) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate(() => new Promise(requestAnimationFrame));
    await page.evaluate(() => new Promise(requestAnimationFrame));
    const seen = await header(page);
    const count = seen.shown.indexOf(false) === -1 ? seen.shown.length : seen.shown.indexOf(false);
    expect(seen.shown.slice(count), `a prefix at ${width} px`).not.toContain(true);
    expect(count, `nothing returns at ${width} px`).toBeLessThanOrEqual(before);
    expect(seen.sticky, `sticky rule at ${width} px`).toBe(seen.oneRow && seen.share <= 0.2);
    before = count;
    counts.push(count);
  }
  expect(counts[0], 'everything fits on a wide screen').toBe(6);
  expect(counts.at(-1), 'a phone sends candidates to the panel').toBeLessThan(6);

  // Sticky at 1280 and on a phone at standard text; the focus and anchors land below it.
  for (const [width, height] of [
    [1280, 900],
    [375, 812],
  ] as const) {
    await page.setViewportSize({ width, height });
    await page.goto(`/${slug}/home`);
    await expect(page.locator('.site-header')).toHaveAttribute('data-sticky', '');
    const seen = await header(page);
    expect(seen.oneRow, `one row at ${width} px`).toBe(true);
    // About 74 px with a logo (MY-266 PR F): 0.75rem padding, a logo of at most 3rem, and nothing
    // taller than the logo or a tap target in the row.
    expect(
      seen.pad.every((p) => p <= 0.76),
      `padding at ${width} px`
    ).toBe(true);
    expect(seen.logo, `logo at ${width} px`).toBeLessThanOrEqual(3.01);
    expect(seen.excess, `height at ${width} px`).toBeLessThanOrEqual(0.05);
    // The name leaves first of the header's own parts on a phone; the link keeps it as its name.
    expect(seen.shown[3], `name beside the logo at ${width} px`).toBe(width > 1000);
    await expect(page.locator('.site-identity')).toHaveAccessibleName('Kopbalk');
    await layoutGate(page, `sticky header at ${width} px`, '.site-header');
    // The measurement leaves no style attribute behind, also not in the tight state.
    await expect(page.locator('[style]'), `no style attribute at ${width} px`).toHaveCount(0);
    await scrollDown(page);
    expect((await header(page)).top, `at the top at ${width} px`).toBeCloseTo(0, 0);

    // The skip link's target.
    await page.keyboard.press('Tab');
    await expect(page.locator('.public-skip')).toBeFocused();
    await page.keyboard.press('Enter');
    const main = await page
      .locator('#public-main')
      .evaluate(
        (m) =>
          m.getBoundingClientRect().top -
          document.querySelector('.site-header')!.getBoundingClientRect().bottom
      );
    expect(main, `skip target below the header at ${width} px`).toBeGreaterThanOrEqual(-0.5);

    // A block anchor, then ten Tabs forward and ten back from it: the links above the anchor
    // scroll into view from above, where the header would cover them.
    await page.goto(`/${slug}/home#block-doel`);
    const anchor = await page
      .locator('#block-doel')
      .evaluate(
        (a) =>
          a.getBoundingClientRect().top -
          document.querySelector('.site-header')!.getBoundingClientRect().bottom
      );
    expect(anchor, `anchor below the header at ${width} px`).toBeGreaterThanOrEqual(-0.5);
    for (const key of [...Array(10).fill('Tab'), ...Array(20).fill('Shift+Tab')]) {
      await page.keyboard.press(key);
      const focus = await focusBelowHeader(page);
      if (focus) expect(focus.gap, `${focus.name} at ${width} px`).toBeGreaterThanOrEqual(-0.5);
    }
  }

  // At 320 px and 200% text the header is more than one row or more than a fifth: in the flow.
  await page.setViewportSize({ width: 320, height: 568 });
  await page.goto(`/${slug}/home`);
  await setTextSize(page, '200%');
  await expect(page.locator('.site-header')).not.toHaveAttribute('data-sticky');
  await expect(page.locator(':root')).not.toHaveCSS('scroll-padding-top', /\d+px/);
  await layoutGate(page, 'header at 320 px and 200% text', '.site-header');
  await scrollDown(page);
  expect((await header(page)).bottom).toBeLessThan(0);
  await setTextSize(page, '');

  // A logo that carries the name (MY-275): no visible name at any width, the same accessible name.
  await withInvoker((invoker) =>
    invoker.run(useCases.updateSiteChrome, systemPrincipal(tenantId, 'e2e'), {
      baseVersion: 0,
      chrome: { footer: {}, logoHasName: true },
    })
  );
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/${slug}/home`);
  // The public page may come from the one-minute freshness window; a reload revalidates.
  await page.reload();
  await expect(page.locator('.site-identity > span')).toHaveCount(0);
  await expect(page.locator('.site-identity')).toHaveAccessibleName('Kopbalk');
  await expectNoAxeViolations(page, { label: 'logo that carries the name' });
}
