// The site navigation's enhancement (ADR 036 rule 12, brief site-navigation § 2 and § 7). Without
// this module the header is complete: Menu is a native `details` whose panel holds the whole main
// menu and both calls to action (`lib/components/SiteHeader.svelte`). With it:
//
// - Menu opens the same panel content as a modal `dialog` from the inline end: showModal() makes
//   the page inert and closes on Escape, the focus starts on the close button and goes back to
//   Menu, the scroll position stays, and a page with a classic scrollbar does not shift.
// - The bar shows the longest prefix of its candidates that fits beside the logo, the first call
//   to action and Menu, measured (`fit` below, a pure function), in the order of `priority`:
//   Search, Language, the second call to action, then the main menu's bar links in menu order. So
//   on a narrowing screen the links leave first and Search last, and a phone keeps one row
//   (MY-266 PR D); a short later link never jumps in for a long earlier one. A candidate that
//   does not fit is `display: none`, so it is neither focusable nor in the accessibility tree;
//   it is in the panel, which always holds everything.
// - If the logo, the first call to action and Menu still do not fit one row, the call to action's
//   label wraps between its words inside the button (`data-tight`) when that is enough, else
//   whole tools wrap.
// - While the header is one row and takes at most a fifth of the viewport's height
//   (`stickyFits`), it gets `data-sticky` and the CSS keeps it at the top; its height goes to
//   `--site-sticky-block-size`, the scroll padding that keeps an anchor or the focus from sliding
//   under it (WCAG 2.4.11). Otherwise it stays in the flow. Not on scroll direction: a header that
//   hides and returns moves under the reader's eyes.
// - A link with sublinks gets a separate button that opens them, in the bar as a dropdown and in
//   the panel as a disclosure; a group is that button alone. One dropdown at a time, Escape
//   closes it and returns the focus to its button.
//
// The fallback stays until every step above has succeeded: the header gets `data-enhanced` last,
// and only then does the CSS show the bar. The words come from the page (`data-*` attributes from
// the catalogs), so this file knows no language, and every node is made with createElement and
// textContent: no innerHTML, so no Trusted Types policy is needed.
//
// A plain file in `static/`, served from the site's own origin under `script-src 'self'`, like
// `_image/lightbox.js`. Rejected: Svelte hydration of the public layout (`csr = false` keeps a
// content page free of a client framework, ADR 009), a CSS breakpoint for the bar (a long label or
// 200% text overruns it) and an observer on the outer container alone, which misses text zoom at
// an unchanged width.

/**
 * How many of the bar's candidates fit, in priority order. `costs[i]` is the width candidate `i`
 * adds to the header row, its gap included; `available` the room the logo and the tools leave.
 * Growing past the `shown` count needs `slack` pixels to spare, so a width that sits on a boundary
 * does not make a link flicker in and out; shrinking happens as soon as something no longer fits.
 * Always a prefix: a candidate that does not fit ends the bar, even if a later one would.
 */
export function fit({ costs, available, shown = 0, slack = 8 }) {
  let used = 0;
  let count = 0;
  for (const cost of costs) {
    used += cost;
    const room = count + 1 > shown ? available - slack : available;
    if (used > room) break;
    count += 1;
  }
  return count;
}

/**
 * The bar's candidates in the order they are shown, the reverse of the order in which they leave
 * for the panel (brief public-chrome-polish § Eén rij op smal): Search, Language, the second call
 * to action, the bar links. Search stays longest because it is the entrance a visitor looks for
 * in the bar; a link is a click away in the panel. Absent parts drop out.
 */
export function priority({ search, languages, second, links = [] }) {
  return [search, languages, second, ...links].filter(Boolean);
}

/**
 * Whether the header may stay at the top: one row, and at most `share` of the viewport's height,
 * so 200% text or a tall logo on a phone never leaves a band of header over the page.
 */
export function stickyFits({ oneRow, height, viewport, share = 0.2 }) {
  return oneRow && height > 0 && height <= viewport * share;
}

const SVG = 'http://www.w3.org/2000/svg';

function node(tag, className, attrs = {}) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  for (const [name, value] of Object.entries(attrs)) el.setAttribute(name, value);
  return el;
}

/** The three lines of the burger, drawn crossed: the close button repeats Menu's own mark. */
function burger() {
  const mark = node('span', 'site-burger', { 'aria-hidden': 'true' });
  mark.append(node('span'), node('span'), node('span'));
  return mark;
}

const px = (value) => Number.parseFloat(value) || 0;

/**
 * The `:root` rule that carries the sticky header's height, in a stylesheet this module
 * constructs: no `style` attribute on the page (public pages carry none) and nothing for the
 * CSP's `style-src` to refuse. Without constructable stylesheets the header is never sticky, since
 * the scroll padding could not keep the focus below it. Rejected: `style` on `<html>`.
 */
