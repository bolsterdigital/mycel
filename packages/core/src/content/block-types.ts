// One entry per block type (ADR 004, ADR 013 rule 2, ADR 020): its props schema and version,
// the enumerated variants and layout props, where its localised fields sit, which tenant data it
// references, and examples for every variant in two locales. `blocks.ts` builds the envelope
// schema, readiness, projection and reference extraction from these entries, so a new type is
// one entry here and nothing else to keep in step. The examples are the fixtures the renderer
// (#8c) and the editor (#11) import; they are not copied.
//
// The four types of #8a (`heading`, `signup-form`, `rich-text`, `paywall`) keep their version 1
// schemas exactly: stored revisions must parse unchanged. The others start at version 1 here.
// No type has child blocks yet; prose inside a card is localised text or a `RichTextDoc`, so the
// id operations keep a flat sibling list. Rejected: deriving localised fields by walking the Zod
// schema (unions and effects make that guesswork) and one hand-kept list of types per consumer.

import { z } from 'zod';
import { localized } from '../i18n/locale.js';
import { MediaCredit } from '../media/model.js';
import { RichTextDoc, isSafeHref, linkedItemIds } from './rich-text.js';
import { exampleId } from '../util/ids.js';

/** A localised map inside a block's props, with its path from `props`. */
export interface LocalField {
  path: (string | number)[];
  value: Record<string, unknown>;
  /** A published locale needs a value: always for required fields, and for optional ones once filled. */
  required: boolean;
}

/** A tenant reference inside a block's props (the `type` column of `content_block_refs`). */
export interface PropReference {
  type: 'form' | 'item' | 'media';
  refId: string;
  /** This media slot takes a document, not an image; the `content_block_refs` row stays `media`. */
  document?: true;
  /** This media slot takes a sound file, not an image; the row stays `media` here too. */
  audio?: true;
}

export interface BlockExample<P> {
  name: string;
  note?: string;
  props: P;
}

/**
 * How the admin edits one prop (brief content-editor § B): the no-JavaScript block forms are
 * generated from these, so no block gets a hand-built form. The label is the catalog key
 * `admin.block.field.<key>`. `optional` says what an empty field stores: `omit` leaves the key
 * out, `null` stores null. An optional `group` gets an explicit "present" choice, because absent
 * and empty can mean different things (a credit override of nothing versus the asset's credit).
 * A `caption` is a localised text where an absent locale inherits the asset's caption and an
 * empty one hides it. `blocks.conformance.test.ts` requires one entry for every key of every
 * props schema, nested ones included.
 */
export type BlockField =
  | {
      key: string;
      kind: 'text';
      localized: boolean;
      multiline?: boolean;
      optional?: 'omit' | 'null';
    }
  | { key: string; kind: 'caption' }
  | { key: string; kind: 'rich-text' }
  | { key: string; kind: 'media'; accept?: 'document' | 'audio' }
  | { key: string; kind: 'reference'; to: 'form' | 'item' }
  | {
      key: string;
      kind: 'choice';
      options: readonly string[];
      /** What a new form selects, when the schema's default is not the first option. */
      initial?: string;
    }
  | { key: string; kind: 'boolean' }
  | { key: string; kind: 'date' }
  | { key: string; kind: 'actions'; min: number; max: number }
  | { key: string; kind: 'group'; optional?: 'omit' | 'null'; fields: readonly BlockField[] }
  | { key: string; kind: 'list'; min: number; max: number; fields: readonly BlockField[] };

export interface BlockDefinition<S extends z.ZodTypeAny, V extends number = number> {
  version: V;
  props: S;
  /** One per prop, in the order the form shows them. */
  fields: readonly BlockField[];
  /** Enumerated props (variant, layout, width, align): every value has an example. */
  variants: Record<string, readonly string[]>;
  localized(props: z.infer<S>): LocalField[];
  references(props: z.infer<S>): PropReference[];
  /** At least one, covering every value of every enumerated prop, with `nl` and `en`. */
  examples: readonly BlockExample<z.input<S>>[];
}

const define = <S extends z.ZodTypeAny, V extends number>(d: BlockDefinition<S, V>) => d;

// Text bounds shared by the cards (brief #8b2 § 1).
const ShortText = z.string().min(1).max(200);
const BodyText = z.string().min(1).max(5000);
/** A transcript: about half an hour of speech, which is what the upload limit lets through. */
const TranscriptText = z.string().min(1).max(50000);
const CaptionText = z.string().max(2000);
const LabelText = z.string().min(1).max(100);

export const WIDTHS = ['content', 'wide', 'full'] as const;
export const ALIGNS = ['start', 'center', 'end'] as const;
export const IMAGE_LAYOUTS = ['content', 'wide', 'full', 'float-left', 'float-right'] as const;
export const HERO_VARIANTS = ['minimal', 'cover', 'split'] as const;
export const CTA_VARIANTS = ['band', 'card'] as const;
export const CALLOUT_VARIANTS = ['info', 'note', 'warning'] as const;
export const CARDS_ACCENTS = ['none', 'bar', 'filled'] as const;
export const GALLERY_VARIANTS = ['grid', 'row'] as const;
export const TIMELINE_ORDERS = ['newest', 'oldest'] as const;
/** How many events one `timeline` block lists; the rest view keeps a place for each. */
export const TIMELINE_ROWS = 24;
/** How many images one `gallery` block shows; the rest view keeps a place for each. */
export const GALLERY_ROWS = 24;
/** How many files one `file-download` block lists; the rest view keeps a place for each. */
export const FILE_DOWNLOAD_ROWS = 12;
export const FAQ_VARIANTS = ['list', 'accordion'] as const;
export const QUOTE_VARIANTS = ['blockquote', 'pullquote'] as const;
export const VIDEO_PROVIDERS = ['youtube', 'vimeo'] as const;
export const FORM_VARIANTS = ['default', 'card'] as const;

