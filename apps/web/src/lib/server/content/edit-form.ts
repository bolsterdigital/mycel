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
  BlockOperationError,
  cleanBlockName,
  GALLERY_ROWS,
  INSERTABLE_BLOCK_TYPES,
  isUuid,
  teaserFollowing,
  type Block,
  type BlockType,
  type ContentDocument,
  type ContentDocumentInput,
  type UseCaseError,
} from '@mycel/core';
import { isDeepStrictEqual } from 'node:util';
import {
  blockIssueName,
  formValues,
  imageAltFromForm,
  postedValues,
  propsFromForm,
  type FieldError,
  type Posted,
} from '#lib/editor/block-form.js';
import { addButtonLists } from '#lib/admin/block-presentation.js';
import { fromArticleEditor } from '#lib/editor/article-document.js';
import { documentFrom, type FormValues } from './content-admin.js';
import { operationIssues, type FieldIssue } from './content-blocks.js';
import { ISSUES } from './edit-copy.js';

/** The name prefix of a stored block's fields. */
export const blockPrefix = (id: string): string => `b.${id}.`;

/** The name prefix of the fields of the block that is not stored yet. */
export const NEW_BLOCK = 'new.';

/** A block's form values; a list the editor shows as a row gets an add button, no spare row. */
export const blockFormValues = (type: BlockType, props: unknown, locales: readonly string[]) =>
  formValues(
    BLOCK_DEFINITIONS[type].fields,
    props as Record<string, unknown> | undefined,
    locales,
    {
      addButton: addButtonLists(type),
    }
  );

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
 * not name a type new content may get (no `hero`, ADR 025 rule 4), a known place and, for before
 * and after, a block of `blockIds`.
 */
export function pendingBlock(
  type: string | null,
  place: string | null,
  anchor: string | null,
  blockIds: readonly string[]
): PendingBlock | null {
  if (!type || !(INSERTABLE_BLOCK_TYPES as readonly string[]).includes(type)) return null;
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
  /** It holds images dropped or pasted on the screen: their alt text is what is left. */
  dropped: boolean;
}

/**
 * The images a drop or paste on the edit screen uploaded (`static/_admin/block-drop.js`), from
 * the `media` query the insert action passes on: valid ids, each once, at most a gallery's worth.
 * Whether the operator may read them is the picker's business, as for any chosen image.
 */
export function droppedMedia(query: string | null): string[] {
  const ids = [...new Set((query ?? '').split(',').filter(isUuid))];
  return ids.slice(0, GALLERY_ROWS);
}

/**
 * The props a pending block starts with when images were dropped: one image for an image block,
 * all of them for a gallery, alt text still to write. Another type, or a count it cannot hold
 * (a gallery needs two), starts empty as chosen.
 */
function droppedProps(type: BlockType, media: readonly string[]) {
  const use = (mediaId: string) => ({ mediaId, decorative: false, alt: null });
  if (type === 'image' && media.length === 1) return use(media[0]!);
  if (type === 'gallery' && media.length >= 2) return { images: media.map(use) };
  return undefined;
}

/**
 * The query of "insert a block here" (`insert` action): the chooser's `type|place:anchor`, or an
 * older select's `insertType.<place>`, plus the images a drop uploaded (`insertMedia`).
 */
export function insertQuery(choice: string, data: FormData): Record<string, string> {
  const divider = choice.indexOf('|');
  const placement = divider < 0 ? choice : choice.slice(divider + 1);
  const [place = '', anchor = ''] = placement.split(':');
  const field = (name: string) => {
    const value = data.get(name);
    return typeof value === 'string' ? value : '';
  };
  const media = droppedMedia(field('insertMedia'));
  return {
    insert: divider < 0 ? field(`insertType.${anchor || place}`) : choice.slice(0, divider),
    place,
    ...(anchor ? { anchor } : {}),
    ...(media.length ? { media: media.join(',') } : {}),
  };
}

/**
 * The pending block for the screen: empty fields, the images a drop uploaded (`media`), or what a
 * refused post typed into them.
 */
