// Only the nodes and marks of ADR 020.2 are admitted to the article editor. StarterKit's extra
// marks and nodes are disabled; the few Mycel nodes carry block identity, not a second storage
// schema. Rejected: StarterKit defaults, which would silently admit blockquotes and code blocks.
import { Extension, Mark, Node } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import StarterKit from '@tiptap/starter-kit';
import { z } from 'zod';

// This module loads before the writer's core schemas. Zod's JIT probe uses Function(), which
// strict CSP reports even when Zod catches the error.
z.config({ jitless: true });

const ArticleDocument = Node.create({
  name: 'doc',
  topNode: true,
  content: '(mycelProse | mycelCard)*',
});

const Prose = Node.create({
  name: 'mycelProse',
  group: 'block',
  content: 'block+',
  defining: true,
  addAttributes() {
    return {
      blockId: { default: null, parseHTML: (element) => element.getAttribute('data-block-id') },
      blockType: { default: 'rich-text' },
      newBlock: { default: null, rendered: false },
      showThrough: { default: null, rendered: false },
    };
  },
  // What another locale says, while this one has no words (#142). A decoration, so it is never in
  // the document and never posted as this locale's text; it goes on the first typed character.
  addProseMirrorPlugins() {
    return [
      new Plugin({
        props: {
          decorations: (state) => {
            const shown: Decoration[] = [];
            state.doc.forEach((node, position) => {
              const through = node.attrs.showThrough as { locale: string; text: string } | null;
              if (node.type.name !== 'mycelProse' || !through || node.textContent.trim()) return;
              shown.push(
                Decoration.node(position, position + node.nodeSize, {
                  'data-through-locale': through.locale,
                  'data-through': through.text,
                })
              );
            });
            return DecorationSet.create(state.doc, shown);
          },
        },
      }),
    ];
  },
  parseHTML() {
    return [{ tag: 'section[data-mycel-prose]' }];
  },
  renderHTML({ HTMLAttributes }) {
    return [
      'section',
      {
        id: `block-${HTMLAttributes.blockId}`,
        'data-mycel-prose': '',
        'data-block-id': HTMLAttributes.blockId,
        class: 'editor-prose',
      },
      0,
    ];
  },
});

const Card = Node.create({
  name: 'mycelCard',
  group: 'block',
  atom: true,
  selectable: true,
  addAttributes() {
    return {
      blockId: { default: null, parseHTML: (element) => element.getAttribute('data-block-id') },
      blockType: { default: null, parseHTML: (element) => element.getAttribute('data-block-type') },
      newBlock: { default: null, rendered: false },
    };
  },
  parseHTML() {
    return [{ tag: 'div[data-mycel-card]' }];
  },
  renderHTML({ HTMLAttributes }) {
    return [
      'div',
      {
        'data-mycel-card': '',
        'data-block-id': HTMLAttributes.blockId,
        'data-block-type': HTMLAttributes.blockType,
        class: 'editor-card',
        contenteditable: 'false',
      },
      HTMLAttributes.blockType ?? 'Card',
    ];
  },
});

const SafeLink = Mark.create({
  name: 'link',
  inclusive: false,
  addAttributes() {
    return {
      href: { default: null, parseHTML: (element) => element.getAttribute('href') },
      itemId: { default: null, parseHTML: (element) => element.getAttribute('data-item-id') },
    };
  },
  parseHTML() {
    return [{ tag: 'a[href]' }, { tag: 'span[data-item-id]' }];
  },
  renderHTML({ HTMLAttributes }) {
    return HTMLAttributes.href
      ? ['a', { href: HTMLAttributes.href, 'data-item-id': HTMLAttributes.itemId ?? undefined }, 0]
      : ['span', { 'data-item-id': HTMLAttributes.itemId }, 0];
  },
});

