import { describe, expect, it } from 'vitest';
import {
  NO_STORE,
  PRIVATE_NO_STORE,
  PUBLIC_CACHE,
  conditional,
  itemCacheHeaders,
} from './http-cache.js';

const ETAG = '"rev:nl:theme:digest"';
const page = (headers: Record<string, string> = {}, status = 200) =>
  new Response('<html></html>', {
    status,
    headers: { 'content-type': 'text/html', etag: ETAG, 'cache-control': PUBLIC_CACHE, ...headers },
  });
const get = (headers: Record<string, string> = {}, method = 'GET') =>
  new Request('http://probe.localhost/x', { method, headers });

describe('conditional', () => {
  it('turns a matching revalidation into an empty 304 with the same validators', async () => {
    const res = conditional(get({ 'if-none-match': ETAG }), page());
    expect(res.status).toBe(304);
    expect(await res.text()).toBe('');
    expect(res.headers.get('etag')).toBe(ETAG);
    expect(res.headers.get('cache-control')).toBe(PUBLIC_CACHE);
    expect(res.headers.get('content-type')).toBeNull();
    expect(conditional(get({ 'if-none-match': `"x", ${ETAG}` }), page()).status).toBe(304);
    expect(conditional(get({ 'if-none-match': ETAG }, 'HEAD'), page()).status).toBe(304);
  });

  it('strips the validator from a no-store response, so nothing revalidates it (#30A)', () => {
    const res = conditional(
      get({ 'if-none-match': '*' }),
      page({ 'cache-control': NO_STORE, etag: '"sveltekit-hash"' })
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('etag')).toBeNull();
  });

  it('never revalidates a reader\u2019s page: private, no-store loses its validator too', () => {
    for (const cache of [PRIVATE_NO_STORE, 'no-store, private', 'No-Store']) {
      const res = conditional(
        get({ 'if-none-match': ETAG }),
        page({ 'cache-control': cache, vary: 'Cookie' })
      );
      expect([res.status, res.headers.get('etag')]).toEqual([200, null]);
    }
    // A directive that merely contains the word is not it.
    expect(
      conditional(get({ 'if-none-match': ETAG }), page({ 'cache-control': 'x-no-store-ish' }))
        .status
    ).toBe(304);
  });

  it('leaves everything else alone', () => {
    expect(conditional(get(), page()).status).toBe(200);
    expect(conditional(get({ 'if-none-match': '"other"' }), page()).status).toBe(200);
    expect(conditional(get({ 'if-none-match': ETAG }, 'POST'), page()).status).toBe(200);
    expect(conditional(get({ 'if-none-match': 'W/"a"' }), page({ etag: 'W/"a"' })).status).toBe(
      200
    );
    expect(conditional(get({ 'if-none-match': ETAG }), page({}, 400)).status).toBe(400);
  });

  it('gives a 404 no-store unless the route chose a policy', () => {
    const missing = conditional(get(), new Response('Not found', { status: 404 }));
    expect(missing.headers.get('cache-control')).toBe(NO_STORE);
    const own = new Response('x', { status: 404, headers: { 'cache-control': 'max-age=5' } });
    expect(conditional(get(), own).headers.get('cache-control')).toBe('max-age=5');
  });
});

describe('itemCacheHeaders', () => {
  const open = { restricted: false, personal: false, etag: ETAG };

  it('keeps a public item a function of its URL', () => {
    expect(itemCacheHeaders(open)).toEqual({ etag: ETAG, 'cache-control': PUBLIC_CACHE });
    expect(itemCacheHeaders({ ...open, etag: null })).toEqual({ 'cache-control': NO_STORE });
  });

  it('lets a cache keep a teaser, but never without the cookie in its key', () => {
    expect(itemCacheHeaders({ ...open, restricted: true })).toEqual({
      etag: ETAG,
      'cache-control': PUBLIC_CACHE,
      vary: 'Cookie',
    });
    expect(itemCacheHeaders({ restricted: true, personal: false, etag: null })).toEqual({
      'cache-control': NO_STORE,
      vary: 'Cookie',
    });
  });

  it('gives a personal answer to nobody else and no validator, whatever tag came along', () => {
    expect(itemCacheHeaders({ restricted: true, personal: true, etag: ETAG })).toEqual({
      'cache-control': PRIVATE_NO_STORE,
      vary: 'Cookie',
    });
  });
});
