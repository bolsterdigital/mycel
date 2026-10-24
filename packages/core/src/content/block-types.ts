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
  | { key: string; kind: 'media' }
  | { key: string; kind: 'reference'; to: 'form' | 'item' }
  | { key: string; kind: 'choice'; options: readonly string[] }
  | { key: string; kind: 'boolean' }
  | { key: string; kind: 'actions'; min: number; max: number }
  | { key: string; kind: 'group'; optional?: 'omit' | 'null'; fields: readonly BlockField[] }
  | { key: string; kind: 'list'; min: number; max: number; fields: readonly BlockField[] };

export interface BlockDefinition<S extends z.ZodTypeAny> {
  version: 1;
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

const define = <S extends z.ZodTypeAny>(d: BlockDefinition<S>): BlockDefinition<S> => d;

// Text bounds shared by the cards (brief #8b2 § 1).
const ShortText = z.string().min(1).max(200);
const BodyText = z.string().min(1).max(5000);
const CaptionText = z.string().max(2000);
const LabelText = z.string().min(1).max(100);

export const WIDTHS = ['content', 'wide', 'full'] as const;
export const ALIGNS = ['start', 'center', 'end'] as const;
export const IMAGE_LAYOUTS = ['content', 'wide', 'full', 'float-left', 'float-right'] as const;
export const HERO_VARIANTS = ['minimal', 'cover', 'split'] as const;
export const CTA_VARIANTS = ['band', 'card'] as const;
export const CALLOUT_VARIANTS = ['info', 'note', 'warning'] as const;
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

/**
 * The use of one image: the media id plus what belongs to this use and not to the file (alt,
 * decorative, caption and credit overrides; docs/reference/media.md). An absent caption or credit
 * inherits the asset's; an empty caption string hides it in that locale.
 */
function imageProps<L extends readonly [string, ...string[]]>(layouts: L) {
  return z
    .object({
      mediaId: z.string().guid(),
      decorative: z.boolean(),
      alt: localized(z.string().min(1).max(1000).regex(/\S/, 'content.image.alt-empty')).nullable(),
      caption: localized(CaptionText).optional(),
      credit: MediaCredit.optional(),
      layout: z.enum(layouts as unknown as [L[number], ...L[number][]]).default(layouts[0]),
    })
    .strict()
    .superRefine((p, ctx) => {
      if (p.decorative && p.alt !== null)
        ctx.addIssue({ code: 'custom', path: ['alt'], message: 'content.image.decorative-alt' });
      if (!p.decorative && p.alt === null)
        ctx.addIssue({ code: 'custom', path: ['alt'], message: 'content.image.alt-required' });
    });
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
const choice = (key: string, options: readonly string[]): BlockField => ({
  key,
  kind: 'choice',
  options,
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
const imageFieldsOf = (layouts: readonly string[]): BlockField[] => [
  { key: 'mediaId', kind: 'media' },
  { key: 'decorative', kind: 'boolean' },
  textField('alt', { localized: true, optional: 'null' }),
  { key: 'caption', kind: 'caption' },
  creditField,
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
  form: '01900000-0000-7000-8000-00000000f001',
  item: '01900000-0000-7000-8000-00000000c001',
  image: '01900000-0000-7000-8000-00000000d001',
  portrait: '01900000-0000-7000-8000-00000000d002',
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
      choice('width', WIDTHS),
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
    version: 1,
    props: z
      .object({
        variant: z.enum(FAQ_VARIANTS).default('list'),
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
    ],
    variants: { variant: FAQ_VARIANTS },
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
