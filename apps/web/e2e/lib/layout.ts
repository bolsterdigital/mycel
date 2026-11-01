// The layout gate of skill ui-action-layout, measured in the browser: at 320 CSS px and at 200%
// text no page scrolls sideways, every action and field is whole, inside the viewport and a 44 px
// target, no word in an action breaks over two lines, an action group keeps DOM order and shows
// no ellipsis, and no label, legend, summary or term runs past the card or group that clips it.
// One set of checks for every route, admin and public; a spec only chooses the route, the width,
// the text size and, where a page holds more than its subject, the part it measures.
// Rejected: a copy per spec. Fifteen specs had one, in five variants, and a check added to one
// (a broken word, a label past its card) never reached the others.

import { expect, type Page } from '@playwright/test';

/** The narrow viewport of the gate: the 320 CSS px of WCAG 1.4.10 reflow. */
export const NARROW = { width: 320, height: 900 };

/** Default text and the largest setting the gate supports. */
export const TEXT_SIZES = ['100%', '200%'] as const;
export type TextSize = (typeof TEXT_SIZES)[number];

/** Set the root font size, as a browser's text-size setting does. A no-op at 100%. */
export async function setTextSize(page: Page, size: TextSize | string) {
  if (size === '100%') return;
  await page.evaluate((s) => (document.documentElement.style.fontSize = s), size);
}

/** WCAG 1.4.12 text spacing as a user stylesheet. A constructable sheet leaves the page's strict
 *  CSP untouched (an injected <style> is refused). The wider text also stands in for a wider
 *  font: a label that wraps on CI's Linux fonts and not on a Mac wraps here on both (#66 PR 6b). */
export async function setTextSpacing(page: Page) {
  await page.evaluate(() => {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(
      '* { line-height: 1.5 !important; letter-spacing: .12em !important; word-spacing: .16em !important; } p { margin-bottom: 2em !important; }'
    );
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
  });
}

