// The view of a content list (pages or articles): what the operator searched for, the one status
// shown, the order and the page. All of it is in the URL, so every view is a link, the browser's
// back button restores it and the list works without JavaScript. This module reads that URL into
// a view, writes a view back as the shortest query that means the same, and turns it into the
// input of `content.item.list`, where the matching and the ordering happen.
//
// The view an item was entered from is kept in a cookie scoped to the site's admin, so "back to
// the list" on that item returns to the search, filter, order and page the operator came from.
// It is written when an item opens with the list as its Referer (the admin sends the full URL
// to itself, `referrer-policy: same-origin`), and only if the value changes. The cookie then
// outlives the saves and redirects that follow; without a Referer the way back is what was kept
// before, or the plain list.
// Rejected: writing the cookie on a GET of the list. An admin page is `no-store`, and Chrome
// drops such a page from the back/forward cache when an HttpOnly cookie changes, so a look at a
// list cost an editor's unsaved rich text. Also rejected: the Referer as the only source (absent
// after a save and redirect), carrying the view through every editor URL and form (a dozen
// redirects would have to pass it on), and restoring the view on the menu link (a menu item
// that opens a filtered list hides content without saying why).
import { ContentType, defaultDirection, MAX_LIST_OFFSET, type useCases } from '@mycel/core';
import type { Cookies } from '@sveltejs/kit';
import type { z } from 'zod';

/** The states a list filters on: the four of a locale, and "published, changed since". */
export const LIST_STATUSES = ['draft', 'scheduled', 'published', 'changed', 'unpublished'] as const;
export type ListStatus = (typeof LIST_STATUSES)[number];

/** The columns a list sorts on. */
export const LIST_SORTS = ['title', 'updated'] as const;
export type ListSort = (typeof LIST_SORTS)[number];
type Direction = 'asc' | 'desc';

export const LIST_PAGE_SIZE = 20;
const DEFAULT_SORT: ListSort = 'updated';
const LAST_PAGE = Math.floor(MAX_LIST_OFFSET / LIST_PAGE_SIZE) + 1;

export interface ListView {
  q: string;
  status: ListStatus | null;
  sort: ListSort;
  dir: Direction;
  /** From 1. */
  page: number;
}

const oneOf = <T extends string>(all: readonly T[], raw: string | null): T | null =>
  all.find((value) => value === raw) ?? null;

/** The view a query asks for; anything it does not understand is the default. */
export function listViewFrom(params: URLSearchParams): ListView {
  const sort = oneOf(LIST_SORTS, params.get('sort')) ?? DEFAULT_SORT;
  const page = Number(params.get('page'));
  const q = (params.get('q') ?? '').trim().slice(0, 100);
  return {
    // A NUL is no search anyone typed, and core refuses it.
    q: q.includes('\0') ? '' : q,
    status: oneOf(LIST_STATUSES, params.get('status')),
    sort,
    dir: oneOf(['asc', 'desc'] as const, params.get('dir')) ?? defaultDirection(sort),
    page: Number.isInteger(page) && page >= 1 ? Math.min(page, LAST_PAGE) : 1,
  };
}

/** The view as query parameters, defaults left out: an untouched list has none. */
export function listParams(view: ListView): URLSearchParams {
  const params = new URLSearchParams();
  if (view.q) params.set('q', view.q);
  if (view.status) params.set('status', view.status);
  if (view.sort !== DEFAULT_SORT) params.set('sort', view.sort);
  if (view.dir !== defaultDirection(view.sort)) params.set('dir', view.dir);
  if (view.page > 1) params.set('page', String(view.page));
  return params;
}

/** Whether the view narrows the list: a search or a status, whatever the order and page. */
export const isFiltered = (view: ListView): boolean => Boolean(view.q || view.status);

/** The list of one type in a view, as an admin path. */
export function listPath(tenant: string, type: ContentType, view?: ListView): string {
  const params = new URLSearchParams({ type });
  if (view) for (const [key, value] of listParams(view)) params.set(key, value);
  return `/admin/${tenant}/content?${params}`;
}

/** What the view asks of `content.item.list`, with the content locale its status is read in. */
export function listInput(
  view: ListView,
  type: ContentType,
  locale: string
): z.input<typeof useCases.listItems.input> {
  return {
    type,
    locale,
    ...(view.q ? { q: view.q } : {}),
    ...(view.status === 'changed'
      ? { hasUnpublishedChanges: true }
      : view.status
        ? { status: view.status }
        : {}),
    sort: view.sort,
    direction: view.dir,
    offset: (view.page - 1) * LIST_PAGE_SIZE,
    limit: LIST_PAGE_SIZE,
  };
}

const cookieOf = (type: ContentType) => `mycel-content-list-${type}`;
/** A working day: tomorrow the list opens as it is, not as it was left. */
const REMEMBERED_SECONDS = 60 * 60 * 12;

/** The view in a Referer, if that is this site's list of this type on this origin. */
function viewInReferer(
  referer: string | null,
  url: URL,
  tenant: string,
  type: ContentType
): ListView | null {
  if (!referer || !URL.canParse(referer)) return null;
  const from = new URL(referer);
  if (from.origin !== url.origin || from.pathname !== `/admin/${tenant}/content`) return null;
  // What the list itself reads: no `type` is the list of pages.
  const listed = ContentType.safeParse(from.searchParams.get('type')).data ?? 'page';
  return listed === type ? listViewFrom(from.searchParams) : null;
}

/**
 * Keeps the view an item is entered from, for the way back; entered from the untouched list, it
 * forgets the last one. Anything else (a save, a link from elsewhere, no Referer) changes nothing.
 */
export function rememberListFromReferer(
  cookies: Cookies,
  referer: string | null,
  url: URL,
  tenant: string,
  type: ContentType
): void {
  const view = viewInReferer(referer, url, tenant, type);
  if (!view) return;
  const path = `/admin/${tenant}`;
  const query = listParams(view).toString();
  const kept = cookies.get(cookieOf(type));
  if (kept === query || (!query && kept === undefined)) return;
  if (!query) {
    cookies.delete(cookieOf(type), { path });
    return;
  }
  cookies.set(cookieOf(type), query, {
    path,
    httpOnly: true,
    sameSite: 'lax',
    maxAge: REMEMBERED_SECONDS,
  });
}

/**
 * The list an item goes back to: the view it was entered from, at the item's own row. The
 * cookie is read through `listViewFrom`, so whatever it holds comes out as a view or as none.
 */
export function recalledListPath(
  cookies: Cookies,
  tenant: string,
  type: ContentType,
  itemId: string
): string {
  const kept = cookies.get(cookieOf(type));
  const view = kept ? listViewFrom(new URLSearchParams(kept)) : undefined;
  return `${listPath(tenant, type, view)}#item-${itemId}`;
}
