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
    // A caption is as wide as its table. A stacked table is `display: block`, and a caption left
    // as a table caption shrinks to its longest syllable and breaks in the middle of a word.
    for (const caption of document.querySelectorAll(`${scope} caption`)) {
      if (caption.classList.contains('ui-visually-hidden')) continue;
      const table = caption.closest('table')!.getBoundingClientRect().width;
      const own = caption.getBoundingClientRect().width;
      if (own + 2 < table)
        out.push(
          `caption narrower than its table: ${caption.textContent?.trim()} ${own} < ${table}`
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
      '[data-hero-alt] > summary',
      '[data-hero-alt] .act',
      '.ui-block-card-action',
      '.ui-block-card-more > summary',
      '.ui-block-card-fold > summary',
      '.ui-choice',
      '.admin-sidebar a',
      '.admin-sidebar summary',
    ];
    for (const root of document.querySelectorAll(scope))
      for (const b of root.querySelectorAll(actions.join(', '))) {
        const r = b.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) continue; // inside a closed dialog or disclosure
        // Positioned content of a closed `details` keeps a box nobody can see (a card's menu).
        if (!b.checkVisibility()) continue;
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
        if (
          !b.matches(
            'button, .ui-button, .ui-block-card-action, .ui-navgroup a, .ui-navgroup summary'
          )
        )
          continue;
        if (
          !b.matches('.ui-navgroup a, .ui-navgroup summary') &&
          getComputedStyle(b).hyphens === 'auto'
        )
          continue;
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
 *  ends when focus returns to the body or to an element it focused before; a cap keeps a page
 *  with a focus trap from looping. Stops outside `within` move the walk on but are not returned.
 *  Native date parts share one active element; consecutive Tabs within it continue the walk.
 *  Other repeats are recognised by element identity, kept in the page between Tabs. Rejected: a key
 *  built from the markup, which two identical controls share (a page with the same call to
 *  action twice ended the walk at the second one and left the rest of the page unmeasured). */
export async function tabStops(page: Page, within = 'body'): Promise<TabStop[]> {
  await page.evaluate(() => {
    (document.activeElement as HTMLElement | null)?.blur();
    (window as unknown as { tabStopsSeen: WeakSet<Element> }).tabStopsSeen = new WeakSet();
    (window as unknown as { tabStopsPrevious: Element | null }).tabStopsPrevious = null;
  });
  const stops: TabStop[] = [];
  for (let i = 0; i < 80; i++) {
    await page.keyboard.press('Tab');
    const stop = await page.evaluate((scope) => {
      const el = document.activeElement;
      if (!el || el === document.body) return null;
      const seen = (window as unknown as { tabStopsSeen: WeakSet<Element> }).tabStopsSeen;
      const state = window as unknown as { tabStopsPrevious: Element | null };
      if (state.tabStopsPrevious === el && el instanceof HTMLInputElement && el.type === 'date')
        return { outside: true as const };
      state.tabStopsPrevious = el;
      if (seen.has(el)) return null;
      seen.add(el);
      if (!el.closest(scope)) return { outside: true as const };
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
      return { outside: false as const, ring, name, hidden };
    }, within);
    if (!stop) break;
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

// ---- Site chrome rails ----
// The public page's named rails, measured against the page's own CSS
// (docs/architecture/content-layout.md § Site chrome). A probe element of each rail is added to
// the page and measured, so the expectation is whatever base.css makes of this container, never a
// number copied here.
// Rejected: recomputing the rails in the test, which passes as long as test and CSS share a mistake.

type Box = { left: number; right: number; top: number; bottom: number };

/** Where the header, footer and the page's first and last content sit, plus the rails. */
export async function chromeRails(page: Page) {
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
      first: box(edge((el) => el.firstElementChild)),
      last: box(edge((el) => el.lastElementChild)),
      padding: [parseFloat(style.paddingBlockStart), parseFloat(style.paddingBlockEnd)],
    };
  });
}

type Rails = Awaited<ReturnType<typeof chromeRails>>;

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