const Width = z.enum(WIDTHS);
const Align = z.enum(ALIGNS);

/** The rich-text link rules, so a card link and a text link are refused for the same reasons. */
const SafeUrl = z.string().min(1).max(2048).refine(isSafeHref, 'content.link.unsafe');
const WebUrl = SafeUrl.refine((v) => /^https?:\/\//i.test(v), 'content.link.unsafe');

/** A button or link of a card: an item of the tenant by id (never a slug), or a safe URL. */
const Action = z
  .object({
    label: localized(LabelText),
    target: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('item'), itemId: z.string().guid() }).strict(),
      z.object({ kind: z.literal('url'), url: SafeUrl }).strict(),
    ]),
  })
  .strict();
type Action = z.infer<typeof Action>;
/** The action schema for what reports on a block's actions (hero conversion). */
export const BlockAction = Action;

/**
 * The use of one image: the media id plus what belongs to this use and not to the file (alt,
 * decorative, caption and credit overrides; docs/reference/media.md). An absent caption or credit
 * inherits the asset's; an empty caption string hides it in that locale.
 */
const IMAGE_USE = {
  mediaId: z.string().guid(),
  decorative: z.boolean(),
  alt: localized(z.string().min(1).max(1000).regex(/\S/, 'content.image.alt-empty')).nullable(),
  caption: localized(CaptionText).optional(),
  credit: MediaCredit.optional(),
};
function altRule(p: { decorative: boolean; alt: unknown }, ctx: z.RefinementCtx) {
  if (p.decorative && p.alt !== null)
    ctx.addIssue({ code: 'custom', path: ['alt'], message: 'content.image.decorative-alt' });
  if (!p.decorative && p.alt === null)
    ctx.addIssue({ code: 'custom', path: ['alt'], message: 'content.image.alt-required' });
}
function imageProps<L extends readonly [string, ...string[]]>(layouts: L) {
  return z
    .object({
      ...IMAGE_USE,
      layout: z.enum(layouts as unknown as [L[number], ...L[number][]]).default(layouts[0]),
    })
    .strict()
    .superRefine(altRule);
}
const ImageProps = imageProps(IMAGE_LAYOUTS);
const HeroImage = imageProps(['content'] as const);
type ImageUse = {
  alt: Record<string, string> | null;
  caption?: Record<string, string> | undefined;
};

// --- field descriptions shared by several types ---------------------------------------------

const textField = (
  key: string,
  opts: Omit<Extract<BlockField, { kind: 'text' }>, 'key' | 'kind'>
) => ({ key, kind: 'text', ...opts }) as const;
const choice = (key: string, options: readonly string[], initial?: string): BlockField => ({
  key,
  kind: 'choice',
  options,
  ...(initial && { initial }),
});
const creditField: BlockField = {
  key: 'credit',
  kind: 'group',
  optional: 'omit',
  fields: [
    {
      key: 'work',
      kind: 'group',
      optional: 'null',
      fields: [textField('title', { localized: false }), textField('maker', { localized: false })],
    },
    textField('photographer', { localized: false, optional: 'null' }),
  ],
};
const imageUseFields: BlockField[] = [
  { key: 'mediaId', kind: 'media' },
  { key: 'decorative', kind: 'boolean' },
  textField('alt', { localized: true, optional: 'null' }),
  { key: 'caption', kind: 'caption' },
  creditField,
];
const imageFieldsOf = (layouts: readonly string[]): BlockField[] => [
  ...imageUseFields,
  choice('layout', layouts),
];

// --- helpers for `localized` and `references` -----------------------------------------------

/** A field that is there: required at publish, whether the schema makes it optional or not. */
function present(path: (string | number)[], value: object | null | undefined): LocalField[] {
  return value ? [{ path, value: value as Record<string, unknown>, required: true }] : [];
}

function imageFields(prefix: (string | number)[], image: ImageUse): LocalField[] {
  return [
    ...present([...prefix, 'alt'], image.alt),
    ...present([...prefix, 'caption'], image.caption),
  ];
}

function actionFields(actions: readonly Action[]): LocalField[] {
  return actions.flatMap((a, i) => present(['actions', i, 'label'], a.label));
}

function actionRefs(actions: readonly Action[]): PropReference[] {
  return actions.flatMap((a) =>
    a.target.kind === 'item' ? [{ type: 'item' as const, refId: a.target.itemId }] : []
  );
}

/** Item links inside a localised rich-text map, every locale. */
function docRefs(map: Partial<Record<string, RichTextDoc>> | undefined): PropReference[] {
  return Object.values(map ?? {}).flatMap((doc) =>
    doc ? linkedItemIds(doc).map((refId) => ({ type: 'item' as const, refId })) : []
  );
}

// --- example data -----------------------------------------------------------------------------

