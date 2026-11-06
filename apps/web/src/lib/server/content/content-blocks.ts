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
  FILE_DOWNLOAD_ROWS,
  GALLERY_ROWS,
  TIMELINE_ROWS,
  blockReferences,
  can,
  useCases,
  type Block,
  type BlockField,
  type BlockType,
  type MediaCredit,
  type Principal,
  type RichTextDoc,
  type UseCaseError,
  type FormDefinition,
  MAX_PAGE_SIZE,
  pickAny,
} from '@mycel/core';
import { runtime } from '../runtime.js';
import { withAssigned } from './content-admin.js';
import { mediaChoice } from '../admin/media-choices.js';
import { richTextHtml } from '../../blocks/rich-text.js';
import type { UiKey } from '../../../i18n/index.js';
import type { MediaChoice } from '../../admin/media-choice.js';

export interface Option {
  id: string;
  label: string;
}

interface Labelled {
  slug: string;
  title: Record<string, string | undefined>;
}

/** How a picker names an item: its title in `locale` (or any), and its address. */
export function itemLabel(item: Labelled, locale: string): string {
  return `${pickAny(item.title, locale) ?? item.slug} (/${item.slug})`;
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
    mediaChoices(principal, [
      ...new Set([...used.media, ...used.documents, ...used.audio, ...alsoChosen]),
    ]),
    invoker.run(useCases.listItems, principal, { limit: MAX_PAGE_SIZE }).then(({ items }) => {
      const label = (i: Labelled) => itemLabel(i, locale);
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
 * What the media pickers offer: a page of the newest images and of the newest documents, each
 * picker showing its own kind, plus the ones already chosen. An
 * editor without `media:read` sees the chosen ones by id, and keeps them.
 */
export async function mediaChoices(
  principal: Principal,
  chosen: readonly string[]
): Promise<MediaChoice[]> {
  const { invoker } = runtime();
  const missing = (id: string): MediaChoice => ({ id, label: id, thumb: false });
  if (!can(principal, 'media:read')) return chosen.map(missing);
  const [images, documents, audio] = await Promise.all(
    (['image', 'document', 'audio'] as const).map((kind) =>
      invoker.run(useCases.listMedia, principal, { kind, limit: MAX_PAGE_SIZE })
    )
  );
  return withAssigned(
    chosen,
    [...images!.items, ...documents!.items, ...audio!.items].map(mediaChoice),
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
      const text = pickAny(v as Record<string, string>, locale);
      if (text) return text;
    }
    if (f.kind === 'list' && Array.isArray(v) && v[0]) {
      const inner = firstText(f.fields, v[0] as Record<string, unknown>, locale);
      if (inner) return inner;
    }
    if (f.kind === 'rich-text' && v && typeof v === 'object') {
      const doc = pickAny(v as Record<string, { content?: unknown[] }>, locale);
      const text = textOf(doc?.content?.[0]);
      if (text) return text;
    }
  }
  return null;
}

/** A localised value in `locale`, else in any locale that has one: a card shows what there is. */
function anyLocale<T>(v: unknown, locale: string): T | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const filled = Object.entries(v as Record<string, T | null | undefined>).filter(([, x]) => x);
  return pickAny(Object.fromEntries(filled) as Record<string, T>, locale);
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
  const local = (v: unknown): string => anyLocale<string>(v, locale) ?? '';
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

/**
 * A text block at rest (MY-110 C1, C2): what the page says, as the page sets it. Every `*From` names
 * the form fields a text comes from, so the screen's script can bring a closed block up to date
 * with what was typed; each name is a field, `|` between alternatives. `html` is the escaping walk
 * in its inert mode, and `proseFrom` the editor that holds the same text. Null for a type without
 * this view, or for a heading, text or quote with nothing to say yet: the card's summary then says
 * so. A callout, FAQ, CTA, video or form always has a view, as their schemas require words or a
 * reference. A form is `form: null` when its reference finds nothing, plus `unread` when it was not
 * looked up; `forms` holds what the lookups found (a definition is read, never copied in).
 */
export type TextRest =
  | { kind: 'heading'; text: string; from: string }
  | {
      kind: 'quote';
      text: string;
      by: string;
      variant: string;
      variantFrom: string;
      from: string;
      byFrom: readonly string[];
    }
  | { kind: 'rich-text'; html: string; proseFrom: string }
  | {
      kind: 'callout';
      variant: string;
      variantFrom: string;
      title: string;
      titleFrom: string;
      html: string;
      proseFrom: string;
    }
  | {
      kind: 'faq';
      variant: string;
      variantFrom: string;
      title: string;
      titleFrom: string;
      /** The list's field name and the locale on screen: how the script finds the rows. */
      list: string;
      locale: string;
      entries: readonly { question: string; from: string; html: string; proseFrom: string }[];
    }
  | {
      kind: 'cta';
      variant: string;
      variantFrom: string;
      title: string;
      titleFrom: string;
      body: string;
      bodyFrom: string;
      /** Always both places the form has, so one typed after opening has somewhere to show. */
      actions: readonly { label: string; from: string }[];
    }
  | {
      kind: 'cards';
      /** One place per row the form can have, so a card typed after opening shows at rest. */
      cards: readonly {
        title: string;
        titleFrom: string;
        body: string;
        bodyFrom: string;
        label: string;
        labelFrom: string;
      }[];
    }
  | {
      kind: 'file-download';
      title: string;
      titleFrom: string;
      body: string;
      bodyFrom: string;
      /** One place per row the form can have, so a file typed after opening shows at rest. */
      files: readonly { label: string; from: string }[];
    }
  | {
      kind: 'gallery';
      /** One place per row, by its alt text: a decorative image has none and takes no room. */
      images: readonly { label: string; from: string }[];
    }
  | { kind: 'audio'; title: string; titleFrom: string }
  | {
      kind: 'timeline';
      title: string;
      titleFrom: string;
      /** One place per row, by its title, in the order of the form rather than of the page. */
      events: readonly { label: string; from: string }[];
    }
  /** A paywall has no words of its own: the screen says what the boundary does. */
  | { kind: 'paywall' }
  | {
      kind: 'video';
      provider: string;
      providerFrom: string;
      title: string;
      titleFrom: string;
      caption: string;
      captionFrom: string;
    }
  | {
      kind: 'form';
      variant: string;
      /** Absent on the legacy `signup-form`, which has no variant. */
      variantFrom?: string;
      /** The reference field: what the screen cannot resolve before the save. */
      idFrom: string;
      /** The reference was not looked up: this principal may not read form definitions. */
      unread?: true;
      form: {
        list: string;
        fields: readonly { type: 'email' | 'consent'; label: string }[];
        submit: string;
      } | null;
    };

/** How many actions a CTA's form offers (`max` of its `actions` field). */
const CTA_ACTION_ROWS = 2;
const CARDS_ROWS = 6;

export function textRestOf(
  block: Block,
  locale: string,
  prefix: string,
  forms: ReadonlyMap<string, FormDefinition | null> = new Map()
): TextRest | null {
  const local = (v: unknown): string => anyLocale<string>(v, locale) ?? '';
  const field = (path: string) => `${prefix}p.${path}`;
  const inert = (v: unknown, idPrefix: string): string => {
    const doc = anyLocale<RichTextDoc>(v, locale);
    if (!doc || !textOf(doc)) return '';
    return richTextHtml(doc, {
      depth: 1,
      links: {},
      base: '',
      idPrefix,
      footnotes: '',
      footnoteBack: '',
      inert: true,
    });
  };
  if (block.type === 'heading') {
    const text = local(block.props.text);
    return text ? { kind: 'heading', text, from: field(`text.${locale}`) } : null;
  }
  if (block.type === 'quote') {
    const { text, attribution: by, variant } = block.props;
    return {
      kind: 'quote',
      text: local(text),
      // As the page prints it (`Quote.svelte`): the source, else the bare address.
      by: [by.name, local(by.role), local(by.source) || by.url].filter(Boolean).join(', '),
      variant,
      variantFrom: field('variant'),
      from: field(`text.${locale}`),
      byFrom: [
        field('attribution.name'),
        field(`attribution.role.${locale}`),
        `${field(`attribution.source.${locale}`)}|${field('attribution.url')}`,
      ],
    };
  }
  if (block.type === 'rich-text') {
    const html = inert(block.props.content, block.id);
    return html ? { kind: 'rich-text', html, proseFrom: field(`content.${locale}.editor`) } : null;
  }
  if (block.type === 'callout') {
    return {
      kind: 'callout',
      variant: block.props.variant,
      variantFrom: field('variant'),
      title: local(block.props.title),
      titleFrom: field(`title.${locale}`),
      html: inert(block.props.body, block.id),
      proseFrom: field(`body.${locale}.editor`),
    };
  }
  if (block.type === 'faq') {
    return {
      kind: 'faq',
      variant: block.props.variant,
      variantFrom: field('variant'),
      title: local(block.props.title),
      titleFrom: field(`title.${locale}`),
      list: field('entries'),
      locale,
      entries: block.props.entries.map((entry, i) => ({
        question: local(entry.question),
        from: field(`entries.${i}.question.${locale}`),
        html: inert(entry.answer, `${block.id}-${i}`),
        proseFrom: field(`entries.${i}.answer.${locale}.editor`),
      })),
    };
  }
  // A legacy hero's words are a CTA's: a title, a text and up to two actions. Its picture stands
  // above them on the screen (`imageRestOf`).
  if (block.type === 'cta' || block.type === 'hero') {
    return {
      kind: 'cta',
      variant: block.props.variant,
      variantFrom: field('variant'),
      title: local(block.props.title),
      titleFrom: field(`title.${locale}`),
      body: local(block.props.body),
      bodyFrom: field(`body.${locale}`),
      actions: Array.from({ length: CTA_ACTION_ROWS }, (_, i) => ({
        label: local(block.props.actions[i]?.label),
        from: field(`actions.${i}.label.${locale}`),
      })),
    };
  }
  if (block.type === 'cards') {
    return {
      kind: 'cards',
      cards: Array.from({ length: CARDS_ROWS }, (_, i) => {
        const card = block.props.cards[i];
        return {
          title: local(card?.title),
          titleFrom: field(`cards.${i}.title.${locale}`),
          body: local(card?.body),
          bodyFrom: field(`cards.${i}.body.${locale}`),
          label: local(card?.actions[0]?.label),
          labelFrom: field(`cards.${i}.actions.0.label.${locale}`),
        };
      }),
    };
  }
  if (block.type === 'file-download') {
    return {
      kind: 'file-download',
      title: local(block.props.title),
      titleFrom: field(`title.${locale}`),
      body: local(block.props.body),
      bodyFrom: field(`body.${locale}`),
      files: Array.from({ length: FILE_DOWNLOAD_ROWS }, (_, i) => ({
        label: local(block.props.files[i]?.name),
        from: field(`files.${i}.name.${locale}`),
      })),
    };
  }
  if (block.type === 'gallery') {
    return {
      kind: 'gallery',
      images: Array.from({ length: GALLERY_ROWS }, (_, i) => ({
        label: local(block.props.images[i]?.alt ?? undefined),
        from: field(`images.${i}.alt.${locale}`),
      })),
    };
  }
  if (block.type === 'audio') {
    return { kind: 'audio', title: local(block.props.title), titleFrom: field(`title.${locale}`) };
  }
  if (block.type === 'timeline') {
    return {
      kind: 'timeline',
      title: local(block.props.title),
      titleFrom: field(`title.${locale}`),
      events: Array.from({ length: TIMELINE_ROWS }, (_, i) => ({
        label: local(block.props.events[i]?.title),
        from: field(`events.${i}.title.${locale}`),
      })),
    };
  }
  if (block.type === 'paywall') return { kind: 'paywall' };
  if (block.type === 'video-embed') {
    return {
      kind: 'video',
      provider: block.props.provider,
      providerFrom: field('provider'),
      title: local(block.props.title),
      titleFrom: field(`title.${locale}`),
      caption: local(block.props.caption),
      captionFrom: field(`caption.${locale}`),
    };
  }
  if (block.type === 'form' || block.type === 'signup-form') {
    const form = forms.get(block.props.formId);
    return {
      kind: 'form',
      variant: block.type === 'form' ? block.props.variant : 'default',
      ...(block.type === 'form' ? { variantFrom: field('variant') } : {}),
      idFrom: field('formId'),
      ...(forms.has(block.props.formId) ? {} : { unread: true as const }),
      form: form
        ? {
            list: form.list,
            fields: form.fields.map((f) => ({ type: f.type, label: local(f.label) })),
            submit: local(form.submitLabel),
          }
        : null,
    };
  }
  return null;
}

/**
 * An image block at rest (MY-110 A): the file it shows at card scale and the caption and credit
 * the page will print, by the renderer's rule (`lib/blocks/resolve.ts`): the block's own caption
 * wins and an empty one hides the file's; the block's credit replaces the file's. `card` is null
 * when the file cannot be shown, so the card says so instead of showing nothing.
 */
export interface ImageRest {
  mediaId: string;
  /** The file's name, or its id when the operator cannot read it. */
  label: string;
  card: { file: string; width: number; height: number } | null;
  caption: string | null;
  /**
   * The form field that holds the caption and the file's own words, so the screen's script can
   * follow the caption's mode at close; null on a hero, whose picture has no caption here.
   */
  captionSource: { from: string; inherited: string } | null;
  credit: MediaCredit | null;
}

export function imageRestOf(
  block: Block,
  locale: string,
  media: readonly MediaChoice[]
): ImageRest | null {
  // A legacy hero shows its picture, not its caption or credit: the page does not set them there.
  const onPage = block.type === 'image';
  if (!onPage && !(block.type === 'hero' && block.props.image)) return null;
  const p = (onPage ? block.props : block.props.image) as {
    mediaId: string;
    caption?: Partial<Record<string, string>>;
    credit?: MediaCredit;
  };
  const asset = media.find((m) => m.id === p.mediaId);
  if (!onPage) {
    return {
      mediaId: p.mediaId,
      label: asset?.label ?? p.mediaId,
      card: asset?.card
        ? { file: asset.card.file, width: asset.card.width, height: asset.card.height }
        : null,
      caption: null,
      captionSource: null,
      credit: null,
    };
  }
  const own = p.caption?.[locale];
  const inherited = asset?.card?.caption[locale] ?? '';
  const caption = own !== undefined ? own : inherited;
  const credit = p.credit ?? asset?.card?.credit ?? null;
  return {
    mediaId: p.mediaId,
    label: asset?.label ?? p.mediaId,
    card: asset?.card
      ? { file: asset.card.file, width: asset.card.width, height: asset.card.height }
      : null,
    caption: caption.trim() ? caption : null,
    captionSource: { from: `b.${block.id}.p.caption.${locale}`, inherited },
    credit: credit && (credit.work || credit.photographer) ? credit : null,
  };
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
  'content.cards.too-few': 'admin.block.issue.tooFewCards',
  'content.cards.too-many': 'admin.block.issue.tooManyCards',
  'content.audio.no-file': 'admin.block.issue.noAudio',
  'content.timeline.too-few': 'admin.block.issue.tooFewEvents',
  'content.timeline.no-date': 'admin.block.issue.noDate',
  'content.gallery.too-few': 'admin.block.issue.tooFewImages',
  'content.gallery.no-image': 'admin.block.issue.noImage',
  'content.files.too-few': 'admin.block.issue.tooFewFiles',
  'content.files.no-file': 'admin.block.issue.noFile',
  'content.reference.media-not-document': 'admin.content.issue.mediaNotDocument',
  'content.reference.media-not-audio': 'admin.content.issue.mediaNotAudio',
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
  // update, `block.props` of insert).
  const prefixes = [`blocks.${index}.props`, 'block.props', 'props'];
  return e.issues.map((i) => {
    const prefix = prefixes.find((p) => i.path.startsWith(`${p}.`));
    return { name: prefix ? `p${i.path.slice(prefix.length)}` : '', copy: issueCopy(i.message) };
  });
}
