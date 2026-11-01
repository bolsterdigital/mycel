// Small block edits on a revisioned item (ADR 020 rules 4 and 6) and block discovery (rule 7).
// Insert, move, remove, update and split_insert address blocks by id, never by array index,
// and each one is a whole save: item lock, `baseRevisionId` check, full document validation,
// reference and entitlement checks, one new revision. They are what no-JS form actions, keyboard
// commands and MCP call; there is no second agent API.
//
// Every operation runs through `mutate`, so the lock, the conflict check and the write are the
// same code as `content.item.update` (`writeRevision`). An unknown id or anchor is
// `invalid_input`: the item exists, the request does not fit its content. Only move and remove
// normalise; insert and update cannot newly join two `rich-text` blocks, and an insert that
// would is refused like an update (`content.blocks.adjacent-rich-text`). Rejected: JSON Patch
// over the document (array indexes shift under concurrent edits) and normalising in `update`
// (whoever sends the whole document sends it canonical).

import { z } from 'zod';
import { notFound, UseCaseError } from '../errors.js';
import type { TransactionContext } from '../ports.js';
import { defineUseCase } from '../registry.js';
import {
  BLOCK_TYPES,
  BlockId,
  BlockInput,
  BlockOperationError,
  REFERENCE_TYPES,
  normalizeBlocks,
  type Block,
  type BlockType,
} from './blocks.js';
import { ContentItem, ContentType, type ContentDocument } from './model.js';
import type { RichTextDoc } from './rich-text.js';
import {
  DEFAULT_PAGE_SIZE,
  ItemWithRevision,
  assertBase,
  finalize,
  lockItem,
  toContentItem,
  writeRevision,
} from './service.js';
import './ports.js';
import { exampleId } from '../util/ids.js';

const ItemId = z.string().guid();
const Limit = z.number().int().min(1).max(100).optional();

/** Where a block goes: next to an id, or at the start or end of the document's block list. */
const Placement = z.union([
  z.object({ before: BlockId }).strict(),
  z.object({ after: BlockId }).strict(),
  z.object({ at: z.enum(['start', 'end']) }).strict(),
]);
type Placement = z.infer<typeof Placement>;

const Target = { itemId: ItemId, baseRevisionId: z.string().guid() };

export const OperationResult = ItemWithRevision.extend({
  /** Ids that did not exist in the base revision. */
  created: z.array(z.string()),
  /** Ids of the base revision that are gone, removed or merged away. */
  retired: z.array(z.string()),
  /** Each retired id whose text now lives in the surviving block `into`. */
  merged: z.array(z.object({ from: z.string(), into: z.string() })),
});

/** What an operation did to the block list, before the document is validated and saved. */
interface Applied {
  blocks: Block[];
  created: string[];
  retired: string[];
  merged: { from: string; into: string }[];
}

const fail = (path: string, issue: string, params?: Record<string, string>): never => {
  throw new BlockOperationError(path, issue, params);
};

/** Index of `id` in the list, or an `invalid_input` on `path`. Flat while no block has children. */
function indexOf(blocks: readonly Block[], id: string, path: string): number {
  const i = blocks.findIndex((b) => b.id === id);
  return i >= 0 ? i : fail(path, 'content.block.unknown', { id });
}

function place(blocks: Block[], block: Block, where: Placement): Block[] {
  const out = [...blocks];
  if ('at' in where) out.splice(where.at === 'start' ? 0 : out.length, 0, block);
  else if ('before' in where) out.splice(indexOf(out, where.before, 'before'), 0, block);
  else out.splice(indexOf(out, where.after, 'after') + 1, 0, block);
  return out;
}

/** The new block of an insert: its own id if it sent a free one, else a fresh one. */
function newBlock(ctx: TransactionContext, blocks: readonly Block[], input: BlockInput): Block {
  if (input.id !== undefined && blocks.some((b) => b.id === input.id))
    fail('block.id', 'content.block-id.duplicate');
  return { ...input, id: input.id ?? ctx.ids.next() } as Block;
}

/**
 * The shared path of every operation: lock, base check, apply to the base revision's blocks,
 * validate the whole document (ids, invariants, block switches), check references, write one
 * revision. A `BlockOperationError` from `apply` becomes `invalid_input`; nothing is written.
 */
