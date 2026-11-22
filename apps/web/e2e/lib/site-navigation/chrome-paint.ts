// The painted chrome (MY-266 PR B, brief public-chrome-polish § Klaar als 1, 2): the header and the
// footer stand in the role pair the theme chose for each, their links take that pair's text and
// carry no underline at rest, hover and focus underline, the current page is bold and underlined,
// and a link in running text keeps its underline. One site walks all four chrome roles for the
// header and the footer; axe (light and dark) on its front page, an article and the open menu.
// Assertions compare colours with the theme and elements with each other, never pixel widths.
// Rejected: a test per role in its own tenant (four seeds for what one theme update shows) and a
// new spec file (the spec budget is full; ui-gate.spec.ts calls this).
import { THEME_PRESETS, systemPrincipal, useCases } from '@mycel/core';
import { testTenant } from '@mycel/db/testing';
import { type Page, expect } from '@playwright/test';
import { expectNoAxeViolations } from '../axe';
import { asOwner, withInvoker } from '../invoker';
import { isA11y } from '../project';
import { publishMenus } from './seed';

const PRESET = THEME_PRESETS.campaign;
/** Header and footer role per step: every role once for each, the default first. */
const STEPS = [
  ['primary', 'primary'],
  ['surface', 'accent'],
  ['accent', 'body'],
  ['body', 'surface'],
] as const;
type Role = (typeof STEPS)[number][number];

const rich = (nl: object[]) => ({ nl: { type: 'doc' as const, content: nl } });
const prose = rich([
  {
    type: 'paragraph',
    content: [
      { type: 'text', text: 'Lees ook ' },
      { type: 'text', text: 'het verslag', marks: [{ type: 'link', attrs: { href: '/x' } }] },
      { type: 'text', text: '.' },
    ],
  },
]);

export interface ChromePaintFixture {
  slug: string;
  tenantId: string;
}

/** A Dutch and English site with a home page, an article and every kind of placed menu. */
export async function seedChromePaint(slug: string): Promise<ChromePaintFixture> {
  const tenant = await asOwner((owner) =>
    testTenant(owner, slug, {
      name: 'Chrome paint',
      locales: ['nl', 'en'],
      platformDomain: process.env['PLATFORM_DOMAIN']!,
    })
  );
  await withInvoker(async (invoker) => {
    const principal = systemPrincipal(tenant.id, 'e2e');
    const ids: string[] = [];
    for (const [type, itemSlug, title] of [
      ['page', 'home', 'Welkom'],
      ['article', 'verslag', 'Een verslag'],
    ] as const) {
      const { item, revision } = await invoker.run(useCases.createItem, principal, {
        slug: itemSlug,
        document: {
          type,
          defaultLocale: 'nl',
          locales: ['nl'],
          title: { nl: title },
          blocks: [{ id: 'text', type: 'rich-text', version: 1, props: { content: prose } }],
        },
      });
      await invoker.run(useCases.publishItem, principal, {
        itemId: item.id,
        revisionId: revision.id,
        locale: 'nl',
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
          { href: 'https://example.org/doneer', label: label('Doneer nu') },
          { href: 'https://example.org/doe-mee', label: label('Doe mee') },
        ],
        footer: [{ itemId: ids[0]!, label: label('Voorpagina') }],
        footerTitle: label('Over ons'),
        legal: [{ href: 'https://example.org/privacy', label: label('Privacy') }],
      },
      ['nl', 'en']
    );
  });
  return { slug, tenantId: tenant.id };
}

const setChrome = (tenantId: string, baseVersion: number, header: Role, footer: Role) =>
  withInvoker((invoker) =>
    invoker.run(useCases.updateSiteTheme, systemPrincipal(tenantId, 'e2e'), {
      baseVersion,
      theme: { ...PRESET, chrome: { header, footer } },
    })
  );

const rgb = (hex: string) => {
  const n = parseInt(hex.slice(1), 16);
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
};
/** A button's colours are a `color-mix` at rest, which Chromium serialises as `color(srgb …)`. */
const asRgb = (css: string) => {
  const srgb = /^color\(srgb ([\d.]+) ([\d.]+) ([\d.]+)\)$/.exec(css);
  return srgb
    ? `rgb(${srgb
        .slice(1)
        .map((c) => Math.round(Number(c) * 255))
        .join(', ')})`
    : css;
};

