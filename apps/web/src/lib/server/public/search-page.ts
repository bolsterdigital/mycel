// The site search (`/search?q=`): one GET form and server-rendered results from
// `content.published.find`, which finds published, indexable locales as far as the principal may
// read them and takes title and excerpt from the live revision (a restricted item's teaser unless
// the reader has access). This adapter turns the result into links, dates and page links, and a
// `restricted` result into the same "members" label an overview card shows; it decides nothing
// about access.
//
// The reader: a request that carries the reader cookie searches as the reader the core finds
// behind it (`readerOfRequest`), and its answer is `personal`, as on a restricted item's page:
// no ETag, and the route sends it `private, no-store`. Without the cookie the page is the
// visitor's and public as before; every answer varies on the cookie, so a cache never hands a
// reader's results to a visitor or the reverse. Rejected: resolving a reader for every search
// (a session read per anonymous question) and a reader's result in a shared cache (it holds
// excerpts from bodies only that reader may read).
//
// Input: `q` is trimmed, its whitespace folded and cut at MAX_SEARCH_QUERY, so an overlong
// address still answers (the form field has the same maxlength); `page` is 1 to MAX_SEARCH_PAGE,
// anything else is a 404 rather than a silent first page, so a crawler that invents numbers gets
// nowhere. Rejected: a 400 for an overlong `q` (a pasted sentence is a visitor's mistake, not an
// attack, and the cut is what the use case would search anyway).
//
// A result is the shared article card (MY-308, `ArticleCard`): the card image resolved as on an
// author's page (decorative, the title beside it is the one link), one line of facts (the
// section, else the kind, which a Video/audio card's play mark already says; then the date, the
// recording and "members"), then the marked excerpt. A hit in a recording lists its moments, each
// a link to the item at that second (`?t=`, MY-305); when only the recording carries the
// question, the moments stand in place of the excerpt, which would show a line without its time.
//
// Filters (MY-308 PR 2) are GET parameters of the same form: `kind`, `section` (a slug),
// `period` and `sort`. An empty value is no filter, so the form can submit "all" as it is; any
// other value the use case does not know, and a section that names none, is a 404 like a page
// out of range. Each kind is a link that keeps the other filters, the section and period are
// selects, the active filters are links that remove one, and every link drops `page`: a new
// filter starts at the first page. The counts are the use case's, so this file adds none.
//
// Cost (anonymous, so the route bounds it): ten results a page, at most twenty pages, at most
// eight tokens of two or more characters (core's `queryTokens`). Each result reads its revision
// once more, so a page is one index query plus at most ten revision reads. A visitor's response is
// public and cached like a content page; results hold nothing a cached content page does not.
// Measured (2026-11-14, 100 sites of 1,000 items plus one of 20,000, two locales, 250 words a
// body): Postgres reads the asking site's rows through the primary key, whose first column the
// RLS condition fixes, and filters them; the GIN index over every site is not chosen, so a short
// prefix never walks another site's words. A query costs about 20 ms on a site of 1,000 items
// and 120 to 300 ms on one of 20,000, rising with the size of that site only.
import { createHash } from 'node:crypto';
import type { Cookies } from '@sveltejs/kit';
import {
  anonymousPrincipal,
  contentPath,
  MAX_SEARCH_PAGE,
  MAX_SEARCH_QUERY,
  SEARCH_KINDS,
  SearchKind,
  SearchPeriod,
  SearchSort,
  Slug,
  UseCaseError,
  useCases,
  type PublishedSearchResult,
} from '@mycel/core';
import { cardRecording, clockTime, isoDuration } from '../../blocks/recording.js';
import { resolveIntro, runtimeSource } from '../../blocks/resolve.js';
import { plural, ui } from '../../../i18n/index.js';
import { languageLinks } from '../../public/language-links.js';
import { searchPath } from '../../public/search-path.js';
import { refuse } from '../http/refuse.js';
import { runtime } from '../runtime.js';
import { sitePath, siteTenant, siteUrls, type Site } from '../site.js';
import { cardPlaceholder } from './chrome.js';
import { READER_COOKIE, readerOfRequest } from './reader.js';
import { siteBrand, siteChrome, siteNavigation, siteTheme } from './theme.js';

/** Results per page; the use case allows up to 20. */
export const SEARCH_PAGE_SIZE = 10;

