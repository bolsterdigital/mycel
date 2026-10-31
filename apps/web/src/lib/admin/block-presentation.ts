// How the edit screen presents each registered block type (MY-110 A, brief block-editor-
// interactions § A1): what a block shows at rest, and which of its fields the open editor puts
// under "Display" or "Source and credits" instead of with the content. Core's props schema stays
// the storage contract; this only names keys of `BLOCK_DEFINITIONS`, never a second list of
// stored fields, and the mapped type makes a new block type a compile error until it has an
// entry here (the conformance test checks the keys). Rejected: deriving the groups from the
// field kind (a `choice` is display for `layout` but content for a video's `provider`) and a
// presentation field in core (the API and MCP have no use for it).
import type { BlockType } from '@mycel/core';

export type RestView =
  /** The picture itself at card scale, with the caption and credit the page shows. */
  | 'image'
  /** The first text and the entries of a list, beside a thumbnail: the interim view of PR 3. */
  | 'summary';

export interface BlockPresentation {
  rest: RestView;
  /** Top-level field keys shown folded under "Display": layout, width, variant. */
  display: readonly string[];
  /** Top-level field keys shown folded under "Source and credits". */
  source: readonly string[];
  /**
   * The MY-110 step that designed this entry: `A` is the image pilot; `C1`-`C4` still show the
   * interim summary until their group is built (brief block-editor-interactions § C).
   */
  stage: 'A' | 'C1' | 'C2' | 'C3' | 'C4';
}

const summary = (stage: BlockPresentation['stage'], display: readonly string[] = []) =>
  ({ rest: 'summary', display, source: [], stage }) as const satisfies BlockPresentation;

export const BLOCK_PRESENTATION: { readonly [T in BlockType]: BlockPresentation } = {
  image: { rest: 'image', display: ['layout'], source: ['credit'], stage: 'A' },
  heading: summary('C1'),
  'rich-text': summary('C1'),
  quote: summary('C1', ['variant', 'width']),
  callout: summary('C2', ['variant']),
  faq: summary('C2', ['variant', 'width']),
  cta: summary('C2', ['variant', 'width', 'align']),
  'video-embed': summary('C3', ['width']),
  form: summary('C3', ['variant', 'width']),
  'signup-form': summary('C3'),
  paywall: summary('C4'),
  hero: summary('C4', ['variant', 'width', 'align']),
};

/** Which group of the open editor a top-level field belongs to. */
export function groupOf(type: BlockType, key: string): 'content' | 'display' | 'source' {
  const p = BLOCK_PRESENTATION[type];
  if (p.display.includes(key)) return 'display';
  if (p.source.includes(key)) return 'source';
  return 'content';
}
