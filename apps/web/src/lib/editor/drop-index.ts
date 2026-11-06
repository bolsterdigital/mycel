// Where a file dropped on the article writer goes: between two top-level nodes of the
// document, the edge of the node under the pointer that is nearest. Inside a text block it is the
// nearest edge between two of its paragraphs, which splits the block in two when `split` allows it
// (WritingSurface.svelte); otherwise the nearest edge of the whole block. Splitting only while the
// item has one locale: a block's other locales would keep the whole text under the first half's
// id, and no screen could say which half they belong to.
// Rejected: ProseMirror's own drop position (any character), since a card is never inline.
import type { EditorView } from '@tiptap/pm/view';

/** Before top-level node `index`; with `split`, inside the text block before it, at that child. */
export interface DropIndex {
  index: number;
  split: number | null;
}

/** Whether `y` lies in the lower half of the element. */
const lower = (dom: Node | null, y: number): boolean => {
  if (!(dom instanceof Element)) return false;
  const box = dom.getBoundingClientRect();
  return y > box.top + box.height / 2;
};

export function dropIndex(view: EditorView, event: MouseEvent, split: boolean): DropIndex {
  const doc = view.state.doc;
  const at = view.posAtCoords({ left: event.clientX, top: event.clientY });
  if (!at) return { index: doc.childCount, split: null };
  const $pos = doc.resolve(at.inside >= 0 ? at.inside : at.pos);
  const top = Math.min($pos.index(0), doc.childCount - 1);
  if (top < 0) return { index: 0, split: null };
  const node = doc.child(top);
  let start = 0;
  for (let i = 0; i < top; i++) start += doc.child(i).nodeSize;
  if (node.type.name !== 'mycelProse' || !split || $pos.depth < 1 || node.childCount < 2)
    return { index: top + (lower(view.nodeDOM(start), event.clientY) ? 1 : 0), split: null };
  const child = Math.min($pos.index(1), node.childCount - 1);
  let offset = start + 1;
  for (let i = 0; i < child; i++) offset += node.child(i).nodeSize;
  const at2 = child + (lower(view.nodeDOM(offset), event.clientY) ? 1 : 0);
  if (at2 === 0) return { index: top, split: null };
  if (at2 >= node.childCount) return { index: top + 1, split: null };
  return { index: top + 1, split: at2 };
}
