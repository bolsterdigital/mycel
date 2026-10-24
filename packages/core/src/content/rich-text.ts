// The constrained rich-text vocabulary inside a `rich-text` block (ADR 020 rule 2, superseding
// ADR 012 rule 6): a ProseMirror document as plain JSON, validated by Zod on every write. Prose
// and relative section headings only; quotes, images and embeds are blocks of their own. The
// core never imports an editor: TipTap is configured to exactly this schema in the admin (#11).
//
// Every node and mark is a strict object, so an unknown node, mark or attribute is rejected
// instead of stored. Bounds (nodes, text) are checked in one walk after the shape is valid;
// list nesting is bounded by the schema. Rejected: a generic `{ type, attrs, content }` node with a type allow-list (attributes
// would go unchecked) and storing HTML (every renderer and agent would parse markup).

import { z } from 'zod';

export const RICH_TEXT_VERSION = 1;

/** Upper bounds per document (one locale's value): generous for a long read, finite for storage. */
export const RICH_TEXT_LIMITS = {
  nodes: 5_000,
  /** Lists inside lists: three levels, part of the schema itself. */
  listNesting: 3,
  characters: 100_000,
  textNode: 20_000,
} as const;

/**
 * A safe link target: http(s) without credentials, mailto, or a site-internal path. Internal
 * links to content use `itemId` instead of a path, so a later slug change (#9) cannot break them.
 */
export function isSafeHref(href: string): boolean {
  if (/[\s\\]/.test(href) || /[\u0000-\u001f]/.test(href)) return false;
  if (href.startsWith('/')) return !href.startsWith('//');
  if (href.startsWith('mailto:')) return href.length > 'mailto:'.length;
  if (!/^https?:\/\//i.test(href)) return false;
  try {
    const url = new URL(href);
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password
    );
  } catch {
    return false;
  }
}

const LinkAttrs = z
  .object({
    href: z.string().min(1).max(2048).optional(),
    itemId: z.string().guid().optional(),
  })
  .strict()
  .refine((a) => (a.href === undefined) !== (a.itemId === undefined), 'content.link.one-target')
  .refine((a) => a.href === undefined || isSafeHref(a.href), 'content.link.unsafe');

export const Mark = z.discriminatedUnion('type', [
  z.object({ type: z.literal('bold') }).strict(),
  z.object({ type: z.literal('italic') }).strict(),
  z.object({ type: z.literal('code') }).strict(),
  z.object({ type: z.literal('link'), attrs: LinkAttrs }).strict(),
  // The note's text travels with its reference; renderers collect them into a notes list.
  z
    .object({
      type: z.literal('footnote_reference'),
      attrs: z.object({ text: z.string().min(1).max(2000) }).strict(),
    })
    .strict(),
]);
export type Mark = z.infer<typeof Mark>;

const Text = z
  .object({
    type: z.literal('text'),
    text: z.string().min(1).max(RICH_TEXT_LIMITS.textNode),
    marks: z
      .array(Mark)
      .max(5)
      .refine((m) => new Set(m.map((x) => x.type)).size === m.length, 'content.marks.duplicate')
      .optional(),
  })
  .strict();
const HardBreak = z.object({ type: z.literal('hard_break') }).strict();
const Inline = z.discriminatedUnion('type', [Text, HardBreak]);

const Paragraph = z
  .object({ type: z.literal('paragraph'), content: z.array(Inline).optional() })
  .strict();
export type Paragraph = z.infer<typeof Paragraph>;

/** Relative section depth 1-3; the renderer resolves it to h2-h4 in root context (ADR 020 rule 2). */
const Heading = z
  .object({
    type: z.literal('heading'),
    attrs: z.object({ level: z.union([z.literal(1), z.literal(2), z.literal(3)]) }).strict(),
    content: z.array(Inline).optional(),
  })
  .strict();

export interface ListItem {
  type: 'list_item';
  content: [Paragraph, ...(Paragraph | BulletList | OrderedList)[]];
}
export interface BulletList {
  type: 'bullet_list';
  content: ListItem[];
}
export interface OrderedList {
  type: 'ordered_list';
  attrs?: { start: number } | undefined;
  content: ListItem[];
}

// Lists nest through list items, at most `listNesting` levels deep; headings never sit inside a
// list. The levels are spelled out instead of written as one recursive (z.lazy) schema, so the
// JSON Schema that agents read describes every level instead of degrading to "any" at the
// recursion.
function lists(level: number): { bullet: z.ZodType<BulletList>; ordered: z.ZodType<OrderedList> } {
  const inner = level > 1 ? lists(level - 1) : null;
  const child = inner ? z.union([Paragraph, inner.bullet, inner.ordered]) : Paragraph;
  const item = z
    .object({ type: z.literal('list_item'), content: z.tuple([Paragraph]).rest(child) })
    .strict();
  return {
    bullet: z
      .object({ type: z.literal('bullet_list'), content: z.array(item).min(1) })
      .strict() as z.ZodType<BulletList>,
    ordered: z
      .object({
        type: z.literal('ordered_list'),
        attrs: z
          .object({ start: z.number().int().min(1).max(100_000) })
          .strict()
          .optional(),
        content: z.array(item).min(1),
      })
      .strict() as z.ZodType<OrderedList>,
  };
}
const { bullet: BulletList, ordered: OrderedList } = lists(RICH_TEXT_LIMITS.listNesting);

const TopLevel = z.union([Paragraph, Heading, BulletList, OrderedList]);

interface Walked {
  nodes: number;
  characters: number;
}

function walk(node: unknown, acc: Walked): void {
  acc.nodes += 1;
  const n = node as { text?: string; content?: unknown[] };
  if (typeof n.text === 'string') acc.characters += n.text.length;
  for (const child of n.content ?? []) walk(child, acc);
}

export const RichTextDoc = z
  .object({ type: z.literal('doc'), content: z.array(TopLevel).min(1) })
  .strict()
  .superRefine((doc, ctx) => {
    const acc: Walked = { nodes: 0, characters: 0 };
    walk(doc, acc);
    if (acc.nodes > RICH_TEXT_LIMITS.nodes)
      ctx.addIssue({ code: 'custom', message: 'content.rich-text.too-many-nodes' });
    if (acc.characters > RICH_TEXT_LIMITS.characters)
      ctx.addIssue({ code: 'custom', message: 'content.rich-text.too-long' });
    // Consecutive headings never skip a level (1 then 3). Where the first heading sits relative
    // to the blocks around it is the renderer's context check (#8c, ADR 020 rule 2).
    let previous = 0;
    doc.content.forEach((node, i) => {
      if (node.type !== 'heading') return;
      if (previous && node.attrs.level > previous + 1)
        ctx.addIssue({
          code: 'custom',
          path: ['content', i, 'attrs', 'level'],
          message: 'content.rich-text.heading-skips-level',
        });
      previous = node.attrs.level;
    });
  });
export type RichTextDoc = z.infer<typeof RichTextDoc>;

/** The content item ids a document links to, for tenant-scoped reference checks. */
export function linkedItemIds(doc: RichTextDoc): string[] {
  const found: string[] = [];
  const visit = (node: unknown): void => {
    const n = node as { marks?: Mark[]; content?: unknown[] };
    for (const mark of n.marks ?? [])
      if (mark.type === 'link' && mark.attrs.itemId) found.push(mark.attrs.itemId);
    for (const child of n.content ?? []) visit(child);
  };
  visit(doc);
  return found;
}