async function mutate(
  ctx: TransactionContext,
  { itemId, baseRevisionId }: { itemId: string; baseRevisionId: string },
  apply: (blocks: Block[]) => Applied
) {
  const item = await lockItem(ctx, itemId);
  assertBase(item, baseRevisionId);
  const base = await ctx.content.revision(itemId, baseRevisionId);
  if (!base) throw notFound('revision');
  let applied: Applied;
  try {
    applied = apply(base.document.blocks);
  } catch (e) {
    if (!(e instanceof BlockOperationError)) throw e;
    throw new UseCaseError('invalid_input', 'the operation does not fit the document', [
      { path: e.path, message: e.issue, ...(e.params && { params: e.params }) },
    ]);
  }
  const doc: ContentDocument = finalize(ctx, base.document, applied.blocks);
  const saved = await writeRevision(ctx, item, doc);
  return { ...saved, created: applied.created, retired: applied.retired, merged: applied.merged };
}

/** Move and remove can bring two text blocks together; they merge into the first. */
function normalized(blocks: Block[], created: string[], retired: string[]): Applied {
  const { blocks: out, merged } = normalizeBlocks(blocks);
  return { blocks: out, created, retired: [...retired, ...merged.map((m) => m.from)], merged };
}

const exampleTarget = {
  itemId: exampleId(0x1),
  baseRevisionId: exampleId(0x2),
};
const exampleHeading = {
  type: 'heading' as const,
  version: 1 as const,
  props: { text: { nl: 'Tussenkop' } },
};

export const insertBlock = defineUseCase({
  name: 'content.block.insert',
  kind: 'command',
  description:
    'Insert one block before or after a block id, or at the start or end, as a new revision; the block keeps a free id it was sent with, otherwise it gets one.',
  requires: 'content:write',
  authenticatedOnly: true,
  input: z.object({ ...Target, block: BlockInput, place: Placement }),
  output: OperationResult,
  examples: [
    { input: { ...exampleTarget, block: exampleHeading, place: { after: 'intro' } } },
    { input: { ...exampleTarget, block: exampleHeading, place: { at: 'end' } } },
  ],
  handler: (ctx, { block, place: where, ...target }) =>
    mutate(ctx, target, (blocks) => {
      const added = newBlock(ctx, blocks, block);
      return { blocks: place(blocks, added, where), created: [added.id], retired: [], merged: [] };
    }),
});

export const moveBlock = defineUseCase({
  name: 'content.block.move',
  kind: 'command',
  description:
    'Move one block before or after another block id, or to the start or end, as a new revision; text blocks that end up next to each other merge into the first.',
  requires: 'content:write',
  authenticatedOnly: true,
  input: z.object({ ...Target, blockId: BlockId, place: Placement }),
  output: OperationResult,
  examples: [{ input: { ...exampleTarget, blockId: 'signup', place: { before: 'intro' } } }],
  handler: (ctx, { blockId, place: where, ...target }) =>
    mutate(ctx, target, (blocks) => {
      const block = blocks[indexOf(blocks, blockId, 'blockId')]!;
      const anchor = 'before' in where ? where.before : 'after' in where ? where.after : null;
      if (anchor === blockId)
        fail('before' in where ? 'before' : 'after', 'content.block.anchor-is-target');
      const rest = blocks.filter((b) => b.id !== blockId);
      return normalized(place(rest, block, where), [], []);
    }),
});

export const removeBlock = defineUseCase({
  name: 'content.block.remove',
  kind: 'command',
  description:
    'Remove one block by id as a new revision; text blocks that end up next to each other merge into the first.',
  requires: 'content:write',
  authenticatedOnly: true,
  input: z.object({ ...Target, blockId: BlockId }),
  output: OperationResult,
  examples: [{ input: { ...exampleTarget, blockId: 'signup' } }],
  handler: (ctx, { blockId, ...target }) =>
    mutate(ctx, target, (blocks) => {
      indexOf(blocks, blockId, 'blockId');
      return normalized(
        blocks.filter((b) => b.id !== blockId),
        [],
        [blockId]
      );
    }),
});

export const setBlockProps = defineUseCase({
  name: 'content.block.update',
  kind: 'command',
  description:
    'Replace the props of one block as a new revision; its id and type stay. Send the complete props: a locale left out of a localised field is removed from it.',
  requires: 'content:write',
  authenticatedOnly: true,
  // The block's own schema checks the props when the document is validated.
  input: z.object({ ...Target, blockId: BlockId, props: z.record(z.string(), z.unknown()) }),
  output: OperationResult,
  examples: [
    {
      input: {
        ...exampleTarget,
        blockId: 'kop',
        props: { text: { nl: 'Nieuwe kop', en: 'New heading' } },
      },
    },
  ],
  handler: (ctx, { blockId, props, ...target }) =>
    mutate(ctx, target, (blocks) => {
      const i = indexOf(blocks, blockId, 'blockId');
      const out = [...blocks];
      out[i] = { ...blocks[i]!, props } as Block;
      return { blocks: out, created: [], retired: [], merged: [] };
    }),
});

