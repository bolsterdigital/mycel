// Floating pairs between pages (MY-269 PR 2, brief view-transitions): on top of the cross-fade of
// PR 1, a card's image and title fly to the document header of the page it opens, and back to the
// card when the reader returns. Pairs, by fixed names that Mycel chooses, never a site:
//
// - an overview or campaign card and the item's header: `doc-media` (image), `doc-title` (title)
//   and, on a campaign, `campaign-count`;
// - a Cards block CTA and the page it opens: `doc-title` (the card title and the page heading);
// - a person card and the person's page: `person-portrait`, `doc-title`;
// - an article's linked author and their profile portrait: `person-portrait`;
// - a campaign's landing page and its thank-you view (`<path>/thanks`): the same header and count.
//
// A cross-document view transition pairs elements by `view-transition-name`, so this module names
// the parts on both sides for the one navigation: on `pageswap` in the old page, on `pagereveal`
// in the new one (which is why the page loads it with `blocking="render"`: a later module would
// miss the first render). A name is a `data-transition` attribute that site-chrome.css turns into
// the name, so no element gets a style attribute (the public CSP and the page's `[style]` check).
// The source page records the pair and source kind in `sessionStorage`. The destination names
// the corresponding header parts for that pair alone. Going back reverses the same pair.
//
// Without this script, without support (`event.viewTransition` absent) or with reduced motion
// (the theme's rule then never starts a transition) nothing is named: PR 1's cross-fade, or
// nothing. A plain file in `static/` under `script-src 'self'`, like `navigation.js`, loaded only
// while the theme's `pageTransitions` is on.
// Rejected: names in the markup, which would have to be unique per page and pair every card with
// every header at once (the browser skips the whole transition on a duplicate name), and typed
// `attr()` for script-free names (Chrome 133+ only).

/** The address as a document: origin, path and query; the fragment does not change the page. */
export function documentOf(href) {
  try {
    const url = new URL(href);
    return url.origin + url.pathname + url.search;
  } catch {
    return null;
  }
}

/** The index of the first candidate link that leads to `target`, or -1 when none does. */
export function cardFor(target, hrefs) {
  const wanted = documentOf(target);
  if (wanted === null) return -1;
  return hrefs.findIndex((href) => documentOf(href) === wanted);
}

/** Whether `thanks` is the thank-you view of the landing page `page` (`<path>/thanks`). */
export function isThanks(page, thanks) {
  try {
    const from = new URL(page);
    const to = new URL(thanks);
    return (
      from.origin === to.origin && to.pathname === `${from.pathname.replace(/\/$/, '')}/thanks`
    );
  } catch {
    return false;
  }
}

/**
 * Which side of a pair this page is in the navigation between `here` and `other`: `card` names
 * the source that links to `other`, `item` names this page's paired header parts, `landing`
 * names the campaign header for a thank-you navigation, and `null` names nothing.
 * `moment` is `swap` (the old page) or `reveal` (the new one); `card` whether this page has a
 * card that links to `other`; `pair` the `{ list, item }` addresses the last card navigation
 * recorded. On a swap from a source link the caller records the pair and its source kind.
 */
export function side({ moment, here, other, card, pair }) {
  const same = (a, b) => a != null && b != null && documentOf(a) === documentOf(b);
  if (moment === 'swap' ? isThanks(here, other) : isThanks(other, here)) return 'landing';
  if (moment === 'swap' && card) return 'card';
  if (!pair) return null;
  if (same(pair.list, other) && same(pair.item, here)) return 'item';
  if (moment === 'reveal' && card && same(pair.list, here) && same(pair.item, other)) return 'card';
  return null;
}

const KEY = 'mycel.transition-pair';
const CARD = '.overview-card, .campaign-card, .person-card';
const HEADINGS = 'h2, h3, h4, h5, h6';
const CARDS_CTA = '.cards-item > .actions > a[href]';
const BYLINE_LINK = '.page-meta > a[href]';
/** Title links, Cards actions and the linked names in an article's byline. */
const SOURCE_LINKS = `:is(${CARD}) :is(${HEADINGS}) a[href], ${CARDS_CTA}, ${BYLINE_LINK}`;

const named = [];

function name(element, value) {
  if (!element) return;
  element.dataset.transition = value;
  named.push(element);
}

function clear() {
  for (const element of named.splice(0)) delete element.dataset.transition;
}

function readPair() {
  try {
    return JSON.parse(sessionStorage.getItem(KEY) ?? 'null');
  } catch {
    return null;
  }
}

function writePair(pair) {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(pair));
  } catch {
    // No storage (a privacy mode): the item page names nothing and only the card flies out.
  }
}

/** The first source link on this page that leads to `other`, if any. */
function sourceLink(other) {
  const links = [...document.querySelectorAll(SOURCE_LINKS)];
  return (
    links[
      cardFor(
        other,
        links.map((a) => a.href)
      )
    ] ?? null
  );
}

function nameSource(link) {
  if (link.matches(BYLINE_LINK)) {
    name(link, 'person-portrait');
    return 'byline';
  }
  if (link.matches(CARDS_CTA)) {
    name(link.closest('.cards-item').querySelector(`:scope > :is(${HEADINGS})`), 'doc-title');
    return 'cta';
  }
  const card = link.closest(CARD);
  const person = card.matches('.person-card');
  name(
    card.querySelector(person ? 'img' : ':is(.campaign-card-image, .campaign-hero) img'),
    person ? 'person-portrait' : 'doc-media'
  );
  name(link.closest(HEADINGS), 'doc-title');
  if (!person) name(card.querySelector('.campaign-count'), 'campaign-count');
  return 'card';
}

function nameItem(source) {
  const main = document.querySelector('main');
  if (!main) return;
  if (source === 'byline') {
    name(main.querySelector('.person-portrait img'), 'person-portrait');
    return;
  }
  name(main.querySelector('h1'), 'doc-title');
  if (source === 'cta') return;
  name(
    main.querySelector(
      ':is(.page-hero, .page-cover, .page-split-media, .campaign-landing > .campaign-hero) img'
    ),
    'doc-media'
  );
  name(main.querySelector('.person-portrait img'), 'person-portrait');
  name(main.querySelector('.campaign-count'), 'campaign-count');
}

function prepare(moment, other, transition) {
  const here = location.href;
  const link = sourceLink(other);
  const pair = readPair();
  const chosen = side({ moment, here, other, card: link !== null, pair });
  if (chosen === 'card' && link) {
    const source = nameSource(link);
    if (moment === 'swap') writePair({ list: here, item: other, source });
  } else if (chosen === 'item') nameItem(pair.source);
  else if (chosen === 'landing') nameItem('card');
  transition.finished.then(clear, clear);
}

if (typeof window !== 'undefined') {
  window.addEventListener('pageswap', (event) => {
    const other = event.activation?.entry?.url;
    if (event.viewTransition && other) prepare('swap', other, event.viewTransition);
  });
  window.addEventListener('pagereveal', (event) => {
    const other = globalThis.navigation?.activation?.from?.url;
    if (event.viewTransition && other) prepare('reveal', other, event.viewTransition);
  });
  // A page that comes back from the back/forward cache drops what its last swap named.
  window.addEventListener('pageshow', (event) => {
    if (event.persisted) clear();
  });
}
