// The platform API over HTTP against Postgres (TODO #16, ADR 015 rule 4): the real composition
// root, the real platform functions, and the effect of a change on the Principal of a tenant's
// API key in the very next request. Every runtime here is built without DATABASE_URL: that the
// routes work at all proves the API needs no schema-owner credentials (ADR 011 rule 1; review
// round 1, audit point 2).
//
// Skips without the three database URLs; with E2E_REQUIRED=1 (CI) that is a failure.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_ENTITLEMENTS, systemPrincipal, useCases } from '@mycel/core';
import { probeForm } from '@mycel/core/testing';
import { createDb, migrate, uuidv7 } from '@mycel/db';
import { sql } from 'kysely';
import { createApp } from './app.js';
import { createRuntime, loadConfig, tokenFingerprint, type Runtime } from './compose.js';

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
        DATABASE_URL: undefined,
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
    expect(rt.config.DATABASE_URL).toBeUndefined();
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

    // TODO #17b: every platform mutation is one `platform` row with the token's fingerprint, in
    // the tenant's own log; refused mutations wrote nothing. The commands over HTTP are there too,
    // refused or not, as the API key.
    // Sorted, not in log order: two rows within one millisecond have no defined order.
    const { items } = await rt.invoker.run(useCases.listAudit, admin, { limit: 100 });
    expect(items.map((r) => [r.operation, r.actorKind, r.result].join(' ')).sort()).toEqual(
      [
        ['platform.tenant.create', 'platform', 'ok'],
        ['tenant.keys.create', 'system', 'ok'],
        ['platform.set_entitlements', 'platform', 'ok'],
        ['forms.submit', 'api-key', 'limit_exceeded'],
        ['platform.set_entitlements', 'platform', 'ok'],
        ['platform.set_status', 'platform', 'ok'],
        ['forms.submit', 'api-key', 'suspended'],
        ['platform.set_status', 'platform', 'ok'],
        ['forms.submit', 'api-key', 'ok'],
      ]
        .map((r) => r.join(' '))
        .sort()
    );
    const platformRows = items.filter((r) => r.actorKind === 'platform');
    expect(new Set(platformRows.map((r) => r.actorId))).toEqual(new Set([tokenFingerprint(TOKEN)]));
    expect(platformRows.every((r) => r.subjectId === tenant.id)).toBe(true);
    expect(JSON.stringify(items)).not.toContain(TOKEN);
    expect(JSON.stringify(items)).not.toContain('@');
  });

  // TODO #17c: stuck work across tenants, read as mycel_ops from the authentication login. The
  // fixture job goes in as the worker (operator connection, as the test harness has it); the API
  // under test still runs without DATABASE_URL.
  it('lists and recovers stuck work per tenant without a payload, behind the token', async () => {
    const rt = runtime(TOKEN);
    const app = appOf(rt);
    const get = (path: string, token = TOKEN) =>
      app.request(`/platform${path}`, { headers: { authorization: `Bearer ${token}` } });
    expect((await app.request('/platform/ops/summary')).status).toBe(401);
    expect((await get('/ops/jobs', `${TOKEN}x`)).status).toBe(401);
    expect((await appOf(runtime()).request('/platform/ops/jobs')).status).toBe(404);

    const created = (await (
      await app.request('/platform/tenants', {
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify({ slug: `ops-${run}`, name: 'Ops', locales: ['nl'] }),
      })
    ).json()) as { id: string };
    const operatorDb = createDb(env['DATABASE_URL']!);
    const id = uuidv7();
    try {
      await operatorDb.transaction().execute(async (trx) => {
        await sql`set local role mycel_worker`.execute(trx);
        await trx
          .insertInto('jobs')
          .values({
            id,
            tenant_id: created.id,
            type: `conformance.${run}.stuck`,
            key: `conformance.${run}.stuck:${id}`,
            run_at: new Date(Date.now() + 86_400_000),
            payload: JSON.stringify({ secret: `payload-${run}` }),
            attempts: 10,
            max_attempts: 10,
            last_error: 'failed for someone@example.org',
          })
          .execute();
      });

      const summary = (await (await get('/ops/summary')).json()) as {
        tenants: { tenantId: string; slug: string; exhaustedJobs: number }[];
      };
      expect(summary.tenants.find((t) => t.tenantId === created.id)).toMatchObject({
        slug: `ops-${run}`,
        exhaustedJobs: 1,
      });
      const jobs = await get(`/ops/jobs?tenantId=${created.id}`);
      expect(jobs.status).toBe(200);
      const body = (await jobs.json()) as { items: Record<string, unknown>[]; nextCursor: null };
      expect(body).toMatchObject({ items: [{ id, attempts: 10 }], nextCursor: null });
      expect(body.items[0]).not.toHaveProperty('payload');
      expect(JSON.stringify(body)).not.toContain(`payload-${run}`);
      expect(JSON.stringify(body)).not.toContain('@');
      for (const path of ['/ops/outbox', '/ops/mail'])
        expect(await (await get(`${path}?tenantId=${created.id}`)).json()).toEqual({
          items: [],
          nextCursor: null,
        });
      expect((await get('/ops/jobs?tenantId=nope')).status).toBe(400);
      expect((await get('/ops/jobs?limit=0')).status).toBe(400);
      // The recoveries: as the platform, audited as such; never a route that acts as a tenant.
      const post = (path: string) =>
        app.request(`/platform${path}`, {
          method: 'POST',
          headers: { authorization: `Bearer ${TOKEN}` },
        });
      expect((await post(`/ops/jobs/${uuidv7()}/retry`)).status).toBe(404);
      expect((await post(`/ops/outbox/${id}/retry`)).status).toBe(404);
      expect((await post('/ops/jobs/nope/close')).status).toBe(400);
      const retried = await post(`/ops/jobs/${id}/retry`);
      expect(retried.status).toBe(200);
      expect(await retried.json()).toEqual({ id });
      // Retried, the job is no longer stuck: a close is a conflict and the listing is empty.
      expect((await post(`/ops/jobs/${id}/close`)).status).toBe(409);
      expect(await (await get(`/ops/jobs?tenantId=${created.id}`)).json()).toEqual({
        items: [],
        nextCursor: null,
      });
      const { items: audit } = await rt.invoker.run(
        useCases.listAudit,
        systemPrincipal(created.id, 'test'),
        { operation: 'platform.ops.job.retry', limit: 10 }
      );
      expect(audit).toMatchObject([
        { actorKind: 'platform', actorId: tokenFingerprint(TOKEN), result: 'ok', subjectId: id },
      ]);
    } finally {
      await operatorDb.transaction().execute(async (trx) => {
        await sql`set local role mycel_worker`.execute(trx);
        await trx.updateTable('jobs').set({ done_at: new Date() }).where('id', '=', id).execute();
      });
      await operatorDb.destroy();
    }
  });
});