// Text blocks: prose, quote and callout against the page's own rails. One synthetic page holds
// every quote width and variant and every callout variant, short and long, with a source link,
// a bare URL and a list, in nl and en. Rejected: one page per registry example, which measures a
// block alone and never next to prose or another rail.

type Inline = { type: 'text'; text: string; marks?: object[] };
const link = (text: string, href: string): Inline => ({
  type: 'text',
  text,
  marks: [{ type: 'link', attrs: { href } }],
});
const para = (...parts: (string | Inline)[]) => ({
  type: 'paragraph',
  content: parts.map((part) => (typeof part === 'string' ? { type: 'text', text: part } : part)),
});
const doc = (...content: object[]) => ({ type: 'doc', content });
const list = (...items: string[]) => ({
  type: 'bullet_list',
  content: items.map((text) => ({ type: 'list_item', content: [para(text)] })),
});
const LONG_URL =
  'https://example.org/verslagen/2026/buurtonderzoek-verkeersveiligheid-oversteekplaatsen';
const LONG = {
  nl: 'Toen de gemeente de oversteek bij de school eindelijk verlegde, zagen we binnen een maand meer kinderen alleen naar school fietsen dan in de tien jaar ervoor. Dat had niemand van ons verwacht.',
  en: 'When the council finally moved the crossing by the school, within a month more children cycled to school alone than in the ten years before. None of us had expected that.',
};

/** The blocks of the text-block page; `version` is each type's registry version. */
export function textBlocks(version: { quote: number; callout: number; 'rich-text': number }) {
  const quote = (id: string, props: object) => ({
    id,
    type: 'quote',
    version: version.quote,
    props,
  });
  const callout = (id: string, props: object) => ({
    id,
    type: 'callout',
    version: version.callout,
    props,
  });
  const source = {
    nl: 'Verslag van het buurtonderzoek naar de oversteekplaatsen',
    en: 'Report of the neighbourhood survey of the crossings',
  };
  return [
    {
      id: 'text-prose',
      type: 'rich-text',
      version: version['rich-text'],
      props: {
        content: {
          nl: doc(para('Lees ', link(LONG_URL, LONG_URL), '.'), list(LONG.nl, 'Kort.')),
          en: doc(para('Read ', link(LONG_URL, LONG_URL), '.'), list(LONG.en, 'Short.')),
        },
      },
    },
    quote('text-quote-short', {
      text: { nl: 'Veilig oversteken.', en: 'Safe crossing.' },
      attribution: { name: 'Fatima el Amrani', role: { nl: 'buurtbewoner', en: 'resident' } },
    }),
    quote('text-quote-long', {
      text: LONG,
      attribution: { name: 'Fatima el Amrani', source, url: LONG_URL },
    }),
    quote('text-pullquote-wide', {
      text: LONG,
      attribution: {
        name: 'Jan de Boer',
        role: { nl: 'wethouder', en: 'alderman' },
        source,
        url: LONG_URL,
      },
      variant: 'pullquote',
      width: 'wide',
    }),
    quote('text-quote-full', {
      text: LONG,
      attribution: { name: 'Kim Bakker', url: LONG_URL },
      width: 'full',
    }),
    quote('text-pullquote-full', {
      text: { nl: 'Samen.', en: 'Together.' },
      attribution: { name: 'Kim Bakker' },
      variant: 'pullquote',
      width: 'full',
    }),
    callout('text-callout-info', {
      body: {
        nl: doc(para('Zie ', link('het verslag', LONG_URL), '.')),
        en: doc(para('See ', link('the report', LONG_URL), '.')),
      },
    }),
    callout('text-callout-note', {
      variant: 'note',
      title: { nl: 'Bijgewerkt na het buurtonderzoek', en: 'Updated after the survey' },
      body: {
        nl: doc(para(LONG.nl, ' ', link(LONG_URL, LONG_URL))),
        en: doc(para(LONG.en, ' ', link(LONG_URL, LONG_URL))),
      },
    }),
    callout('text-callout-warning', {
      variant: 'warning',
      title: { nl: 'Let op', en: 'Note' },
      body: { nl: doc(list(LONG.nl, 'Kort.')), en: doc(list(LONG.en, 'Short.')) },
    }),
  ];
}

