// An image beside the text stands beside running text, never above a heading (P185-79: a float
// placed before a text that opens with its heading started higher than the heading did). So
// the headings go first, in reading order too, and the float starts at the first paragraph.
// That holds for a run of floats (they all wait for the same text) and across blocks: heading
// blocks and texts that are only headings move up whole, until the first block with running
// text, whose opening headings are split off.
// Here and not in the document: an editor's block order stays as saved, and every representation
// that renders a model gets the same answer. Rejected: pushing the float down with a margin (a
// heading's height depends on its wrapping) and refusing the order in the editor (a correct
// document, with a rendering problem).

import type { RenderBlock } from './model.js';

const isFloat = (block: RenderBlock) =>
  block.type === 'image' && block.image !== null && block.layout.startsWith('float-');

/** How many top-level nodes a text opens with that are headings. */
const openingHeadings = (block: RenderBlock & { type: 'rich-text' }) => {
  const at = block.doc.content.findIndex((node) => node.type !== 'heading');
  return at === -1 ? block.doc.content.length : at;
};

export function headingsAboveFloats(blocks: readonly RenderBlock[]): RenderBlock[] {
  const out: RenderBlock[] = [];
  let i = 0;
  while (i < blocks.length) {
    if (!isFloat(blocks[i]!)) {
      out.push(blocks[i]!);
      i += 1;
      continue;
    }
    const start = i;
    while (i < blocks.length && isFloat(blocks[i]!)) i += 1;
    const floats = blocks.slice(start, i);
    const above: RenderBlock[] = [];
    const beside: RenderBlock[] = [];
    while (i < blocks.length) {
      const next = blocks[i]!;
      if (next.type === 'heading') {
        above.push(next);
        i += 1;
        continue;
      }
      if (next.type !== 'rich-text') break;
      const count = openingHeadings(next);
      if (count === 0) break;
      i += 1;
      if (count === next.doc.content.length) {
        above.push(next);
        continue;
      }
      above.push({
        id: `${next.id}-opening`,
        type: 'rich-text',
        sourceId: next.id,
        doc: { ...next.doc, content: next.doc.content.slice(0, count) },
      });
      beside.push({ ...next, doc: { ...next.doc, content: next.doc.content.slice(count) } });
      break;
    }
    out.push(...above, ...floats, ...beside);
  }
  return out;
}