/** Every problem the gate sees on the current page; `within` narrows the actions it measures. */
export function layoutProblems(page: Page, within = 'body'): Promise<string[]> {
  return page.evaluate((scope) => {
    const out: string[] = [];
    // A scope that matches nothing would measure no action at all, and pass.
    if (!document.querySelector(scope)) out.push(`nothing to measure: ${scope}`);
    const width = document.documentElement.clientWidth;
    if (document.documentElement.scrollWidth > width) {
      out.push(`page scrolls sideways: ${document.documentElement.scrollWidth} > ${width}`);
      const path = (node: Element) => {
        const parts: string[] = [];
        for (let el: Element | null = node; el && el !== document.body; el = el.parentElement)
          parts.unshift(el.tagName.toLowerCase() + [...el.classList].map((c) => `.${c}`).join(''));
        return parts.join(' > ');
      };
      // Text that overflows its own box (a label without a break) is no element of its own, so
      // count each element's content reach, not only its box; a table scrolls in its own frame.
      const past = [...document.body.querySelectorAll('*')]
        .filter((node) => !node.closest('.ui-table-scroll'))
        .map((node) => {
          const box = node.getBoundingClientRect();
          return { node, right: Math.max(box.right, box.left + node.scrollWidth) };
        })
        .filter(({ right }) => right > width + 1);
      // An ancestor reaches as far as the child that overflows it; name the innermost only.
      for (const { node, right } of past
        .filter(({ node }) => !past.some((o) => o.node !== node && node.contains(o.node)))
        .sort((a, b) => b.right - a.right)
        .slice(0, 5))
        out.push(
          `past the edge: ${path(node)} right=${Math.round(right)} text=${JSON.stringify((node.textContent ?? '').trim().slice(0, 60))}`
        );
    }
    const actions = [
      'button',
      'a.button',
      'a.ui-button',
      '.actions a',
      '.ui-button',
      '.ui-subnav a',
      '.ui-view-switch a',
      '.ui-breadcrumb a',
      '.ui-table th a',
      '.ui-fold > summary',
      '.ui-choice',
      '.admin-sidebar a',
      '.admin-menu > summary',
    ];
    for (const root of document.querySelectorAll(scope))
      for (const b of root.querySelectorAll(actions.join(', '))) {
        const r = b.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) continue; // inside a closed dialog or disclosure
        // Hidden from everyone on purpose (the edit form's default button for Enter, #66 PR 6):
        // no pointer or tab reaches it, so it is no action to measure.
        if (b.closest('[aria-hidden="true"]') && b.getAttribute('tabindex') === '-1') continue;
        const label = b.textContent?.trim() ?? '';
        if (b.scrollWidth > b.clientWidth + 1) out.push(`clipped: ${label}`);
        if (b.scrollHeight > b.clientHeight + 1) out.push(`clipped in height: ${label}`);
        // A table scrolls sideways in its own frame; its header links may sit past the edge.
        if (!b.closest('.ui-table-scroll') && (r.right > width + 1 || r.left < -1))
          out.push(`outside the viewport: ${label}`);
        if (r.height < 44 || r.width < 44) out.push(`tap target under 44px: ${label}`);
        // A button keeps its words whole; a link or checkbox row may wrap like running text. A
        // word is what lies between spaces and hyphens: a line may end after a hyphen
        // ("Site-|instellingen"), never inside a word. Empty boxes at a line end do not count.
        // A button on a site that hyphenates (`hyphens: auto`, base.css) breaks a word with a
        // visible hyphen on purpose. A main navigation label is a word or two and keeps them whole
        // without that exemption: it inherited `hyphens: auto`, so the rule never fired and
        // "Dashboar|d" at 320 CSS px and 200% text passed (#66 PR 2).
        if (!b.matches('button, .ui-button, .ui-navgroup a')) continue;
        if (!b.matches('.ui-navgroup a') && getComputedStyle(b).hyphens === 'auto') continue;
        const walker = document.createTreeWalker(b, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode())
          for (const match of (node.textContent ?? '').matchAll(/[^\s-]+/g)) {
            const range = document.createRange();
            range.setStart(node, match.index);
            range.setEnd(node, match.index + match[0].length);
            if ([...range.getClientRects()].filter((box) => box.width > 0).length > 1)
              out.push(`word broken: ${match[0]} in ${label}`);
          }
      }
    // Inside an action group no label ends in an ellipsis, and reading and focus order follow
    // the DOM: a later action is never above an earlier one, or left of it on the same line.
    for (const root of document.querySelectorAll(scope))
      for (const group of root.querySelectorAll('.actions, .ui-actions')) {
        let previous: DOMRect | null = null;
        for (const a of group.querySelectorAll(
          ':scope > a, :scope > button, :scope > .ui-button'
        )) {
          const r = a.getBoundingClientRect();
          if (r.width === 0 && r.height === 0) continue;
          const label = a.textContent?.trim() ?? '';
          if (getComputedStyle(a).textOverflow === 'ellipsis') out.push(`ellipsis: ${label}`);
          if (
            previous &&
            (r.top < previous.top - 1 ||
              (Math.abs(r.top - previous.top) < 1 && r.left < previous.left))
          )
            out.push(`visual order differs from DOM order: ${label}`);
          previous = r;
        }
      }
    // A field is a target too. A text field scrolls a long value by design, so only its box,
    // position and size count; a checkbox or radio is measured as its `.ui-choice` row.
    for (const root of document.querySelectorAll(scope))
      for (const f of root.querySelectorAll(
        'input:not([type="hidden"], [type="checkbox"], [type="radio"]), select, textarea'
      )) {
        const r = f.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) continue;
        if (f.closest('[aria-hidden="true"]')) continue; // a honeypot, out of reach on purpose
        const name = f.getAttribute('name') ?? f.id;
        if (r.right > width + 1 || r.left < -1) out.push(`field outside the viewport: ${name}`);
        if (r.height < 44 || r.width < 44) out.push(`field under 44px: ${name}`);
      }
    // A label that runs past its card is clipped by the card even when the page does not scroll
    // (a radio's label at 200% text did).
    const card = '.ui-card-body, .card, .ui-card, .ui-panel, .ui-fieldset';
    for (const l of document.querySelectorAll(`:is(${card}) :is(label, legend, summary, dd)`)) {
      const box = l.closest(card)!.getBoundingClientRect();
      const range = document.createRange();
      range.selectNodeContents(l);
      if (range.getBoundingClientRect().right > box.right + 1)
        out.push(`past its card: ${l.textContent?.trim()}`);
    }
    return out;
  }, within);
}

/** Assert the gate on the current page; `label` names the state in the failure. */
export async function layoutGate(page: Page, label?: string, within?: string) {
  expect(await layoutProblems(page, within), label).toEqual([]);
}

/** What a forced-colors user (Windows High Contrast) loses on the current page; the caller
 *  emulates `forced-colors: active`. The browser then paints every background as the system
 *  canvas, drops `box-shadow` and recolours borders and outlines, so an action whose shape was
 *  its background or shadow becomes loose text, and a focus ring drawn as a shadow disappears.
 *  Two checks: every visible button, button-styled link and text field keeps a border on all four
 *  sides, and every tab stop in `within` shows an outline when focused from the keyboard.
 *  Rejected: comparing screenshots with and without forced colours. It would flag every recoloured
 *  pixel and say nothing about which control lost its shape. */