export function pendingView(
  p: PendingBlock,
  locales: readonly string[],
  typed?: Record<string, string | string[]>,
  media: readonly string[] = []
): PendingView {
  const hidden = pendingFields(p);
  const values: Record<string, string> = {};
  const props = typed ? undefined : droppedProps(p.type, media);
  if (typed) {
    for (const [k, v] of Object.entries(typed))
      if (k.startsWith(`${NEW_BLOCK}p.`) || k.endsWith('.rows'))
        if (k.startsWith(NEW_BLOCK) && typeof v === 'string') values[k] = v;
  } else
    for (const [k, v] of Object.entries(blockFormValues(p.type, props, locales)))
      values[`${NEW_BLOCK}${k}`] = v;
  return {
    type: p.type,
    place: hidden[`${NEW_BLOCK}place`] as PendingView['place'],
    anchor: hidden[`${NEW_BLOCK}anchor`] || null,
    hidden,
    values,
    dropped: !!props,
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
    const name = cleanBlockName({
      ...block.name,
      ...Object.fromEntries(
        names
          .filter((n) => n.startsWith(`${prefix}name.`))
          .map((n) => [n.slice(`${prefix}name.`.length), String(posted.get(n) ?? '').trim()])
      ),
    });
    const result = {
      ...block,

      props:
        block.type === 'image' ? imageAltFromForm(read.props, within(posted, prefix)) : read.props,
    } as Block;
    // Empty metadata must not make an untouched form look changed before core parses it.
    if (name) result.name = name;
    else delete result.name;
    return result;
  });
  return { blocks: out, errors };
}

/** The props of the pending block as typed, with errors under its full field names. */
export function pendingProps(p: PendingBlock, posted: Posted) {
  const read = propsFromForm(BLOCK_DEFINITIONS[p.type].fields, within(posted, NEW_BLOCK));
  return {
    props:
      p.type === 'image' ? imageAltFromForm(read.props, within(posted, NEW_BLOCK)) : read.props,
    errors: read.errors.map((e) => ({ ...e, name: `${NEW_BLOCK}${e.name}` })),
  };
}

/**
 * The pending block still holds what choosing it showed: nothing typed, picked or switched in any
 * of `locales`. Choosing another block then replaces it instead of inserting it, the way a menu
 * choice replaces an untouched one; anything typed is still inserted first, or refused with
 * its words kept.
 *
 * Both the props and every posted value must match the empty block. Props alone miss words a
 * field only keeps beside something else (a caption or credit without an image, a URL without a
 * label): those read back as the empty block's props, and the block with the words would vanish.
 * A list's row count and a choice's default are in the empty view, so they match. An enhanced
 * editor's `.editor` document is left to the props: blank, it reads as nothing; with words, the
 * props differ. Rejected: refusing the new choice until Cancel (a step for nothing lost) and
 * comparing props only (the case above).
 */
export function pendingUntouched(
  p: PendingBlock,
  posted: Posted,
  locales: readonly string[]
): boolean {
  const fields = BLOCK_DEFINITIONS[p.type].fields;
  const empty = formValues(fields, undefined, locales);
  const typed = within(posted, NEW_BLOCK);
  const asShown = typed
    .names()
    .filter((n) => n.startsWith('p.') && !n.endsWith('.editor'))
    .every((n) => (typed.get(n) ?? '') === (empty[n] ?? ''));
  return (
    asShown &&
    isDeepStrictEqual(
      pendingProps(p, posted).props,
      p.type === 'image'
        ? imageAltFromForm(propsFromForm(fields, postedValues(empty)).props, typed)
        : propsFromForm(fields, postedValues(empty)).props
    )
  );
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
  [/^document\.heroAlt(\.[\w-]+)?$/, 'heroAlt'],
  // Only the newest correction comes from the form; the stored ones are read-only.
  [/^document\.corrections\.\d+\.date$/, 'correctionDate'],
];

/**
 * Core's refusal of a paywall block without the marker teaser. It sits on `blocks`, but on a save
 * the block is already there and what the editor changed is the teaser, so that is the field it
 * names. Only on the save's own path (`document.blocks`): on a block action (root `blocks`) the
 * refused insert put the paywall there, and an open item shows no teaser choice to point at.
 * Rejected: a path entry `document.blocks` in `DOCUMENT_FIELDS`, which would send every other
 * issue on the block list (an unrecorded medium) to the teaser as well.
 */
const PAYWALL_WITHOUT_MARKER = 'content.access.paywall-without-marker';

/**
 * The issues of a refused save that name a document field, as `{ name, message }`. A save's input
 * nests the document (`document.access.teaser`); a block action validates the stored document,
 * whose paths start at its root (`access.teaser`).
 */
