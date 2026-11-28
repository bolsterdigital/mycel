// The filters and counts of the site search (MY-308 PR 2): kind, section and period narrow the
// hits, the sort orders them, and the facets say how many hits each kind and each section holds.
//
// One rule for every adapter, here. A hit's kind follows from its type and the article's
// presentation profile (`searchKind`), its section from the revision (`SearchEntry.sectionId`),
// its period from the publication date the result shows. A facet counts the hits of the same
// question under every other filter: the kinds ignore the kind filter and the sections ignore the
// section filter, so each count says what one click on that facet would show. The period has no
// count, it narrows them all. The memory adapter folds `searchFacetsOf` over its hits, Postgres
// states the same in one grouping query over the same matching rows as the list, so a count
// never says more than the list holds, except for a hit the use case drops at its second access
// decision.
//
// A period is a moment before now: seven days, a calendar month, a calendar year, in UTC.
// Rejected: a calendar week or month in the site's time zone (a visitor at 00:30 on the 1st sees
// a nearly empty "this month"), and a date range in the address (a form with two date fields is
// a task, a choice of three is a click).
//
// Rejected: counts per period (the three overlap, so their sum says nothing, and a fourth
// grouping per search for a number that rarely decides anything), and counting in the use case
// from a full read of every hit (the list reads one page, a count would read them all).

import { z } from 'zod';

export const SearchKind = z.enum(['page', 'article', 'media']);
export type SearchKind = z.infer<typeof SearchKind>;
export const SEARCH_KINDS = SearchKind.options;

export const SearchPeriod = z.enum(['week', 'month', 'year']);
export type SearchPeriod = z.infer<typeof SearchPeriod>;

/** `best`: title hits first, then the newest publication; `newest`: the newest publication. */
export const SearchSort = z.enum(['best', 'newest']);
export type SearchSort = z.infer<typeof SearchSort>;

/** What a hit is for the filters; `profile` is the article's presentation profile. */
export function searchKind(type: 'page' | 'article', profile: string | null): SearchKind {
  if (type === 'page') return 'page';
  return profile === 'media' ? 'media' : 'article';
}

/** The narrowing an adapter applies: every field it holds, the facets as `searchFacetsOf` says. */
export interface SearchFilter {
  kind?: SearchKind | undefined;
  sectionId?: string | undefined;
  /** Published at or after this moment. */
  since?: Date | undefined;
}

/**
 * The first moment of a period ending now. A month or year back keeps the day of the month where
 * the target month has it and takes its last day otherwise (31 March to 28 February), so a month
 * is never shorter than the calendar says.
 */
export function searchSince(period: SearchPeriod, now: Date): Date {
  if (period === 'week') return new Date(now.getTime() - 7 * 86_400_000);
  const months = period === 'month' ? 1 : 12;
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth() - months;
  const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const at = new Date(now.getTime());
  at.setUTCFullYear(year, month, Math.min(now.getUTCDate(), last));
  return at;
}

/** The facet fields of one matching hit. */
export interface FacetRow {
  kind: SearchKind;
  sectionId: string | null;
  publishedAt: Date;
}

/** Whether a hit passes `filter`, leaving out the facet named in `ignore`. */
export function passesSearchFilter(
  row: FacetRow,
  filter: SearchFilter,
  ignore?: 'kind' | 'section'
): boolean {
  if (filter.since && row.publishedAt.getTime() < filter.since.getTime()) return false;
  if (ignore !== 'kind' && filter.kind && row.kind !== filter.kind) return false;
  if (ignore !== 'section' && filter.sectionId && row.sectionId !== filter.sectionId) return false;
  return true;
}

/** How many hits each kind and each section holds; a section without hits is absent. */
export interface SearchFacets {
  kinds: Record<SearchKind, number>;
  sections: { sectionId: string; count: number }[];
}

/** The facets of the matching hits, as the Postgres grouping states them. */
export function searchFacetsOf(rows: readonly FacetRow[], filter: SearchFilter): SearchFacets {
  const kinds: Record<SearchKind, number> = { page: 0, article: 0, media: 0 };
  const sections = new Map<string, number>();
  for (const row of rows) {
    if (passesSearchFilter(row, filter, 'kind')) kinds[row.kind] += 1;
    if (row.sectionId && passesSearchFilter(row, filter, 'section'))
      sections.set(row.sectionId, (sections.get(row.sectionId) ?? 0) + 1);
  }
  return {
    kinds,
    sections: [...sections].map(([sectionId, count]) => ({ sectionId, count })).sort(bySection),
  };
}

/** The order an adapter returns sections in, so both give the same list. */
export const bySection = (a: { sectionId: string }, b: { sectionId: string }) =>
  a.sectionId < b.sectionId ? -1 : a.sectionId > b.sectionId ? 1 : 0;

/** The hits the list shows under `filter`: the kind count of the chosen kind, or all kinds. */
export function searchTotal(facets: SearchFacets, kind: SearchKind | undefined): number {
  return kind ? facets.kinds[kind] : SEARCH_KINDS.reduce((n, k) => n + facets.kinds[k], 0);
}
