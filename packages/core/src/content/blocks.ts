// The block registry of the content model (ADR 004, ADR 020 rule 1). A block is `{ id, type,
// version, props }`: the id is a stable string, unique in the whole document, kept across edits
// and moves, so editors and agents address blocks by identity instead of array position. The
// stored schema requires the id; the input schema lets a caller omit it for a new block and the
// core assigns one (`assignBlockIds`).
//
// This is #8a's set: `heading` and `signup-form` from the probe, plus `rich-text` and the
// `paywall` boundary. #8b adds the rest (quote, image, ...) by entry, and with containers the
// tree walk below starts descending into child block lists. Rejected: the block id as an array
// index (an insert renumbers everything after it, ADR 020 rejected alternatives).

import { z } from 'zod';
import { localized } from '../i18n/locale.js';
import { RichTextDoc, linkedItemIds } from './rich-text.js';

/** Total blocks per document, nested ones included (ADR 020 rule 1). */
export const MAX_BLOCKS = 200;

export const BlockId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, 'content.block-id.invalid');

const blockProps = {
  // No `level` prop: the renderer derives the heading level from tree depth (ADR 004 rule 3).
  heading: z.object({ text: localized(z.string().min(1).max(200)) }).strict(),
  // A reference, never a copy: the forms module owns the fields (ADR 004 rule 6).
  'signup-form': z.object({ formId: z.string().uuid() }).strict(),
  'rich-text': z.object({ content: localized(RichTextDoc) }).strict(),
  // The teaser boundary of `access.teaser: 'marker'` (ADR 018 rule 6); it renders nothing.
  paywall: z.object({}).strict(),
} as const;

export type BlockType = keyof typeof blockProps;
export const BLOCK_TYPES = Object.keys(blockProps) as BlockType[];

function blockSchema<T extends z.ZodTypeAny>(id: T) {
  const block = <K extends BlockType>(type: K) =>
    z
      .object({ id, type: z.literal(type), version: z.literal(1), props: blockProps[type] })
      .strict();
  return z.discriminatedUnion('type', [
    block('heading'),
    block('signup-form'),
    block('rich-text'),
    block('paywall'),
  ]);
}

/** A stored block: the id is required. */
export const Block = blockSchema(BlockId);
export type Block = z.infer<typeof Block>;

/** A block as a caller sends it: a new block may omit its id. */
export const BlockInput = blockSchema(BlockId.optional());
export type BlockInput = z.infer<typeof BlockInput>;

/** Every block of the tree, depth first. Flat for now: no #8a block has child blocks. */
export function allBlocks<B extends { type: string }>(blocks: readonly B[]): B[] {
  return [...blocks];
}

/**
 * Tree invariants that hold for input and stored blocks alike (ADR 020 rules 1 and 4): at most
 * MAX_BLOCKS blocks, no id twice, and no two `rich-text` blocks next to each other in one list.
 */
export function blockTreeIssues(
  blocks: readonly { id?: string | undefined; type: string }[]
): { path: (string | number)[]; message: string }[] {
  const issues: { path: (string | number)[]; message: string }[] = [];
  if (allBlocks(blocks).length > MAX_BLOCKS)
    issues.push({ path: [], message: 'content.blocks.too-many' });
  const seen = new Set<string>();
  blocks.forEach((b, i) => {
    if (b.id !== undefined) {
      if (seen.has(b.id)) issues.push({ path: [i, 'id'], message: 'content.block-id.duplicate' });
      seen.add(b.id);
    }
    if (b.type === 'rich-text' && blocks[i - 1]?.type === 'rich-text')
      issues.push({ path: [i], message: 'content.blocks.adjacent-rich-text' });
  });
  return issues;
}

/** Give every block without an id a new one; existing ids are kept as they are. */
export function assignBlockIds(blocks: readonly BlockInput[], next: () => string): Block[] {
  return blocks.map((b) => ({ ...b, id: b.id ?? next() }) as Block);
}

/** The localised fields of one block, with their path inside the block and whether they are required. */
export function blockLocalized(
  block: BlockInput
): { path: (string | number)[]; value: Record<string, unknown>; required: boolean }[] {
  switch (block.type) {
    case 'heading':
      return [{ path: ['props', 'text'], value: block.props.text, required: true }];
    case 'rich-text':
      return [{ path: ['props', 'content'], value: block.props.content, required: true }];
    case 'signup-form':
    case 'paywall':
      return [];
  }
}