/** What is off about the page's prose, quotes and callouts, measured against probe elements of
 *  its own rails: each block sits on the rail its width names (prose and callout on the content
 *  rail), the quotation and its attribution keep the content rail inside a wide or full block,
 *  no line or link reaches past its block, and no link text is hyphenated. */
export function textBlockProblems(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    const main = document.querySelector('main.page')!;
    const rail = (className: string) => {
      const probe = document.createElement('div');
      probe.className = className;
      main.append(probe);
      const r = probe.getBoundingClientRect();
      probe.remove();
      return r;
    };
    const rails: Record<string, DOMRect> = {
      content: rail(''),
      wide: rail('layout-wide'),
      full: rail('layout-full'),
    };
    const off = (a: DOMRect, b: DOMRect) =>
      Math.abs(a.left - b.left) > 1 || Math.abs(a.right - b.right) > 1;
    const outside = (a: DOMRect, b: DOMRect) => a.left < b.left - 1 || a.right > b.right + 1;
    const blocks = main.querySelectorAll(':scope .rich-text, :scope .quote, :scope .callout');
    if (!blocks.length) out.push('no text blocks');
    blocks.forEach((block, at) => {
      const label = `${at} ${block.className}`;
      const width = /width-(wide|full)/.exec(block.className)?.[1] ?? 'content';
      const box = block.getBoundingClientRect();
      if (off(box, rails[width]!)) out.push(`${label}: not on the ${width} rail`);
      const inner = block.matches('.quote') ? [...block.children] : [block];
      for (const part of inner)
        if (outside(part.getBoundingClientRect(), rails.content!))
          out.push(`${label}: ${part.tagName.toLowerCase()} past the content rail`);
      for (const a of block.querySelectorAll('a'))
        if (getComputedStyle(a).hyphens === 'auto') out.push(`${label}: a link is hyphenated`);
      for (const el of block.querySelectorAll('*'))
        for (const r of el.getClientRects())
          if (r.width && outside(r, box))
            out.push(`${label}: ${el.tagName.toLowerCase()} past the block`);
    });
    return [...new Set(out)];
  });
}

// Media blocks: every image layout and video width between prose, with a landscape, a portrait, a
// panorama and a source smaller than its column, long captions and credits, floats that hang past
// their text, in nl and en. Rejected: the registry examples, which put one image alone on a page
// and never a float before a wide block or at the end of the article.

const CAPTION = {
  nl: 'Bewoners meten de snelheid van het verkeer bij de oversteek op de Vaartweg, op een zaterdagochtend in maart, samen met de wijkagent en twee leerlingen van de school.',
  en: 'Residents measure the speed of the traffic at the Vaartweg crossing on a Saturday morning in March, with the community officer and two pupils of the school.',
};