/** Example ids: the renderer's resolver fixtures (#8c) map these to a form, an item and images. */
export const EXAMPLE_IDS = {
  form: exampleId(0xf001),
  item: exampleId(0xc001),
  image: exampleId(0xd001),
  portrait: exampleId(0xd002),
  document: exampleId(0xd003),
  audio: exampleId(0xd004),
} as const;

const doc = (...paragraphs: string[]): RichTextDoc => ({
  type: 'doc',
  content: paragraphs.map((text) => ({ type: 'paragraph', content: [{ type: 'text', text }] })),
});
const linkedDoc = (before: string, link: string, itemId: string): RichTextDoc => ({
  type: 'doc',
  content: [
    {
      type: 'paragraph',
      content: [
        { type: 'text', text: before },
        { type: 'text', text: link, marks: [{ type: 'link', attrs: { itemId } }] },
      ],
    },
  ],
});
const image = {
  mediaId: EXAMPLE_IDS.image,
  decorative: false,
  alt: {
    nl: 'Demonstranten met spandoeken op het Malieveld',
    en: 'Protesters with banners on the Malieveld',
  },
};
const signUp = {
  label: { nl: 'Teken de petitie', en: 'Sign the petition' },
  target: { kind: 'item' as const, itemId: EXAMPLE_IDS.item },
};
const readMore = {
  label: { nl: 'Lees het rapport', en: 'Read the report' },
  target: { kind: 'url' as const, url: 'https://example.org/rapport' },
};
/** The longest label the schema allows in Dutch: the UI gate's worst case (#8c, #11). */
const longLabel = {
  label: {
    nl: 'Schrijf je vandaag nog in voor de maandelijkse nieuwsbrief over lokale woningbouwplannen',
    en: 'Subscribe today to the monthly newsletter on local housing plans',
  },
  target: { kind: 'url' as const, url: '/nieuwsbrief' },
};

// --- the registry -----------------------------------------------------------------------------

const JOIN_CARD = {
  title: { nl: 'Word lid', en: 'Become a member' },
  body: { nl: 'Samen staan we sterker.', en: 'Together we stand stronger.' },
  actions: [
    {
      label: { nl: 'Meld je aan', en: 'Sign up' },
      target: { kind: 'item' as const, itemId: EXAMPLE_IDS.item },
    },
  ],
};
const VOLUNTEER_CARD = {
  title: { nl: 'Doe mee als vrijwilliger', en: 'Volunteer with us' },
  body: {
    nl: 'Een paar uur per maand maakt al verschil, ook als je nog nooit eerder hebt meegedaan.',
    en: 'A few hours a month already make a difference, even if you have never joined in before.',
  },
  actions: [
    {
      label: { nl: 'Bekijk de klussen', en: 'See the jobs' },
      target: { kind: 'url' as const, url: 'https://example.org/klussen' },
    },
  ],
};
const DONATE_CARD = {
  title: { nl: 'Steun ons', en: 'Support us' },
  actions: [
    {
      label: { nl: 'Doneer', en: 'Donate' },
      target: { kind: 'url' as const, url: 'https://example.org/doneer' },
    },
  ],
};
const NO_LINK_CARD = {
  title: { nl: 'Kom langs', en: 'Drop by' },
  body: { nl: 'Elke dinsdag op kantoor.', en: 'Every Tuesday at the office.' },
};

