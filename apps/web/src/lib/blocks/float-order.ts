// An image beside the text stands beside running text, never above a heading (P185-79: a float
// placed before a text that opens with its heading started higher than the heading did). So
// the heading goes first, in reading order too, and the float starts at the first paragraph.
// Here and not in the document: an editor's block order stays as saved, and every representation
// that renders a model gets the same answer. Rejected: pushing the float down with a margin (a
// heading's height depends on its wrapping) and refusing the order in the editor (a correct
// document, with a rendering problem).

import type { RenderBlock } from './model.js';

const isFloat = (block: RenderBlock) =>
  block.type === 'image' && block.image !== null && block.layout.startsWith('float-');

export function headingsAboveFloats(blocks: readonly RenderBlock[]): RenderBlock[] {
  const out: RenderBlock[] = [];
  for (let i = 0; i < blocks.length; i += 1) {
    const block = blocks[i]!;
    const next = blocks[i + 1];
    if (!isFloat(block) || !next) {
      out.push(block);
    } else if (next.type === 'heading') {
      out.push(next, block);
      i += 1;
    } else if (
      next.type === 'rich-text' &&
      next.doc.content[0]?.type === 'heading' &&
      next.doc.content.length > 1
    ) {
      const [opening, ...rest] = next.doc.content;
      out.push(
        {
          id: `${next.id}-opening`,
          type: 'rich-text',
          sourceId: next.id,
          doc: { ...next.doc, content: [opening!] },
        },
        block,
        { ...next, doc: { ...next.doc, content: rest } }
      );
      i += 1;
    } else {
      out.push(block);
    }
  }
  return out;
}
