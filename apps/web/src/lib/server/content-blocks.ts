// The server half of the block forms (brief content-editor § B): what a block form needs besides
// the field descriptions (the images and items a field can point at), one line per block for its
// summary, and core's refusals mapped onto the form's field names. The forms themselves come
// from `lib/editor/block-form.ts`; the actions call the block operations of the registry
// (`content.block.update`, `move`, `remove`, `insert`) with `baseRevisionId`, so a no-JS edit
// is the same command an agent sends.
//
// The pickers list a bounded page (a hundred, newest first) plus whatever the block already
// points at, like the author picker of A1, so opening and saving a form never drops a reference
// beyond the first page. Forms have no list use case yet: a form reference is its id, typed.
// Rejected: loading every image and item of the site (unbounded), and a picker per field type in
// the component (the options belong to the tenant, not to the block).

import {
  BLOCK_DEFINITIONS,
  blockReferences,
  can,
  useCases,
  type Block,
  type BlockField,
  type BlockType,
  type Principal,
  type UseCaseError,
} from '@mycel/core';
import { runtime } from './runtime.js';
import { withAssigned } from './content-admin.js';
import { mediaChoice } from './admin/media-choices.js';
import type { UiKey } from '../../i18n/index.js';
import type { MediaChoice } from '../admin/media-choice.js';

export interface Option {
  id: string;
  label: string;
}

/** The images and items the pickers offer: a page of each plus everything the blocks use. */
export async function pickerOptions(
  principal: Principal,
  blocks: readonly Block[],
  locale: string,
  /** Images chosen outside the blocks (the document's featured and share image). */
  alsoChosen: readonly string[] = []
): Promise<{ media: MediaChoice[]; items: Option[]; upload: boolean }> {
  const { invoker } = runtime();
  const used = blockReferences(blocks);
  const orNull = <T>(p: Promise<T>) => p.catch(() => null);
  const [media, items] = await Promise.all([
    mediaChoices(principal, [...new Set([...used.media, ...alsoChosen])]),
    invoker.run(useCases.listItems, principal, { limit: 100 }).then(({ items }) => {
      const label = (i: { slug: string; title: Record<string, string | undefined> }) =>
        `${i.title[locale] ?? Object.values(i.title)[0] ?? i.slug} (/${i.slug})`;
      return withAssigned(
        used.items,
        items.map((i) => ({ id: i.id, label: label(i) })),
        async (itemId) => {
          const got = await orNull(invoker.run(useCases.getItem, principal, { itemId }));
          return got && { id: got.item.id, label: label(got.item) };
        },
        (id) => ({ id, label: id })
      );
    }),
  ]);
  return { media, items, upload: can(principal, 'media:write') };
}

/**
 * The images a media picker offers: a page of the newest plus the ones already chosen. An
 * editor without `media:read` sees the chosen ones by id, and keeps them.
 */
export async function mediaChoices(
  principal: Principal,
  chosen: readonly string[]
): Promise<MediaChoice[]> {
  const { invoker } = runtime();
  const missing = (id: string): MediaChoice => ({ id, label: id, thumb: false });
  if (!can(principal, 'media:read')) return chosen.map(missing);
  const { items } = await invoker.run(useCases.listMedia, principal, { kind: 'image', limit: 100 });
  return withAssigned(
    chosen,
    items.map(mediaChoice),
    async (id) => {
      const m = await invoker.run(useCases.getMedia, principal, { id }).catch(() => null);
      return m && mediaChoice(m);
    },
    missing
  );
}

/** The text of a rich-text node and everything in it, in order. */
function textOf(node: unknown): string {
  const n = node as { text?: string; content?: unknown[] } | undefined;
  return (n?.text ?? '') + (n?.content ?? []).map(textOf).join('');
}

/** The first localised text of a block's fields in `locale`, lists and rich text included. */
function firstText(
  fields: readonly BlockField[],
  props: Record<string, unknown>,
  locale: string
): string | null {
  for (const f of fields) {
    const v = props[f.key];
    if (f.kind === 'text' && f.localized && v && typeof v === 'object') {
      const map = v as Record<string, string>;
      const text = map[locale] ?? Object.values(map)[0];
      if (text) return text;
    }
    if (f.kind === 'list' && Array.isArray(v) && v[0]) {
      const inner = firstText(f.fields, v[0] as Record<string, unknown>, locale);
      if (inner) return inner;
    }
    if (f.kind === 'rich-text' && v && typeof v === 'object') {
      const doc = ((v as Record<string, unknown>)[locale] ?? Object.values(v)[0]) as
        { content?: unknown[] } | undefined;
      const text = textOf(doc?.content?.[0]);
      if (text) return text;
    }
  }
  return null;
}

