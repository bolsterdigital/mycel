// The platform API over HTTP against Postgres (TODO #16, ADR 015 rule 4): the real composition
// root, the real operator-connection functions, and the effect of a change on the Principal of a
// tenant's API key in the very next request.
//
// Skips without the three database URLs; with E2E_REQUIRED=1 (CI) that is a failure.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_ENTITLEMENTS, systemPrincipal, useCases } from '@mycel/core';
import { probeForm } from '@mycel/core/testing';
import { migrate, uuidv7 } from '@mycel/db';
import { createApp } from './app.js';
import { createRuntime, loadConfig, type Runtime } from './compose.js';

const env = process.env;
const ready = !!(env['DATABASE_URL'] && env['APP_DATABASE_URL'] && env['AUTH_DATABASE_URL']);
if (env['E2E_REQUIRED'] === '1' && !ready)
  throw new Error('E2E_REQUIRED=1 but a database URL is not set');

const TOKEN = 'platform-conformance-token-0123456789abcdef';

describe.skipIf(!ready)('platform API', () => {
  const runtimes: Runtime[] = [];
  const runtime = (token?: string) => {
    const rt = createRuntime(
      loadConfig({
        ...env,
        SIGNING_SECRET: env['SIGNING_SECRET'] ?? 'conformance-signing-secret',
        PUBLIC_BASE_URL: env['PUBLIC_BASE_URL'] ?? 'http://127.0.0.1:4173',
        MAIL_FROM: env['MAIL_FROM'] ?? 'noreply@example.org',
        MAILER: 'console',
        MAIL_SPOOL_DIR: undefined,
        PLATFORM_DOMAIN: env['PLATFORM_DOMAIN'] ?? 'localhost',
        PLATFORM_API_TOKEN: token,
      })
    );
    runtimes.push(rt);
    return rt;
  };
  const appOf = (rt: Runtime) =>
    createApp({
      invoker: rt.invoker,
      authenticate: rt.authenticateApiKey,
      platform: rt.platformApi,
    });
  const run = Math.random().toString(36).slice(2, 8);

  beforeAll(async () => {
    await migrate(env['DATABASE_URL']!, {
      appPassword: env['MYCEL_APP_PASSWORD'],
      authPassword: env['MYCEL_AUTH_PASSWORD'],
      log: () => {},
    });
  });

  afterAll(async () => {
    await Promise.all(runtimes.map((rt) => rt.close()));
  });

  it('does not exist without PLATFORM_API_TOKEN', async () => {
    const app = appOf(runtime());
    const res = await app.request('/platform/tenants', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(404);
  });

  it('refuses a missing or wrong token with 401', async () => {
    const app = appOf(runtime(TOKEN));
    expect((await app.request('/platform/tenants')).status).toBe(401);
    const wrong = await app.request('/platform/tenants', {
      headers: { authorization: `Bearer ${TOKEN}x` },
    });
    expect(wrong.status).toBe(401);
    expect(await wrong.json()).toMatchObject({ type: 'urn:mycel:problem:unauthorized' });
  });

  it('creates, lists, reads, sets entitlements and status, and the next request sees it', async () => {
    const rt = runtime(TOKEN);
    const app = appOf(rt);
    const call = (method: string, path: string, body?: unknown) =>
      app.request(`/platform${path}`, {
        method,
        headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });

    const slug = `plat-${run}`;
    const created = await call('POST', '/tenants', {
      slug,
      name: 'Platform',
      locales: ['nl', 'en'],
      entitlements: { remove_branding: false },
    });
    expect(created.status).toBe(201);
    const tenant = (await created.json()) as { id: string; slug: string };
    expect(tenant).toMatchObject({
      slug,
      status: 'active',
      storedEntitlements: { remove_branding: false },
      entitlements: { ...DEFAULT_ENTITLEMENTS, remove_branding: false },
    });
    expect((await call('POST', '/tenants', { slug, name: 'x', locales: ['nl'] })).status).toBe(409);
    expect((await call('POST', '/tenants', { slug: 'x', name: 'x', locales: [] })).status).toBe(
      400
    );

    const listed = (await (await call('GET', '/tenants')).json()) as { tenants: { id: string }[] };
    expect(listed.tenants.map((t) => t.id)).toContain(tenant.id);
    expect((await call('GET', `/tenants/${tenant.id}`)).status).toBe(200);
    expect((await call('GET', `/tenants/${uuidv7()}`)).status).toBe(404);

    // A key of the new tenant, and a form for it to post to.
    const admin = systemPrincipal(tenant.id, 'conformance');
    const formId = uuidv7();
    await rt.uow.run(admin, (ctx) => ctx.forms.insert(probeForm(formId)));
    const key = await rt.invoker.run(useCases.createKey, admin, {
      name: 'conformance',
      capabilities: ['forms:write', 'content:read'],
    });
    const submit = () =>
      app.request('/v1/forms.submit', {
        method: 'POST',
        headers: { authorization: `Bearer ${key.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          formId,
          values: { email: `${run}@example.org`, consent: true },
          locale: 'nl',
        }),
      });

    const capped = await call('PUT', `/tenants/${tenant.id}/entitlements`, { 'supporters.max': 0 });
    expect(await capped.json()).toMatchObject({ storedEntitlements: { 'supporters.max': 0 } });
    const refused = await submit();
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({
      type: 'urn:mycel:problem:limit_exceeded',
      issues: [{ message: 'entitlements.limit.supporters.max' }],
    });
    expect(
      (await call('PUT', `/tenants/${tenant.id}/entitlements`, { 'sites.max': 1 })).status
    ).toBe(400);

    await call('PUT', `/tenants/${tenant.id}/entitlements`, {});
    expect((await call('PUT', `/tenants/${tenant.id}/status`, { status: 'paused' })).status).toBe(
      400
    );
    const paused = await call('PUT', `/tenants/${tenant.id}/status`, { status: 'suspended' });
    expect(await paused.json()).toMatchObject({ status: 'suspended' });
    const whileSuspended = await submit();
    expect(whileSuspended.status).toBe(403);
    expect(await whileSuspended.json()).toMatchObject({ type: 'urn:mycel:problem:suspended' });

    await call('PUT', `/tenants/${tenant.id}/status`, { status: 'active' });
    expect((await submit()).status).toBe(200);
  });
});
