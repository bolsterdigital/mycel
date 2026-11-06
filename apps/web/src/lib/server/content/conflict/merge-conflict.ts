// The edit screen's half of ADR 026. Core merges a save on an older revision with what was saved
// since; only when both changed the same value does a save come back, and then the form returns
// as the merge proposes (their changes taken in, the editor's kept), on the newest revision, with
// one choice per conflicting value: "keep mine" (checked) or "use theirs". Nothing else asks.
//
// A choice is posted as `resolve.<path>`; "use theirs" takes the value the form's base (the newest
// revision when the conflict was shown) has at that path (`takeValue`). A block one side removed
// is the one value the form cannot show by its fields, so its proposal travels as `keep.<path>`
// and "keep mine" puts it back or takes it out. The writer's document is rebuilt from the
// proposal as well, so it never posts a block the newest revision does not know without
// carrying it, and is never stuck on a block it lost. Rejected: the old notice, a table of every change since the form
// was opened and a second save that put the whole form over the newest revision (which undid
// the other changes the editor had not read); and a choice per field with nothing pre-selected,
// which a required radio would enforce for every other button of the one form as well.

import {
  ContentDocumentInput,
  mergeSave,
  takeValue,
  useCases,
  valueAt,
  type Block,
  type BlockType,
  type ContentDocument,
  type MergeConflict,
  type Principal,
  type Revision,
} from '@mycel/core';
import { toArticleEditor } from '#lib/editor/article-document.js';
import { runtime } from '#lib/server/runtime.js';
import {
  actorLabel,
  diffRows,
  valuesOf,
  when,
  type FormValues,
} from '#lib/server/content/content-admin.js';
import { blockFormValues, blockPrefix, type PendingBlock } from '#lib/server/content/edit-form.js';
import { isDeepStrictEqual } from 'node:util';
import type { UiKey } from '../../../../i18n/index.js';

/** One value both changed, as the screen offers it. */
export interface ConflictChoice {
  path: string;
  label: UiKey;
  params: Record<string, string>;
  /** The type of the block a conflict is in, for its name. */
  blockType?: BlockType;
  /** Short text of each side; null where that side removed it. */
  theirs: string | null;
  mine: string | null;
  /** The proposal around a removed block (`keep.<path>`), JSON. */
  keep: string | null;
}

export interface ConflictView {
  who: string;
  when: string;
  choices: ConflictChoice[];
  /** The full difference table, only when no merge could be computed (a pattern, an old tab). */
  changes: ReturnType<typeof diffRows>;
}

const FIELDS: Record<string, UiKey> = {
  title: 'admin.content.field.title',
  lead: 'admin.content.field.lead',
  'seo.title': 'admin.content.field.seoTitle',
  'seo.description': 'admin.content.field.seoDescription',
  'seo.noindex': 'admin.content.field.noindex',
  'seo.canonical': 'admin.content.field.canonical',
  'seo.imageId': 'admin.content.field.shareImage',
  heroImageId: 'admin.content.field.heroImage',
  heroAlt: 'admin.content.field.heroAlt',
  featuredImageId: 'admin.content.field.featuredImage',
  'featured.title': 'admin.content.field.featuredTitle',
  'featured.description': 'admin.content.field.featuredDescription',
  authorIds: 'admin.content.field.authors',
  sectionId: 'admin.content.field.section',
  tags: 'admin.content.field.tags',
  corrections: 'admin.content.field.corrections',
  access: 'admin.content.field.level',
  'presentation.header': 'admin.content.field.headerLayout',
};

const BLOCK = /^blocks\[id=([^\]]+)\]/;