/** The blocks of the media page; `media` holds the uploaded image ids, `version` each type's. */
export function mediaBlocks(
  media: { landscape: string; portrait: string; panorama: string; small: string },
  version: { image: number; 'video-embed': number; 'rich-text': number }
) {
  const prose = (id: string, text: { nl: string; en: string }) => ({
    id,
    type: 'rich-text',
    version: version['rich-text'],
    props: {
      content: { nl: doc(para(text.nl), para(text.nl)), en: doc(para(text.en), para(text.en)) },
    },
  });
  const image = (id: string, mediaId: string, layout: string, extra: object = {}) => ({
    id,
    type: 'image',
    version: version.image,
    props: { mediaId, decorative: false, alt: { nl: 'Verkeer', en: 'Traffic' }, layout, ...extra },
  });
  const video = (id: string, width: string, props: object) => ({
    id,
    type: 'video-embed',
    version: version['video-embed'],
    props: { width, ...props },
  });
  const long = {
    caption: CAPTION,
    credit: {
      work: { title: 'Ochtendmeting', maker: 'Werkgroep Vaartweg' },
      photographer: 'Sam de Vries',
    },
  };
  const title = {
    nl: 'Verslag van de bewonersavond over de nieuwe oversteekplaats bij de basisschool',
    en: 'Report of the residents’ evening about the new crossing by the primary school',
  };
  return [
    prose('media-prose-open', LONG),
    image('media-content-landscape', media.landscape, 'content', long),
    image('media-float-left-portrait', media.portrait, 'float-left', {
      caption: { nl: 'Staand.', en: 'Portrait.' },
    }),
    prose('media-prose-beside-left', LONG),
    image('media-wide-panorama', media.panorama, 'wide', long),
    image('media-float-right-small', media.small, 'float-right', { caption: CAPTION }),
    prose('media-prose-short', { nl: 'Kort.', en: 'Short.' }),
    video('media-video-content', 'content', { provider: 'youtube', videoId: 'dQw4w9WgXcQ', title }),
    image('media-content-portrait', media.portrait, 'content'),
    image('media-full-panorama', media.panorama, 'full', long),
    video('media-video-wide', 'wide', {
      provider: 'vimeo',
      videoId: '76979871',
      title,
      caption: CAPTION,
    }),
    image('media-content-small', media.small, 'content', {
      caption: { nl: 'Klein bronbeeld.', en: 'Small source.' },
    }),
    video('media-video-full', 'full', {
      provider: 'youtube',
      videoId: 'aqz-KE-bpKQ',
      title,
      caption: CAPTION,
    }),
    prose('media-prose-close', LONG),
    image('media-float-left-end', media.landscape, 'float-left', { caption: CAPTION }),
  ];
}

/** What is off about the page's images and videos, measured against probe elements of its own
 *  rails: each figure sits on the rail its layout names, a float stays inside the gutters and
 *  leaves the text beside it a readable line, every image fills its figure in its own aspect
 *  ratio, a caption starts at the image's edge (the gutter for a full image) and keeps the
 *  content measure, a video's title and caption keep the content rail, nothing framed or broad
 *  sits beside a hanging float, the page contains its last float, and with `sizes` (default text)
 *  each image's `sizes` picks the srcset candidate its rendered width would. */