let rootRule;
function stickyRule() {
  if (rootRule !== undefined) return rootRule;
  rootRule = null;
  if (typeof CSSStyleSheet === 'undefined' || !('adoptedStyleSheets' in document)) return rootRule;
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(':root {}');
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
  rootRule = sheet.cssRules[0];
  return rootRule;
}

function enhance(header) {
  const details = header.querySelector('.site-menu');
  const summary = details?.querySelector('.site-menu-toggle');
  const panel = details?.querySelector('.site-panel');
  const bar = header.querySelector('.site-bar');
  const tools = header.querySelector('.site-tools');
  const identity = header.querySelector('.site-identity');
  const rtl = getComputedStyle(header).direction === 'rtl';

  // Disclosure buttons for a link's sublinks and for a group, in the panel and the bar alike.
  const toggles = [...header.querySelectorAll('[data-site-toggle]')];
  const listOf = (button) => document.getElementById(button.getAttribute('aria-controls'));
  const setOpen = (button, open) => {
    button.setAttribute('aria-expanded', String(open));
    const list = listOf(button);
    if (list) list.hidden = !open;
  };
  const dropdowns = toggles.filter((b) => bar?.contains(b));
  const closeDropdowns = (except) => {
    for (const b of dropdowns) if (b !== except) setOpen(b, false);
  };
  for (const button of toggles) {
    setOpen(button, button.getAttribute('aria-expanded') === 'true');
    button.hidden = false;
    button.addEventListener('click', () => {
      const open = button.getAttribute('aria-expanded') !== 'true';
      if (dropdowns.includes(button)) closeDropdowns(button);
      setOpen(button, open);
    });
  }
  if (bar) {
    bar.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      const open = dropdowns.find((b) => b.getAttribute('aria-expanded') === 'true');
      if (!open) return;
      setOpen(open, false);
      open.focus();
    });
    // A dropdown closes once the focus or a click leaves its item.
    bar.addEventListener('focusout', (event) => {
      const item = event.target.closest('li.site-bar-item');
      if (item && !item.contains(event.relatedTarget)) closeDropdowns();
    });
    document.addEventListener('click', (event) => {
      if (!(event.target instanceof Node) || !bar.contains(event.target)) closeDropdowns();
    });
  }

  // The panel becomes a modal dialog. It moves, it is not copied: one tree, one set of ids,
  // nothing hidden that a screen reader could still reach.
  let dialog = null;
  if (details && summary && panel) {
    const title = summary.textContent.trim();
    dialog = node('dialog', 'site-dialog', { 'aria-labelledby': 'site-dialog-title' });
    const head = node('div', 'site-dialog-head');
    const heading = node('h2', 'site-dialog-title', { id: 'site-dialog-title' });
    heading.textContent = title;
    const close = node('button', 'site-dialog-close', { type: 'button' });
    const word = node('span');
    word.textContent = header.dataset.menuClose ?? '×';
    close.append(burger(), word);
    head.append(heading, close);
    dialog.append(head, panel);
    header.append(dialog);

    close.addEventListener('click', () => dialog.close());
    // A click on the backdrop lands on the dialog itself; its content fills the box. A link to a
    // part of this page (a menu item with an anchor) only scrolls, so the dialog closes before the
    // jump and the focus goes with the jump, not back to Menu.
    let jumped = false;
    dialog.addEventListener('click', (event) => {
      const link = event.target instanceof Element ? event.target.closest('a[href]') : null;
      jumped =
        !!link?.hash && link.origin === location.origin && link.pathname === location.pathname;
      if (jumped || event.target === dialog) dialog.close();
    });
    dialog.addEventListener('close', () => {
      if (!jumped) summary.focus();
      jumped = false;
    });
    summary.addEventListener('click', (event) => {
      event.preventDefault();
      closeDropdowns();
      // The close button stands where Menu stood, so the cross does not jump.
      const at = summary.getBoundingClientRect();
      const end = rtl ? at.left : document.documentElement.clientWidth - at.right;
      dialog.style.setProperty('--site-opener-top', `${Math.max(0, at.top)}px`);
      dialog.style.setProperty('--site-opener-end', `${Math.max(0, end)}px`);
      // A classic scrollbar takes room the scroll lock would give back to the page, which then
      // shifts sideways; the CSS keeps that room only when there is one (`site-chrome.css`).
      const root = document.documentElement;
      root.toggleAttribute('data-site-gutter', window.innerWidth > root.clientWidth);
      dialog.showModal();
      close.focus();
    });
  }

  // The measured bar, its candidates in `priority` order.
  const second = tools?.querySelector('[data-site-candidate]');
  const search = tools?.querySelector(':scope > .site-search-link[data-site-yield]');
  const languages = tools?.querySelector(':scope > .site-languages[data-site-yield]');
  const links = bar ? [...bar.querySelectorAll(':scope > ul > li')] : [];
  const candidates = priority({ search, languages, second, links });
  const inTools = (c) => !links.includes(c);
  let shown = 0;
  let pending = 0;

  function measure() {
    pending = 0;
    // Measured at natural widths: the tight state below is undone first, in the same task, so
    // nothing paints in between and the result does not depend on the state it is about to set.
    header.toggleAttribute('data-tight', false);
    header.toggleAttribute('data-measuring', true);
    const row = header.getBoundingClientRect();
    const style = getComputedStyle(header);
    const width =
      row.width -
      px(style.paddingInlineStart ?? style.paddingLeft) -
      px(style.paddingInlineEnd ?? style.paddingRight);
    const gap = px(style.columnGap);
    const toolGap = tools ? px(getComputedStyle(tools).columnGap) : 0;
    const barGap = bar ? px(getComputedStyle(bar.querySelector('ul')).columnGap) : 0;
    // The tools that always stay (the first call to action, Menu) at their natural width in one
    // row.
    const toolParts = tools
      ? [...tools.children].filter((c) => !candidates.includes(c) && c.getClientRects().length)
      : [];
    const toolsWidth =
      toolParts.reduce((sum, c) => sum + c.getBoundingClientRect().width, 0) +
      Math.max(0, toolParts.length - 1) * toolGap;
    const costs = candidates.map((c) => {
      const own = c.getBoundingClientRect().width;
      if (inTools(c)) return own + toolGap;
      // The first bar link brings the gap between the bar and the tools; later ones the bar's.
      return own + (c === links[0] ? gap : barGap);
    });
    header.toggleAttribute('data-measuring', false);
    const available = width - identity.getBoundingClientRect().width - gap - toolsWidth;
    // When the logo, the first call to action and Menu do not fit one row, the call to action's
    // label may wrap between its words inside the button (Dreamkit's phone header), if that is
    // enough: measured at its narrowest, the longest word. Otherwise whole tools wrap as before.
    const first = tools?.querySelector(':scope > .site-action:not(.secondary)');
    let tight = false;
    if (available < 0 && first) {
      const natural = first.getBoundingClientRect().width;
      first.style.setProperty('inline-size', 'min-content');
      first.style.setProperty('hyphens', 'manual');
      tight = available + natural - first.getBoundingClientRect().width >= 0;
      first.style.removeProperty('inline-size');
      first.style.removeProperty('hyphens');
    }
    const count = fit({ costs, available, shown });
    // A candidate that leaves the bar never takes the focus with it: its dropdown or language
    // list closes and the focus moves to Menu, which stays and holds the same entry (brief § 2).
    // Rejected: waiting until the focus leaves, which keeps a header that no longer fits in two
    // rows meanwhile.
    const leaving = candidates.slice(count, shown);
    if (leaving.some((c) => c.querySelector('[aria-expanded="true"]'))) closeDropdowns();
    for (const c of leaving) if (c instanceof HTMLDetailsElement) c.open = false;
    if (leaving.some((c) => c.contains(document.activeElement))) summary?.focus();
    shown = count;
    header.toggleAttribute('data-tight', tight);
    candidates.forEach((c, i) => c.toggleAttribute('data-shown', i < count));
    bar?.toggleAttribute(
      'data-shown',
      links.some((l) => l.hasAttribute('data-shown'))
    );
    stick();
  }

  // One row: every part of the header that is displayed shares a line with every other.
  function stick() {
    const parts = [identity, bar, ...(tools ? [...tools.children] : [])]
      .filter((el) => el?.getClientRects().length)
      .map((el) => el.getBoundingClientRect());
    const oneRow = Math.max(...parts.map((r) => r.top)) < Math.min(...parts.map((r) => r.bottom));
    const height = header.getBoundingClientRect().height;
    const rule = stickyRule();
    const sticky = !!rule && stickyFits({ oneRow, height, viewport: window.innerHeight });
    header.toggleAttribute('data-sticky', sticky);
    if (sticky) rule.style.setProperty('--site-sticky-block-size', `${Math.ceil(height)}px`);
    else rule?.style.removeProperty('--site-sticky-block-size');
  }
  const schedule = () => {
    if (!pending) pending = requestAnimationFrame(measure);
  };

  // The room changes with the header's width, and with the size of what stands in it: text zoom
  // at an unchanged width resizes the logo's name and the tools, a loaded font every label. The
  // viewport's height alone decides the sticky share, so a window resize schedules too.
  const observer = new ResizeObserver(schedule);
  for (const el of [header, identity, ...(tools ? [...tools.children] : [])])
    if (el) observer.observe(el);
  window.addEventListener('resize', schedule);
  document.fonts?.addEventListener?.('loadingdone', schedule);
  document.fonts?.ready.then(schedule);
  measure();
  header.toggleAttribute('data-enhanced', true);
}

if (typeof document !== 'undefined')
  for (const header of document.querySelectorAll('.site-header[data-site-nav]')) {
    try {
      enhance(header);
    } catch (error) {
      // The native header keeps working; say why it was not enhanced.
      console.error('site navigation not enhanced', error);
    }
  }
