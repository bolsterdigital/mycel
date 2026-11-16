// An overview fills itself: the newest or oldest published articles or pages, filtered by
// section and tags, or the upcoming or past events (pages with the `event` profile), with
// up to six pinned items on top. The block stores a filter, never a copy
// of the list, so a new article appears without republishing the page that holds the block; the
// list is read when the page is (`content/published/overview.ts`). Section and tags exist on
// articles only, so a page source carries neither. In a file of its own because the registry
// file stands at its size ceiling. Rejected: a collection table with its own revisions and
// publication (kept for reusable selections) and a limit as a free number (the no-JS form
// has no number field; a choice of 1 to 24 is the same range). An agenda orders by the start, so
// `order` does not apply to it: upcoming runs soonest first, past most recent first, the order a
// visitor reads either in. Rejected: "upcoming" stored on the item (it changes without an edit).
import { z } from 'zod';
import type { BlockDefinition, WIDTHS } from '../block-types.js';
import { EXAMPLE_IDS } from './example-ids.js';

export const OVERVIEW_SOURCES = ['article', 'page', 'event'] as const;
/** Which events an agenda lists, decided when the page is read (`content/published/overview.ts`). */
export const OVERVIEW_WHEN = ['upcoming', 'past'] as const;
export const OVERVIEW_LAYOUTS = ['cards', 'list'] as const;
export const OVERVIEW_ORDERS = ['newest', 'oldest'] as const;
/** 1 to 24, as strings: a choice in the no-JS form. */
export const OVERVIEW_LIMITS = Array.from({ length: 24 }, (_, i) => String(i + 1)) as [
  string,
  ...string[],
];
export const OVERVIEW_MAX_PINS = 6;
export const OVERVIEW_MAX_TAGS = 5;
const OVERVIEW_WIDTHS: typeof WIDTHS = ['content', 'wide', 'full'];

export const OverviewProps = z
  .object({
    source: z.enum(OVERVIEW_SOURCES).default('article'),
    sectionId: z.string().guid().nullable().default(null),
    /** Every tag must be on an article; compared in canonical form (`canonicalTag`). */
    tags: z
      .array(z.object({ tag: z.string().trim().min(1).max(50) }).strict())
      .max(OVERVIEW_MAX_TAGS)
      .default([]),
    /** Events only; ignored for another source. */
    when: z.enum(OVERVIEW_WHEN).default('upcoming'),
    order: z.enum(OVERVIEW_ORDERS).default('newest'),
    limit: z.enum(OVERVIEW_LIMITS).default('6'),
    pinned: z
      .array(z.object({ itemId: z.string().guid() }).strict())
      .max(OVERVIEW_MAX_PINS)
      .default([]),
    layout: z.enum(OVERVIEW_LAYOUTS).default('cards'),
    /** A plain "older" link to `?p=2` on the same page, without JavaScript. */
    archive: z.boolean().default(false),
    width: z.enum(OVERVIEW_WIDTHS).default('wide'),
  })
  .strict()
  .refine(
    (p) => p.source === 'article' || (p.sectionId === null && p.tags.length === 0),
    'content.overview.filter-article-only'
  )
  .refine(
    (p) => new Set(p.pinned.map((v) => v.itemId)).size === p.pinned.length,
    'content.overview.pin-duplicate'
  );
export type OverviewProps = z.infer<typeof OverviewProps>;

export const overviewDefinition: BlockDefinition<typeof OverviewProps, 1> = {
  version: 1,
  props: OverviewProps,
  fields: [
    { key: 'source', kind: 'choice', options: OVERVIEW_SOURCES },
    { key: 'sectionId', kind: 'reference', to: 'section', optional: 'null' },
    {
      key: 'tags',
      kind: 'list',
      min: 0,
      max: OVERVIEW_MAX_TAGS,
      fields: [{ key: 'tag', kind: 'text', localized: false }],
    },
    { key: 'when', kind: 'choice', options: OVERVIEW_WHEN },
    { key: 'order', kind: 'choice', options: OVERVIEW_ORDERS },
    { key: 'limit', kind: 'choice', options: OVERVIEW_LIMITS, initial: '6' },
    {
      key: 'pinned',
      kind: 'list',
      min: 0,
      max: OVERVIEW_MAX_PINS,
      fields: [{ key: 'itemId', kind: 'reference', to: 'item' }],
    },
    { key: 'layout', kind: 'choice', options: OVERVIEW_LAYOUTS },
    { key: 'archive', kind: 'boolean' },
    { key: 'width', kind: 'choice', options: OVERVIEW_WIDTHS, initial: 'wide' },
  ],
  variants: {
    source: OVERVIEW_SOURCES,
    when: OVERVIEW_WHEN,
    order: OVERVIEW_ORDERS,
    layout: OVERVIEW_LAYOUTS,
    width: OVERVIEW_WIDTHS,
  },
  localized: () => [],
  references: (p) => [
    ...(p.sectionId ? [{ type: 'section' as const, refId: p.sectionId }] : []),
    ...p.pinned.map(({ itemId }) => ({ type: 'item' as const, refId: itemId })),
  ],
  examples: [
    {
      name: 'overview-articles-cards',
      note: 'The newest articles of one section, one pinned on top, with an older link.',
      props: {
        sectionId: EXAMPLE_IDS.section,
        pinned: [{ itemId: EXAMPLE_IDS.item }],
        limit: '3',
        archive: true,
      },
    },
    {
      name: 'overview-articles-list',
      props: { order: 'oldest', layout: 'list', width: 'content' },
    },
    { name: 'overview-pages-full', props: { source: 'page', limit: '4', width: 'full' } },
    {
      name: 'overview-events-upcoming',
      note: 'An agenda: the next events, soonest first, with when and where on each card.',
      props: { source: 'event', limit: '3' },
    },
    {
      name: 'overview-events-past-list',
      props: { source: 'event', when: 'past', layout: 'list', width: 'content' },
    },
  ],
};
