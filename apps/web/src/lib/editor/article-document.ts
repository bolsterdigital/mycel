// The article writing surface is a view of the stored block tree (ADR 020.5). Prose nodes keep
// their stable block ids; card nodes keep the complete block as opaque data. Only the selected
// locale's prose is editable here. The server resolves every id against the base revision and
// never trusts props sent by the browser. Rejected: storing the TipTap document as a revision,
// which would make public rendering and MCP depend on an admin editor.
import { richTextHtml } from '../blocks/rich-text.js';
import {
  Block,
  ContentDocument,
  RichTextDoc,
  isBlankDoc,
  normalizeBlocks,
  teaserFollowing,
} from '@mycel/core';

export type EditorNode = {
  type: 'mycelProse' | 'mycelCard';
  attrs: {
    blockId: string;
    blockType?: string;
    newBlock?: unknown;
    /** What another locale says, shown beside an empty block and never posted back as its value. */
    showThrough?: ShowThrough | null;
  };
  content?: RichTextDoc['content'];
};
export type ShowThrough = { locale: string; text: string };
export type ArticleEditorDocument = {
  type: 'doc';
  content: EditorNode[];
  removedCardIds?: string[];
};

/** Only a user edit records missing cards; restoring one (including Undo) clears its intent. */
export function removedArticleCards(
  before: ArticleEditorDocument,
  after: ArticleEditorDocument,
  removed: readonly string[],
  userEdit: boolean
): string[] {
  const present = new Set((after.content ?? []).map((node) => node.attrs?.blockId));
  return [
    ...new Set([
      ...removed,
      ...(userEdit
        ? (before.content ?? [])
            .filter((node) => node.type === 'mycelCard')
            .map((node) => node.attrs.blockId)
        : []),
    ]),
  ].filter((id) => !present.has(id));
}
export class EditorInputError extends Error {}

export const toTiptap = (value: unknown): unknown => {
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
  const converted =
    node.type === 'ordered_list' &&
    node.attrs &&
    typeof node.attrs === 'object' &&
    'start' in node.attrs &&
    (node.attrs as Record<string, unknown>).start === 1
      ? { ...node, attrs: { ...node.attrs, mycelExplicitStart: true }, type }
      : 'type' in node
        ? { ...node, type }
        : node;
  return Object.fromEntries(Object.entries(converted).map(([key, item]) => [key, toTiptap(item)]));
};

export const fromTiptap = (value: unknown): unknown => {
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
  if (type === 'ordered_list') {
    const normalized: Record<string, unknown> = { ...node, type };
    if (normalized.attrs && typeof normalized.attrs === 'object') {
      // TipTap adds `type: null` and a default start of 1. Only an omitted start loses the default.
      const explicitStart =
        (normalized.attrs as Record<string, unknown>).mycelExplicitStart === true;
      const attrs = Object.fromEntries(
        Object.entries(normalized.attrs).filter(
          ([key, entry]) =>
            key !== 'mycelExplicitStart' &&
            !(key === 'type' && entry === null) &&
            !(key === 'start' && entry === 1 && !explicitStart)
        )
      );
      if (Object.keys(attrs).length) normalized.attrs = attrs;
      else delete normalized.attrs;
    }
    return Object.fromEntries(
      Object.entries(normalized).map(([key, item]) => [key, fromTiptap(item)])
    );
  }
  return Object.fromEntries(
    Object.entries('type' in node ? { ...node, type } : node).map(([key, item]) => [
      key,
      fromTiptap(item),
    ])
  );
};

const SHOW_THROUGH_LENGTH = 200;

const wordsOf = (node: unknown): string[] => {
  const { text, content } = node as { text?: unknown; content?: unknown };
  return [
    ...(typeof text === 'string' ? [text] : []),
    ...(Array.isArray(content) ? content.flatMap(wordsOf) : []),
  ];
};

