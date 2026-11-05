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
//
// The columns and the page size are a person's way of reading, not a view of the content: kept in
// a cookie per site and type that only the choice itself (a POST) writes, so a look at a list
// writes nothing. A query may still name them, for one link, and then they travel with that view.
// Rejected: `localStorage` (the admin renders on the server, so the table would flash and the
// choice would need JavaScript), and an operator preference in `mycel_auth`, which the brief's
// "per person, in the browser" does not ask for.
import {
  canonicalTag,
  ContentType,
  defaultDirection,
  isUuid,
  MAX_LIST_OFFSET,
  MAX_PAGE_SIZE,
  type useCases,
} from '@mycel/core';
import type { Cookies } from '@sveltejs/kit';
import type { z } from 'zod';
import { keepListQuery } from '../admin/list-memory.js';
import { fromLocalInput } from './content-admin-publication.js';

/** The states a list filters on: the four of a locale, and "published, changed since". */
export const LIST_STATUSES = ['draft', 'scheduled', 'published', 'changed', 'unpublished'] as const;
export type ListStatus = (typeof LIST_STATUSES)[number];

/** The columns a list sorts on. */
export const LIST_SORTS = ['title', 'updated', 'created'] as const;
export type ListSort = (typeof LIST_SORTS)[number];
type Direction = 'asc' | 'desc';

/** Where a translation in another of the site's locales stands. */
export const LIST_TRANSLATIONS = ['behind', 'missing'] as const;
export type ListTranslation = (typeof LIST_TRANSLATIONS)[number];

/** The columns beside the title, which always stays. In this order, whatever the choice's. */
export const LIST_COLUMNS = [
  'status',
  'author',
  'section',
  'tags',
  'slug',
  'created',
  'updated',
] as const;
export type ListColumn = (typeof LIST_COLUMNS)[number];
const ARTICLE_ONLY: readonly ListColumn[] = ['author', 'section', 'tags'];
const DEFAULT_COLUMNS: readonly ListColumn[] = ['status', 'updated'];

/** The columns a type has: a page has no authors, section or tags (ADR 012). */
export const columnsOf = (type: ContentType): ListColumn[] =>
  LIST_COLUMNS.filter((column) => type === 'article' || !ARTICLE_ONLY.includes(column));

export const LIST_PAGE_SIZES = [20, 50, MAX_PAGE_SIZE] as const;
export const LIST_PAGE_SIZE = LIST_PAGE_SIZES[0];
const DEFAULT_SORT: ListSort = 'updated';
const LAST_PAGE = Math.floor(MAX_LIST_OFFSET / LIST_PAGE_SIZE) + 1;

export interface ListView {
  q: string;
  status: ListStatus | null;
  /** An author id; only an article has one, like the section and the tag. */
  author: string | null;
  section: string | null;
  /** Canonical, or empty. */
  tag: string;
  /** Last saved from this day, in the admin's zone, as `YYYY-MM-DD`; or empty. */
  from: string;
  /** Last saved up to and including this day; or empty. */
  to: string;
  translation: ListTranslation | null;
  sort: ListSort;
  dir: Direction;
  /** From 1. */
  page: number;
  /** Named by the query for this view; null follows the person's choice. */
  columns: ListColumn[] | null;
  per: number | null;
}

/** What a list shows: the view's own columns and size, else the person's, else the default. */
export interface ListDisplay {
  columns: ListColumn[];
  per: number;
}

const oneOf = <T extends string>(all: readonly T[], raw: string | null): T | null =>
  all.find((value) => value === raw) ?? null;

const uuid = (raw: string | null): string | null => (raw && isUuid(raw) ? raw : null);

