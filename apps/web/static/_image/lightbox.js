// The lightbox : an image that opens larger is a plain link to its
// larger file (`lib/blocks/Picture.svelte`), and that is the whole feature without this module.
// With it, a click opens the file in a modal <dialog> over the page: fitted to the screen with
// room around it, its caption under it, actual size on a click with dragging or scrolling to pan,
// the arrows through the images of one gallery. Dreamkit's PhotoSwipe behaviour, kept
// (wings-media-blocks `lightbox-config.js`), on what the browser already does: showModal() makes
// the page inert and closes on Escape; the focus goes back to the link explicitly.
//
// The words come from the page (`data-lightbox-*` on the figure or gallery, from the catalogs), so
// this file knows no language. Every node is made with createElement and textContent and the
// caption is a clone of the figcaption: no innerHTML, so no Trusted Types policy is needed. Its
// stylesheet is loaded from here, so a page without an image that opens carries none of it.
//
// A plain file in `static/`, served from the site's own origin under `script-src 'self'`, like
// `_form/proof.js`. Rejected: PhotoSwipe 5 (about 70 KB of script for this, buttons set through
// innerHTML under `require-trusted-types-for`, a vendored file without a bundler) and a Vite client
// entry, which with `csr = false` needs hand-wired asset imports for one module.

const SVG = 'http://www.w3.org/2000/svg';
// Lucide (ISC): x, chevron-left, chevron-right, zoom-in.
const ICONS = {
  close: ['M18 6 6 18', 'm6 6 12 12'],
  previous: ['m15 18-6-6 6-6'],
  next: ['m9 18 6-6-6-6'],
  zoom: ['m21 21-4.34-4.34', 'M11 8v6', 'M8 11h6'],
};

const stylesheet = document.createElement('link');
stylesheet.rel = 'stylesheet';
stylesheet.href = new URL('lightbox.css', import.meta.url).pathname;
const styled = new Promise((resolve) => {
  stylesheet.addEventListener('load', resolve, { once: true });
  stylesheet.addEventListener('error', resolve, { once: true });
});
document.head.append(stylesheet);

let box = null;
let slides = [];
let index = 0;
let opener = null;
let drag = null;

function node(tag, className, attrs = {}) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  for (const [name, value] of Object.entries(attrs)) el.setAttribute(name, value);
  return el;
}

function button(name, label) {
  const b = node('button', `lightbox-button lightbox-${name}`, { type: 'button' });
  const icon = document.createElementNS(SVG, 'svg');
  for (const [k, v] of Object.entries({
    viewBox: '0 0 24 24',
    width: '24',
    height: '24',
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': '2',
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    'aria-hidden': 'true',
  }))
    icon.setAttribute(k, v);
  if (name === 'zoom') {
    const lens = document.createElementNS(SVG, 'circle');
    for (const [k, v] of Object.entries({ cx: '11', cy: '11', r: '8' })) lens.setAttribute(k, v);
    icon.append(lens);
  }
  for (const d of ICONS[name]) {
    const path = document.createElementNS(SVG, 'path');
    path.setAttribute('d', d);
    icon.append(path);
  }
  const word = node('span', 'lightbox-word');
  word.textContent = label;
  b.append(icon, word);
  return b;
}

/** The dialog, made once per page with the words of the first group that opens it. */
function build(words) {
  const dialog = node('dialog', 'lightbox', { 'aria-label': words.dialog });
  const count = node('p', 'lightbox-count', { 'aria-live': 'polite' });
  const close = button('close', words.close);
  const stage = node('div', 'lightbox-stage');
  const img = node('img', 'lightbox-image', { alt: '', decoding: 'async' });
  stage.append(img);
  const previous = button('previous', words.previous);
  const next = button('next', words.next);
  const zoom = button('zoom', words.zoom);
  zoom.setAttribute('aria-pressed', 'false');
  const caption = node('div', 'lightbox-caption');
  dialog.append(count, close, stage, previous, next, zoom, caption);
  document.body.append(dialog);

  close.addEventListener('click', () => dialog.close());
  previous.addEventListener('click', () => go(index - 1));
  next.addEventListener('click', () => go(index + 1));
  zoom.addEventListener('click', () => setZoom(!dialog.classList.contains('zoomed')));
  // Fitted, a click on the image zooms and one beside it closes. At actual size the image fills
  // the stage and a drag captures the pointer there, so any click on the stage that did not end
  // a drag goes back to fitted; only the bars around it still close.
  dialog.addEventListener('click', (event) => {
    const zoomed = dialog.classList.contains('zoomed');
    const moved = drag?.moved;
    drag = null;
    if (moved) return;
    if (zoomed && (event.target === stage || event.target === img)) setZoom(false);
    else if (event.target === img && !zoom.hidden) setZoom(true, event);
    else if (event.target === dialog || event.target === stage) dialog.close();
  });
  dialog.addEventListener('keydown', (event) => {
    if (slides.length < 2 || dialog.classList.contains('zoomed')) return;
    const to = { ArrowLeft: index - 1, ArrowRight: index + 1, Home: 0, End: slides.length - 1 }[
      event.key
    ];
    if (to === undefined) return;
    event.preventDefault();
    go(to);
  });
  // Dragging pans an image at actual size with a mouse; a finger scrolls the stage natively.
  stage.addEventListener('pointerdown', (event) => {
    if (event.pointerType !== 'mouse' || !dialog.classList.contains('zoomed')) return;
    drag = { x: event.clientX, y: event.clientY, left: stage.scrollLeft, top: stage.scrollTop };
    stage.setPointerCapture(event.pointerId);
  });
  stage.addEventListener('pointermove', (event) => {
    if (!drag || !stage.hasPointerCapture(event.pointerId)) return;
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    if (Math.abs(dx) + Math.abs(dy) > 4) drag.moved = true;
    stage.scrollLeft = drag.left - dx;
    stage.scrollTop = drag.top - dy;
  });
  window.addEventListener('resize', () => dialog.open && fitZoom());
  dialog.addEventListener('close', () => {
    setZoom(false);
    img.removeAttribute('src');
    const back = opener;
    opener = null;
    back?.focus();
  });
  return { dialog, count, close, stage, img, previous, next, zoom, caption };
}