/** Colours and link decoration of the chrome as rendered, in the light scheme. */
const paint = (page: Page) =>
  page.evaluate(() => {
    const style = (selector: string) => getComputedStyle(document.querySelector(selector)!);
    const links = [...document.querySelectorAll('.site-header a, .site-footer a')]
      .filter((a) => !a.classList.contains('button') && a.checkVisibility())
      .map((a) => {
        const s = getComputedStyle(a);
        return {
          text: a.textContent!.trim(),
          current: a.hasAttribute('aria-current'),
          line: s.textDecorationLine,
          bold: Number(s.fontWeight) >= 700,
        };
      });
    const action = style('.site-tools > .site-action:not(.secondary)');
    return {
      header: [style('.site-header').color, style('.site-header').backgroundColor],
      footer: [style('.site-footer').color, style('.site-footer').backgroundColor],
      body: style('body').backgroundColor,
      action: [action.color, action.backgroundColor],
      links,
      prose: style('main p a').textDecorationLine,
    };
  });

export async function exerciseChromePaint(page: Page, { slug, tenantId }: ChromePaintFixture) {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.emulateMedia({ colorScheme: 'light' });
  const light = PRESET.palettes.light;
  const pair = (role: Role) => [rgb(light[role].foreground), rgb(light[role].background)];
  let version = 0;
  for (const [header, footer] of STEPS) {
    ({ version } = await setChrome(tenantId, version, header, footer));
    await page.goto(`/${slug}/home`);
    // Inside the public freshness window a navigation may reuse the old HTML; reload revalidates.
    await page.reload();
    const seen = await paint(page);
    seen.action = seen.action.map(asRgb);
    const step = `header ${header}, footer ${footer}`;
    expect(seen.header, step).toEqual(pair(header));
    expect(seen.footer, step).toEqual(pair(footer));
    if (header === 'primary') {
      expect(seen.header[1], 'a primary header parts from the body').not.toBe(seen.body);
      expect(seen.action, 'the first action inverts on a primary header').toEqual(
        pair('primary').reverse()
      );
    } else expect(seen.action, step).toEqual(pair('primary'));
    // At rest only the current page is underlined (and bold); running text keeps its underline.
    expect(seen.links.length, step).toBeGreaterThan(3);
    for (const link of seen.links)
      expect([link.text, link.line, link.bold], step).toEqual(
        link.current ? [link.text, 'underline', true] : [link.text, 'none', link.bold]
      );
    expect(seen.links.some((l) => l.current)).toBe(true);
    expect(seen.prose, 'a link in running text').toBe('underline');
    await expectNoAxeViolations(page, { label: `front page, ${step}`, dark: true });
  }
  await page.emulateMedia({ colorScheme: 'light' });

  // Hover and keyboard focus underline a chrome link.
  const search = page.locator('.site-search-link');
  const line = () => search.evaluate((a) => getComputedStyle(a).textDecorationLine);
  await search.hover();
  expect(await line()).toBe('underline');
  await page.mouse.move(0, 600);
  expect(await line()).toBe('none');
  await page.keyboard.press('Tab');
  for (let i = 0; i < 12 && !(await search.evaluate((a) => a === document.activeElement)); i++)
    await page.keyboard.press('Tab');
  expect(await search.evaluate((a) => a.matches(':focus-visible'))).toBe(true);
  expect(await line()).toBe('underline');

  // The menu panel on the body pair: its links rest without underline, the current one bold.
  await page.locator('.site-menu-toggle').click();
  const panel = page.locator(isA11y() ? '.site-dialog .site-panel' : '.site-panel');
  await expect(panel).toBeVisible();
  // The dialog slides in; axe measures colours, so it waits for the slide to end.
  await page.evaluate(() =>
    Promise.all(document.getAnimations().map((animation) => animation.finished))
  );
  const panelLinks = await panel
    .locator('.site-tree a')
    .evaluateAll((all) =>
      all.map((a) => [
        a.hasAttribute('aria-current'),
        getComputedStyle(a).textDecorationLine,
        getComputedStyle(a).color,
      ])
    );
  expect(panelLinks.length).toBeGreaterThan(1);
  for (const [current, decoration, colour] of panelLinks) {
    expect(decoration).toBe(current ? 'underline' : 'none');
    expect(colour).toBe(rgb(light.body.foreground));
  }
  await expectNoAxeViolations(page, { label: 'open menu', dark: true });

  await page.goto(`/${slug}/articles/verslag`);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Een verslag');
  await expectNoAxeViolations(page, { label: 'article', dark: true });
}
