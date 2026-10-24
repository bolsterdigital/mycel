// The article writing surface is a view of the stored block tree (ADR 020.5). Prose nodes keep
// their stable block ids; card nodes keep the complete block as opaque data. Only the selected
// locale's prose is editable here. The server resolves every id against the base revision and
// never trusts props sent by the browser. Rejected: storing the TipTap document as a revision,
// which would make public rendering and MCP depend on an admin editor.
import { Block, ContentDocument, RichTextDoc } from '@mycel/core';

export type EditorNode = {
  type: 'mycelProse' | 'mycelCard';
  attrs: { blockId: string; blockType?: string; newBlock?: unknown };
  content?: RichTextDoc['content'];
};
export type ArticleEditorDocument = { type: 'doc'; content: EditorNode[] };
export class EditorInputError extends Error {}

const toTiptap = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(toTiptap);
  if (!value || typeof value !== 'object') return value;
  const node = value as Record<string, unknown>;
  const type =
    node.type === 'bullet_list'
      ? 'bulletList'
      : node.type === 'ordered_list'
        ? 'orderedList'
        : node.type === 'list_item'
          ? 'listItem'
          : node.type === 'hard_break'
            ? 'hardBreak'
            : node.type === 'footnote_reference'
              ? 'footnoteReference'
              : node.type;
  return Object.fromEntries(
    Object.entries('type' in node ? { ...node, type } : node).map(([key, item]) => [
      key,
      toTiptap(item),
    ])
  );
};

const fromTiptap = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(fromTiptap);
  if (!value || typeof value !== 'object') return value;
  const node = value as Record<string, unknown>;
  const type =
    node.type === 'bulletList'
      ? 'bullet_list'
      : node.type === 'orderedList'
        ? 'ordered_list'
        : node.type === 'listItem'
          ? 'list_item'
          : node.type === 'hardBreak'
            ? 'hard_break'
            : node.type === 'footnoteReference'
              ? 'footnote_reference'
              : node.type;
  if (type === 'link' && node.attrs && typeof node.attrs === 'object') {
    const attrs = Object.fromEntries(
      Object.entries(node.attrs).filter(([, entry]) => entry !== null && entry !== undefined)
    );
    return { type, attrs };
  }
  return Object.fromEntries(
    Object.entries('type' in node ? { ...node, type } : node).map(([key, item]) => [
      key,
      fromTiptap(item),
    ])
  );
};

export function toArticleEditor(doc: ContentDocument, locale: string): ArticleEditorDocument {
  return {
    type: 'doc',
    content: doc.blocks.map((block) =>
      block.type === 'rich-text'
        ? {
            type: 'mycelProse' as const,
            attrs: { blockId: block.id, blockType: block.type },
            content: toTiptap(
              block.props.content[locale]?.content ?? [{ type: 'paragraph' }]
            ) as RichTextDoc['content'],
          }
        : { type: 'mycelCard' as const, attrs: { blockId: block.id, blockType: block.type } }
    ),
  };
}

/** Parse an untrusted editor payload against the base revision and core's complete document schema. */
export function fromArticleEditor(
  base: ContentDocument,
  locale: string,
  input: unknown
): ContentDocument {
  if (!base.locales.includes(locale)) throw new EditorInputError('Unknown document locale');
  const root = input as Partial<ArticleEditorDocument>;
  if (root?.type !== 'doc' || !Array.isArray(root.content) || root.content.length > 200)
    throw new EditorInputError('Invalid editor document');
  const byId = new Map(base.blocks.map((block) => [block.id, block]));
  const seen = new Set<string>();
  const blocks: Block[] = root.content.map((node) => {
    const id = node?.attrs?.blockId;
    if (typeof id !== 'string' || seen.has(id))
      throw new EditorInputError('Invalid block identity');
    seen.add(id);
    const initial = byId.get(id);
    const newProse = !initial && node.type === 'mycelProse' && node.attrs.newBlock;
    const prose = newProse
      ? RichTextDoc.parse({ type: 'doc', content: fromTiptap(node.content) })
      : null;
    const block =
      initial ??
      (node.attrs.newBlock
        ? Block.parse(
            newProse
              ? { ...(node.attrs.newBlock as object), props: { content: { [locale]: prose } } }
              : node.attrs.newBlock
          )
        : null);
    if (
      !block ||
      block.id !== id ||
      node.type !== (block.type === 'rich-text' ? 'mycelProse' : 'mycelCard')
    )
      throw new EditorInputError('Unknown or changed block');
    if (block.type !== 'rich-text') return block;
    const content = RichTextDoc.parse({ type: 'doc', content: fromTiptap(node.content) });
    return {
      ...block,
      props: { ...block.props, content: { ...block.props.content, [locale]: content } },
    };
  });
  if ([...byId.keys()].some((id) => !seen.has(id)))
    throw new EditorInputError('A block is missing');
  return ContentDocument.parse({ ...base, blocks });
}