/** What a conflict is about, in the editor's words: a field, a block by number, or the order. */
function labelOf(
  path: string,
  doc: ContentDocumentInput
): Pick<ConflictChoice, 'label' | 'params' | 'blockType'> {
  if (path === '') return { label: 'admin.content.conflict.field.document', params: {} };
  if (path === 'blocks' || path === 'blocks#order')
    return { label: 'admin.content.conflict.field.blocks', params: {} };
  const last = path.split(/[.[]/).at(-1)!;
  const locale = doc.locales.includes(last) ? last : '';
  const block = BLOCK.exec(path);
  if (block) {
    const at = doc.blocks.findIndex((b) => b.id === block[1]);
    return {
      label: 'admin.content.conflict.field.block',
      params: { n: String(at + 1), ...(locale ? { locale } : {}) },
      ...(doc.blocks[at] ? { blockType: doc.blocks[at].type } : {}),
    };
  }
  const parts = path.split('.');
  if (locale) parts.pop();
  const field = FIELDS[parts.join('.')] ?? FIELDS[parts[0]!];
  return field
    ? { label: field, params: { locale } }
    : { label: 'admin.content.conflict.field.other', params: { path } };
}

/** A value as one short line: the words of text and blocks, never JSON of a whole document. */
function shown(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  const words: string[] = [];
  const walk = (x: unknown, key = ''): void => {
    if (typeof x === 'string') {
      if (key !== 'id' && key !== 'type') words.push(x);
    } else if (typeof x === 'number' || typeof x === 'boolean') words.push(String(x));
    else if (Array.isArray(x)) x.forEach((y) => walk(y));
    else if (x && typeof x === 'object')
      for (const [k, y] of Object.entries(x)) if (k !== 'version') walk(y, k);
  };
  walk(v);
  const s = words.join(' ').replace(/\s+/g, ' ').trim();
  return s.length > 200 ? `${s.slice(0, 199)}…` : s;
}

/** A top-level block's presence: the proposal's list as ids around the one block itself. */
function keepOf(path: string, proposal: ContentDocumentInput): string | null {
  const id = BLOCK.exec(path)?.[1];
  if (!id || path !== `blocks[id=${id}]`) return null;
  return JSON.stringify({ blocks: proposal.blocks.map((b) => (b.id === id ? b : { id: b.id })) });
}

/** The fields of a document as the form names them, in the locale the form shows. */
function fieldValues(doc: ContentDocumentInput, editing: string | null | undefined): FormValues {
  const shownLocales =
    editing === undefined ? doc.locales : editing && doc.locales.includes(editing) ? [editing] : [];
  const values: FormValues = { ...valuesOf(doc as ContentDocument) };
  for (const b of doc.blocks)
    if (b.id)
      for (const [k, v] of Object.entries(blockFormValues(b.type, b.props, shownLocales)))
        values[`${blockPrefix(b.id)}${k}`] = v;
  return values;
}

/**
 * The writer's document of the proposal against the newest revision: a block the newest lacks
 * travels with its own data (`newBlock`), and a block the proposal removed while the newest
 * changed it stays in, because the writer cannot leave out a block its base has; "keep mine"
 * takes it out on save.
 */
function writerOf(proposal: ContentDocumentInput, newest: ContentDocument, editing: string) {
  const known = new Map(newest.blocks.map((b) => [b.id, b]));
  const ids = new Set(proposal.blocks.map((b) => b.id));
  let doc = proposal as ContentDocument;
  for (const b of newest.blocks)
    if (!ids.has(b.id)) doc = takeValue(doc, newest, `blocks[id=${b.id}]`);
  doc = { ...doc, blocks: foldNewText(doc.blocks, known) };
  const editor = toArticleEditor(doc, editing);
  for (const node of editor.content) {
    const block = doc.blocks.find((b) => b.id === node.attrs.blockId) as Block | undefined;
    if (!block || known.has(block.id)) continue;
    Object.assign(node.attrs, {
      newBlock:
        block.type === 'rich-text'
          ? { id: block.id, type: block.type, version: block.version }
          : block,
    });
  }
  return JSON.stringify(editor);
}

/**
 * A new text block next to a text block the newest revision has, folded into that one in reading
 * order. Both sides adding text after the same card gives two text blocks side by side,
 * which no document may hold (ADR 020 rule 4), and the writer cannot leave out the newest's one:
 * so the writer shows both texts as one block, keeping the newest's id, and the next save is
 * valid with either choice. "Keep mine" keeps what the writer shows (both texts), "use theirs"
 * takes the newest block list. Rejected: the proposal's list alone, which the writer refuses
 * because a block of its base is missing.
 */
function foldNewText(blocks: readonly Block[], known: ReadonlyMap<string, Block>): Block[] {
  const out: Block[] = [];
  for (const b of blocks) {
    const prev = out.at(-1);
    if (
      !prev ||
      prev.type !== 'rich-text' ||
      b.type !== 'rich-text' ||
      (known.has(prev.id) && known.has(b.id))
    ) {
      out.push(b);
      continue;
    }
    const keep = known.has(prev.id) ? prev : b;
    const content: Record<string, { type: 'doc'; content: unknown[] }> = {};
    for (const locale of new Set([
      ...Object.keys(prev.props.content),
      ...Object.keys(b.props.content),
    ])) {
      const parts = [prev.props.content[locale], b.props.content[locale]].flatMap(
        (d) => d?.content ?? []
      );
      content[locale] = { type: 'doc', content: parts };
    }
    out[out.length - 1] = { ...keep, props: { ...keep.props, content } } as Block;
  }
  return out;
}

/**
 * The conflict of a save of `mine` on `base`: who saved the newest revision and when, one choice
 * per value both changed, and the form values to come back with (the proposal on the newest
 * revision). Without choices the newest revision merged cleanly after all (it changed again in
 * between); the caller then shows the difference table instead.
 */
export async function conflictOf(
  principal: Principal,
  itemId: string,
  base: ContentDocument,
  mine: ContentDocumentInput,
  ctx: ProposalContext
): Promise<{ view: ConflictView; values: FormValues; newest: string; slug: string }> {
  const { item, revision } = await runtime().invoker.run(useCases.getItem, principal, { itemId });
  return { ...proposalOf(base, mine, revision, ctx), newest: revision.id, slug: item.slug };
}

interface ProposalContext {
  values: FormValues;
  editing: string | null | undefined;
  zone: string;
  /** The slug field moved by both: theirs is the item's, mine the typed one. */
  slug: { theirs: string; mine: string } | null;
}

/** `conflictOf` without the read: the view and form values against the newest revision. */
export function proposalOf(
  base: ContentDocument,
  mine: ContentDocumentInput,
  revision: Pick<Revision, 'actor' | 'createdAt' | 'document'>,
  ctx: ProposalContext
): { view: ConflictView; values: FormValues } {
  const newest = revision.document;
  const { document: proposal, conflicts } = mergeSave(base, mine, newest, ContentDocumentInput);
  const choices = conflicts.map((c: MergeConflict) => ({
    path: c.path,
    ...labelOf(c.path, BLOCK.test(c.path) && !valueAt(proposal, c.path) ? newest : proposal),
    theirs: shown(c.theirs),
    mine: shown(c.mine),
    keep: keepOf(c.path, proposal),
  }));
  if (ctx.slug)
    choices.unshift({
      path: 'slug',
      label: 'admin.content.slug',
      params: {},
      theirs: ctx.slug.theirs,
      mine: ctx.slug.mine,
      keep: null,
    });
  // What the form showed and the proposal no longer has is cleared, not left at the old value.
  const before = fieldValues(base, ctx.editing);
  const after = fieldValues(proposal, ctx.editing);
  for (const [k, v] of Object.entries(before))
    if (!(k in after)) after[k] = Array.isArray(v) ? [] : '';
  const values: FormValues = { ...ctx.values, ...after };
  if (ctx.values.articleEditor && ctx.editing)
    values.articleEditor = writerOf(proposal, newest, ctx.editing);
  return {
    view: {
      who: actorLabel(revision.actor),
      when: when(revision.createdAt, ctx.zone),
      choices,
      changes: [],
    },
    values,
  };
}

/**
 * The choices of a conflict the form came back with, applied to what it posts: "use theirs"
 * takes the base's value (the newest revision when the conflict was shown), "keep mine" makes a
 * removed block's presence what the proposal had. The slug choice is the caller's (it is no
 * revision value).
 */
export function applyChoices(
  document: ContentDocumentInput,
  base: ContentDocument,
  data: FormData
): ContentDocumentInput {
  let doc = document;
  for (const [name, choice] of data.entries()) {
    if (!name.startsWith('resolve.') || name === 'resolve.slug') continue;
    const path = name.slice('resolve.'.length);
    if (choice === 'theirs') {
      doc = takeValue(doc, base, path);
      continue;
    }
    const keep = data.get(`keep.${path}`);
    if (typeof keep !== 'string') continue;
    let source: unknown;
    try {
      source = JSON.parse(keep);
    } catch {
      continue;
    }
    if ((valueAt(source, path) === undefined) !== (valueAt(doc, path) === undefined))
      doc = takeValue(doc, source, path);
  }
  return doc;
}

/**
 * Who saved the newest revision, when, and every change since `from`: the table a conflict shows
 * when there is no posted document to merge (a pattern on a filled document, input put back
 * after a login). The slug lives on the item, not in a revision, so a moved address is its own
 * row when the form says what it was rendered with (`baseSlug`).
 */
export async function changesSince(
  principal: Principal,
  itemId: string,
  from: string,
  zone: string,
  baseSlug?: string
): Promise<{ view: ConflictView; newest: string; slug: string }> {
  const { invoker } = runtime();
  const { item, revision } = await invoker.run(useCases.getItem, principal, { itemId });
  const { changes } = await invoker.run(useCases.diffRevisions, principal, {
    itemId: item.id,
    fromRevisionId: from,
    toRevisionId: revision.id,
  });
  const moved = baseSlug !== undefined && baseSlug !== item.slug;
  return {
    newest: revision.id,
    slug: item.slug,
    view: {
      who: actorLabel(revision.actor),
      when: when(revision.createdAt, zone),
      choices: [],
      changes: diffRows(
        moved ? [{ path: 'slug', before: baseSlug, after: item.slug }, ...changes] : changes
      ),
    },
  };
}

/**
 * The form values a conflict comes back with: the newest revision as base and the item's slug as
 * `baseSlug`. An untouched slug field follows the item, so the next save keeps the address the
 * other tab gave it; a slug the operator typed stays, to be applied by that save.
 */
export function conflictValues(values: FormValues, newest: string, slug: string): FormValues {
  const untouched = !('slug' in values) || values.slug === values.baseSlug;
  return {
    ...values,
    baseRevisionId: newest,
    ...('baseSlug' in values ? { baseSlug: slug } : {}),
    ...('slug' in values && untouched ? { slug } : {}),
  };
}

/**
 * The block a pending insert would add, when the revision already has it: not in the form's base,
 * same type and props, at the pending place: the same post again (a double click on Save), whose
 * save wrote nothing new. Null otherwise.
 */
export async function insertedBefore(
  principal: Principal,
  itemId: string,
  revisionId: string,
  base: ContentDocument,
  pending: PendingBlock,
  props: unknown
): Promise<string | null> {
  const { revision } = await runtime().invoker.run(useCases.getItem, principal, {
    itemId,
    revisionId,
  });
  const blocks = revision.document.blocks;
  const known = new Set(base.blocks.map((b) => b.id));
  const at = blocks.findIndex(
    (b, i) =>
      !known.has(b.id) &&
      b.type === pending.type &&
      isDeepStrictEqual(b.props, props) &&
      ('after' in pending.place
        ? blocks[i - 1]?.id === pending.place.after
        : 'before' in pending.place
          ? blocks[i + 1]?.id === pending.place.before
          : i === blocks.length - 1)
  );
  return blocks[at]?.id ?? null;
}