export const splitInsertBlock = defineUseCase({
  name: 'content.block.split_insert',
  kind: 'command',
  description:
    'Split a text block at a paragraph boundary in every locale it has and put one block in between, as a new revision; the first part keeps the id, the second gets a new one.',
  requires: 'content:write',
  authenticatedOnly: true,
  input: z.object({
    ...Target,
    blockId: BlockId,
    /** Per locale: the index in the doc's top-level `content` where the second part starts. */
    at: z.record(z.string(), z.number().int().min(0)),
    block: BlockInput,
  }),
  output: OperationResult,
  examples: [
    {
      input: { ...exampleTarget, blockId: 'intro', at: { nl: 2, en: 2 }, block: exampleHeading },
      note: 'A heading card between the second and third paragraph, in both locales.',
    },
  ],
  handler: (ctx, { blockId, at, block, ...target }) =>
    mutate(ctx, target, (blocks) => {
      const i = indexOf(blocks, blockId, 'blockId');
      const text = blocks[i]!;
      if (text.type !== 'rich-text') return fail('blockId', 'content.split.not-rich-text');
      const first: Record<string, RichTextDoc> = {};
      const second: Record<string, RichTextDoc> = {};
      for (const locale of Object.keys(at))
        if (!(locale in text.props.content)) fail(`at.${locale}`, 'content.split.locale-unknown');
      for (const [locale, doc] of Object.entries(text.props.content)) {
        if (!doc) continue;
        const cut = at[locale];
        if (cut === undefined) return fail(`at.${locale}`, 'content.split.locale-missing');
        // Both halves must keep at least one node: a rich-text doc is never empty.
        if (cut <= 0 || cut >= doc.content.length) fail(`at.${locale}`, 'content.split.empty-part');
        first[locale] = { type: 'doc', content: doc.content.slice(0, cut) };
        second[locale] = { type: 'doc', content: doc.content.slice(cut) };
      }
      const added = newBlock(ctx, blocks, block);
      const rest: Block = { ...text, id: ctx.ids.next(), props: { content: second } };
      const out = [...blocks];
      out.splice(i, 1, { ...text, props: { content: first } }, added, rest);
      return {
        blocks: out,
        created: [added.id, rest.id],
        retired: [],
        merged: [],
      };
    }),
});

const ReferenceFilter = z.object({ type: z.enum(REFERENCE_TYPES), id: z.string().guid() });

export const findItems = defineUseCase({
  name: 'content.item.find',
  kind: 'query',
  description:
    'Find items that contain a block type or reference a form, item, author, section or media id, in the latest revision or, with live, in what is published; newest first.',
  requires: 'content:read',
  authenticatedOnly: true,
  input: z.object({
    blockType: z.enum(BLOCK_TYPES as [BlockType, ...BlockType[]]).optional(),
    ref: ReferenceFilter.optional(),
    live: z.boolean().optional(),
    type: ContentType.optional(),
    after: z.string().guid().optional(),
    limit: Limit,
  }),
  output: z.object({
    items: z.array(ContentItem),
    matches: z.array(z.object({ itemId: z.string().guid(), blockIds: z.array(z.string()) })),
    next: z.string().guid().nullable(),
  }),
  examples: [
    { input: { blockType: 'signup-form' } },
    {
      input: { ref: { type: 'form', id: exampleId(0x3) }, live: true },
      note: 'Where a form is live: only revisions a locale publishes count.',
    },
  ],
  async handler(ctx, { blockType, ref, live, type, after, limit }) {
    if (!blockType && !ref)
      throw new UseCaseError('invalid_input', 'give a block type, a reference or both', [
        { path: 'blockType', message: 'content.find.filter-required' },
      ]);
    const page = await ctx.content.find(
      { blockType, ref, live: live ?? false, type },
      after ?? null,
      limit ?? DEFAULT_PAGE_SIZE
    );
    return {
      items: page.rows.map((m) => toContentItem(m.item)),
      matches: page.rows.map((m) => ({ itemId: m.item.id, blockIds: m.blockIds })),
      next: page.next,
    };
  },
});