export async function forcedColorsProblems(page: Page, within = 'body'): Promise<string[]> {
  const out = await page.evaluate((scope) => {
    const problems: string[] = [];
    const label = (el: Element) =>
      (el.textContent ?? '').trim().slice(0, 40) ||
      el.getAttribute('name') ||
      el.getAttribute('aria-label') ||
      el.tagName.toLowerCase();
    const shaped =
      'button, a.button, .ui-button, input:not([type="hidden"], [type="checkbox"], [type="radio"]), select, textarea';
    for (const root of document.querySelectorAll(scope))
      for (const el of root.querySelectorAll(shaped)) {
        if (el.getClientRects().length === 0 || el.closest('[aria-hidden="true"]')) continue;
        const style = getComputedStyle(el);
        if (style.forcedColorAdjust === 'none')
          problems.push(`opts out of forced colours: ${label(el)}`);
        const sides = ['Top', 'Right', 'Bottom', 'Left'] as const;
        const bare = sides.filter(
          (side) =>
            style.getPropertyValue(`border-${side.toLowerCase()}-style`) === 'none' ||
            parseFloat(style.getPropertyValue(`border-${side.toLowerCase()}-width`)) === 0
        );
        if (bare.length) problems.push(`no border in forced colours: ${label(el)}`);
      }
    return problems;
  }, within);
  const stops = await tabStops(page, within);
  for (const stop of stops)
    if (!stop.ring) out.push(`no focus outline in forced colours: ${stop.name}`);
  if (stops.length === 0) out.push('no tab stop on the page');
  return out;
}

/** One keyboard focus stop, measured right after the Tab that reached it. */
export interface TabStop {
  name: string;
  /** An outline is drawn: style not `none` and a width above zero. */
  ring: boolean;
  /** Every sampled point of the control is outside the viewport or under a fixed or sticky
   *  element that is not the control's own ancestor: WCAG 2.4.11, focus not obscured. */
  hidden: boolean;
}

/** Walk the tab order from the top of the page and measure each stop inside `within`. The walk
 *  ends when focus returns to the body or to a stop it saw before; a cap keeps a page with a
 *  focus trap from looping. Stops outside `within` move the walk on but are not returned. */
export async function tabStops(page: Page, within = 'body'): Promise<TabStop[]> {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  const seen = new Set<string>();
  const stops: TabStop[] = [];
  for (let i = 0; i < 80; i++) {
    await page.keyboard.press('Tab');
    const stop = await page.evaluate((scope) => {
      const el = document.activeElement;
      if (!el || el === document.body) return null;
      const path = [...el.parentElement!.children].indexOf(el) + ':' + el.outerHTML.slice(0, 120);
      if (!el.closest(scope)) return { path, outside: true as const };
      const style = getComputedStyle(el);
      const ring = style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0;
      const name =
        (el.textContent ?? '').trim().slice(0, 40) ||
        el.getAttribute('name') ||
        el.getAttribute('aria-label') ||
        el.tagName.toLowerCase();
      // The centre and four points just inside the corners. A point counts as hidden when it is
      // off screen or the top element there is not the control and sits in a fixed or sticky box.
      const r = el.getBoundingClientRect();
      const inset = Math.min(2, r.width / 4, r.height / 4);
      const points = [
        [r.left + r.width / 2, r.top + r.height / 2],
        [r.left + inset, r.top + inset],
        [r.right - inset, r.top + inset],
        [r.left + inset, r.bottom - inset],
        [r.right - inset, r.bottom - inset],
      ] as const;
      const pinned = (node: Element | null) => {
        for (let n = node; n && n !== el; n = n.parentElement) {
          if (n.contains(el)) return false;
          const position = getComputedStyle(n).position;
          if (position === 'fixed' || position === 'sticky') return true;
        }
        return false;
      };
      const hidden = points.every(([x, y]) => {
        if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) return true;
        const top = document.elementFromPoint(x, y);
        return !!top && top !== el && !el.contains(top) && pinned(top);
      });
      return { path, outside: false as const, ring, name, hidden };
    }, within);
    if (!stop || seen.has(stop.path)) break;
    seen.add(stop.path);
    if (!stop.outside) stops.push({ name: stop.name, ring: stop.ring, hidden: stop.hidden });
  }
  return stops;
}

/** Each tab stop in `within` that a fixed or sticky bar covers completely when it has focus. */
export async function focusObscuredProblems(page: Page, within = 'body'): Promise<string[]> {
  const stops = await tabStops(page, within);
  const out = stops.filter((stop) => stop.hidden).map((stop) => `focus obscured: ${stop.name}`);
  if (stops.length === 0) out.push('no tab stop on the page');
  return out;
}
