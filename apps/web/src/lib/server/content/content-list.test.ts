// The view of a content list (#79): a query reads into a view whatever it holds, a view writes
// back as the shortest query that means the same, the view asks `content.item.list` for exactly
// what it shows, and the way back from an item is the view last seen, or the plain list.

import { describe, expect, it } from 'vitest';
import type { Cookies } from '@sveltejs/kit';
import {
  listInput,
  listParams,
  listPath,
  listViewFrom,
  recalledListPath,
  rememberList,
} from './content-list.js';

const view = (query: string) => listViewFrom(new URLSearchParams(query));
const ITEM = '01900000-0000-7000-8000-000000000001';

/** A cookie jar that records what a response would set. */
function jar(initial: Record<string, string> = {}) {
  const held = new Map(Object.entries(initial));
  const calls: string[] = [];
  const cookies = {
    get: (name: string) => held.get(name),
    set: (name: string, value: string, options: { path: string }) => {
      held.set(name, value);
      calls.push(`set ${name} ${options.path}`);
    },
    delete: (name: string, options: { path: string }) => {
      held.delete(name);
      calls.push(`delete ${name} ${options.path}`);
    },
  } as unknown as Cookies;
  return { cookies, held, calls };
}

describe('listViewFrom', () => {
  it('is the last saved first, unfiltered, on page one without a query', () => {
    expect(view('type=page')).toEqual({
      q: '',
      status: null,
      sort: 'updated',
      dir: 'desc',
      page: 1,
    });
  });

  it('reads a search, a status, an order and a page', () => {
    expect(view('q=+buurt+&status=changed&sort=title&dir=desc&page=3')).toEqual({
      q: 'buurt',
      status: 'changed',
      sort: 'title',
      dir: 'desc',
      page: 3,
    });
    // A title sorts from A, a moment from the newest, unless the query says otherwise.
    expect(view('sort=title').dir).toBe('asc');
    expect(view('sort=updated&dir=asc').dir).toBe('asc');
  });

  it('takes what it does not understand as the default', () => {
    expect(view('status=live&sort=slug&dir=up&page=0')).toEqual(view(''));
    expect(view('page=2.5').page).toBe(1);
    expect(view('page=-4').page).toBe(1);
    expect(view('page=99999999').page).toBe(5001);
    expect(view(`q=${'a'.repeat(300)}`).q).toHaveLength(100);
  });
});

describe('listParams and listPath', () => {
  it('leave out every default, so an untouched list has no query of its own', () => {
    expect(listParams(view('sort=updated&dir=desc&page=1&status=')).toString()).toBe('');
    expect(listParams(view('sort=title&dir=asc')).toString()).toBe('sort=title');
    expect(listPath('probe', 'article')).toBe('/admin/probe/content?type=article');
  });

  it('write a view in one order, encoded', () => {
    expect(listPath('probe', 'page', view('page=2&dir=asc&status=draft&q=a%26b c'))).toBe(
      '/admin/probe/content?type=page&q=a%26b+c&status=draft&dir=asc&page=2'
    );
  });
});

describe('listInput', () => {
  it('asks for the page of twenty the view shows, in the content locale', () => {
    expect(listInput(view('q=buurt&status=draft&page=3'), 'article', 'en')).toEqual({
      type: 'article',
      locale: 'en',
      q: 'buurt',
      status: 'draft',
      sort: 'updated',
      direction: 'desc',
      offset: 40,
      limit: 20,
    });
  });

  it('asks for "changed" as published with changes, not as a status', () => {
    const input = listInput(view('status=changed'), 'page', 'nl');
    expect(input).toMatchObject({ hasUnpublishedChanges: true });
    expect(input).not.toHaveProperty('status');
    expect(input).not.toHaveProperty('q');
  });
});

describe('the way back from an item', () => {
  it('is the view last seen for that type, at the row of the item', () => {
    const { cookies, calls } = jar();
    rememberList(cookies, 'probe', 'article', view('q=buurt&sort=title&page=2'));
    expect(calls).toEqual(['set mycel-content-list-article /admin/probe']);
    expect(recalledListPath(cookies, 'probe', 'article', ITEM)).toBe(
      `/admin/probe/content?type=article&q=buurt&sort=title&page=2#item-${ITEM}`
    );
    // Pages keep their own view.
    expect(recalledListPath(cookies, 'probe', 'page', ITEM)).toBe(
      `/admin/probe/content?type=page#item-${ITEM}`
    );
  });

  it('forgets the view once the list is opened untouched, and sets nothing when none was kept', () => {
    const { cookies, calls, held } = jar({ 'mycel-content-list-page': 'q=buurt' });
    rememberList(cookies, 'probe', 'page', view(''));
    expect(held.size).toBe(0);
    rememberList(cookies, 'probe', 'page', view(''));
    expect(calls).toEqual(['delete mycel-content-list-page /admin/probe']);
  });

  it('reads a stored value as a view, so nothing else comes out of it', () => {
    const { cookies } = jar({
      'mycel-content-list-page': 'q=x&status=nope&next=//evil.example&page=2#frag',
    });
    expect(recalledListPath(cookies, 'probe', 'page', ITEM)).toBe(
      `/admin/probe/content?type=page&q=x#item-${ITEM}`
    );
  });
});