const FootnoteReference = Mark.create({
  name: 'footnoteReference',
  addAttributes() {
    return { text: { default: null, parseHTML: (element) => element.getAttribute('data-note') } };
  },
  parseHTML() {
    return [{ tag: 'span[data-note]' }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['span', { 'data-note': HTMLAttributes.text }, 0];
  },
});

// TipTap supplies start: 1 to every ordered list. Keep whether it was present in the stored
// document so the adapter can distinguish an omitted default from an explicit start of 1.
const ExplicitListStart = Extension.create({
  name: 'mycelExplicitListStart',
  addGlobalAttributes() {
    return [
      {
        types: ['orderedList'],
        attributes: { mycelExplicitStart: { default: null, rendered: false } },
      },
    ];
  },
});

// Typing into an empty document creates prose through the schema, bypassing the paste path.
// Assign identity in the transaction before onUpdate can serialize it; existing ids stay intact.
const BlockIdentity = Extension.create({
  name: 'mycelBlockIdentity',
  addProseMirrorPlugins() {
    return [
      new Plugin({
        appendTransaction(_transactions, _oldState, state) {
          const transaction = state.tr;
          state.doc.forEach((node, position) => {
            if (node.type.name !== 'mycelProse' || node.attrs.blockId) return;
            const id = crypto.randomUUID();
            transaction.setNodeMarkup(position, undefined, {
              ...node.attrs,
              blockId: id,
              newBlock: { id, type: 'rich-text', version: 1, props: { content: {} } },
            });
          });
          return transaction.docChanged ? transaction : null;
        },
      }),
    ];
  },
});

/** The range a link is being written for, kept visible while focus is in the link field. */
export const pendingRangeKey = new PluginKey<{ from: number; to: number } | null>(
  'mycelPendingRange'
);

// The browser draws no selection in a text that lost focus, so the words a link is for would
// vanish the moment its address field opens. A decoration, so nothing of it is stored.
// Rejected: keeping focus in the text and the field outside the tab order, which no keyboard
// reaches.
const PendingRange = Extension.create({
  name: 'mycelPendingRange',
  addProseMirrorPlugins() {
    return [
      new Plugin<{ from: number; to: number } | null>({
        key: pendingRangeKey,
        state: {
          init: () => null,
          apply(transaction, range) {
            const next = transaction.getMeta(pendingRangeKey) as
              { from: number; to: number } | null | undefined;
            if (next !== undefined) return next;
            if (!range) return null;
            return {
              from: transaction.mapping.map(range.from),
              to: transaction.mapping.map(range.to),
            };
          },
        },
        props: {
          decorations(state) {
            const range = pendingRangeKey.getState(state);
            if (!range || range.from >= range.to) return null;
            return DecorationSet.create(state.doc, [
              Decoration.inline(range.from, range.to, { class: 'editor-pending-range' }),
            ]);
          },
        },
      }),
    ];
  },
});

/** Lists in lists as deep as the stored schema allows (core `RICH_TEXT_LIMITS.listNesting`). */
const LIST_NESTING = 3;

// Tab in a list item nests it, and TipTap nests without end while the schema stops at three
// levels: a fourth level was a document the save refused. At the limit Tab does nothing.
// Rejected: letting Tab leave the text there, which moves focus when the writer asked to indent.
const ListDepth = Extension.create({
  name: 'mycelListDepth',
  priority: 1000,
  addKeyboardShortcuts() {
    return {
      Tab: ({ editor }) => {
        const { $from } = editor.state.selection;
        let lists = 0;
        for (let depth = $from.depth; depth > 0; depth--)
          if (['bulletList', 'orderedList'].includes($from.node(depth).type.name)) lists += 1;
        return lists >= LIST_NESTING;
      },
    };
  },
});

export const articleExtensions = [
  StarterKit.configure({
    document: false,
    blockquote: false,
    codeBlock: false,
    horizontalRule: false,
    strike: false,
    underline: false,
    link: false,
    trailingNode: false,
    heading: { levels: [1, 2, 3] },
  }),
  ArticleDocument,
  Prose,
  Card,
  SafeLink,
  FootnoteReference,
  ExplicitListStart,
  BlockIdentity,
  PendingRange,
  ListDepth,
];

// A page field is one rich-text document. Giving it the article wrapper would let Enter create
// a second top-level prose node that a single-field serializer could accidentally drop.
export const proseExtensions = [
  ...articleExtensions.filter(
    (extension) =>
      !['doc', 'mycelProse', 'mycelCard', 'mycelBlockIdentity'].includes(extension.name)
  ),
  Node.create({ name: 'doc', topNode: true, content: 'block+' }),
];