/**
 * The words an emptied block has in another locale, default locale first. A hint, not content: the
 * editor's text would be posted as this locale's translation (#142). Rejected: loading the other
 * locale into the editor, which stores Dutch as English on the next save.
 */
function showThrough(
  content: Record<string, unknown>,
  locale: string,
  defaultLocale: string
): ShowThrough | null {
  if (content[locale] !== undefined && !isBlankDoc(content[locale])) return null;
  const other = [defaultLocale, ...Object.keys(content)].find(
    (l) => l !== locale && content[l] !== undefined && !isBlankDoc(content[l])
  );
  if (!other) return null;
  const text = wordsOf(content[other]).join(' ').replace(/\s+/g, ' ').trim();
  return {
    locale: other,
    text:
      text.length > SHOW_THROUGH_LENGTH ? `${text.slice(0, SHOW_THROUGH_LENGTH).trimEnd()}…` : text,
  };
}

export function toArticleEditor(doc: ContentDocument, locale: string): ArticleEditorDocument {
  return {
    type: 'doc',
    content: doc.blocks.map((block) =>
      block.type === 'rich-text'
        ? {
            type: 'mycelProse' as const,
            attrs: {
              blockId: block.id,
              blockType: block.type,
              showThrough: showThrough(block.props.content, locale, doc.defaultLocale),
            },
            content: toTiptap(
              block.props.content[locale]?.content ?? [{ type: 'paragraph' }]
            ) as RichTextDoc['content'],
          }
        : { type: 'mycelCard' as const, attrs: { blockId: block.id, blockType: block.type } }
    ),
  };
}

/**
 * A prose block after the writer. Emptied is absent, as in the block forms: another locale with
 * words keeps the block and shows through, and readiness sees a missing translation. Without words
 * anywhere the block goes, because an empty line between two cards is ordinary writing (#142), not
 * a mistake to refuse. Rejected: refusing the save as the native form does, which blocks everything
 * else on the screen over a line nobody can see.
 */
function written(
  block: Extract<Block, { type: 'rich-text' }>,
  locale: string,
  content: RichTextDoc
): Block[] {
  const { [locale]: _emptied, ...others } = block.props.content;
  if (!isBlankDoc(content))
    return [{ ...block, props: { ...block.props, content: { ...others, [locale]: content } } }];
  if (Object.values(others).every(isBlankDoc)) return [];
  return [{ ...block, props: { ...block.props, content: others } }];
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
  const removed = root.removedCardIds ?? [];
  if (
    !Array.isArray(removed) ||
    removed.length > 200 ||
    removed.some(
      (id) => typeof id !== 'string' || !byId.has(id) || byId.get(id)?.type === 'rich-text'
    )
  )
    throw new EditorInputError('Invalid card removal');
  const seen = new Set<string>();
  const blocks: Block[] = root.content.flatMap((node) => {
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
    if (block.type !== 'rich-text') return [block];
    const content = RichTextDoc.parse({ type: 'doc', content: fromTiptap(node.content) });
    return written(block, locale, content);
  });
  if ([...byId.keys()].some((id) => !seen.has(id) && !removed.includes(id)))
    throw new EditorInputError('A block is missing');
  // Taking away or placing the only paywall moves the teaser with it, as the screen's own block
  // action does (#231); the form may still state another teaser over this one.
  const kept = normalizeBlocks(blocks).blocks;
  return ContentDocument.parse({ ...base, access: teaserFollowing(base, kept), blocks: kept });
}

/** The same constrained renderer supplies the initial sheet; no independent HTML serializer. */
export function articleProseHtml(node: EditorNode): string {
  return richTextHtml(RichTextDoc.parse(fromTiptap({ type: 'doc', content: node.content })), {
    depth: 0,
    links: {},
    base: '',
    idPrefix: node.attrs.blockId,
    footnotes: '',
    footnoteBack: '',
    inert: true,
    editing: true,
  });
}
