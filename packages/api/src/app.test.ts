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

describe('HTTP front', () => {
  it('lists every registered operation', async () => {
    const { app } = await setup();
    const res = await app.request('/v1');
    const { operations } = (await res.json()) as { operations: { name: string }[] };
    expect(operations.map((o) => o.name).sort()).toEqual([
      'content.page.create',
      'content.page.get',
      'forms.form.get',
      'forms.submit',
      'supporters.get',
    ]);
  });

  it('runs the same use cases as the other fronts, with Problem Details on errors', async () => {
    const { post } = await setup();
    expect((await post('content.page.get', { slug: 'signup' }, 'Bearer bad')).status).toBe(401);
    expect((await post('content.page.get', { slug: 'signup' })).status).toBe(404);
    expect((await post('content.page.create', probePage(FORM))).status).toBe(200);
    const page = await post('content.page.get', { slug: 'signup' });
    expect(page.status).toBe(200);
    expect(await page.json()).toMatchObject({ slug: 'signup' });

    const bad = await post('content.page.create', { slug: 'Nope!' });
    expect(bad.status).toBe(422);
    expect(bad.headers.get('content-type')).toBe('application/problem+json');
    expect(await bad.json()).toMatchObject({ title: 'invalid_input', status: 422 });

    const submit = await post('forms.submit', {
      formId: FORM,
      values: { email: 'a@example.org', consent: true },
      locale: 'nl',
    });
    expect(await submit.json()).toMatchObject({ status: 'accepted' });
    expect((await post('no.such.thing', {})).status).toBe(404);
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
