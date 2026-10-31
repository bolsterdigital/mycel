// The one form of the edit screen (#66 PR 2, brief edit-screen § 6): the document's fields and
// every block's fields in a single <form>, so a block action never loses what was typed in
// another block (brief § 1 point 4). A block's fields carry `b.<blockId>.` in front of the names
// `lib/editor/block-form.ts` reads; a block chosen but not stored yet carries `new.` and its type
// and place as hidden fields. Every action of the screen first saves what the form carries as one
// `content.item.update`, then runs its own use case on the revision that save made.
//
// A new block is not stored when it is chosen: an empty block of most types is invalid, and core
// stores no invalid props (ADR 004). It is shown empty at its place and inserted with the next
// save through `content.block.insert`, which refuses it with its fields when it is not complete.
// Rejected: a page of its own per insert (the old `blocks/new`, which left the screen) and
// inserting a placeholder block with dummy props (stored content nobody wrote).
//
// The form shows one locale (#66 PR 4): `formDocument` is the whole save of one post, document
// fields and blocks, and keeps every other locale as the base revision has it.

import {
  BLOCK_DEFINITIONS,
  BLOCK_TYPES,
  type Block,
  type BlockType,
  type ContentDocument,
  type ContentDocumentInput,
  type UseCaseError,
} from '@mycel/core';
import { formValues, propsFromForm, type FieldError, type Posted } from '#lib/editor/block-form.js';
import { fromArticleEditor } from '#lib/editor/article-document.js';
import { documentFrom, type FormValues } from './content-admin.js';

/** The name prefix of a stored block's fields. */
export const blockPrefix = (id: string): string => `b.${id}.`;

/** The name prefix of the fields of the block that is not stored yet. */
export const NEW_BLOCK = 'new.';

/** The names under `prefix`, without it. */
export function within(posted: Posted, prefix: string): Posted {
  return {
    get: (name) => posted.get(`${prefix}${name}`),
    names: () =>
      posted
        .names()
        .filter((n) => n.startsWith(prefix))
        .map((n) => n.slice(prefix.length)),
  };
}

/** Where a new block goes, in the shape `content.block.insert` takes. */
export type Placement = { before: string } | { after: string } | { at: 'end' };

export interface PendingBlock {
  type: BlockType;
  place: Placement;
}

/**
 * The block chosen but not stored yet, from the query (`insert`, `place`, `anchor`) or the hidden
 * fields of the form (`new.type`, `new.place`, `new.anchor`); null when there is none or it does
 * not name a known type, a known place and, for before and after, a block of `blockIds`.
 */
export function pendingBlock(
  type: string | null,
  place: string | null,
  anchor: string | null,
  blockIds: readonly string[]
): PendingBlock | null {
  if (!type || !(BLOCK_TYPES as readonly string[]).includes(type)) return null;
  const known = !!anchor && blockIds.includes(anchor);
  const at: Placement | null =
    place === 'end'
      ? { at: 'end' }
      : place === 'before' && known
        ? { before: anchor }
        : place === 'after' && known
          ? { after: anchor }
          : null;
  return at && { type: type as BlockType, place: at };
}

/** The hidden fields that carry a pending block through a post. */
export function pendingFields(p: PendingBlock): Record<string, string> {
  const place = 'at' in p.place ? 'end' : 'before' in p.place ? 'before' : 'after';
  const anchor = 'before' in p.place ? p.place.before : 'after' in p.place ? p.place.after : '';
  return {
    [`${NEW_BLOCK}type`]: p.type,
    [`${NEW_BLOCK}place`]: place,
    [`${NEW_BLOCK}anchor`]: anchor,
  };
}

/** What the edit screen shows of a pending block: its type, place, hidden fields and values. */
export interface PendingView {
  type: BlockType;
  place: 'before' | 'after' | 'end';
  anchor: string | null;
  hidden: Record<string, string>;
  values: Record<string, string>;
}

/** The pending block for the screen: empty fields, or what a refused post typed into them. */
export function pendingView(
  p: PendingBlock,
  locales: readonly string[],
  typed?: Record<string, string | string[]>
): PendingView {
  const hidden = pendingFields(p);
  const values: Record<string, string> = {};
  if (typed) {
    for (const [k, v] of Object.entries(typed))
      if (k.startsWith(`${NEW_BLOCK}p.`) || k.endsWith('.rows'))
        if (k.startsWith(NEW_BLOCK) && typeof v === 'string') values[k] = v;
  } else
    for (const [k, v] of Object.entries(
      formValues(BLOCK_DEFINITIONS[p.type].fields, undefined, locales)
    ))
      values[`${NEW_BLOCK}${k}`] = v;
  return {
    type: p.type,
    place: hidden[`${NEW_BLOCK}place`] as PendingView['place'],
    anchor: hidden[`${NEW_BLOCK}anchor`] || null,
    hidden,
    values,
  };
}

