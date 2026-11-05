// What a content list can ask beyond a type and a slug: a search, the publication state of one
// locale, an order and a position. An overview in the admin and an agent ask the same questions,
// so they are fields of `content.item.list`, and the rules live here once: the memory adapter
// runs these functions as written, the Postgres adapter states the same rules in SQL, and one
// scenario in `packages/db/src/adapter-rules.test.ts` holds the two to one answer.
//
// Titles order by the Unicode root collation (`Intl.Collator('und')` here, `und-x-icu` in
// Postgres), so "Één" sorts with the e's on every installation whatever its database locale.
// Rejected: filtering and sorting in the admin route (a page of twenty cannot be searched or
// sorted from outside the store), a second use case for searching, and the database's default
// collation for titles (glibc, musl and ICU order a space and an accent differently, so the
// adapters would disagree).
//
// Author, section and tag read the latest revision: the first two through its references, a tag
// from the document, because tags are strings without a reference row (ADR 012 rule 3). Where a
// translation stands cannot be said in SQL: it is `readinessIssues` over the block registry. So
// `translation` is the one filter core applies itself, walking the other filters' matches a batch
// at a time (`service.ts`), which is why both adapters agree on it without a scenario holding them
// together. Rejected: a stored state per revision, which needs a backfill the SQL-only migration
// runner cannot compute, and which a rare filter on a multilingual site does not yet justify.

import { z } from 'zod';
import { Locale } from '../i18n/locale.js';
import { statusOf } from './lifecycle.js';
import {
  canonicalTag,
  LocaleStatus,
  readinessIssues,
  type ContentDocument,
  type ContentType,
} from './model.js';
import type { ItemRecord } from './ports.js';
import type { TransactionContext } from '../ports.js';

export const ItemSort = z.enum(['created', 'updated', 'title']);
export type ItemSort = z.infer<typeof ItemSort>;

export const SortDirection = z.enum(['asc', 'desc']);
export type SortDirection = z.infer<typeof SortDirection>;

/** The most rows a list skips: far past any site's content, and a bound on the scan. */
export const MAX_LIST_OFFSET = 100_000;

/** The fields `content.item.list` takes to narrow and order its answer. */
export const itemListFields = {
  // A NUL is no search anyone typed, and Postgres refuses it in a parameter: a 400, not a 500.
  q: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .refine((q) => !q.includes('\0'))
    .optional(),
  locale: Locale.optional(),
  status: LocaleStatus.optional(),
  hasUnpublishedChanges: z.boolean().optional(),
  authorId: z.string().guid().optional(),
  sectionId: z.string().guid().optional(),
  // A filter, not a stored tag: a tag no article can have just finds nothing.
  tag: z
    .string()
    .trim()
    .min(1)
    .max(50)
    .refine((tag) => !tag.includes('\0'))
    .transform(canonicalTag)
    .optional(),
  updatedFrom: z.string().datetime({ offset: true }).optional(),
  updatedBefore: z.string().datetime({ offset: true }).optional(),
  translation: z
    .object({
      state: z.enum(['behind', 'missing']),
      locales: z.array(Locale).min(1).max(50),
    })
    .optional(),
  sort: ItemSort.optional(),
  direction: SortDirection.optional(),
  offset: z.number().int().min(0).max(MAX_LIST_OFFSET).optional(),
};

export interface ItemFilter {
  type?: ContentType | undefined;
  slug?: string | undefined;
  /** Contained, whatever the case, in the slug or in the title of any locale. */
  q?: string | undefined;
  /** The locale `status`, `hasUnpublishedChanges` and a title order look at; else the item's default. */
  locale?: string | undefined;
  status?: LocaleStatus | undefined;
  /** Live with a newer revision that is not (true), or any other state of the locale (false). */
  hasUnpublishedChanges?: boolean | undefined;
  /** In the latest revision, like the three that follow; only an article has them. */
  authorId?: string | undefined;
  sectionId?: string | undefined;
  /** Canonical (`canonicalTag`). */
  tag?: string | undefined;
  /** Last saved at or after this moment. */
  updatedFrom?: Date | undefined;
  /** Last saved before this moment. */
  updatedBefore?: Date | undefined;
}

export type TranslationState = 'ok' | 'behind' | 'missing';

/**
 * Where a translation stands: `missing` when the document lacks the locale, `behind` when a field
 * that another locale has is empty in it (`readinessIssues`, `missing-translation`), else `ok`.
 */