export const BLOCK_DEFINITIONS = {
  // No `level` prop: the renderer derives the heading level from tree depth (ADR 004 rule 3).
  heading: define({
    version: 1,
    props: z.object({ text: localized(z.string().min(1).max(200)) }).strict(),
    fields: [textField('text', { localized: true })],
    variants: {},
    localized: (p) => present(['text'], p.text),
    references: () => [],
    examples: [{ name: 'heading', props: { text: { nl: 'Wie we zijn', en: 'Who we are' } } }],
  }),
  // A reference, never a copy: the forms module owns the fields (ADR 004 rule 6). Kept as a
  // supported legacy type next to `form`, with its own entitlement.
  'signup-form': define({
    version: 1,
    props: z.object({ formId: z.string().guid() }).strict(),
    fields: [{ key: 'formId', kind: 'reference', to: 'form' }],
    variants: {},
    localized: () => [],
    references: (p) => [{ type: 'form', refId: p.formId }],
    examples: [{ name: 'signup-form', props: { formId: EXAMPLE_IDS.form } }],
  }),
  'rich-text': define({
    version: 1,
    props: z.object({ content: localized(RichTextDoc) }).strict(),
    fields: [{ key: 'content', kind: 'rich-text' }],
    variants: {},
    localized: (p) => present(['content'], p.content),
    references: (p) => docRefs(p.content),
    examples: [
      {
        name: 'rich-text',
        props: {
          content: {
            nl: linkedDoc('Meer over ons werk staat in ', 'het jaarverslag', EXAMPLE_IDS.item),
            en: linkedDoc('More about our work is in ', 'the annual report', EXAMPLE_IDS.item),
          },
        },
      },
    ],
  }),
  // The teaser boundary of `access.teaser: 'marker'` (ADR 018 rule 6); it renders nothing.
  paywall: define({
    version: 1,
    props: z.object({}).strict(),
    fields: [],
    variants: {},
    localized: () => [],
    references: () => [],
    examples: [{ name: 'paywall', props: {} }],
  }),

  image: define({
    version: 1,
    props: ImageProps,
    fields: imageFieldsOf(IMAGE_LAYOUTS),
    variants: { layout: IMAGE_LAYOUTS },
    localized: (p) => imageFields([], p),
    references: (p) => [{ type: 'media', refId: p.mediaId }],
    examples: [
      { name: 'image-content', props: image },
      {
        name: 'image-wide-caption-credit',
        note: 'Caption and credit override the asset for this use.',
        props: {
          ...image,
          layout: 'wide',
          caption: { nl: 'Ruim tweeduizend mensen kwamen af op de oproep.', en: '' },
          credit: { work: null, photographer: 'Sam de Vries' },
        },
      },
      {
        name: 'image-full-decorative',
        note: 'Decorative: no alt text, the renderer writes alt="".',
        props: { mediaId: EXAMPLE_IDS.image, decorative: true, alt: null, layout: 'full' },
      },
      {
        name: 'image-float-left',
        props: { ...image, mediaId: EXAMPLE_IDS.portrait, layout: 'float-left' },
      },
      {
        name: 'image-float-right',
        props: {
          ...image,
          mediaId: EXAMPLE_IDS.portrait,
          layout: 'float-right',
          credit: { work: { title: 'Zonder titel', maker: 'R. Jansen' }, photographer: null },
        },
      },
    ],
  }),

  hero: define({
    version: 1,
    props: z
      .object({
        variant: z.enum(HERO_VARIANTS).default('minimal'),
        title: localized(ShortText),
        body: localized(BodyText).optional(),
        image: HeroImage.optional(),
        actions: z.array(Action).max(2).default([]),
        width: Width.default('full'),
        align: Align.default('start'),
      })
      .strict()
      // #8c renders cover text on a validated opaque theme surface, never straight on a photo.
      .refine((p) => p.variant === 'minimal' || p.image !== undefined, {
        path: ['image'],
        message: 'content.hero.image-required',
      }),
    fields: [
      choice('variant', HERO_VARIANTS),
      textField('title', { localized: true }),
      textField('body', { localized: true, multiline: true, optional: 'omit' }),
      { key: 'image', kind: 'group', optional: 'omit', fields: imageFieldsOf(['content']) },
      { key: 'actions', kind: 'actions', min: 0, max: 2 },
      choice('width', WIDTHS, 'full'),
      choice('align', ALIGNS),
    ],
    variants: { variant: HERO_VARIANTS, width: WIDTHS, align: ALIGNS },
    localized: (p) => [
      ...present(['title'], p.title),
      ...present(['body'], p.body),
      ...(p.image ? imageFields(['image'], p.image) : []),
      ...actionFields(p.actions),
    ],
    references: (p) => [
      ...(p.image ? [{ type: 'media' as const, refId: p.image.mediaId }] : []),
      ...actionRefs(p.actions),
    ],
    examples: [
      {
        name: 'hero-minimal',
        props: { title: { nl: 'Schone lucht voor iedereen', en: 'Clean air for everyone' } },
      },
      {
        name: 'hero-cover',
        props: {
          variant: 'cover',
          title: { nl: 'Schone lucht voor iedereen', en: 'Clean air for everyone' },
          body: {
            nl: 'Samen met tienduizend buren vragen we de gemeente om actie.',
            en: 'Together with ten thousand neighbours we ask the council to act.',
          },
          image: { ...image, caption: { nl: 'Op het Malieveld', en: 'On the Malieveld' } },
          actions: [signUp, readMore],
          align: 'center',
        },
      },
      {
        name: 'hero-split-long-label',
        props: {
          variant: 'split',
          title: { nl: 'Bouwen voor de buurt', en: 'Building for the neighbourhood' },
          image,
          actions: [longLabel],
          width: 'wide',
          align: 'end',
        },
      },
      {
        name: 'hero-minimal-content',
        props: {
          title: { nl: 'Nieuws', en: 'News' },
          width: 'content',
        },
      },
    ],
  }),

  cta: define({
    version: 1,
    props: z
      .object({
        variant: z.enum(CTA_VARIANTS).default('band'),
        title: localized(ShortText),
        body: localized(BodyText).optional(),
        actions: z.array(Action).min(1).max(2),
        width: Width.default('content'),
        align: Align.default('start'),
      })
      .strict(),
    fields: [
      choice('variant', CTA_VARIANTS),
      textField('title', { localized: true }),
      textField('body', { localized: true, multiline: true, optional: 'omit' }),
      { key: 'actions', kind: 'actions', min: 1, max: 2 },
      choice('width', WIDTHS),
      choice('align', ALIGNS),
    ],
    variants: { variant: CTA_VARIANTS, width: WIDTHS, align: ALIGNS },
    localized: (p) => [
      ...present(['title'], p.title),
      ...present(['body'], p.body),
      ...actionFields(p.actions),
    ],
    references: (p) => actionRefs(p.actions),
    examples: [
      {
        name: 'cta-band',
        props: {
          title: { nl: 'Doe mee', en: 'Join in' },
          body: { nl: 'Elke handtekening telt.', en: 'Every signature counts.' },
          actions: [signUp],
        },
      },
      {
        name: 'cta-card-two-actions',
        props: {
          variant: 'card',
          title: { nl: 'Steun ons werk', en: 'Support our work' },
          actions: [signUp, longLabel],
          width: 'wide',
          align: 'center',
        },
      },
      {
        name: 'cta-full-end',
        props: {
          title: { nl: 'Lees verder', en: 'Read on' },
          actions: [readMore],
          width: 'full',
          align: 'end',
        },
      },
    ],
  }),

  // Dreamkit's action cards in one block: the entries are props, as in `faq`; the number of columns
  // follows the width on offer, and `width: full` is the band. Rejected: a column count, which a
  // narrow container cannot honour, and a parent with child blocks, which would give every card
  // block operations nobody needs.
  cards: define({
    version: 1,
    props: z
      .object({
        accent: z.enum(CARDS_ACCENTS).default('none'),
        width: Width.default('wide'),
        cards: z
          .array(
            z
              .object({
                title: localized(ShortText),
                body: localized(BodyText).optional(),
                actions: z.array(Action).max(1).default([]),
              })
              .strict()
          )
          .min(2, 'content.cards.too-few')
          .max(6),
      })
      .strict(),
    fields: [
      {
        key: 'cards',
        kind: 'list',
        min: 2,
        max: 6,
        fields: [
          textField('title', { localized: true }),
          textField('body', { localized: true, multiline: true, optional: 'omit' }),
          { key: 'actions', kind: 'actions', min: 0, max: 1 },
        ],
      },
      choice('accent', CARDS_ACCENTS),
      choice('width', WIDTHS, 'wide'),
    ],
    variants: { accent: CARDS_ACCENTS, width: WIDTHS },
    localized: (p) =>
      p.cards.flatMap((c, i) => [
        ...present(['cards', i, 'title'], c.title),
        ...present(['cards', i, 'body'], c.body),
        ...c.actions.flatMap((a, j) => present(['cards', i, 'actions', j, 'label'], a.label)),
      ]),
    references: (p) => p.cards.flatMap((c) => actionRefs(c.actions)),
    examples: [
      {
        name: 'cards-three-links',
        props: { cards: [JOIN_CARD, VOLUNTEER_CARD, DONATE_CARD] },
      },
      {
        name: 'cards-bar-content',
        props: { accent: 'bar', width: 'content', cards: [JOIN_CARD, VOLUNTEER_CARD] },
      },
      {
        name: 'cards-filled-full',
        props: {
          accent: 'filled',
          width: 'full',
          cards: [JOIN_CARD, VOLUNTEER_CARD, DONATE_CARD, NO_LINK_CARD],
        },
      },
    ],
  }),

  // Dreamkit's file download, with the name of a file required and localised: readers get
  // "Annual report 2025", not `jr-2025-final-v3.pdf`, and the rest view can show it without a media
  // lookup. Rejected: falling back on the filename, which puts an internal name on the public site.
  // No width: a list of links reads best at the width of the text.
  'file-download': define({
    version: 1,
    props: z
      .object({
        title: localized(ShortText).optional(),
        body: localized(BodyText).optional(),
        files: z
          .array(
            z
              .object({
                fileId: z.string().guid('content.files.no-file'),
                name: localized(ShortText),
              })
              .strict()
          )
          .min(1, 'content.files.too-few')
          .max(FILE_DOWNLOAD_ROWS),
      })
      .strict(),
    fields: [
      textField('title', { localized: true, optional: 'omit' }),
      textField('body', { localized: true, multiline: true, optional: 'omit' }),
      {
        key: 'files',
        kind: 'list',
        min: 1,
        max: FILE_DOWNLOAD_ROWS,
        fields: [
          { key: 'fileId', kind: 'media', accept: 'document' },
          textField('name', { localized: true }),
        ],
      },
    ],
    variants: {},
    localized: (p) => [
      ...present(['title'], p.title),
      ...present(['body'], p.body),
      ...p.files.flatMap((f, i) => present(['files', i, 'name'], f.name)),
    ],
    references: (p) =>
      p.files.map((f) => ({ type: 'media' as const, refId: f.fileId, document: true as const })),
    examples: [
      {
        name: 'file-download-one',
        props: {
          files: [
            {
              fileId: EXAMPLE_IDS.document,
              name: { nl: 'Jaarverslag 2025', en: 'Annual report 2025' },
            },
          ],
        },
      },
      {
        name: 'file-download-titled',
        props: {
          title: { nl: 'Stukken bij deze zaak', en: 'Documents in this case' },
          body: {
            nl: 'Alle stukken die we openbaar hebben gekregen, met hun datum.',
            en: 'Every document we obtained publicly, with its date.',
          },
          files: [
            {
              fileId: EXAMPLE_IDS.document,
              name: { nl: 'Jaarverslag 2025', en: 'Annual report 2025' },
            },
            {
              fileId: EXAMPLE_IDS.document,
              name: { nl: 'Brief aan de gemeente', en: 'Letter to the municipality' },
            },
          ],
        },
      },
    ],
  }),

  // Dreamkit's carousel, without the library: `row` is a native scroll-snap row that works without
  // JavaScript, `grid` needs no scrolling at all. Each image is a use like the image block's, with
  // its own alt per locale. Rejected: PhotoSwipe's lightbox and thumbnails, a script and a dialog
  // for what a larger `width` already gives; autoplay, which WCAG 2.2.2 would have us let stop.
  gallery: define({
    version: 1,
    props: z
      .object({
        variant: z.enum(GALLERY_VARIANTS).default('grid'),
        width: Width.default('wide'),
        images: z
          .array(
            z
              .object({ ...IMAGE_USE, mediaId: z.string().guid('content.gallery.no-image') })
              .strict()
              .superRefine(altRule)
          )
          .min(2, 'content.gallery.too-few')
          .max(GALLERY_ROWS),
      })
      .strict(),
    fields: [
      { key: 'images', kind: 'list', min: 2, max: GALLERY_ROWS, fields: imageUseFields },
      choice('variant', GALLERY_VARIANTS),
      choice('width', WIDTHS, 'wide'),
    ],
    variants: { variant: GALLERY_VARIANTS, width: WIDTHS },
    localized: (p) => p.images.flatMap((image, i) => imageFields(['images', i], image)),
    references: (p) => p.images.map((image) => ({ type: 'media' as const, refId: image.mediaId })),
    examples: [
      {
        name: 'gallery-grid',
        props: {
          images: [image, { ...image, mediaId: EXAMPLE_IDS.portrait }],
        },
      },
      {
        name: 'gallery-row-content',
        props: {
          variant: 'row',
          width: 'content',
          images: [
            { ...image, caption: { nl: 'Op het plein.', en: 'On the square.' } },
            { mediaId: EXAMPLE_IDS.portrait, decorative: true, alt: null },
            { ...image, credit: { work: null, photographer: 'Sam de Vries' } },
          ],
        },
      },
      {
        name: 'gallery-grid-full',
        props: {
          width: 'full',
          images: [image, { ...image, mediaId: EXAMPLE_IDS.portrait }, image],
        },
      },
    ],
  }),

  // Dreamkit's audio player, without Plyr: the browser's own controls need no script and no styling
  // that can fail. A title is required because a player without a name says nothing to a screen
  // reader. Rejected: a captions file and a poster, which an audio element does not show; a switch
  // to hide the download, which hides nothing from a visitor who has the file playing; the podcast
  // feed and episode fields, which need an entity of their own (custom post types).
  audio: define({
    version: 1,
    props: z
      .object({
        title: localized(ShortText),
        fileId: z.string().uuid('content.audio.no-file'),
        transcript: localized(TranscriptText).optional(),
      })
      .strict(),
    fields: [
      textField('title', { localized: true }),
      { key: 'fileId', kind: 'media', accept: 'audio' },
      textField('transcript', { localized: true, multiline: true, optional: 'omit' }),
    ],
    variants: {},
    localized: (p) => [...present(['title'], p.title), ...present(['transcript'], p.transcript)],
    references: (p) => [{ type: 'media' as const, refId: p.fileId, audio: true as const }],
    examples: [
      {
        name: 'audio-plain',
        props: {
          title: { nl: 'Het gesprek met de raad', en: 'The talk with the council' },
          fileId: EXAMPLE_IDS.audio,
        },
      },
      {
        name: 'audio-transcript',
        props: {
          title: { nl: 'Het gesprek met de raad', en: 'The talk with the council' },
          fileId: EXAMPLE_IDS.audio,
          transcript: {
            nl: 'Goedemorgen.\nWe beginnen met de petitie.',
            en: 'Good morning.\nWe start with the petition.',
          },
        },
      },
    ],
  }),

  // Dreamkit's timeline, without the script. An event has a date, a title, a text and at most one
  // link, and the visitor gets all of them, sorted on the server. Rejected: Dreamkit's split into
  // upcoming and earlier steps with a "now" marker, which needs a script to correct cached HTML and
  // makes one revision's output depend on the day; folding each event, which hides the text for a
  // list that is at most 24 short entries. No width: a list of dates reads best at the text's width.
  timeline: define({
    version: 1,
    props: z
      .object({
        title: localized(ShortText).optional(),
        order: z.enum(TIMELINE_ORDERS).default('newest'),
        events: z
          .array(
            z
              .object({
                date: z.string().date('content.timeline.no-date'),
                title: localized(ShortText),
                body: localized(BodyText).optional(),
                actions: z.array(Action).max(1).default([]),
              })
              .strict()
          )
          .min(2, 'content.timeline.too-few')
          .max(TIMELINE_ROWS),
      })
      .strict(),
    fields: [
      textField('title', { localized: true, optional: 'omit' }),
      {
        key: 'events',
        kind: 'list',
        min: 2,
        max: TIMELINE_ROWS,
        fields: [
          { key: 'date', kind: 'date' },
          textField('title', { localized: true }),
          textField('body', { localized: true, multiline: true, optional: 'omit' }),
          { key: 'actions', kind: 'actions', min: 0, max: 1 },
        ],
      },
      choice('order', TIMELINE_ORDERS),
    ],
    variants: { order: TIMELINE_ORDERS },
    localized: (p) => [
      ...present(['title'], p.title),
      ...p.events.flatMap((e, i) => [
        ...present(['events', i, 'title'], e.title),
        ...present(['events', i, 'body'], e.body),
        ...e.actions.flatMap((a, j) => present(['events', i, 'actions', j, 'label'], a.label)),
      ]),
    ],
    references: (p) => p.events.flatMap((e) => actionRefs(e.actions)),
    examples: [
      {
        name: 'timeline-newest',
        props: {
          events: [
            { date: '2026-03-02', title: { nl: 'Petitie aangeboden', en: 'Petition handed over' } },
            { date: '2026-05-19', title: { nl: 'Debat in de raad', en: 'Debate in the council' } },
          ],
        },
      },
      {
        name: 'timeline-oldest-titled',
        props: {
          title: { nl: 'Hoe het ging', en: 'How it went' },
          order: 'oldest',
          events: [
            {
              date: '2026-05-19',
              title: { nl: 'Debat in de raad', en: 'Debate in the council' },
              body: {
                nl: 'De raad stemde over het voorstel.',
                en: 'The council voted on the proposal.',
              },
              actions: [signUp],
            },
            { date: '2026-03-02', title: { nl: 'Petitie aangeboden', en: 'Petition handed over' } },
            { date: '2026-05-19', title: { nl: 'Besluit gepubliceerd', en: 'Decision published' } },
          ],
        },
      },
    ],
  }),

  callout: define({
    version: 1,
    props: z
      .object({
        variant: z.enum(CALLOUT_VARIANTS).default('info'),
        title: localized(ShortText).optional(),
        body: localized(RichTextDoc),
      })
      .strict(),
    fields: [
      choice('variant', CALLOUT_VARIANTS),
      textField('title', { localized: true, optional: 'omit' }),
      { key: 'body', kind: 'rich-text' },
    ],
    variants: { variant: CALLOUT_VARIANTS },
    localized: (p) => [...present(['title'], p.title), ...present(['body'], p.body)],
    references: (p) => docRefs(p.body),
    examples: [
      {
        name: 'callout-info',
        props: {
          body: {
            nl: linkedDoc('De uitslag staat in ', 'ons verslag', EXAMPLE_IDS.item),
            en: linkedDoc('The outcome is in ', 'our report', EXAMPLE_IDS.item),
          },
        },
      },
      {
        name: 'callout-note',
        props: {
          variant: 'note',
          title: { nl: 'Let op', en: 'Note' },
          body: { nl: doc('Dit artikel is bijgewerkt.'), en: doc('This article was updated.') },
        },
      },
      {
        name: 'callout-warning',
        props: {
          variant: 'warning',
          title: { nl: 'Waarschuwing', en: 'Warning' },
          body: {
            nl: doc('Deel geen persoonsgegevens in de reacties.'),
            en: doc('Do not share personal data in the comments.'),
          },
        },
      },
    ],
  }),

  faq: define({
    version: 2,
    props: z
      .object({
        variant: z.enum(FAQ_VARIANTS).default('list'),
        width: Width.default('content'),
        title: localized(ShortText).optional(),
        // Entries are props, not blocks: no ids, no block operations on them.
        entries: z
          .array(
            z.object({ question: localized(ShortText), answer: localized(RichTextDoc) }).strict()
          )
          .min(1)
          .max(30),
      })
      .strict(),
    fields: [
      choice('variant', FAQ_VARIANTS),
      textField('title', { localized: true, optional: 'omit' }),
      {
        key: 'entries',
        kind: 'list',
        min: 1,
        max: 30,
        fields: [textField('question', { localized: true }), { key: 'answer', kind: 'rich-text' }],
      },
      choice('width', WIDTHS),
    ],
    variants: { variant: FAQ_VARIANTS, width: WIDTHS },
    localized: (p) => [
      ...present(['title'], p.title),
      ...p.entries.flatMap((e, i) => [
        ...present(['entries', i, 'question'], e.question),
        ...present(['entries', i, 'answer'], e.answer),
      ]),
    ],
    references: (p) => p.entries.flatMap((e) => docRefs(e.answer)),
    examples: [
      {
        name: 'faq-list',
        props: {
          title: { nl: 'Veelgestelde vragen', en: 'Frequently asked questions' },
          entries: [
            {
              question: { nl: 'Wat gebeurt er met mijn gegevens?', en: 'What happens to my data?' },
              answer: {
                nl: linkedDoc('Dat lees je in ', 'onze privacyverklaring', EXAMPLE_IDS.item),
                en: linkedDoc('See ', 'our privacy statement', EXAMPLE_IDS.item),
              },
            },
            {
              question: { nl: 'Kan ik me afmelden?', en: 'Can I unsubscribe?' },
              answer: { nl: doc('Ja, altijd.'), en: doc('Yes, at any time.') },
            },
          ],
        },
      },
      {
        name: 'faq-accordion',
        props: {
          variant: 'accordion',
          entries: [
            {
              question: { nl: 'Wanneer is de actie?', en: 'When is the action?' },
              answer: { nl: doc('Op zaterdag.'), en: doc('On Saturday.') },
            },
          ],
        },
      },
      ...(['list', 'accordion'] as const).flatMap((variant) =>
        (['wide', 'full'] as const).map((width) => ({
          name: `faq-${variant}-${width}`,
          props: {
            variant,
            width,
            title: { nl: 'Veelgestelde vragen', en: 'Frequently asked questions' },
            entries: [
              {
                question: {
                  nl:
                    width === 'full'
                      ? 'Wat gebeurt er met mijn gegevens als ik aan deze lange campagne meedoe en later mijn keuze wil aanpassen?'
                      : 'Wat gebeurt er met mijn gegevens?',
                  en:
                    width === 'full'
                      ? 'What happens to my information when I join this long campaign and later decide to change my choice?'
                      : 'What happens to my data?',
                },
                answer: {
                  nl: linkedDoc('Dat lees je in ', 'onze privacyverklaring', EXAMPLE_IDS.item),
                  en: linkedDoc('See ', 'our privacy statement', EXAMPLE_IDS.item),
                },
              },
            ],
          },
        }))
      ),
    ],
  }),

  quote: define({
    version: 1,
    props: z
      .object({
        text: localized(BodyText),
        attribution: z
          .object({
            // A proper name: the same in every locale.
            name: ShortText,
            role: localized(ShortText).optional(),
            source: localized(ShortText).optional(),
            url: WebUrl.optional(),
          })
          .strict(),
        variant: z.enum(QUOTE_VARIANTS).default('blockquote'),
        width: Width.default('content'),
      })
      .strict(),
    fields: [
      textField('text', { localized: true, multiline: true }),
      {
        key: 'attribution',
        kind: 'group',
        fields: [
          textField('name', { localized: false }),
          textField('role', { localized: true, optional: 'omit' }),
          textField('source', { localized: true, optional: 'omit' }),
          textField('url', { localized: false, optional: 'omit' }),
        ],
      },
      choice('variant', QUOTE_VARIANTS),
      choice('width', WIDTHS),
    ],
    variants: { variant: QUOTE_VARIANTS, width: WIDTHS },
    localized: (p) => [
      ...present(['text'], p.text),
      ...present(['attribution', 'role'], p.attribution.role),
      ...present(['attribution', 'source'], p.attribution.source),
    ],
    references: () => [],
    examples: [
      {
        name: 'quote-blockquote',
        props: {
          text: {
            nl: 'We wachten al tien jaar op een veilige oversteek.',
            en: 'We have been waiting ten years for a safe crossing.',
          },
          attribution: {
            name: 'Fatima el Amrani',
            role: { nl: 'buurtbewoner', en: 'local resident' },
          },
        },
      },
      {
        name: 'quote-pullquote-wide',
        props: {
          text: { nl: 'Dit is pas het begin.', en: 'This is only the beginning.' },
          attribution: {
            name: 'Jan de Boer',
            source: { nl: 'Het Parool, 3 mei', en: 'Het Parool, 3 May' },
            url: 'https://example.org/interview',
          },
          variant: 'pullquote',
          width: 'wide',
        },
      },
      {
        name: 'quote-full',
        props: {
          text: { nl: 'Samen staan we sterk.', en: 'Together we stand strong.' },
          attribution: { name: 'Kim Bakker' },
          width: 'full',
        },
      },
    ],
  }),

  // Never iframe HTML or an arbitrary URL: a provider and a bounded id. #8c starts from a plain
  // link to the provider and adds the embed only as an explicit enhancement; no oEmbed fetch.
  'video-embed': define({
    version: 1,
    props: z
      .object({
        provider: z.enum(VIDEO_PROVIDERS),
        videoId: z.string().min(1).max(20),
        title: localized(ShortText),
        caption: localized(CaptionText).optional(),
        width: Width.default('content'),
      })
      .strict()
      .refine(
        (p) =>
          p.provider === 'youtube'
            ? /^[A-Za-z0-9_-]{11}$/.test(p.videoId)
            : /^[0-9]{1,20}$/.test(p.videoId),
        { path: ['videoId'], message: 'content.video.id-invalid' }
      ),
    fields: [
      choice('provider', VIDEO_PROVIDERS),
      textField('videoId', { localized: false }),
      textField('title', { localized: true }),
      textField('caption', { localized: true, multiline: true, optional: 'omit' }),
      choice('width', WIDTHS),
    ],
    variants: { provider: VIDEO_PROVIDERS, width: WIDTHS },
    localized: (p) => [...present(['title'], p.title), ...present(['caption'], p.caption)],
    references: () => [],
    examples: [
      {
        name: 'video-youtube',
        props: {
          provider: 'youtube',
          videoId: 'dQw4w9WgXcQ',
          title: { nl: 'Verslag van de mars', en: 'Report of the march' },
        },
      },
      {
        name: 'video-vimeo-wide',
        props: {
          provider: 'vimeo',
          videoId: '76979871',
          title: { nl: 'Interview met de wethouder', en: 'Interview with the alderman' },
          caption: { nl: 'Opgenomen in maart.', en: 'Recorded in March.' },
          width: 'wide',
        },
      },
      {
        name: 'video-full',
        props: {
          provider: 'youtube',
          videoId: 'aqz-KE-bpKQ',
          title: { nl: 'Korte film', en: 'Short film' },
          width: 'full',
        },
      },
    ],
  }),

  // A reference to an existing form definition: no copied fields or consent texts, no second
  // form engine (ADR 004 rule 6).
  form: define({
    version: 1,
    props: z
      .object({
        formId: z.string().guid(),
        variant: z.enum(FORM_VARIANTS).default('default'),
        width: Width.default('content'),
      })
      .strict(),
    fields: [
      { key: 'formId', kind: 'reference', to: 'form' },
      choice('variant', FORM_VARIANTS),
      choice('width', WIDTHS),
    ],
    variants: { variant: FORM_VARIANTS, width: WIDTHS },
    localized: () => [],
    references: (p) => [{ type: 'form', refId: p.formId }],
    examples: [
      { name: 'form-default', props: { formId: EXAMPLE_IDS.form } },
      {
        name: 'form-card-wide',
        props: { formId: EXAMPLE_IDS.form, variant: 'card', width: 'wide' },
      },
      { name: 'form-full', props: { formId: EXAMPLE_IDS.form, width: 'full' } },
    ],
  }),
};
