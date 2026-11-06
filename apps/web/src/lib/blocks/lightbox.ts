// The lightbox : which images open larger, and the words the script
// `static/_image/lightbox.js` reads from the page, since it knows no language of its own.
// Rejected: a word list per locale in the script, which puts copy outside the catalogs (ADR 007).

import type { BlockCopy } from './model.js';
import type { ImageLayout } from './sizes.js';

// Which images open larger: Dreamkit's rule (wings-media-blocks image/render.php), an image whose
// largest file is at least 10% wider than the image on the page. The page width is the layout's
// rail from sizes.ts in CSS px, against the widest public variant (w1920 at most; the original
// stays private). `full` never opens: it already is the screen. An image without an alt never
// opens: a link needs a name, and a decorative image has nothing to show larger. In a gallery every
// image opens, as in Dreamkit, and the arrows walk that one gallery.
// Rejected: opening every image, which for one already at its full size is a click for nothing.
const RAIL_PX: Record<ImageLayout, number | null> = {
  content: 704,
  wide: 1088,
  full: null,
  'float-left': 368,
  'float-right': 368,
};

/** The larger file an image block opens in its layout, or null when it stays as it is. */
export function largerImage(
  image: { alt: string; large: { src: string; width: number; height: number } | null },
  layout: ImageLayout | 'gallery'
): { src: string; width: number; height: number } | null {
  if (!image.alt || !image.large) return null;
  if (layout === 'gallery') return image.large;
  const rail = RAIL_PX[layout];
  return rail !== null && image.large.width >= rail * 1.1 ? image.large : null;
}

/** The `data-*` attributes of a figure or gallery whose images open: the dialog's words. */
export function lightboxAttributes(copy: BlockCopy['lightbox']): Record<string, string> {
  return {
    'data-lightbox': copy.dialog,
    'data-lightbox-close': copy.close,
    'data-lightbox-previous': copy.previous,
    'data-lightbox-next': copy.next,
    'data-lightbox-zoom': copy.zoom,
    'data-lightbox-count': copy.count,
  };
}

/** The script, one module per page however many images open; served from the site's own origin. */
export const LIGHTBOX_SCRIPT = '/_image/lightbox.js';
