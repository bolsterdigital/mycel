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

/** Tenant references the blocks make: forms (ADR 004 rule 6) and linked content items. */
export function blockReferences(blocks: readonly BlockInput[]): {
  forms: string[];
  items: string[];
} {
  const forms = new Set<string>();
  const items = new Set<string>();
  for (const b of allBlocks(blocks)) {
    if (b.type === 'signup-form') forms.add(b.props.formId);
    if (b.type === 'rich-text')
      for (const doc of Object.values(b.props.content))
        if (doc) for (const id of linkedItemIds(doc)) items.add(id);
  }
  return { forms: [...forms], items: [...items] };
}
