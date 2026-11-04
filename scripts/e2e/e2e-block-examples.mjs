// Keep browser seed envelopes tied to registry metadata; a fixed version breaks future schemas.
// A pure mapping, so `e2e-block-examples.test.mjs` proves it without a browser.

/**
 * The types with a fixed place on the `e2e-blokken-*` pages: content-blocks.spec.ts reaches a block
 * by its place, so these stay as they are and a type added to the registry lands behind them,
 * wherever the registry lists it. Do not add to this list. Rejected: renumbering the spec per new
 * block, 81 lines each time, and reaching each block by type, which rewrites those lines at once
 * for no gain in what they prove.
 */
export const PLACED_TYPES = [
  'heading',
  'signup-form',
  'rich-text',
  'paywall',
  'image',
  'hero',
  'cta',
  'callout',
  'faq',
  'quote',
  'video-embed',
  'form',
];

/** The first example of every type, for one page: the placed types first, then the rest. */
export function everyBlockType(definitions) {
  const added = Object.keys(definitions).filter((type) => !PLACED_TYPES.includes(type));
  return [...PLACED_TYPES, ...added].map((type) => definitions[type].examples[0].name);
}

export function blockExamples(definitions) {
  return Object.fromEntries(
    Object.entries(definitions).flatMap(([type, d]) =>
      d.examples.map((e) => [e.name, { type, version: d.version, props: e.props }])
    )
  );
}