export function mediaBlockProblems(page: Page, sizes: boolean): Promise<string[]> {
  return page.evaluate(async (checkSizes) => {
    const out: string[] = [];
    const main = document.querySelector('main.page')!;
    const rail = (className: string) => {
      const probe = document.createElement('div');
      probe.className = className;
      main.append(probe);
      const r = probe.getBoundingClientRect();
      probe.remove();
      return r;
    };
    const rails: Record<string, DOMRect> = {
      content: rail(''),
      wide: rail('layout-wide'),
      full: rail('layout-full'),
    };
    const probe = document.createElement('div');
    probe.style.width = 'var(--gutter)';
    main.append(probe);
    const gutter = probe.getBoundingClientRect().width;
    probe.remove();
    const off = (a: DOMRect, b: DOMRect) =>
      Math.abs(a.left - b.left) > 1 || Math.abs(a.right - b.right) > 1;
    // The boxes of the text itself, not of the elements around it: a credit is a block as wide
    // as its caption, whatever the length of the name in it.
    const lines = (el: Element) => {
      const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      const rects: DOMRect[] = [];
      const range = document.createRange();
      for (let node = walk.nextNode(); node; node = walk.nextNode()) {
        range.selectNodeContents(node);
        rects.push(...[...range.getClientRects()].filter((r) => r.width > 0));
      }
      return rects;
    };
    const imgs = [...main.querySelectorAll('img')];
    for (const img of imgs) img.loading = 'eager';
    await Promise.all(imgs.map((img) => img.decode().catch(() => undefined)));
    const blocks = [...main.querySelectorAll(':scope .image, :scope .video')];
    if (!blocks.length) out.push('no media blocks');
    const floats: DOMRect[] = [];
    for (const [at, block] of main.querySelectorAll('.block').entries()) {
      const box = block.getBoundingClientRect();
      const label = `${at} ${block.className}`;
      if (getComputedStyle(block).float !== 'none') {
        floats.push(box);
        if (box.left < rails.full!.left + gutter - 1 || box.right > rails.full!.right - gutter + 1)
          out.push(`${label}: past the gutter`);
        const text = block.nextElementSibling?.querySelector('p');
        const [line, next] = text ? lines(text) : [];
        if (text && line && next && line.width < 15 * parseFloat(getComputedStyle(text).fontSize))
          out.push(`${label}: the text beside it is under 15em`);
      } else if (
        block.matches('.image, .video, .width-wide, .width-full, .layout-wide, .layout-full')
      )
        for (const f of floats)
          if (box.top < f.bottom - 1 && box.left < f.right && box.right > f.left)
            out.push(`${label}: beside a float`);
      if (!block.matches('.image, .video')) continue;
      const width = /(?:width|layout)-(wide|full|content)\b/.exec(block.className)?.[1];
      if (width && off(box, rails[width]!)) out.push(`${label}: not on the ${width} rail`);
      const img = block.querySelector('img');
      if (img) {
        const r = img.getBoundingClientRect();
        if (Math.abs(r.width - box.width) > 1)
          out.push(`${label}: image ${r.width}px in ${box.width}px`);
        if (!img.naturalWidth) out.push(`${label}: image not loaded`);
        else if (
          Math.abs(r.width / r.height - img.naturalWidth / img.naturalHeight) >
          0.01 * (r.width / r.height)
        )
          out.push(`${label}: image stretched`);
        if (checkSizes && img.srcset) {
          const candidates = img.srcset
            .split(', ')
            .map((c) => parseInt(c.split(' ')[1]!))
            .sort((a, b) => a - b);
          const pick = (w: number) => candidates.find((c) => c >= w) ?? candidates.at(-1);
          const slot = img.sizes
            .split(', ')
            .map((s) => /^(\(.*\))?\s*(.+)$/.exec(s)!)
            .find((m) => !m[1] || matchMedia(m[1]).matches)!;
          const probe = document.createElement('div');
          probe.style.width = slot[2]!;
          document.body.append(probe);
          const claimed = probe.getBoundingClientRect().width;
          probe.remove();
          if (pick(claimed) !== pick(r.width))
            out.push(`${label}: sizes says ${Math.round(claimed)}px for ${Math.round(r.width)}px`);
        }
      }
      const inner = block.matches('.video')
        ? [...block.children]
        : [...block.querySelectorAll('figcaption')];
      for (const part of inner) {
        const text = lines(part);
        if (!text.length) continue;
        const left = Math.min(...text.map((r) => r.left));
        const right = Math.max(...text.map((r) => r.right));
        if (block.matches('.image')) {
          const edge =
            img!.getBoundingClientRect().left + (box.left <= rails.full!.left + 1 ? gutter : 0);
          if (Math.abs(left - edge) > 1) out.push(`${label}: caption not at the image's edge`);
          if (right > rails.full!.right - (box.right >= rails.full!.right - 1 ? gutter : 0) + 1)
            out.push(`${label}: caption against the edge`);
        } else if (left < rails.content!.left - 1 || right > rails.content!.right + 1)
          out.push(`${label}: ${part.tagName.toLowerCase()} past the content rail`);
        if (right - left > rails.content!.width + 1)
          out.push(`${label}: a caption line past the measure`);
      }
      for (const el of block.querySelectorAll('*'))
        for (const r of el.getClientRects())
          if (r.width && (r.left < box.left - 1 || r.right > box.right + 1))
            out.push(`${label}: ${el.tagName.toLowerCase()} past the block`);
    }
    const last = main.getBoundingClientRect().bottom;
    if (floats.some((f) => f.bottom > last + 1)) out.push('a float hangs past the page');
    return [...new Set(out)];
  }, sizes);
}