/** A real calendar day as `YYYY-MM-DD`, or empty. */
function day(raw: string | null): string {
  if (!raw || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return '';
  const at = new Date(`${raw}T00:00:00Z`);
  return !Number.isNaN(at.getTime()) && at.toISOString().startsWith(raw) ? raw : '';
}

function columnsFrom(raw: string | null, type: ContentType): ListColumn[] | null {
  if (raw === null) return null;
  const named = raw.split(',');
  return columnsOf(type).filter((column) => named.includes(column));
}

function perFrom(raw: string | null): number | null {
  return LIST_PAGE_SIZES.find((size) => String(size) === raw) ?? null;
}

/** The view a query asks for; anything it does not understand is the default. */
export function listViewFrom(params: URLSearchParams, type: ContentType): ListView {
  const sort = oneOf(LIST_SORTS, params.get('sort')) ?? DEFAULT_SORT;
  const page = Number(params.get('page'));
  const q = (params.get('q') ?? '').trim().slice(0, 100);
  const article = type === 'article';
  const tag = canonicalTag(params.get('tag') ?? '').slice(0, 50);
  return {
    // A NUL is no search anyone typed, and core refuses it.
    q: q.includes('\0') ? '' : q,
    status: oneOf(LIST_STATUSES, params.get('status')),
    author: article ? uuid(params.get('author')) : null,
    section: article ? uuid(params.get('section')) : null,
    tag: article && !tag.includes('\0') ? tag : '',
    from: day(params.get('from')),
    to: day(params.get('to')),
    translation: oneOf(LIST_TRANSLATIONS, params.get('translation')),
    sort,
    dir: oneOf(['asc', 'desc'] as const, params.get('dir')) ?? defaultDirection(sort),
    page: Number.isInteger(page) && page >= 1 ? Math.min(page, LAST_PAGE) : 1,
    columns: columnsFrom(params.get('columns'), type),
    per: perFrom(params.get('per')),
  };
}

/** The view as query parameters, defaults left out: an untouched list has none. */
export function listParams(view: ListView): URLSearchParams {
  const params = new URLSearchParams();
  for (const name of ['q', 'status', 'author', 'section', 'tag', 'from', 'to'] as const) {
    const value = view[name];
    if (value) params.set(name, value);
  }
  if (view.translation) params.set('translation', view.translation);
  if (view.sort !== DEFAULT_SORT) params.set('sort', view.sort);
  if (view.dir !== defaultDirection(view.sort)) params.set('dir', view.dir);
  if (view.page > 1) params.set('page', String(view.page));
  if (view.columns) params.set('columns', view.columns.join(','));
  if (view.per) params.set('per', String(view.per));
  return params;
}

/** No filter at all: what "clear filters" leaves of a view, order and display included. */
export const NO_FILTERS = {
  q: '',
  status: null,
  author: null,
  section: null,
  tag: '',
  from: '',
  to: '',
  translation: null,
} as const satisfies Partial<ListView>;

/** Whether the view narrows the list, whatever the order, the page and the display. */
export const isFiltered = (view: ListView): boolean =>
  (Object.keys(NO_FILTERS) as (keyof typeof NO_FILTERS)[]).some((name) => Boolean(view[name]));

/** One filter of a view, removable on its own. */
export interface ListChip {
  name: keyof typeof NO_FILTERS;
  value: string;
}

/** The view's filters, in the order the form asks them. */
export const listChips = (view: ListView): ListChip[] =>
  (Object.keys(NO_FILTERS) as (keyof typeof NO_FILTERS)[]).flatMap((name) => {
    const value = view[name];
    return value ? [{ name, value }] : [];
  });

/** The list of one type in a view, as an admin path. */
export function listPath(tenant: string, type: ContentType, view?: ListView): string {
  const params = new URLSearchParams({ type });
  if (view) for (const [key, value] of listParams(view)) params.set(key, value);
  return `/admin/${tenant}/content?${params}`;
}

/** The first moment of the day after `day`, in `zone`. */
function endOf(day: string, zone: string): Date | null {
  const next = new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  return fromLocalInput(`${next}T00:00`, zone);
}

/**
 * What the view asks of `content.item.list`: its status read in the content `locale`, its days in
 * the admin's `zone`, a translation looked for in the site's `others` locales.
 */
export function listInput(
  view: ListView,
  type: ContentType,
  locale: string,
  { per, zone, others }: { per: number; zone: string; others: readonly string[] }
): z.input<typeof useCases.listItems.input> {
  const from = view.from ? fromLocalInput(`${view.from}T00:00`, zone) : null;
  const before = view.to ? endOf(view.to, zone) : null;
  return {
    type,
    locale,
    ...(view.q ? { q: view.q } : {}),
    ...(view.status === 'changed'
      ? { hasUnpublishedChanges: true }
      : view.status
        ? { status: view.status }
        : {}),
    ...(view.author ? { authorId: view.author } : {}),
    ...(view.section ? { sectionId: view.section } : {}),
    ...(view.tag ? { tag: view.tag } : {}),
    ...(from ? { updatedFrom: from.toISOString() } : {}),
    ...(before ? { updatedBefore: before.toISOString() } : {}),
    ...(view.translation && others.length
      ? { translation: { state: view.translation, locales: [...others] } }
      : {}),
    sort: view.sort,
    direction: view.dir,
    offset: Math.min((view.page - 1) * per, MAX_LIST_OFFSET),
    limit: per,
  };
}

const displayCookieOf = (type: ContentType) => `mycel-content-display-${type}`;

/** What this list shows: the view's own columns and size, else the person's, else the default. */
export function listDisplay(cookies: Cookies, view: ListView, type: ContentType): ListDisplay {
  const kept = new URLSearchParams(cookies.get(displayCookieOf(type)) ?? '');
  return {
    columns:
      view.columns ??
      columnsFrom(kept.get('columns'), type) ??
      DEFAULT_COLUMNS.filter((column) => columnsOf(type).includes(column)),
    per: view.per ?? perFrom(kept.get('per')) ?? LIST_PAGE_SIZE,
  };
}

/**
 * Keeps a person's choice of columns and page size for this site and type, a year. Only the choice
 * itself writes it. A changed HttpOnly cookie drops a `no-store` page from Chrome's back/forward
 * cache, so an editor left with unsaved text behind this list reloads; that took a deliberate
 * choice after the editor's own leave warning, unlike a look at a list (see the top of this file).
 */
export function chooseListDisplay(
  cookies: Cookies,
  tenant: string,
  type: ContentType,
  form: FormData
): void {
  const named = form.getAll('column').map(String);
  const columns = columnsOf(type).filter((column) => named.includes(column));
  const per = perFrom(String(form.get('per'))) ?? LIST_PAGE_SIZE;
  cookies.set(displayCookieOf(type), `columns=${columns.join(',')}&per=${per}`, {
    path: `/admin/${tenant}`,
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 60 * 60 * 24 * 365,
  });
}

const cookieOf = (type: ContentType) => `mycel-content-list-${type}`;

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
  return listed === type ? listViewFrom(from.searchParams, type) : null;
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
  keepListQuery(cookies, cookieOf(type), tenant, listParams(view).toString());
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
  const view = kept ? listViewFrom(new URLSearchParams(kept), type) : undefined;
  return `${listPath(tenant, type, view)}#item-${itemId}`;
}
