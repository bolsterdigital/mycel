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

import { z } from 'zod';
import { Locale } from '../i18n/locale.js';
import { statusOf } from './lifecycle.js';
import { LocaleStatus, type ContentType } from './model.js';
import type { ItemRecord } from './ports.js';

export const ItemSort = z.enum(['created', 'updated', 'title']);
export type ItemSort = z.infer<typeof ItemSort>;

export const SortDirection = z.enum(['asc', 'desc']);
export type SortDirection = z.infer<typeof SortDirection>;

/** The most rows a list skips: far past any site's content, and a bound on the scan. */
export const MAX_LIST_OFFSET = 100_000;

/** The fields `content.item.list` takes to narrow and order its answer. */
export const itemListFields = {
  q: z.string().trim().min(1).max(100).optional(),
  locale: Locale.optional(),
  status: LocaleStatus.optional(),
  hasUnpublishedChanges: z.boolean().optional(),
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
}

export interface ItemOrder {
  by: ItemSort;
  direction: SortDirection;
}

/** Newest first for the two moments, A to Z for titles. */
export const defaultDirection = (by: ItemSort): SortDirection => (by === 'title' ? 'asc' : 'desc');

/** The title an item sorts under: in `locale`, else in its own default locale, else empty. */
export const sortTitle = (item: ItemRecord, locale?: string): string =>
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
