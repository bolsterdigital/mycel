// The element id a top-level block renders with, so a menu link with an anchor (ADR 036 rule 3,
// `content(itemId, anchor?)`) lands on it. The id is the block id behind a fixed prefix, and
// `navigationHref` writes the same prefix: a block id (`^[A-Za-z0-9_-]{1,64}$`) may otherwise be
// `public-main`, `site-bar-0`, `preview-banner` or `campaign-<id>`, ids the page already uses, and
// the browser would jump to the first. Rejected: the block id as it is (no rule keeps an editor's
// or importer's id out of the page's own namespace) and a hash of it (an author reading the
// address could no longer tell which block it names).
//
// A text split around a float (`float-order.ts`) renders twice; the first piece in reading order
// carries the source id, so the link lands on the opening heading. `paywall` renders nothing and
// gets no id; the resolver does not offer it as an anchor either. A block whose reference did not
// resolve (an image that is gone, a form that is not there) renders nothing at run time; a link to
// it then opens the top of the page, which is also what a vanished anchor does.

import type { RenderBlock } from './model.js';

export const BLOCK_ANCHOR_PREFIX = 'block-';

/** The element id of block `id`, and the fragment a link to it ends in. */
export const blockAnchor = (id: string): string => `${BLOCK_ANCHOR_PREFIX}${id}`;

/** Per rendered block id, the element id it carries; a block without one is absent. */
export function anchorIds(blocks: readonly RenderBlock[]): Map<string, string> {
  const out = new Map<string, string>();
  const taken = new Set<string>();
  for (const block of blocks) {
    if (block.type === 'paywall') continue;
    const source = (block.type === 'rich-text' && block.sourceId) || block.id;
    if (taken.has(source)) continue;
    taken.add(source);
    out.set(block.id, blockAnchor(source));
  }
  return out;
}