/** The zoom button only where actual size is larger than the fitted image. */
function fitZoom() {
  const { dialog, img, zoom } = box;
  if (dialog.classList.contains('zoomed')) return;
  zoom.hidden = !(img.getBoundingClientRect().width < slides[index].width - 1);
}

function setZoom(on, at) {
  const { dialog, stage, img, zoom } = box;
  const before = img.getBoundingClientRect();
  dialog.classList.toggle('zoomed', on);
  zoom.setAttribute('aria-pressed', String(on));
  stage.tabIndex = on ? 0 : -1;
  if (!on) {
    fitZoom();
    return;
  }
  // Keep the point under the pointer under it; from the button, the middle.
  const fx = at ? (at.clientX - before.left) / before.width : 0.5;
  const fy = at ? (at.clientY - before.top) / before.height : 0.5;
  const after = img.getBoundingClientRect();
  const view = stage.getBoundingClientRect();
  stage.scrollLeft = after.width * fx - (at ? at.clientX - view.left : view.width / 2);
  stage.scrollTop = after.height * fy - (at ? at.clientY - view.top : view.height / 2);
}

function go(to) {
  index = (to + slides.length) % slides.length;
  show();
}

function show() {
  const { dialog, count, img, previous, next, caption } = box;
  const slide = slides[index];
  setZoom(false);
  img.alt = slide.alt;
  img.width = slide.width;
  img.height = slide.height;
  // The image the page already loaded holds the place until the larger file is in.
  img.src = slide.thumb || slide.src;
  if (slide.thumb) {
    const large = new Image();
    large.onload = () => {
      if (slides[index] !== slide || !dialog.open) return;
      img.src = slide.src;
      fitZoom();
    };
    large.src = slide.src;
  }
  caption.replaceChildren(
    ...(slide.caption ? [...slide.caption.childNodes].map((n) => n.cloneNode(true)) : [])
  );
  caption.hidden = !slide.caption;
  const many = slides.length > 1;
  previous.hidden = next.hidden = !many;
  count.textContent = many
    ? box.words.count.replace('{n}', String(index + 1)).replace('{total}', String(slides.length))
    : '';
  requestAnimationFrame(fitZoom);
}

function slideOf(link) {
  const img = link.querySelector('img');
  return {
    link,
    src: link.href,
    width: Number(link.dataset.width) || img?.naturalWidth || 1,
    height: Number(link.dataset.height) || img?.naturalHeight || 1,
    alt: img?.alt ?? '',
    thumb: img?.currentSrc ?? '',
    caption: link.closest('figure')?.querySelector('figcaption') ?? null,
  };
}

async function open(link) {
  const group = link.closest('[data-lightbox]');
  const d = group.dataset;
  const words = {
    dialog: d.lightbox,
    close: d.lightboxClose,
    previous: d.lightboxPrevious,
    next: d.lightboxNext,
    zoom: d.lightboxZoom,
    count: d.lightboxCount,
  };
  await styled;
  if (!box) box = build(words);
  box.words = words;
  const links = [...group.querySelectorAll('a.enlarge')];
  slides = links.map(slideOf);
  index = Math.max(0, links.indexOf(link));
  opener = link;
  box.dialog.showModal();
  box.close.focus();
  show();
}

document.addEventListener('click', (event) => {
  const link = event.target instanceof Element ? event.target.closest('a.enlarge') : null;
  if (!link || !link.closest('[data-lightbox]')) return;
  // A modified or middle click keeps doing what a link does: a new tab, a download.
  if (event.defaultPrevented || event.button !== 0) return;
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  open(link);
});
