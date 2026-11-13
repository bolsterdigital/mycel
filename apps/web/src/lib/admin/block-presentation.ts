// How the edit screen presents each registered block type (MY-110 A, brief block-editor-
// interactions § A1): what a block shows at rest, and which of its fields the open editor puts
// under "Display" or "Source and credits" instead of with the content. Core's props schema stays
// the storage contract; this only names keys of `BLOCK_DEFINITIONS`, never a second list of
// stored fields, and the mapped type makes a new block type a compile error until it has an
// entry here (the conformance test checks the keys). Rejected: deriving the groups from the
// field kind (a `choice` is display for `layout` but content for a video's `provider`) and a
// presentation field in core (the API and MCP have no use for it).
import type { BlockType } from '@mycel/core';
import type { IconName } from './ui/icons.js';

/** Decorative cues for the same registered types; visible names always carry their meaning. */
export const BLOCK_ICONS: Readonly<Record<BlockType, IconName>> = {
  'people-grid': 'users',
  heading: 'heading',
  'rich-text': 'text',
  image: 'image',
  quote: 'quote',
  callout: 'info',
  faq: 'circle-help',
  cta: 'megaphone',
  cards: 'clipboard-list',
  'file-download': 'download',
  gallery: 'images',
  timeline: 'calendar',
  audio: 'volume',
  'video-embed': 'video',
  form: 'clipboard-list',
  'signup-form': 'mail',
  'campaign-card': 'megaphone',
  paywall: 'lock',
  hero: 'image',
};

export type RestView =
  /** The picture itself at card scale, with the caption and credit the page shows. */
  | 'image'
  /** The words as the page sets them (`BlockText`): a heading, a text, a quote, a callout, an FAQ, a CTA, a video's title, a form's shape, a paywall's boundary, a legacy hero's words under its picture. */
  | 'text';

export interface BlockPresentation {
  rest: RestView;
  /** Top-level field keys shown folded under "Display": layout, width, variant. */
  display: readonly string[];
  /** Top-level field keys shown folded under "Source and credits". */
  source: readonly string[];
  /**
   * The MY-110 step that designed this entry: `A` is the image pilot, `C1` and `C2` the text
   * blocks, `C3` the video and the forms, `C4` the paywall and the legacy hero (brief
   * block-editor-interactions § C).
   */
  stage: 'A' | 'C1' | 'C2' | 'C3' | 'C4';
  /**
   * The open editor shows this list as the row the site shows: its entries side by side,
   * typed in place, added with a button instead of a spare row, and `style` as the choice above
   * them instead of under "Display".
   */
  row?: { list: string; style: string };
}

/** The keys of the lists a block's form offers with an add button. */
export const addButtonLists = (type: BlockType): readonly string[] => {
  const row = BLOCK_PRESENTATION[type].row;
  return row ? [row.list] : [];
};

export const BLOCK_PRESENTATION: { readonly [T in BlockType]: BlockPresentation } = {
  'people-grid': {
    rest: 'text',
    display: ['columns', 'showRole', 'showBio', 'showContact'],
    source: [],
    stage: 'C2',
  },
  image: { rest: 'image', display: ['layout'], source: ['credit'], stage: 'A' },
  heading: { rest: 'text', display: [], source: [], stage: 'C1' },
  'rich-text': { rest: 'text', display: [], source: [], stage: 'C1' },
  quote: { rest: 'text', display: ['variant', 'width'], source: [], stage: 'C1' },
  callout: { rest: 'text', display: ['variant'], source: [], stage: 'C2' },
  faq: { rest: 'text', display: ['variant', 'width'], source: [], stage: 'C2' },
  cta: { rest: 'text', display: ['variant', 'width', 'align'], source: [], stage: 'C2' },
  cards: {
    rest: 'text',
    display: ['width'],
    source: [],
    stage: 'C2',
    row: { list: 'cards', style: 'accent' },
  },
  'file-download': { rest: 'text', display: [], source: [], stage: 'C2' },
  gallery: { rest: 'text', display: ['variant', 'width'], source: [], stage: 'C2' },
  timeline: { rest: 'text', display: ['order'], source: [], stage: 'C2' },
  audio: { rest: 'text', display: [], source: [], stage: 'C2' },
  'video-embed': { rest: 'text', display: ['width'], source: [], stage: 'C3' },
  form: { rest: 'text', display: ['variant', 'width'], source: [], stage: 'C3' },
  'signup-form': { rest: 'text', display: [], source: [], stage: 'C3' },
  // ADR 033 rule 4: the campaign as the site shows it now, with its state and count.
  'campaign-card': { rest: 'text', display: ['variant', 'width'], source: [], stage: 'C3' },
  paywall: { rest: 'text', display: [], source: [], stage: 'C4' },
  hero: { rest: 'text', display: ['variant', 'width', 'align'], source: [], stage: 'C4' },
};

/** Which group of the open editor a top-level field belongs to. */
export function groupOf(type: BlockType, key: string): 'content' | 'display' | 'source' {
  const p = BLOCK_PRESENTATION[type];
  if (p.display.includes(key)) return 'display';
  if (p.source.includes(key)) return 'source';
  return 'content';
}
