import { describe, expect, it } from 'vitest';
import {
  passesSearchFilter,
  searchFacetsOf,
  searchKind,
  searchSince,
  searchTotal,
  type FacetRow,
} from './search-facets.js';

describe('search facets', () => {
  it('names a page, an article and a Video/audio article apart', () => {
    expect(searchKind('page', null)).toBe('page');
    expect(searchKind('article', null)).toBe('article');
    expect(searchKind('article', 'longread')).toBe('article');
    expect(searchKind('article', 'media')).toBe('media');
  });

  it('goes back a week, a calendar month and a calendar year, in UTC', () => {
    const at = (iso: string, period: 'week' | 'month' | 'year') =>
      searchSince(period, new Date(iso)).toISOString();
    expect(at('2026-11-28T10:00:00.000Z', 'week')).toBe('2026-11-21T10:00:00.000Z');
    expect(at('2026-11-28T10:00:00.000Z', 'month')).toBe('2026-10-28T10:00:00.000Z');
    expect(at('2026-01-15T10:00:00.000Z', 'month')).toBe('2025-12-15T10:00:00.000Z');
    // The last day of a shorter month, not a day that overflows into the next one.
    expect(at('2026-03-31T10:00:00.000Z', 'month')).toBe('2026-02-28T10:00:00.000Z');
    expect(at('2028-02-29T10:00:00.000Z', 'year')).toBe('2027-02-28T10:00:00.000Z');
    expect(at('2026-11-28T10:00:00.000Z', 'year')).toBe('2025-11-28T10:00:00.000Z');
  });

  const day = (d: number) => new Date(Date.UTC(2026, 10, d));
  const rows: FacetRow[] = [
    { kind: 'page', sectionId: null, publishedAt: day(1) },
    { kind: 'article', sectionId: 'a', publishedAt: day(2) },
    { kind: 'article', sectionId: 'b', publishedAt: day(20) },
    { kind: 'media', sectionId: 'a', publishedAt: day(21) },
  ];

  it('counts each facet under every other filter, and the period under all', () => {
    expect(searchFacetsOf(rows, {})).toEqual({
      kinds: { page: 1, article: 2, media: 1 },
      sections: [
        { sectionId: 'a', count: 2 },
        { sectionId: 'b', count: 1 },
      ],
    });
    const filter = { kind: 'article' as const, sectionId: 'a', since: day(2) };
    const facets = searchFacetsOf(rows, filter);
    expect(facets).toEqual({
      kinds: { page: 0, article: 1, media: 1 },
      sections: [
        { sectionId: 'a', count: 1 },
        { sectionId: 'b', count: 1 },
      ],
    });
    expect(searchTotal(facets, 'article')).toBe(1);
    expect(searchTotal(facets, undefined)).toBe(2);
    expect(rows.filter((r) => passesSearchFilter(r, filter)).length).toBe(1);
  });
});
