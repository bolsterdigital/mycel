// Only the nodes and marks of ADR 020.2 are admitted to the article editor. StarterKit's extra
// marks and nodes are disabled; the few Mycel nodes carry block identity, not a second storage
// schema. Rejected: StarterKit defaults, which would silently admit blockquotes and code blocks.
import { Extension, Mark, Node } from '@tiptap/core';
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
    };
  },
  parseHTML() {
    return [{ tag: 'section[data-mycel-prose]' }];
  },
  renderHTML({ HTMLAttributes }) {
    return [
      'section',
      { 'data-mycel-prose': '', 'data-block-id': HTMLAttributes.blockId, class: 'editor-prose' },
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
    return [{ tag: 'a[href]' }];
  },
  renderHTML({ HTMLAttributes }) {
    return [
      'a',
      { href: HTMLAttributes.href ?? '#', 'data-item-id': HTMLAttributes.itemId ?? undefined },
      0,
    ];
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
];
