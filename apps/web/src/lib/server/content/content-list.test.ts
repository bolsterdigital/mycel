// The view of a content list (#79): a query reads into a view whatever it holds, a view writes
// back as the shortest query that means the same, the view asks `content.item.list` for exactly
// what it shows, and the way back from an item is the view it was entered from, or the plain list.

import { describe, expect, it } from 'vitest';
import type { Cookies } from '@sveltejs/kit';
import { TRANSLATION_TOO_BROAD, UseCaseError } from '@mycel/core';
import {
  chooseListDisplay,
  columnsOf,
  isFiltered,
  listChips,
  listDisplay,
  listInput,
  listParams,
  listPath,
  listViewFrom,
  recalledListPath,
  rememberListFromReferer,
  translationTooBroad,
} from './content-list.js';

const view = (query: string, type: 'page' | 'article' = 'article') =>
  listViewFrom(new URLSearchParams(query), type);
const NL = { per: 20, zone: 'Europe/Amsterdam', others: ['en'] };
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
      author: null,
      section: null,
      tag: '',
      from: '',
      to: '',
      translation: null,
      sort: 'updated',
      dir: 'desc',
      page: 1,
      columns: null,
      per: null,
    });
  });

  it('reads a search, a status, an order and a page', () => {
    expect(view('q=+buurt+&status=changed&sort=title&dir=desc&page=3')).toMatchObject({
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
    expect(listInput(view('q=buurt&status=draft&page=3'), 'article', 'en', NL)).toEqual({
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
    const input = listInput(view('status=changed'), 'page', 'nl', NL);
    expect(input).toMatchObject({ hasUnpublishedChanges: true });
    expect(input).not.toHaveProperty('status');
    expect(input).not.toHaveProperty('q');
  });
});

const AUTHOR = '01900000-0000-7000-8000-00000000000a';

describe('the filters of a view', () => {
  it('reads an author, a section, a tag, two days and a translation', () => {
    const asked = view(
      `author=${AUTHOR}&section=${ITEM}&tag=+Buurt++Nieuws&from=2026-03-29&to=2026-03-29&translation=behind`
    );
    expect(asked).toMatchObject({
      author: AUTHOR,
      section: ITEM,
      tag: 'buurt nieuws',
      from: '2026-03-29',
      to: '2026-03-29',
      translation: 'behind',
    });
    expect(isFiltered(asked)).toBe(true);
    expect(listChips(asked).map((c) => c.name)).toEqual([
      'author',
      'section',
      'tag',
      'from',
      'to',
      'translation',
    ]);
  });

  it('takes what it does not understand as no filter', () => {
    const asked = view('author=sam&section=1&from=2026-02-31&to=gisteren&translation=oud&tag=%00');
    expect(isFiltered(asked)).toBe(false);
    expect(listChips(asked)).toEqual([]);
  });

  it('asks nothing of a page that only an article can answer', () => {
    const asked = view(`author=${AUTHOR}&section=${ITEM}&tag=zee&from=2026-01-01`, 'page');
    expect(asked).toMatchObject({ author: null, section: null, tag: '', from: '2026-01-01' });
  });

  it('turns two days into the moments of the admin zone, the last day whole', () => {
    // 29 March 2026 in Amsterdam has 23 hours: the clock jumps from 02:00 to 03:00.
    expect(listInput(view('from=2026-03-29&to=2026-03-29'), 'page', 'nl', NL)).toMatchObject({
      updatedFrom: '2026-03-28T23:00:00.000Z',
      updatedBefore: '2026-03-29T22:00:00.000Z',
    });
  });

  it('looks for a translation in the other locales, and not without any', () => {
    expect(listInput(view('translation=missing'), 'page', 'nl', NL)).toMatchObject({
      translation: { state: 'missing', locales: ['en'] },
    });
    expect(
      listInput(view('translation=missing'), 'page', 'nl', { ...NL, others: [] })
    ).not.toHaveProperty('translation');
  });

  it('keeps an offset core accepts, whatever the page size asks', () => {
    expect(listInput(view('page=5001'), 'page', 'nl', { ...NL, per: 100 }).offset).toBe(100_000);
  });
});

describe('the display of a list', () => {
  const form = (columns: string[], per: string) => {
    const data = new FormData();
    for (const column of columns) data.append('column', column);
    data.set('per', per);
    return data;
  };

  it('shows the status and the last save, twenty to a page, until someone chooses', () => {
    expect(listDisplay(jar().cookies, view(''), 'article')).toEqual({
      columns: ['status', 'updated'],
      per: 20,
    });
  });

  it('offers a page no column it cannot fill', () => {
    expect(columnsOf('page')).toEqual(['status', 'slug', 'created', 'updated']);
    expect(view('columns=author,slug', 'page').columns).toEqual(['slug']);
  });

  it('keeps a choice per site and type, and in its own order', () => {
    const { cookies, calls } = jar();
    chooseListDisplay(cookies, 'probe', 'article', form(['updated', 'tags', 'nonsense'], '50'));
    expect(calls).toEqual(['set mycel-content-display-article /admin/probe']);
    expect(listDisplay(cookies, view(''), 'article')).toEqual({
      columns: ['tags', 'updated'],
      per: 50,
    });
    // Another type follows its own choice.
    expect(listDisplay(cookies, view(''), 'page').per).toBe(20);
  });

  it('may hold nothing but the title, and a size it does not know is the default', () => {
    const { cookies } = jar();
    chooseListDisplay(cookies, 'probe', 'page', form([], '7'));
    expect(listDisplay(cookies, view('', 'page'), 'page')).toEqual({ columns: [], per: 20 });
  });

  it('lets a query name the display for one link, and keeps it in the view', () => {
    const { cookies } = jar();
    chooseListDisplay(cookies, 'probe', 'article', form(['status'], '50'));
    const asked = view('columns=slug&per=100');
    expect(listDisplay(cookies, asked, 'article')).toEqual({ columns: ['slug'], per: 100 });
    expect(listParams(asked).toString()).toBe('columns=slug&per=100');
    expect(listParams(view('per=7')).toString()).toBe('');
  });
});

describe('a query that holds a NUL', () => {
  it('is no search', () => {
    expect(view('q=a%00b').q).toBe('');
    expect(listInput(view('q=%00'), 'page', 'nl', NL)).not.toHaveProperty('q');
  });
});

describe('the way back from an item', () => {
  const HERE = new URL(`http://mycel.test/admin/probe/content/${ITEM}`);
  const list = (query: string) => `http://mycel.test/admin/probe/content?${query}`;
  const enter = (cookies: Cookies, referer: string | null, type: 'page' | 'article' = 'page') =>
    rememberListFromReferer(cookies, referer, HERE, 'probe', type);

  it('is the view the item was entered from, at the row of the item', () => {
    const { cookies, calls } = jar();
    enter(cookies, list('type=article&q=buurt&sort=title&page=2'), 'article');
    expect(calls).toEqual(['set mycel-content-list-article /admin/probe']);
    expect(recalledListPath(cookies, 'probe', 'article', ITEM)).toBe(
      `/admin/probe/content?type=article&q=buurt&sort=title&page=2#item-${ITEM}`
    );
    // Pages keep their own view.
    expect(recalledListPath(cookies, 'probe', 'page', ITEM)).toBe(
      `/admin/probe/content?type=page#item-${ITEM}`
    );
  });

  it('forgets the view when entered from the untouched list, and sets nothing when none was kept', () => {
    const { cookies, calls, held } = jar({ 'mycel-content-list-page': 'q=buurt' });
    enter(cookies, list('type=page'));
    expect(held.size).toBe(0);
    enter(cookies, list('type=page'));
    expect(calls).toEqual(['delete mycel-content-list-page /admin/probe']);
  });

  // A changed HttpOnly cookie drops a `no-store` page from the back/forward cache.
  it('does not write the same view again', () => {
    const { cookies, calls } = jar({ 'mycel-content-list-page': 'q=buurt' });
    enter(cookies, list('type=page&q=buurt'));
    expect(calls).toEqual([]);
  });

  it.each([
    ['no Referer', null],
    ['an unreadable Referer', 'not a url'],
    ['another origin', 'http://evil.example/admin/probe/content?type=page&q=x'],
    ['another site', 'http://mycel.test/admin/other/content?type=page&q=x'],
    ['the item itself, after a save', `http://mycel.test/admin/probe/content/${ITEM}?saved`],
    ['the list of another type', list('type=article&q=x')],
  ])('changes nothing after %s', (_, referer) => {
    const { cookies, calls } = jar({ 'mycel-content-list-page': 'q=buurt' });
    enter(cookies, referer);
    expect(calls).toEqual([]);
    expect(recalledListPath(cookies, 'probe', 'page', ITEM)).toBe(
      `/admin/probe/content?type=page&q=buurt#item-${ITEM}`
    );
  });

  it('reads a list without a type as the list of pages, as the list itself does', () => {
    const { cookies } = jar();
    enter(cookies, list('q=buurt'));
    expect(recalledListPath(cookies, 'probe', 'page', ITEM)).toBe(
      `/admin/probe/content?type=page&q=buurt#item-${ITEM}`
    );
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

describe('translationTooBroad', () => {
  it('tells that one refusal from any other', () => {
    const issue = (message: string) => [{ path: 'translation', message }];
    expect(
      translationTooBroad(new UseCaseError('invalid_input', 'x', issue(TRANSLATION_TOO_BROAD)))
    ).toBe(true);
    expect(translationTooBroad(new UseCaseError('invalid_input', 'x', issue('other')))).toBe(false);
    expect(translationTooBroad(new Error(TRANSLATION_TOO_BROAD))).toBe(false);
  });
});
