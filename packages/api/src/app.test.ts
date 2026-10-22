import { describe, expect, it } from 'vitest';
import { Invoker, buildRegistry, systemPrincipal } from '@mycel/core';
import { MemoryUnitOfWork, probeForm, probePage } from '@mycel/core/testing';
import { Metrics, createLogger } from '@mycel/observability';
import { createApp } from './app.js';
import { HmacSigner } from './signer.js';

const TENANT = '01900000-0000-7000-8000-00000000aaaa';
const FORM = '01900000-0000-7000-8000-00000000f000';

async function setup() {
  const uow = new MemoryUnitOfWork();
  const invoker = new Invoker(buildRegistry(), uow);
  await uow.run(systemPrincipal(TENANT, 'test'), (ctx) => ctx.forms.insert(probeForm(FORM)));
  const app = createApp({
    invoker,
    authenticate: async (h) => (h === 'Bearer good' ? systemPrincipal(TENANT, 'api') : null),
  });
  const post = (name: string, body: unknown, auth = 'Bearer good') =>
    app.request(`/v1/${name}`, {
      method: 'POST',
      headers: { authorization: auth, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  return { app, post, uow };
}

// Generic HTTP behaviour (status codes, Problem Details, OpenAPI) is in
// registry.conformance.test.ts; this file keeps the signup flow and the caching contract.
describe('HTTP front', () => {
  it('runs the signup flow: create the page, read it, submit the form', async () => {
    const { post } = await setup();
    expect((await post('content.page.get', { slug: 'signup' })).status).toBe(404);
    expect((await post('content.page.create', probePage(FORM))).status).toBe(200);
    const page = await post('content.page.get', { slug: 'signup' });
    expect(page.status).toBe(200);
    expect(await page.json()).toMatchObject({ slug: 'signup' });
    expect((await post('content.page.create', probePage(FORM))).status).toBe(409);

    const submit = await post('forms.submit', {
      formId: FORM,
      values: { email: 'a@example.org', consent: true },
      locale: 'nl',
    });
    expect(await submit.json()).toMatchObject({ status: 'accepted' });
    expect((await post('no.such.thing', {})).status).toBe(404);
  });

  it('serves flat queries as GET with a weak ETag and 304 on a match', async () => {
    const { app, post } = await setup();
    await post('content.page.create', probePage(FORM));
    const get = (headers: Record<string, string> = {}) =>
      app.request('/v1/content.page.get?slug=signup', {
        headers: { authorization: 'Bearer good', ...headers },
      });

    const first = await get();
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ slug: 'signup' });
    const etag = first.headers.get('etag')!;
    expect(etag).toMatch(/^W\/"/);
    expect(first.headers.get('cache-control')).toBe('private, no-cache');

    const revalidated = await get({ 'if-none-match': etag });
    expect(revalidated.status).toBe(304);
    expect(await revalidated.text()).toBe('');
    expect((await get({ 'if-none-match': 'W/"other"' })).status).toBe(200);

    const invalid = await app.request('/v1/content.page.get?slug=Nope!', {
      headers: { authorization: 'Bearer good' },
    });
    expect(invalid.status).toBe(400);
  });
});

describe('HmacSigner', () => {
  it('round-trips and rejects tampering', async () => {
    const s = new HmacSigner('0123456789abcdef');
    const token = await s.sign('{"a":1}');
    expect(await s.verify(token)).toBe('{"a":1}');
    expect(await s.verify(token.slice(0, -2) + 'xx')).toBeNull();
    expect(await new HmacSigner('fedcba9876543210').verify(token)).toBeNull();
    expect(s.hashIp('1.2.3.4')).not.toContain('1.2.3.4');
  });
});

// TODO #17a: request ids, the access line, readiness and metrics.
describe('HTTP observability', () => {
  async function observed(ready = true, metricsToken?: string) {
    const out: string[] = [];
    const log = createLogger({ service: 'api', write: (l) => void out.push(l) });
    const uow = new MemoryUnitOfWork();
    const app = createApp({
      invoker: new Invoker(buildRegistry(), uow),
      authenticate: async (h) => (h === 'Bearer good' ? systemPrincipal(TENANT, 'api') : null),
      observability: {
        log,
        metrics: new Metrics(),
        newRequestId: () => 'fresh-request-id',
        ready: async () => ready,
        metricsToken,
      },
    });
    return { app, lines: () => out.map((l) => JSON.parse(l) as Record<string, unknown>) };
  }

  it('echoes a valid request id, replaces an invalid one, and logs one access line each', async () => {
    const { app, lines } = await observed();
    const get = (id?: string) =>
      app.request('/v1/content.page.get?slug=signup', {
        headers: { authorization: 'Bearer good', ...(id ? { 'x-request-id': id } : {}) },
      });
    expect((await get('caddy-0123456789')).headers.get('x-request-id')).toBe('caddy-0123456789');
    expect((await get('no good')).headers.get('x-request-id')).toBe('fresh-request-id');
    expect(lines()).toMatchObject([
      {
        level: 'info',
        msg: 'request',
        service: 'api',
        requestId: 'caddy-0123456789',
        tenantId: TENANT,
        method: 'GET',
        route: '/v1/:name',
        status: 404,
      },
      { requestId: 'fresh-request-id', route: '/v1/:name' },
    ]);
    expect(JSON.stringify(lines())).not.toContain('slug=signup');
    expect(typeof lines()[0]!['durationMs']).toBe('number');
  });

  it('answers /readyz 200 with a database and 503 without, /healthz either way', async () => {
    const up = await observed(true);
    const down = await observed(false);
    expect((await up.app.request('/readyz')).status).toBe(200);
    expect(await (await down.app.request('/readyz')).json()).toEqual({ db: 'down' });
    expect((await down.app.request('/readyz')).status).toBe(503);
    expect((await down.app.request('/healthz')).status).toBe(200);
  });

  it('serves /metrics only with the token, in the Prometheus text format', async () => {
    const token = 'm'.repeat(32);
    expect((await (await observed()).app.request('/metrics')).status).toBe(404);
    const { app } = await observed(true, token);
    await app.request('/v1/nope', {
      method: 'POST',
      headers: { authorization: 'Bearer good', 'content-type': 'application/json' },
      body: '{}',
    });
    expect((await app.request('/metrics')).status).toBe(404);
    expect(
      (await app.request('/metrics', { headers: { authorization: 'Bearer wrong' } })).status
    ).toBe(404);
    const res = await app.request('/metrics', { headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^text\/plain; version=0\.0\.4/);
    const text = await res.text();
    expect(text).toContain('# TYPE mycel_http_requests_total counter');
    expect(text).toMatch(
      /mycel_http_requests_total\{method="POST",route="\/v1\/:name",status="4xx"\} 1/
    );
    expect(text).toContain('mycel_use_case_errors_total{code="not_found"} 1');
    expect(text).not.toContain(TENANT);
  });
});
