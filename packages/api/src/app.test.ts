import { describe, expect, it } from 'vitest';
import { Invoker, buildRegistry, systemPrincipal } from '@mycel/core';
import {
  FakeInputHasher,
  MemoryUnitOfWork,
  probeForm,
  probePage,
  TENANT,
} from '@mycel/core/testing';
import { Metrics, createLogger } from '@mycel/observability';
import { createApp } from './app.js';
import type { PlatformStore } from './platform.js';
import { loadConfig } from './compose.js';
import { HmacInputHasher, HmacSigner } from './signer.js';

const FORM = '01900000-0000-7000-8000-00000000f000';
const PLATFORM_TOKEN = 'p'.repeat(32);

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
  it('runs the signup flow: create the page, publish it, read it, submit the form', async () => {
    const { post } = await setup();
    expect((await post('content.published.get', { type: 'page', slug: 'signup' })).status).toBe(
      404
    );
    const created = await post('content.item.create', probePage(FORM));
    expect(created.status).toBe(200);
    const { item, revision } = (await created.json()) as {
      item: { id: string };
      revision: { id: string };
    };
    // A draft is not public: nothing is served before an explicit publish.
    expect((await post('content.published.get', { type: 'page', slug: 'signup' })).status).toBe(
      404
    );
    for (const locale of ['nl', 'en'])
      expect(
        (await post('content.item.publish', { itemId: item.id, revisionId: revision.id, locale }))
          .status
      ).toBe(200);
    const page = await post('content.published.get', { type: 'page', slug: 'signup' });
    expect(page.status).toBe(200);
    expect(await page.json()).toMatchObject({ slug: 'signup', locale: 'nl' });
    expect((await post('content.item.create', probePage(FORM))).status).toBe(409);

    const submit = await post('form.submit', {
      formId: FORM,
      values: { email: 'a@example.org', consent: true },
      locale: 'nl',
    });
    expect(await submit.json()).toMatchObject({ status: 'accepted' });
    expect((await post('no.such.thing', {})).status).toBe(404);
  });

  it('never returns an unpublished translation from the published snapshot', async () => {
    const { post } = await setup();
    const input = probePage(FORM);
    input.document.blocks[0] = {
      type: 'heading',
      version: 1,
      props: { text: { nl: 'Meld je aan', en: 'EN-DRAFT-MARKER' } },
    };
    const { item, revision } = (await (await post('content.item.create', input)).json()) as {
      item: { id: string };
      revision: { id: string };
    };
    await post('content.item.publish', { itemId: item.id, revisionId: revision.id, locale: 'nl' });
    const page = await post('content.published.get', { type: 'page', slug: 'signup' });
    expect(page.status).toBe(200);
    const body = await page.text();
    expect(body).not.toContain('EN-DRAFT-MARKER');
    expect(JSON.parse(body)).toMatchObject({ locale: 'nl', locales: ['nl'] });
  });

  it('serves flat queries as GET with a weak ETag and 304 on a match', async () => {
    const { app, post } = await setup();
    const { item, revision } = (await (
      await post('content.item.create', probePage(FORM))
    ).json()) as {
      item: { id: string };
      revision: { id: string };
    };
    await post('content.item.publish', { itemId: item.id, revisionId: revision.id, locale: 'nl' });
    const get = (headers: Record<string, string> = {}) =>
      app.request('/v1/content.published.get?type=page&slug=signup', {
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

    const invalid = await app.request('/v1/content.published.get?type=page&slug=Nope!', {
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

// TODO #17b: the audit input hash. The core's test hasher (Web Crypto) is the same HMAC, so the
// seed's and the API's rows hash alike under one key.
describe('HmacInputHasher', () => {
  it('is HMAC-SHA256 in hex, equal to the core test hasher under the same key', async () => {
    const key = 'audit-key-0123456789';
    const hash = await new HmacInputHasher(key).hash('{"a":1}');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(await new FakeInputHasher(key).hash('{"a":1}')).toBe(hash);
    expect(await new HmacInputHasher('another-key-0123456').hash('{"a":1}')).not.toBe(hash);
    expect(() => new HmacInputHasher('short')).toThrow(/AUDIT_HASH_KEY/);
  });

  it('is required in production', () => {
    const base = {
      APP_DATABASE_URL: 'postgres://a@localhost/x',
      AUTH_DATABASE_URL: 'postgres://b@localhost/x',
      SIGNING_SECRET: 'test-only-signing-secret',
      PUBLIC_BASE_URL: 'https://example.org',
      MAIL_FROM: 'noreply@example.org',
      PLATFORM_DOMAIN: 'example.org',
    };
    expect(() => loadConfig({ ...base, NODE_ENV: 'production' })).toThrow(
      /AUDIT_HASH_KEY is required in production/
    );
    expect(() =>
      loadConfig({ ...base, NODE_ENV: 'production', AUDIT_HASH_KEY: 'prod-audit-key-0123' })
    ).not.toThrow(/AUDIT_HASH_KEY/);
    expect(loadConfig(base).AUDIT_HASH_KEY).toBeUndefined();
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
      // Only for the refusal it counts: an id that is no uuid never reaches the store.
      platform: { token: PLATFORM_TOKEN, store: {} as PlatformStore },
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
      app.request('/v1/content.published.get?type=page&slug=signup', {
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
    // A body that is no JSON and a refusal of the platform API count like any other refusal.
    await app.request('/v1/nope', {
      method: 'POST',
      headers: { authorization: 'Bearer good', 'content-type': 'application/json' },
      body: '{',
    });
    await app.request('/platform/tenants/not-an-id', {
      headers: { authorization: `Bearer ${PLATFORM_TOKEN}` },
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
      /mycel_http_requests_total\{method="POST",route="\/v1\/:name",status="4xx"\} 2/
    );
    expect(text).toContain('mycel_use_case_errors_total{code="not_found"} 1');
    expect(text).toContain('mycel_use_case_errors_total{code="invalid_input"} 2');
    expect(text).not.toContain(TENANT);
  });
});

// TODO #20c decision 3: one middleware, so a 200, a router 404, a problem and an internal error
// all carry the same set. Negative: HSTS never over plain HTTP, and X-Forwarded-Proto counts only
// behind a trusted proxy.
describe('security headers', () => {
  const expectApiSet = (res: Response) => {
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(res.headers.get('content-security-policy')).toBe(
      "default-src 'none'; frame-ancestors 'none'"
    );
  };

  it('are on a 200, a 404 and a problem response', async () => {
    const { app, post } = await setup();
    const ok = await app.request('/healthz');
    expect(ok.status).toBe(200);
    const missing = await app.request('/nowhere');
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ type: 'urn:mycel:problem:not_found' });
    const refused = await post('no.such.thing', {});
    expect(refused.headers.get('content-type')).toMatch(/problem\+json/);
    const unauthorized = await post('no.such.thing', {}, 'Bearer bad');
    expect(unauthorized.status).toBe(401);
    for (const res of [ok, missing, refused, unauthorized]) {
      expectApiSet(res);
      expect(res.headers.has('strict-transport-security')).toBe(false);
    }
  });

  it('HSTS over HTTPS only, without includeSubDomains or preload', async () => {
    const { app } = await setup();
    const https = await app.request('https://api.example.org/healthz');
    expect(https.headers.get('strict-transport-security')).toBe('max-age=31536000');
    const spoofed = await app.request('/healthz', { headers: { 'x-forwarded-proto': 'https' } });
    expect(spoofed.headers.has('strict-transport-security')).toBe(false);
  });

  it('behind a trusted proxy, follows X-Forwarded-Proto', async () => {
    const app = createApp({
      invoker: new Invoker(buildRegistry(), new MemoryUnitOfWork()),
      authenticate: async () => null,
      trustProxy: true,
    });
    const viaTls = await app.request('/healthz', { headers: { 'x-forwarded-proto': 'https' } });
    expect(viaTls.headers.get('strict-transport-security')).toBe('max-age=31536000');
    const plain = await app.request('/healthz', { headers: { 'x-forwarded-proto': 'http' } });
    expect(plain.headers.has('strict-transport-security')).toBe(false);
  });
});
