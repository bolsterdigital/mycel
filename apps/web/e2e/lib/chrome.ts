// Site chrome rails: the public page's named rails, measured against the page's own CSS, and an
// item preview's chrome against its public page. Split from layout.ts, which reached its size
// ceiling; the subject is the chrome, not a block.

import { expect, type Frame, type Page } from '@playwright/test';

// The public page's named rails, measured against the page's own CSS
// (docs/architecture/content-layout.md § Site chrome). A probe element of each rail is added to
// the page and measured, so the expectation is whatever base.css makes of this container, never a
// number copied here.
// Rejected: recomputing the rails in the test, which passes as long as test and CSS share a mistake.

type Box = { left: number; right: number; top: number; bottom: number };

/** Where the header, footer and the page's first and last content sit, plus the rails. */
export async function chromeRails(page: Page | Frame) {
  // A login lands on its URL before `load`: measured then, the chrome had no stylesheet yet.
  await page.waitForLoadState('load');
  await page.evaluate(() => document.fonts.ready);
  return page.evaluate(() => {
    const box = (el: Element | null | undefined): Box | null => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
    };
    const main = document.querySelector('main.page')!;
    const rail = (className: string) => {
      const probe = document.createElement('div');
      probe.className = className;
      main.append(probe);
      const r = box(probe)!;
      probe.remove();
      return r;
    };
    // A preview wraps each block in a `display: contents` wrapper, which has no box of its own.
    const edge = (pick: (el: Element) => Element | null): Element | null => {
      let el = pick(main);
      while (el && getComputedStyle(el).display === 'contents') el = pick(el);
      return el;
    };
    const style = getComputedStyle(main);
    return {
      wide: rail('layout-wide'),
      header: box(document.querySelector('.site-header')),
      identity: box(document.querySelector('.site-header .site-identity')),
      nav: box(document.querySelector('.site-header nav')),
      footer: box(document.querySelector('.site-footer')),
      footerParts: [...(document.querySelector('.site-footer')?.children ?? [])].map(box),
      links: [...document.querySelectorAll('.site-header a, .site-footer a')].map((a) =>
        a.getAttribute('href')
      ),
      first: box(edge((el) => el.firstElementChild)),
      last: box(edge((el) => el.lastElementChild)),
      padding: [parseFloat(style.paddingBlockStart), parseFloat(style.paddingBlockEnd)],
    };
  });
}

export type Rails = Awaited<ReturnType<typeof chromeRails>>;

/** Header and footer content start and end on the wide rail. The navigation ends on the rail in
 *  the logo's row, or starts on it under the logo; `oneRow` demands the first, without it the
 *  row the browser chose is checked. */
export function expectChromeOnWideRail(m: Rails, oneRow?: boolean) {
  const { wide, identity, nav } = m;
  expect(Math.abs(identity!.left - wide.left)).toBeLessThanOrEqual(1);
  if (nav) {
    oneRow ??= nav.top < identity!.bottom;
    expect(nav.right).toBeLessThanOrEqual(wide.right + 1);
    if (oneRow) {
      expect(nav.top).toBeLessThan(identity!.bottom);
      expect(Math.abs(nav.right - wide.right)).toBeLessThanOrEqual(1);
    } else {
      expect(nav.top).toBeGreaterThanOrEqual(identity!.bottom);
      expect(Math.abs(nav.left - wide.left)).toBeLessThanOrEqual(1);
    }
  }
  for (const part of m.footerParts) {
    expect(Math.abs(part!.left - wide.left)).toBeLessThanOrEqual(1);
    expect(part!.right).toBeLessThanOrEqual(wide.right + 1);
  }
}

/** Header to first content and last content to footer are the page's padding, whatever the
 *  first and last element are, and the two are the same distance. */
export function expectChromeTransitions(m: Rails) {
  const [top, bottom] = m.padding as [number, number];
  if (m.header) expect(m.first!.top - m.header.bottom).toBeCloseTo(top, 0);
  if (m.footer) expect(m.footer.top - m.last!.bottom).toBeCloseTo(bottom, 0);
  expect(bottom).toBeGreaterThanOrEqual(32);
}

/** An item preview (saved, or live in the editor's frame) shows its public page's chrome at the
 *  same width: the same parts, header height, rails and transitions, and every site link under
 *  the preview's `base`, so following one never leaves the platform origin by itself (ADR 014). */
export function expectPreviewChrome(preview: Rails, site: Rails, base: string) {
  const parts = (m: Rails) => [!m.nav, m.footerParts.length, m.links.length];
  const height = (m: Rails) => m.header!.bottom - m.header!.top;
  expect(parts(preview)).toEqual(parts(site));
  expect(height(preview)).toBeCloseTo(height(site), 0);
  expectChromeOnWideRail(preview, site.nav ? site.nav.top < site.identity!.bottom : undefined);
  expectChromeTransitions(preview);
  for (const href of preview.links)
    if (href?.startsWith('/')) expect(href).toMatch(new RegExp(`^${base}(/|$)`));
}
