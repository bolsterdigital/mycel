// The two default patterns of ADR 012 rule 8, long-read and photo-story, as pure factories that
// return a `PatternInput`. They are data like any pattern a tenant saves: `content.pattern.create`
// stores one with its own block ids and media usages, and applying it through
// `content.item.create` copies the blocks with fresh ids. The starter copy comes from the domain
// catalogs (ADR 007), one value per requested locale.
//
// A photo story needs real photos: the caller passes media ids of the tenant with their alt text
// or `decorative`, and the factory refuses to build one without a photo. Rejected: shipping a
// global example image in every tenant (an asset nobody uploaded, protected by nobody) and a
// placeholder media id (a pattern that can never be saved or applied).

import { t, type MessageKey } from '../i18n/index.js';
import { PatternInput } from './model.js';
import type { RichTextDoc } from './rich-text.js';

type Copy = Record<string, string>;

/** One catalog key in every locale. */
const copy = (locales: readonly string[], key: MessageKey): Copy =>
  Object.fromEntries(locales.map((l) => [l, t(l, key)]));

/** A rich-text value with one paragraph per key, in every locale. */
const prose = (locales: readonly string[], ...keys: MessageKey[]): Record<string, RichTextDoc> =>
  Object.fromEntries(
    locales.map((l) => [
      l,
      {
        type: 'doc' as const,
        content: keys.map((k) => ({
          type: 'paragraph' as const,
          content: [{ type: 'text' as const, text: t(l, k) }],
        })),
      },
    ])
  );

/** Prose, a pull quote, more prose: the opening of a long read. */
export function longReadPattern(locales: readonly string[] = ['nl', 'en']): PatternInput {
  return PatternInput.parse({
    name: copy(locales, 'patterns.long-read.name'),
    description: copy(locales, 'patterns.long-read.description'),
    intendedType: 'article',
    blocks: [
      {
        type: 'rich-text',
        version: 1,
        props: { content: prose(locales, 'patterns.long-read.intro', 'patterns.long-read.body') },
      },
      {
        type: 'quote',
        version: 1,
        props: {
          text: copy(locales, 'patterns.long-read.quote'),
          attribution: { name: t(locales[0] ?? 'en', 'patterns.long-read.quote-name') },
          variant: 'pullquote',
        },
      },
      {
        type: 'rich-text',
        version: 1,
        props: { content: prose(locales, 'patterns.long-read.body') },
      },
    ],
  });
}

/** One photo of a story: a media id of the tenant plus how this use describes it. */
export interface StoryPhoto {
  mediaId: string;
  decorative: boolean;
  /** Required unless decorative; one value per locale of the pattern. */
  alt: Record<string, string> | null;
  caption?: Record<string, string>;
}

/**
 * A cover hero with the first photo, then each further photo wide with a caption and a short
 * text in between. Throws without photos; alt text that does not fit the schema fails the parse,
 * so the result is always a valid pattern.
 */
export function photoStoryPattern(
  photos: readonly StoryPhoto[],
  locales: readonly string[] = ['nl', 'en']
): PatternInput {
  const [cover, ...rest] = photos;
  if (!cover) throw new Error('a photo story needs at least one photo');
  const use = (p: StoryPhoto) => ({
    mediaId: p.mediaId,
    decorative: p.decorative,
    alt: p.alt,
    ...(p.caption ? { caption: p.caption } : {}),
  });
  return PatternInput.parse({
    name: copy(locales, 'patterns.photo-story.name'),
    description: copy(locales, 'patterns.photo-story.description'),
    intendedType: 'article',
    blocks: [
      {
        type: 'hero',
        version: 1,
        props: {
          variant: 'cover',
          title: copy(locales, 'patterns.photo-story.title'),
          image: use(cover),
        },
      },
      {
        type: 'rich-text',
        version: 1,
        props: { content: prose(locales, 'patterns.photo-story.intro') },
      },
      ...rest.flatMap((p) => [
        { type: 'image', version: 1, props: { ...use(p), layout: 'wide' } },
        {
          type: 'rich-text',
          version: 1,
          props: { content: prose(locales, 'patterns.photo-story.between') },
        },
      ]),
    ],
  });
}