export function documentFieldIssues(e: UseCaseError): { name: string; message: string }[] {
  return e.issues
    .map((i) => {
      if (i.path === 'document.blocks' && i.message === PAYWALL_WITHOUT_MARKER)
        return { name: 'teaser', message: i.message };
      const path = i.path.startsWith('document.') ? i.path : `document.${i.path}`;
      return { name: DOCUMENT_FIELDS.find(([re]) => re.test(path))?.[1] ?? '', message: i.message };
    })
    .filter((i) => i.name);
}

/**
 * The issues of a refused block operation as the summary lists them. The reason can sit on the
 * document, not the block (a second paywall beside the marker teaser's one), or on the operation
 * itself (a removal or move that would join text of different locales). With neither, the message
 * has to stand alone, so it is not the sentence that ends in a colon.
 */
export function blockRefusalIssues(e: UseCaseError): FieldIssue[] {
  if (e.code !== 'invalid_input') return [];
  const onFields = documentFieldIssues(e).map((i) => ({
    name: i.name,
    copy: ISSUES[i.message] ?? 'admin.block.error.invalid',
  }));
  return onFields.length ? onFields : operationIssues(e);
}

/**
 * The control a block issue points at. Core refuses a localised field as a whole when none of its
 * locales has words (`b.<id>.p.text`), but the form only has a control per locale: without this
 * the summary's link leads nowhere and the field is not marked. The first locale the form carried
 * is the one on screen. Rejected: an id on a wrapper around the locales, which the link reaches
 * but cannot focus. A list refused as a whole (too few rows) points at its first row's first
 * control: its only direct child is the hidden row count, which has no label and takes no focus.
 */
export function formFieldOf(name: string, values: Readonly<Record<string, unknown>>): string {
  if (name in values) return name;
  const prefix = `${name}.`;
  const keys = Object.keys(values).filter((k) => k.startsWith(prefix));
  if (`${prefix}rows` in values) return keys.find((k) => k !== `${prefix}rows`) ?? name;
  return keys.find((k) => !k.slice(prefix.length).includes('.')) ?? name;
}

/**
 * A block issue as the summary lists it: the control it links to (`formFieldOf`) and, for a list
 * refused as a whole, the list it is about, so the words say "Cards" and not the first row's
 * first field.
 */
export function blockIssueField(
  name: string,
  values: Readonly<Record<string, unknown>>
): { name: string; list?: string } {
  const field = formFieldOf(name, values);
  return `${name}.rows` in values ? { name: field, list: name } : { name: field };
}

/** Core's refusal to join two text blocks whose locales or names differ. */
const MERGE_AMBIGUOUS = 'content.blocks.merge-ambiguous';

/** A refusal of the form's input: a Markdown or editor issue, or core's ambiguous join. */
export type FormError = Omit<FieldError, 'message'> & {
  message: FieldError['message'] | typeof MERGE_AMBIGUOUS;
};

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
): { document: ContentDocumentInput; blocks: Block[]; errors: FormError[] } {
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
    } catch (e) {
      // A removal that would join two text blocks of different locales or names is refused by
      // core (`normalizeBlocks` does not guess translations) and says so; any other editor
      // failure keeps the general sentence. Rejected: passing every core issue through, which
      // would surface keys of a malformed payload nobody can act on.
      const message: FormError['message'] =
        e instanceof BlockOperationError && e.issue === MERGE_AMBIGUOUS
          ? MERGE_AMBIGUOUS
          : 'editor.markdown.invalid';
      return {
        document: doc,
        blocks: kept,
        errors: [{ name: 'articleEditor', message, line: 1 }],
      };
    }
  }
  const readable = editing === undefined || (!!editing && doc.locales.includes(editing));
  const read = readable ? blocksFrom(kept, post, skip) : { blocks: kept, errors: [] };
  return {
    document: { ...doc, access: accessFollowing(base, doc, read.blocks), blocks: read.blocks },
    blocks: read.blocks,
    errors: read.errors,
  };
}

/**
 * The access a post saves (#231). One save can take away or place the only paywall (the writer,
 * a new block form), so the teaser follows it by core's rule (`teaserFollowing`), as a block action
 * does; a teaser the editor changed in the same post is theirs and stands, refusal and all.
 * Rejected: following only in the writer's payload, which the posted teaser field then overwrote.
 */
function accessFollowing(
  base: ContentDocument,
  doc: ContentDocumentInput,
  blocks: readonly Block[]
): ContentDocumentInput['access'] {
  if (!isDeepStrictEqual(doc.access?.teaser, base.access.teaser)) return doc.access;
  return { ...doc.access, teaser: teaserFollowing(base, blocks).teaser };
}
