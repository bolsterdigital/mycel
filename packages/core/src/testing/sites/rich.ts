// Small builders for demo site definitions: rich text as ProseMirror JSON and blocks at their
// current version, so a definition reads as content instead of nested objects. Localised values
// are plain records (`{ nl, en }`), and a definition that has only `nl` passes only `nl`.
// Rejected: reusing the private helpers of `demo-content.ts` (that file sits at its size ceiling
// and its builders are tied to two fixed locales).

import type { z } from 'zod';
import type { BlockInput } from '../../content/blocks.js';
import { BLOCK_DEFINITIONS } from '../../content/block-types.js';
import type { RichTextDoc } from '../../content/rich-text.js';

/** A localised text: one entry per locale the item has. */
export type L = Record<string, string>;

type Mark =
  | { type: 'bold' | 'italic' | 'code' }
  | { type: 'link'; attrs: { href: string } | { itemId: string } }
  | { type: 'lang'; attrs: { lang: string } }
  | { type: 'footnote_reference'; attrs: { text: string } };
interface Text {
  type: 'text';
  text: string;
  marks?: Mark[];
}
type Inline = Text | { type: 'hard_break' };
type Part = string | Inline;
type Node = { type: string; [key: string]: unknown };

const inline = (part: Part): Inline =>
  typeof part === 'string' ? { type: 'text', text: part } : part;
const marked = (text: string, ...marks: Mark[]): Text => ({ type: 'text', text, marks });

export const bold = (text: string) => marked(text, { type: 'bold' });
export const italic = (text: string) => marked(text, { type: 'italic' });
export const code = (text: string) => marked(text, { type: 'code' });
export const boldItalic = (text: string) => marked(text, { type: 'bold' }, { type: 'italic' });
export const href = (text: string, url: string) =>
  marked(text, { type: 'link', attrs: { href: url } });
export const to = (text: string, itemId: string) =>
  marked(text, { type: 'link', attrs: { itemId } });
export const note = (text: string, footnote: string) =>
  marked(text, { type: 'footnote_reference', attrs: { text: footnote } });
export const lang = (text: string, locale: string) =>
  marked(text, { type: 'lang', attrs: { lang: locale } });
export const br: Inline = { type: 'hard_break' };

export const p = (...parts: Part[]): Node => ({ type: 'paragraph', content: parts.map(inline) });
export const h = (level: 2 | 3, text: string): Node => ({
  type: 'heading',
  attrs: { level },
  content: [{ type: 'text', text }],
});
const li = (item: Part | Node[]): Node => ({
  type: 'list_item',
  content: Array.isArray(item) ? item : [p(item)],
});
export const ul = (...items: (Part | Node[])[]): Node => ({
  type: 'bullet_list',
  content: items.map(li),
});
export const ol = (...items: (Part | Node[])[]): Node => ({
  type: 'ordered_list',
  content: items.map(li),
});
export const doc = (...content: Node[]) => ({ type: 'doc', content }) as unknown as RichTextDoc;

type Defs = typeof BLOCK_DEFINITIONS;
/** A block of `type` at its current version; its props are checked when the item is saved. */
export function block<T extends keyof Defs>(
  type: T,
  props: Partial<z.input<Defs[T]['props']>> & Record<string, unknown>
): BlockInput {
  return { type, version: BLOCK_DEFINITIONS[type].version, props } as unknown as BlockInput;
}

/** A rich-text block: one document per locale. */
export const text = (content: Record<string, Node[]>): BlockInput =>
  block('rich-text', {
    content: Object.fromEntries(Object.entries(content).map(([l, nodes]) => [l, doc(...nodes)])),
  });

/** A rich-text block of one sentence per locale. */
export const say = (sentence: L): BlockInput =>
  text(Object.fromEntries(Object.entries(sentence).map(([l, s]) => [l, [p(s)]])));

export const heading = (value: L): BlockInput => block('heading', { text: value });

/** One rich-text document per locale, for the rich-text props of other blocks (faq, callout). */
export const rich = (content: Record<string, Node[]>) =>
  Object.fromEntries(Object.entries(content).map(([l, nodes]) => [l, doc(...nodes)]));
