// Which top-level blocks of a render model put an element on the page, so a menu anchor can be
// checked against what visitors get (brief site-navigation § D3, ADR 036 rule 3). A block whose
// reference did not resolve for the visitor (a restricted image, a form that is not there, a
// campaign that shows nothing) renders no element; a link to it opens the top of the page.
//
// The answer comes from the renderer itself: `Blocks.svelte` rendered on the server, and the
// element ids `anchor.ts` gives it. Rejected: a predicate per block type next to the components
// (a second copy of their conditions that drifts the first time a block learns to render
// nothing), and an existence check of the references in core (`blockReferenceIssues`), which
// answers whether a save may refer to them, not whether the visitor sees the block: a restricted
// image exists and still shows nothing.

import { render } from 'svelte/server';
import { BLOCK_ANCHOR_PREFIX } from './anchor.js';
import Blocks from './Blocks.svelte';
import type { RenderModel } from './model.js';

const ELEMENT_ID = new RegExp(`\\sid="${BLOCK_ANCHOR_PREFIX}([A-Za-z0-9_-]{1,64})"`, 'g');

/** The ids of the blocks of `model` that render an element a link can land on. */
export function shownBlockIds(model: RenderModel): Set<string> {
  const { body } = render(Blocks, { props: { model } });
  return new Set([...body.matchAll(ELEMENT_ID)].map((m) => m[1]!));
}