/** The question as the route searches it: trimmed, single-spaced, at most MAX_SEARCH_QUERY. */
export function searchQuery(raw: string | null): string {
  return (raw ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_SEARCH_QUERY).trim();
}

/** The page number of `?page=`, or null when it is not one a visitor can ask for. */
export function searchPage(raw: string | null): number | null {
  if (raw === null) return 1;
  if (!/^[1-9]\d{0,1}$/.test(raw)) return null;
  const page = Number(raw);
  return page <= MAX_SEARCH_PAGE ? page : null;
}

/** The filters of the address; null when one holds a value no visitor can choose. */
export function searchFilters(params: URLSearchParams) {
  const value = <T>(name: string, schema: { safeParse(v: unknown): { success: boolean } }) => {
    const raw = params.get(name);
    if (!raw) return { ok: true, value: undefined };
    return schema.safeParse(raw).success
      ? { ok: true, value: raw as T }
      : { ok: false, value: undefined };
  };
  const kind = value<SearchKind>('kind', SearchKind);
  const section = value<string>('section', Slug);
  const period = value<SearchPeriod>('period', SearchPeriod);
  const sort = value<SearchSort>('sort', SearchSort);
  if (!kind.ok || !section.ok || !period.ok || !sort.ok) return null;
  return {
    kind: kind.value,
    section: section.value,
    period: period.value,
    sort: sort.value ?? ('best' as const),
  };
}
type SearchFilters = NonNullable<ReturnType<typeof searchFilters>>;

