// The block envelope and the helpers every save, publish and projection runs (ADR 004, ADR 020
// rule 1). A block is `{ id, type, version, props }`: the id is a stable string, unique in the
// whole document, kept across edits and moves, so editors and agents address blocks by identity
// instead of array position. The stored schema requires the id; the input schema lets a caller
// omit it for a new block and the core assigns one (`assignBlockIds`).
//
// The types themselves are entries in `block-types.ts`; everything here is derived from those
// entries (schema, localised fields, projection, references), so adding a type touches one file.
// With containers the tree walk below starts descending into child block lists. Rejected: the
// block id as an array index (an insert renumbers everything after it, ADR 020 rejected
// alternatives), and a switch per helper (a new type that one helper forgets leaks a locale or
// misses a reference).

import { z } from 'zod';
import { BLOCK_DEFINITIONS, type BlockDefinition, type LocalField } from './block-types.js';
import type { RichTextDoc } from './rich-text.js';

export * from './block-types.js';

/** Total blocks per document, nested ones included (ADR 020 rule 1). */
export const MAX_BLOCKS = 200;

export const BlockId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, 'content.block-id.invalid');

type Definitions = typeof BLOCK_DEFINITIONS;
export type BlockType = keyof Definitions;
export const BLOCK_TYPES = Object.keys(BLOCK_DEFINITIONS) as BlockType[];

/** The props of one type as stored (defaults applied) and as a caller may send them. */
export type BlockProps<K extends BlockType> = z.infer<Definitions[K]['props']>;
export type BlockPropsInput<K extends BlockType> = z.input<Definitions[K]['props']>;

export type StoredBlock = {
  [K in BlockType]: { id: string; type: K; version: 1; props: BlockProps<K> };
}[BlockType];
export type StoredBlockIn = {
  [K in BlockType]: { id: string; type: K; version: 1; props: BlockPropsInput<K> };
}[BlockType];
export type NewBlock = {
  [K in BlockType]: { id?: string | undefined; type: K; version: 1; props: BlockProps<K> };
}[BlockType];
export type NewBlockIn = {
  [K in BlockType]: { id?: string | undefined; type: K; version: 1; props: BlockPropsInput<K> };
}[BlockType];

/** The definition of a type, untyped, for the generic helpers below. */
function definition(type: BlockType): BlockDefinition<z.ZodTypeAny> {
  return BLOCK_DEFINITIONS[type] as BlockDefinition<z.ZodTypeAny>;
}

function blockSchema(id: z.ZodTypeAny): z.ZodTypeAny {
  const options = BLOCK_TYPES.map((type) =>
    z
      .object({
        id,
        type: z.literal(type),
        version: z.literal(definition(type).version),
        props: definition(type).props,
      })
      .strict()
  );
  return z.discriminatedUnion(
    'type',
    options as unknown as [
      z.ZodDiscriminatedUnionOption<'type'>,
      ...z.ZodDiscriminatedUnionOption<'type'>[],
    ]
  );
}

/** A stored block: the id is required. */
export const Block = blockSchema(BlockId) as z.ZodType<StoredBlock, z.ZodTypeDef, StoredBlockIn>;
export type Block = StoredBlock;

/** A block as a caller sends it: a new block may omit its id. */
export const BlockInput = blockSchema(BlockId.optional()) as z.ZodType<
  NewBlock,
  z.ZodTypeDef,
  NewBlockIn
>;
export type BlockInput = NewBlock;

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
export function blockLocalized(block: BlockInput): LocalField[] {
  return definition(block.type)
    .localized(block.props)
    .map((f) => ({ ...f, path: ['props', ...f.path] }));
}

/**
 * The block as one locale sees it: every localised field, nested ones included, reduced to that
 * locale's value. Driven by `blockLocalized`, so projection and readiness see the same fields.
 */
export function projectBlock(block: Block, locale: string): Block {
  let out: unknown = block;
  for (const f of blockLocalized(block)) out = setIn(out, f.path, only(f.value, locale));
  return out as Block;
}

function only<T>(value: Partial<Record<string, T>>, locale: string): Record<string, T> {
  const v = value[locale];
  return v === undefined ? {} : { [locale]: v };
}

/** A copy of `target` with `value` at `path`; every object or array on the path is copied. */
function setIn(target: unknown, path: readonly (string | number)[], value: unknown): unknown {
  const [key, ...rest] = path;
  if (key === undefined) return value;
  const next = setIn((target as Record<string | number, unknown>)[key], rest, value);
  if (Array.isArray(target)) {
    const copy = [...target];
    copy[key as number] = next;
    return copy;
  }
  return { ...(target as object), [key]: next };
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
 * content items (rich text, card actions) and media (`image`, a hero's image). A block that
 * links the same item twice yields one row.
 */
export function blockReferenceRows(blocks: readonly Block[]): BlockReference[] {
  const rows = new Map<string, BlockReference>();
  for (const b of allBlocks(blocks))
    for (const { type, refId } of definition(b.type).references(b.props))
      rows.set(`${b.id} ${type} ${refId}`, { blockId: b.id, type, refId });
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
