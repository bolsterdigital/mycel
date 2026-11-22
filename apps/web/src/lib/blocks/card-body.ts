// When a full campaign card shows the campaign's text open instead of in `<details>` (ADR 038
// rule 4): a short text without subheadings reads in one glance, so folding it away only adds a
// click. The limit is a word count over what the card shows (headings, paragraphs, quotes,
// callouts; not image captions), set here with its test. Rejected: a character count (it varies
// with the language more than words do) and leaving the choice to the editor (a stored flag per
// card, while the same campaign text then folds on one page and not on another).

import type { RichTextDoc } from '@mycel/core';
import type { RenderBlock } from './model.js';

/** At most this many words and no subheading: the card shows the text open. */
export const CARD_BODY_OPEN_WORDS = 80;

type Node = { type: string; text?: string; content?: readonly Node[] };

const words = (text: string | null | undefined) => (text ?? '').split(/\s+/).filter(Boolean).length;

function docWords(doc: RichTextDoc): { words: number; heading: boolean } {
  let count = 0;
  let heading = false;
  const walk = (node: Node) => {
    if (node.type === 'heading') heading = true;
    if (node.type === 'text') count += words(node.text);
    for (const child of node.content ?? []) walk(child);
  };
  walk(doc as unknown as Node);
  return { words: count, heading };
}

/** True when the body is short enough, and without a subheading, to show open in a card. */
export function opensInCard(blocks: readonly RenderBlock[]): boolean {
  let count = 0;
  for (const block of blocks) {
    if (block.type === 'heading') return false;
    if (block.type === 'rich-text' || block.type === 'callout') {
      const doc = docWords(block.type === 'rich-text' ? block.doc : block.body);
      if (doc.heading) return false;
      count += doc.words + (block.type === 'callout' ? words(block.title) : 0);
    }
    if (block.type === 'quote') count += words(block.text);
  }
  return count <= CARD_BODY_OPEN_WORDS;
}