export async function loadSearchPage(site: Site, locale: string, url: URL, cookies: Cookies) {
  const q = searchQuery(url.searchParams.get('q'));
  const page = searchPage(url.searchParams.get('page'));
  const filters = searchFilters(url.searchParams);
  if (page === null || !filters || (page > 1 && !q)) refuse(404);
  const { invoker, uow } = runtime();
  const reader = anonymousPrincipal(siteTenant(site), ['content:read']);
  const personal = cookies.get(READER_COOKIE) !== undefined;
  const asker = (personal && (await readerOfRequest(cookies, site))) || reader;
  const { defaultLocale } = site.tenant;
  const empty = { kinds: { page: 0, article: 0, media: 0 }, sections: [] };
  const result = q
    ? await invoker
        .run(useCases.findPublished, asker, {
          q,
          locale,
          page,
          limit: SEARCH_PAGE_SIZE,
          ...filters,
        })
        .catch((error: unknown) => {
          // A section slug that names no section of this site.
          if (error instanceof UseCaseError && error.code === 'not_found') refuse(404);
          throw error;
        })
    : { items: [], next: null, total: 0, facets: empty };
  // A page past the last result is not a page, like an offset past a profile's articles.
  if (page > 1 && !result.items.length) refuse(404);
  const timeZone = (await invoker.run(useCases.getSiteGeneral, reader, {})).value.timeZone;
  const date = new Intl.DateTimeFormat(locale, { dateStyle: 'long', timeZone });
  const action = sitePath(site, searchPath(locale, defaultLocale));
  // An address of this search with some filters changed; defaults and empty values left out.
  const query = (over: Partial<SearchFilters> = {}, n = 1) => {
    const f = { ...filters, ...over };
    const params = new URLSearchParams({ q });
    for (const key of ['kind', 'section', 'period'] as const) {
      const v = f[key];
      if (v) params.set(key, v);
    }
    if (f.sort !== 'best') params.set('sort', f.sort);
    if (n > 1) params.set('page', String(n));
    return params;
  };
  const href = (over: Partial<SearchFilters> = {}, n = 1) => `${action}?${query(over, n)}`;
  const pageHref = (n: number) => href({}, n);
  const absolute = await siteUrls(site);
  const t = ui(locale);
  const source = runtimeSource({
    invoker,
    uow,
    reader: anonymousPrincipal(siteTenant(site), ['content:read', 'media:read']),
    defaultLocale,
  });
  const image = async (item: PublishedSearchResult) =>
    item.imageId
      ? (
          await resolveIntro(
            source,
            {
              lead: null,
              heroImageId: item.imageId,
              heroAlt: null,
              heroPlacement: item.imagePlacement,
            },
            locale
          )
        ).hero
      : null;
  const card = async (item: PublishedSearchResult) => {
    const href = sitePath(site, contentPath(item, locale, defaultLocale));
    const recording = cardRecording(item.recording, locale);
    const onlyMoments = item.foundIn === 'recording' && item.moments.length > 0;
    return {
      id: item.id,
      href,
      title: item.title,
      // The section names an article best; the kind otherwise, unless the play mark says it.
      label:
        item.section?.name ??
        (item.kind === 'media' && recording ? null : t(`public.search.kind.${item.kind}`)),
      excerpt: onlyMoments ? [] : item.excerpt,
      date: { iso: item.publishedAt, label: date.format(new Date(item.publishedAt)) },
      image: await image(item),
      recording,
      restricted: item.restricted,
      moments: item.moments.map((m) => ({
        href: `${href}?t=${m.seconds}`,
        time: { iso: isoDuration(m.seconds), label: clockTime(m.seconds) },
        segments: m.segments,
      })),
    };
  };
  const kindLabel = (k: SearchKind) => t(`public.search.filter.kind.${k}`);
  const sectionName =
    result.facets.sections.find((x) => x.slug === filters.section)?.name ?? filters.section;
  const filtered = Boolean(filters.kind || filters.section || filters.period);
  const all = SEARCH_KINDS.reduce((n, k) => n + result.facets.kinds[k], 0);
  const filterView = {
    filtered,
    count: q ? plural(t, 'public.search.count', result.total, { q }) : null,
    kinds: [
      { value: null, label: t('public.search.filter.kind.all'), count: all },
      ...SEARCH_KINDS.map((k) => ({
        value: k,
        label: kindLabel(k),
        count: result.facets.kinds[k],
      })),
    ]
      // A kind without hits is no click worth offering, unless it is the one chosen.
      .filter((k) => k.value === null || k.count > 0 || k.value === filters.kind)
      .map((k) => ({
        label: `${k.label} (${k.count})`,
        href: href({ kind: k.value ?? undefined }),
        current: (k.value ?? undefined) === filters.kind,
      })),
    kind: filters.kind ?? null,
    sections: result.facets.sections.map((x) => ({
      value: x.slug,
      label: `${x.name} (${x.count})`,
      selected: x.slug === filters.section,
    })),
    periods: (['', ...SearchPeriod.options] as const).map((p) => ({
      value: p,
      label: t(`public.search.filter.period.${p || 'all'}`),
      selected: p === (filters.period ?? ''),
    })),
    sorts: SearchSort.options.map((v) => ({
      value: v,
      label: t(`public.search.sort.${v}`),
      selected: v === filters.sort,
    })),
    // Each active filter as a link to the same search without it.
    chips: [
      ...(filters.kind
        ? [{ label: kindLabel(filters.kind), href: href({ kind: undefined }) }]
        : []),
      ...(filters.section
        ? [{ label: sectionName ?? '', href: href({ section: undefined }) }]
        : []),
      ...(filters.period
        ? [
            {
              label: t(`public.search.filter.period.${filters.period}`),
              href: href({ period: undefined }),
            },
          ]
        : []),
    ],
    clear: filtered ? href({ kind: undefined, section: undefined, period: undefined }) : null,
  };
  const view = {
    navigationLanguages: languageLinks(
      site.tenant.locales.map((l) => ({
        hreflang: l,
        href: `${sitePath(site, searchPath(l, defaultLocale))}${q ? `?${query()}` : ''}`,
      }))
    ),
    q,
    ...filterView,
    page,
    start: (page - 1) * SEARCH_PAGE_SIZE + 1,
    action,
    locale,
    results: await Promise.all(result.items.map(card)),
    base: sitePath(site, ''),
    placeholder: await cardPlaceholder(site, sitePath(site, '')),
    previous: page > 1 ? pageHref(page - 1) : null,
    next: result.next ? pageHref(result.next) : null,
    // A search page is never a canonical answer: it points at the empty form of its locale.
    canonical: absolute(searchPath(locale, defaultLocale)),
  };
  // The layout around the results is part of the response, as on a profile page: a change of
  // theme, menu or brand must not be confirmed by a 304 for the old page.
  const [theme, chrome, navigation, brand] = await Promise.all([
    siteTheme(site),
    siteChrome(site),
    siteNavigation(site, locale),
    siteBrand(site),
  ]);
  const digest = createHash('sha256')
    .update(
      JSON.stringify({ view, theme: theme.hash, chrome, navigation, brand, access: site.access })
    )
    .digest('base64url');
  return { view, etag: personal ? null : `"search:${digest}"` };
}