/** One line that says which block this is: its first localised text in `locale`. */
export function summaryOf(block: Block, locale: string): string {
  const text = firstText(
    BLOCK_DEFINITIONS[block.type as BlockType].fields,
    block.props as Record<string, unknown>,
    locale
  );
  return clip(text ?? '');
}

/**
 * What a block card shows while it is folded (#66 PR 3, brief edit-screen § 9a), read from the
 * block register rather than per type: its first image (a picture says more than its alt text),
 * the caption, else the first text outside a list, and the entries of its first list one line each (the
 * questions of an FAQ). Rejected: a hand-written summary per block type, which a new type forgets.
 */
export interface BlockPreview {
  text: string;
  mediaId: string | null;
  entries: string[];
}

export function previewOf(block: Block, locale: string): BlockPreview {
  const fields = BLOCK_DEFINITIONS[block.type as BlockType].fields;
  const props = block.props as Record<string, unknown>;
  const local = (v: unknown): string => {
    if (!v || typeof v !== 'object') return '';
    const map = v as Record<string, string | null | undefined>;
    return map[locale] || Object.values(map).find((x) => typeof x === 'string' && x) || '';
  };
  const media = (fs: readonly BlockField[], ps: Record<string, unknown>): string | null => {
    for (const f of fs) {
      const v = ps[f.key];
      if (f.kind === 'media' && typeof v === 'string' && v) return v;
      if (f.kind === 'group' && v && typeof v === 'object') {
        const inner = media(f.fields, v as Record<string, unknown>);
        if (inner) return inner;
      }
    }
    return null;
  };
  const list = fields.find((f) => f.kind === 'list');
  const entries =
    list?.kind === 'list' && Array.isArray(props[list.key])
      ? (props[list.key] as Block[]).map((entry) =>
          clip(firstText(list.fields, entry as unknown as Record<string, unknown>, locale) ?? '')
        )
      : [];
  const caption = fields.find((f) => f.kind === 'caption');
  const text =
    (caption && local(props[caption.key])) ||
    firstText(
      fields.filter((f) => f.kind !== 'list'),
      props,
      locale
    ) ||
    (list ? '' : summaryOf(block, locale));
  return { text: clip(text), mediaId: media(fields, props), entries: entries.filter(Boolean) };
}

const clip = (text: string) => (text.length > 80 ? `${text.slice(0, 79)}…` : text);

/** A refusal on one field of a block form: the field's name and catalog copy. */
export interface FieldIssue {
  name: string;
  copy: UiKey;
}

const ISSUE_COPY: Record<string, UiKey> = {
  'i18n.localized.empty': 'admin.block.issue.required',
  'content.image.alt-required': 'admin.block.issue.altRequired',
  'content.image.decorative-alt': 'admin.block.issue.decorativeAlt',
  'content.image.alt-empty': 'admin.block.issue.required',
  'content.hero.image-required': 'admin.block.issue.heroImage',
  'content.link.unsafe': 'admin.block.issue.unsafeLink',
  'content.link.one-target': 'admin.block.issue.unsafeLink',
  'content.video.id-invalid': 'admin.block.issue.videoId',
  'content.reference.item-unknown': 'admin.content.issue.referenceUnknown',
  'content.reference.form-unknown': 'admin.content.issue.referenceUnknown',
  'content.reference.media-unknown': 'admin.content.issue.referenceUnknown',
  'content.reference.media-not-image': 'admin.content.issue.mediaNotImage',
  'content.blocks.adjacent-rich-text': 'admin.block.issue.adjacentText',
  'content.blocks.too-many': 'admin.block.issue.tooMany',
  'entitlements.feature-off': 'admin.block.issue.notIncluded',
  'editor.markdown.unclosed-link': 'admin.block.issue.unclosedLink',
  'editor.markdown.unknown-footnote': 'admin.block.issue.unknownFootnote',
  'editor.markdown.list-item-start': 'admin.block.issue.listItemStart',
  'editor.markdown.invalid': 'admin.block.issue.richText',
};

/** Catalog copy for an issue key of core or of the Markdown reader. */
export const issueCopy = (message: string): UiKey =>
  ISSUE_COPY[message] ?? 'admin.block.issue.other';

/**
 * Core's issues of a block operation as field issues. A path inside the block's props
 * (`blocks.<i>.props.title.nl`) becomes the form name (`p.title.nl`); anything else (the tree,
 * an entitlement) is an issue on the block as a whole, with an empty name.
 */
export function fieldIssues(e: UseCaseError, index: number): FieldIssue[] {
  // The document's path to the block (`blocks.<i>.props`), or the operation's input (`props` of
  // set_props, `block.props` of insert).
  const prefixes = [`blocks.${index}.props`, 'block.props', 'props'];
  return e.issues.map((i) => {
    const prefix = prefixes.find((p) => i.path.startsWith(`${p}.`));
    return { name: prefix ? `p${i.path.slice(prefix.length)}` : '', copy: issueCopy(i.message) };
  });
}