export function translationState(doc: ContentDocument, locale: string): TranslationState {
  if (!doc.locales.includes(locale)) return 'missing';
  return readinessIssues(doc, locale).some(
    (i) => i.message === 'content.publish.missing-translation'
  )
    ? 'behind'
    : 'ok';
}

/**
 * The latest documents a list reads, and a log line for each row it must show without one. An
 * overview renders nothing from the document, so that row stays and its own edit screen says what
 * is wrong; the line is how an operator finds the row before anyone opens it. Rejected: throwing,
 * which let one stored document take the list, the dashboard and every edit screen's pickers down
 * until someone repaired it in SQL.
 */
export async function listedDocuments(
  ctx: Pick<TransactionContext, 'content' | 'log'>,
  rows: readonly { id: string }[]
): Promise<Map<string, ContentDocument>> {
  const documents = await ctx.content.latestDocuments(rows.map((r) => r.id));
  for (const { id } of rows) {
    if (!documents.has(id)) ctx.log.warn('content.list.document_unreadable', { itemId: id });
  }
  return documents;
}

/** What a list says per locale the document has; a locale it lacks is missing by absence. */
export const listedTranslations = (doc: ContentDocument): Record<string, 'ok' | 'behind'> =>
  Object.fromEntries(
    doc.locales.map((l) => [l, translationState(doc, l) === 'behind' ? 'behind' : 'ok'])
  );

/** The `translation` filter: the state in at least one of these locales. */
export interface TranslationFilter {
  state: 'behind' | 'missing';
  locales: string[];
}

export const matchesTranslation = (doc: ContentDocument, filter: TranslationFilter): boolean =>
  filter.locales.some((locale) => translationState(doc, locale) === filter.state);

/** The filter's questions about the latest revision, as the memory adapter asks them. */
export function matchesItemDocument(doc: ContentDocument, filter: ItemFilter): boolean {
  if (!filter.authorId && !filter.sectionId && !filter.tag) return true;
  if (doc.type !== 'article') return false;
  if (filter.authorId && !doc.authorIds.includes(filter.authorId)) return false;
  if (filter.sectionId && doc.sectionId !== filter.sectionId) return false;
  return !filter.tag || doc.tags.includes(filter.tag);
}

export interface ItemOrder {
  by: ItemSort;
  direction: SortDirection;
}

/** Newest first for the two moments, A to Z for titles. */
export const defaultDirection = (by: ItemSort): SortDirection => (by === 'title' ? 'asc' : 'desc');

/** The title an item sorts under: in `locale`, else in its own default locale, else empty. */
const sortTitle = (item: ItemRecord, locale?: string): string =>
  (locale ? item.title[locale] : undefined) ?? item.title[item.defaultLocale] ?? '';

export function matchesItemFilter(item: ItemRecord, filter: ItemFilter): boolean {
  if (filter.type && item.type !== filter.type) return false;
  if (filter.slug && item.slug !== filter.slug) return false;
  if (filter.q) {
    const needle = filter.q.toLowerCase();
    const found = [item.slug, ...Object.values(item.title)].some((text) =>
      text.toLowerCase().includes(needle)
    );
    if (!found) return false;
  }
  if (filter.updatedFrom && item.updatedAt < filter.updatedFrom) return false;
  if (filter.updatedBefore && item.updatedAt >= filter.updatedBefore) return false;
  if (filter.status === undefined && filter.hasUnpublishedChanges === undefined) return true;
  const state = item.publication.find((s) => s.locale === (filter.locale ?? item.defaultLocale));
  // An item without the locale has no publication state there, so no state matches it.
  if (!state) return false;
  if (filter.status && statusOf(state) !== filter.status) return false;
  if (filter.hasUnpublishedChanges !== undefined) {
    const changed =
      state.publishedRevisionId !== null && state.publishedRevisionId !== item.latestRevisionId;
    if (changed !== filter.hasUnpublishedChanges) return false;
  }
  return true;
}

const titles = new Intl.Collator('und');

/**
 * Orders two items: negative when `a` comes first. Ties fall to the id in the same direction, so
 * every order is total and a position in it is stable.
 */
export function compareItems(
  order: ItemOrder,
  locale?: string
): (a: ItemRecord, b: ItemRecord) => number {
  const sign = order.direction === 'asc' ? 1 : -1;
  const byId = (a: ItemRecord, b: ItemRecord) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  return (a, b) => {
    const first =
      order.by === 'title'
        ? titles.compare(sortTitle(a, locale), sortTitle(b, locale))
        : order.by === 'updated'
          ? a.updatedAt.getTime() - b.updatedAt.getTime()
          : 0;
    return sign * (first || byId(a, b));
  };
}
