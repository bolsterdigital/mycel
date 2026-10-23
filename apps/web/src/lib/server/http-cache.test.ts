import { describe, expect, it } from 'vitest';
import { NO_STORE, PUBLIC_CACHE, conditional, noneMatch } from './http-cache.js';

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

describe('noneMatch', () => {
  it('compares weakly and knows *', () => {
    expect(noneMatch(null, ETAG)).toBe(false);
    expect(noneMatch('*', ETAG)).toBe(true);
    expect(noneMatch(`W/${ETAG}`, ETAG)).toBe(true);
  });
});
