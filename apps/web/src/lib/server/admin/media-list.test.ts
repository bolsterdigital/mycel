import type { Cookies } from '@sveltejs/kit';
import { describe, expect, it } from 'vitest';
import {
  mediaChips,
  mediaFiltered,
  mediaListInput,
  mediaListParams,
  mediaListPath,
  mediaListViewFrom,
  recalledMediaPath,
  rememberMediaListFromReferer,
} from './media-list.js';

const view = (query: string) => mediaListViewFrom(new URLSearchParams(query));
const ID = '01900000-0000-7000-8000-000000000001';

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

describe('mediaListViewFrom', () => {
  it('is the newest first, unfiltered grid on page one without a query', () => {
    expect(view('')).toEqual({
      q: '',
      kind: null,
      show: null,
      order: 'created-desc',
      sort: 'created',
      dir: 'desc',
      layout: 'grid',
      page: 1,
    });
  });

  it('reads what it understands and takes the default for the rest', () => {
    expect(view('kind=audio&show=no-alt&sort=size-asc&view=list&page=3')).toMatchObject({
      kind: 'audio',
      show: 'no-alt',
      sort: 'size',
      dir: 'asc',
      layout: 'list',
      page: 3,
    });
    expect(view('kind=zip&show=all&sort=name&view=table&page=-1')).toMatchObject({
      kind: null,
      show: null,
      order: 'created-desc',
      layout: 'grid',
      page: 1,
    });
  });

  it('takes a NUL for no search, as core would refuse it', () => {
    expect(view('q=a%00b').q).toBe('');
  });
});

describe('mediaListParams', () => {
  it('leaves the defaults out, so an untouched library has no query', () => {
    expect(mediaListPath('probe', view(''))).toBe('/admin/probe/media');
    expect(mediaListParams(view('sort=created-desc&view=grid&page=1')).toString()).toBe('');
  });

  it('round-trips a whole view', () => {
    const asked = view('q=plein&kind=image&show=unused&sort=name-desc&view=list&page=2');
    expect(view(mediaListParams(asked).toString())).toEqual(asked);
  });
});

describe('filters', () => {
  it('says which filters are on, order and layout not among them', () => {
    expect(mediaFiltered(view('sort=name-asc&view=list&page=2'))).toBe(false);
    expect(mediaChips(view('sort=name-asc&view=list'))).toEqual([]);
    expect(mediaChips(view('show=unused&q=plein&kind=image'))).toEqual([
      { name: 'q', value: 'plein' },
      { name: 'kind', value: 'image' },
      { name: 'show', value: 'unused' },
    ]);
  });
});

describe('mediaListInput', () => {
  it('asks only what the view holds', () => {
    expect(mediaListInput(view(''))).toEqual({
      sort: 'created',
      direction: 'desc',
      offset: 0,
      limit: 50,
    });
  });

  it('turns the one need into its filter, and a page into a position', () => {
    expect(mediaListInput(view('show=unused&page=3'))).toMatchObject({ unused: true, offset: 100 });
    const lacking = mediaListInput(view('show=no-alt&q=plein&kind=image&sort=name-asc'));
    expect(lacking).toMatchObject({
      missingAlt: true,
      q: 'plein',
      kind: 'image',
      sort: 'name',
      direction: 'asc',
    });
    expect(lacking).not.toHaveProperty('unused');
  });

  it('never asks past the use case bound, however far a URL says', () => {
    expect(mediaListInput(view('page=99999999')).offset).toBe(100_000);
  });
});

describe('the way back from an asset', () => {
  const url = new URL(`https://admin.test/admin/probe/media/${ID}`);
  const list = (query: string) => `https://admin.test/admin/probe/media${query}`;

  it('keeps the view the asset is entered from, and lands on the asset', () => {
    const { cookies, calls } = jar();
    rememberMediaListFromReferer(cookies, list('?show=no-alt&view=list&page=2'), url, 'probe');
    expect(calls).toEqual(['set mycel-media-list /admin/probe']);
    expect(recalledMediaPath(cookies, 'probe', ID)).toBe(
      `/admin/probe/media?show=no-alt&view=list&page=2#media-${ID}`
    );
  });

  it('forgets it when the asset is entered from the untouched library', () => {
    const { cookies, calls } = jar({ 'mycel-media-list': 'show=unused' });
    rememberMediaListFromReferer(cookies, list(''), url, 'probe');
    expect(calls).toEqual(['delete mycel-media-list /admin/probe']);
    expect(recalledMediaPath(cookies, 'probe', ID)).toBe(`/admin/probe/media#media-${ID}`);
  });

  it('writes nothing when the view did not change: a changed cookie drops the bfcache', () => {
    const { cookies, calls } = jar({ 'mycel-media-list': 'show=unused' });
    rememberMediaListFromReferer(cookies, list('?show=unused'), url, 'probe');
    expect(calls).toEqual([]);
  });

  it.each([
    ['no Referer', null],
    ['a nonsense Referer', 'not a url'],
    ['another origin', 'https://elders.test/admin/probe/media?show=unused'],
    ['another site', 'https://admin.test/admin/ander/media?show=unused'],
    ['the asset itself, after a save', `https://admin.test/admin/probe/media/${ID}`],
  ])('leaves what it kept on %s', (_, referer) => {
    const { cookies, calls } = jar({ 'mycel-media-list': 'kind=image' });
    rememberMediaListFromReferer(cookies, referer, url, 'probe');
    expect(calls).toEqual([]);
  });

  it('goes back after a delete to the same view, saying so and at no asset', () => {
    const { cookies } = jar({ 'mycel-media-list': 'kind=image' });
    expect(recalledMediaPath(cookies, 'probe', null, 'deleted')).toBe(
      '/admin/probe/media?kind=image&done=deleted'
    );
  });

  it('reads a kept value through the view, so nothing else gets into the link', () => {
    const { cookies } = jar({ 'mycel-media-list': 'evil=1&kind=nope' });
    expect(recalledMediaPath(cookies, 'probe', ID)).toBe(`/admin/probe/media#media-${ID}`);
  });
});