/** The block as one locale sees it: every localised field reduced to that locale's value. */
export function projectBlock(block: Block, locale: string): Block {
  switch (block.type) {
    case 'heading':
      return { ...block, props: { text: only(block.props.text, locale) } };
    case 'rich-text':
      return { ...block, props: { content: only(block.props.content, locale) } };
    case 'signup-form':
    case 'paywall':
      return block;
  }
}

function only<T>(value: Partial<Record<string, T>>, locale: string): Record<string, T> {
  const v = value[locale];
  return v === undefined ? {} : { [locale]: v };
}

/** What a reference points at (ADR 020 rule 7); the `type` column of `content_block_refs`. */
export const REFERENCE_TYPES = ['form', 'item', 'author', 'section', 'media'] as const;
export type ReferenceType = (typeof REFERENCE_TYPES)[number];

/** One reference a block makes: the row `content_block_refs` holds for it. */
export interface BlockReference {
  blockId: string;
  type: ReferenceType;
  refId: string;
}

/**
 * Every tenant reference of the blocks, one per block and target: forms (ADR 004 rule 6), linked
 * content items, and media (none yet: the `image` block arrives with #8b2). A block that links
 * the same item twice yields one row.
 */
export function blockReferenceRows(blocks: readonly Block[]): BlockReference[] {
  const rows = new Map<string, BlockReference>();
  const add = (blockId: string, type: ReferenceType, refId: string) =>
    rows.set(`${blockId} ${type} ${refId}`, { blockId, type, refId });
  for (const b of allBlocks(blocks)) {
    if (b.type === 'signup-form') add(b.id, 'form', b.props.formId);
    if (b.type === 'rich-text')
      for (const doc of Object.values(b.props.content))
        if (doc) for (const id of linkedItemIds(doc)) add(b.id, 'item', id);
  }
  return [...rows.values()];
}

/** Tenant references the blocks make, as sets per kind: what a save checks exists. */
export function blockReferences(blocks: readonly BlockInput[]): {
  forms: string[];
  items: string[];
  media: string[];
} {
  // Input blocks may lack an id; the sets do not need one.
  const rows = blockReferenceRows(blocks.map((b) => ({ ...b, id: b.id ?? '-' }) as Block));
  const of = (type: ReferenceType) => [
    ...new Set(rows.filter((r) => r.type === type).map((r) => r.refId)),
  ];
  return { forms: of('form'), items: of('item'), media: of('media') };
}

/** The outcome of normalising one block list (ADR 020 rule 4). */
export interface Normalized {
  blocks: Block[];
  /** Each id that disappeared into the block before it. */
  merged: { from: string; into: string }[];
}

/**
 * Merges every run of adjacent `rich-text` blocks into its first block: per locale the
 * ProseMirror `content` arrays are concatenated in order, so marks, attributes and headings
 * survive unchanged. Two blocks that do not have the same set of locales cannot be merged without
 * one of them losing a translation or gaining an empty one, so that fails closed
 * (`content.blocks.merge-ambiguous`) instead of guessing. Rejected: merging into the union of
 * locales, which would publish half a translation.
 */
export function normalizeBlocks(blocks: readonly Block[]): Normalized {
  const out: Block[] = [];
  const merged: { from: string; into: string }[] = [];
  for (const block of blocks) {
    const previous = out.at(-1);
    if (block.type !== 'rich-text' || previous?.type !== 'rich-text') {
      out.push(block);
      continue;
    }
    const a = previous.props.content;
    const b = block.props.content;
    const locales = Object.keys(a).sort();
    if (locales.join() !== Object.keys(b).sort().join())
      throw new BlockOperationError('blockId', `content.blocks.merge-ambiguous:${previous.id}`);
    const content: Record<string, RichTextDoc> = {};
    for (const l of locales)
      content[l] = { type: 'doc', content: [...a[l]!.content, ...b[l]!.content] };
    out[out.length - 1] = { ...previous, props: { content } };
    merged.push({ from: block.id, into: previous.id });
  }
  return { blocks: out, merged };
}

/** A block operation that cannot apply to this tree; the use case turns it into `invalid_input`. */
export class BlockOperationError extends Error {
  constructor(
    /** The input field the problem is about (`blockId`, `before`, `at.en`, ...). */
    readonly path: string,
    readonly issue: string
  ) {
    super(issue);
  }
}