/**
 * The blocks with the props the form carries for them. A block the form has no field of (one
 * saved in between, or `skip`, the block being removed) keeps its stored props; rich text the form
 * could not read comes back as errors under the block's full field names.
 */
export function blocksFrom(
  blocks: readonly Block[],
  posted: Posted,
  skip?: string
): { blocks: Block[]; errors: FieldError[] } {
  const errors: FieldError[] = [];
  const names = posted.names();
  const out = blocks.map((block) => {
    const prefix = blockPrefix(block.id);
    if (block.id === skip || !names.some((n) => n.startsWith(prefix))) return block;
    const read = propsFromForm(
      BLOCK_DEFINITIONS[block.type].fields,
      within(posted, prefix),
      block.props as Record<string, unknown>
    );
    errors.push(...read.errors.map((e) => ({ ...e, name: `${prefix}${e.name}` })));
    return { ...block, props: read.props } as Block;
  });
  return { blocks: out, errors };
}

/** The props of the pending block as typed, with errors under its full field names. */
export function pendingProps(p: PendingBlock, posted: Posted) {
  const read = propsFromForm(BLOCK_DEFINITIONS[p.type].fields, within(posted, NEW_BLOCK));
  return {
    props: read.props,
    errors: read.errors.map((e) => ({ ...e, name: `${NEW_BLOCK}${e.name}` })),
  };
}

/**
 * The form field a core issue is about: `document.blocks.<i>.props.<path>` of a save is the field
 * of the block at `i`, `block.props.<path>` of an insert the new block's; '' for any other path.
 */
export function blockIssueName(path: string, blocks: readonly { id: string }[]): string {
  const stored = /^(?:document\.)?blocks\.(\d+)\.props(\..+)?$/.exec(path);
  if (stored) {
    const block = blocks[Number(stored[1])];
    return block ? `${blockPrefix(block.id)}p${stored[2] ?? ''}` : '';
  }
  const added = /^block\.props(\..+)?$/.exec(path);
  return added ? `${NEW_BLOCK}p${added[1] ?? ''}` : '';
}

/** The issues of a refusal that name a block field, as `{ name, message }`. */
export function blockIssues(
  e: UseCaseError,
  blocks: readonly { id: string }[]
): { name: string; message: string }[] {
  return e.issues
    .map((i) => ({ name: blockIssueName(i.path, blocks), message: i.message }))
    .filter((i) => i.name);
}

/**
 * The form field of a document-level issue on a save (`document.seo.canonical`, `document.tags.3`,
 * `document.access.teaser`), so a refusal links to the field on whichever tab holds it; '' for a
 * path the form has no field for. The access teaser's block count is its own field.
 */
const DOCUMENT_FIELDS: [RegExp, string][] = [
  [/^document\.seo\.canonical$/, 'canonical'],
  [/^document\.tags(\.\d+)?$/, 'tags'],
  [/^document\.access\.tierIds$/, 'level'],
  [/^document\.access\.teaser\.blocks$/, 'teaserBlocks'],
  [/^document\.access\.teaser$/, 'teaser'],
  [/^document\.defaultLocale$/, 'locales'],
  // Only the newest correction comes from the form; the stored ones are read-only.
  [/^document\.corrections\.\d+\.date$/, 'correctionDate'],
];

/** The issues of a refused save that name a document field, as `{ name, message }`. */
export function documentFieldIssues(e: UseCaseError): { name: string; message: string }[] {
  return e.issues
    .map((i) => ({
      name: DOCUMENT_FIELDS.find(([re]) => re.test(i.path))?.[1] ?? '',
      message: i.message,
    }))
    .filter((i) => i.name);
}

/**
 * The document one post of the edit form makes on top of `base`: the document's fields
 * (`documentFrom`) and every block's (`blocksFrom`), with `editing` the one locale the form shows
 * (left out: every locale it carries). Blocks are read from the base without a locale the form
 * took off; the fields of a locale that is taken off in the same post are not read at all.
 */
export function formDocument(
  base: ContentDocument,
  values: FormValues,
  post: Posted,
  today: string,
  editing?: string | null,
  skip?: string
): { document: ContentDocumentInput; blocks: Block[]; errors: FieldError[] } {
  const doc = documentFrom(base, values, today, editing);
  let kept = doc.blocks as Block[];
  const article = post.get('articleEditor');
  if (article && editing && base.type === 'article') {
    try {
      kept = documentFrom(
        fromArticleEditor(base, editing, JSON.parse(article)),
        values,
        today,
        editing
      ).blocks as Block[];
    } catch {
      return {
        document: doc,
        blocks: kept,
        errors: [{ name: 'articleEditor', message: 'editor.markdown.invalid', line: 1 }],
      };
    }
  }
  const readable = editing === undefined || (!!editing && doc.locales.includes(editing));
  const read = readable ? blocksFrom(kept, post, skip) : { blocks: kept, errors: [] };
  return { document: { ...doc, blocks: read.blocks }, blocks: read.blocks, errors: read.errors };
}
