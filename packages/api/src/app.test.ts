import { describe, expect, it } from 'vitest';
import { Invoker, buildRegistry, systemPrincipal } from '@mycel/core';
import { MemoryUnitOfWork, probeForm, probePage } from '@mycel/core/testing';
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
