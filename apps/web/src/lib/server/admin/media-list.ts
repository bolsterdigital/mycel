// The view of the media library: what the operator searched for, the one type and the one need
// shown, the order, the layout and the page. All of it is in the URL, on the rules of a content
// list (`content/content-list.ts`): every view is a link, and this module reads a URL into a view,
// writes a view back as the shortest query that means the same, and turns it into the input of
// `media.list`, where the matching and the ordering happen.
//
// "Unused" and "alt missing" are one choice: a file without a use has no use to lack alt text, so
// the two never hold together and two fields would offer an empty list. The order is one value too,
// because a form has to name a direction with it and a second select for that reads worse than
// "Newest first". Rejected: the content list's kept columns and page size, which nobody asked of a
// library that opens as a grid.
import { MAX_LIST_OFFSET, type useCases } from '@mycel/core';
import type { Cookies } from '@sveltejs/kit';
import type { z } from 'zod';
import { keepListQuery } from './list-memory.js';

export const MEDIA_KINDS = ['image', 'document', 'audio'] as const;
export type MediaListKind = (typeof MEDIA_KINDS)[number];

export const MEDIA_SHOWS = ['unused', 'no-alt'] as const;
export type MediaListShow = (typeof MEDIA_SHOWS)[number];

export const MEDIA_ORDERS = [
  'created-desc',
  'created-asc',
  'name-asc',
  'name-desc',
  'size-desc',
  'size-asc',
] as const;
export type MediaListOrder = (typeof MEDIA_ORDERS)[number];
const DEFAULT_ORDER: MediaListOrder = 'created-desc';

export const MEDIA_PAGE_SIZE = 50;
const LAST_PAGE = Math.floor(MAX_LIST_OFFSET / MEDIA_PAGE_SIZE) + 1;

export interface MediaListView {
  q: string;
  kind: MediaListKind | null;
  show: MediaListShow | null;
  order: MediaListOrder;
  /** The two halves of `order`, for the table's headings and the use case. */
  sort: 'created' | 'name' | 'size';
  dir: 'asc' | 'desc';
  layout: 'grid' | 'list';
  /** From 1. */
  page: number;
}

const oneOf = <T extends string>(all: readonly T[], raw: string | null): T | null =>
  all.find((value) => value === raw) ?? null;

const withOrder = <V extends { order: MediaListOrder }>(view: V) => {
  const [sort, dir] = view.order.split('-') as [MediaListView['sort'], MediaListView['dir']];
  return { ...view, sort, dir };
};

/** The view a query asks for; anything it does not understand is the default. */
export function mediaListViewFrom(params: URLSearchParams): MediaListView {
  const q = (params.get('q') ?? '').trim().slice(0, 100);
  const page = Number(params.get('page'));
  return withOrder({
    // A NUL is no search anyone typed, and core refuses it.
    q: q.includes('\0') ? '' : q,
    kind: oneOf(MEDIA_KINDS, params.get('kind')),
    show: oneOf(MEDIA_SHOWS, params.get('show')),
    order: oneOf(MEDIA_ORDERS, params.get('sort')) ?? DEFAULT_ORDER,
    layout: params.get('view') === 'list' ? ('list' as const) : ('grid' as const),
    page: Number.isInteger(page) && page >= 1 ? Math.min(page, LAST_PAGE) : 1,
  });
}

/** The view as query parameters, defaults left out: an untouched library has none. */
export function mediaListParams(view: Omit<MediaListView, 'sort' | 'dir'>): URLSearchParams {
  const params = new URLSearchParams();
  if (view.q) params.set('q', view.q);
  if (view.kind) params.set('kind', view.kind);
  if (view.show) params.set('show', view.show);
  if (view.order !== DEFAULT_ORDER) params.set('sort', view.order);
  if (view.layout === 'list') params.set('view', 'list');
  if (view.page > 1) params.set('page', String(view.page));
  return params;
}

/** No filter at all: what "clear filters" leaves of a view, order and layout included. */
export const MEDIA_NO_FILTERS = { q: '', kind: null, show: null } as const;

export const mediaFiltered = (view: MediaListView): boolean =>
  Boolean(view.q || view.kind || view.show);

/** The view's filters, in the order the form asks them. */
export const mediaChips = (
  view: MediaListView
): { name: keyof typeof MEDIA_NO_FILTERS; value: string }[] =>
  (['q', 'kind', 'show'] as const).flatMap((name) => {
    const value = view[name];
    return value ? [{ name, value }] : [];
  });

/** The library in a view, as an admin path. */
export function mediaListPath(
  tenant: string,
  view?: Omit<MediaListView, 'sort' | 'dir'>,
  done?: string
): string {
  const params = view ? mediaListParams(view) : new URLSearchParams();
  if (done) params.set('done', done);
  const query = params.toString();
  return `/admin/${tenant}/media${query ? `?${query}` : ''}`;
}

/** What the view asks of `media.list`. */
export function mediaListInput(view: MediaListView): z.input<typeof useCases.listMedia.input> {
  return {
    ...(view.q ? { q: view.q } : {}),
    ...(view.kind ? { kind: view.kind } : {}),
    ...(view.show === 'unused' ? { unused: true } : {}),
    ...(view.show === 'no-alt' ? { missingAlt: true } : {}),
    sort: view.sort,
    direction: view.dir,
    offset: Math.min((view.page - 1) * MEDIA_PAGE_SIZE, MAX_LIST_OFFSET),
    limit: MEDIA_PAGE_SIZE,
  };
}

const COOKIE = 'mycel-media-list';

/**
 * Keeps the view an asset is entered from, for the way back; entered from the untouched library, it
 * forgets the last one. Anything else (a save, a link from elsewhere, no Referer) changes nothing.
 */
export function rememberMediaListFromReferer(
  cookies: Cookies,
  referer: string | null,
  url: URL,
  tenant: string
): void {
  if (!referer || !URL.canParse(referer)) return;
  const from = new URL(referer);
  if (from.origin !== url.origin || from.pathname !== `/admin/${tenant}/media`) return;
  const query = mediaListParams(mediaListViewFrom(from.searchParams)).toString();
  keepListQuery(cookies, COOKIE, tenant, query);
}

/**
 * The library an asset goes back to: the view it was entered from, at the asset's own place when
 * it still has one. The cookie is read through `mediaListViewFrom`, so whatever it holds comes out
 * as a view or as none.
 */
export function recalledMediaPath(
  cookies: Cookies,
  tenant: string,
  mediaId: string | null,
  done?: string
): string {
  const kept = cookies.get(COOKIE);
  const view = kept ? mediaListViewFrom(new URLSearchParams(kept)) : undefined;
  return `${mediaListPath(tenant, view, done)}${mediaId ? `#media-${mediaId}` : ''}`;
}
