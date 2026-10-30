// The real composition root against Postgres (TODO #7, fundamentcheck 2026-10-21): principals
// built by `createRuntime` from `api_keys` rows through the mycel_authenticator login, not
// injected into the registry. A key works over HTTP and for the agent, and stops working on the
// next request once revoked, in the same running process.
//
// Skips without the three database URLs; in CI that is a failure.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { systemPrincipal, useCases } from '@mycel/core';
import { createDb } from '@mycel/db';
import { requireDatabase, testTenant, migrateSchema } from '@mycel/db/testing';
import { runSuffix } from '@mycel/core/testing';
import { createApp } from './app.js';
import { createRuntime, loadConfig, type Runtime } from './runtime/compose.js';

const env = process.env;
const { skip } = requireDatabase('app', 'auth');

describe.skipIf(skip)('API keys through the composition root', () => {
  const operatorDb = createDb(env['DATABASE_URL'] ?? '');
  let runtime: Runtime | undefined;
  let tenantId = '';

  beforeAll(async () => {
    await migrateSchema(env['DATABASE_URL']!);
    tenantId = (
      await testTenant(operatorDb, `auth-${runSuffix()}`, {
        name: 'Auth',
      })
    ).id;
  });

  afterAll(async () => {
    await runtime?.close();
    await operatorDb.destroy();
  });

  it('authenticates HTTP and the agent from the row and refuses both after revocation', async () => {
    const config = (token?: string) =>
      loadConfig({
        ...env,
        SIGNING_SECRET: env['SIGNING_SECRET'] ?? 'conformance-signing-secret',
        PUBLIC_BASE_URL: env['PUBLIC_BASE_URL'] ?? 'http://127.0.0.1:4173',
        MAIL_FROM: env['MAIL_FROM'] ?? 'noreply@example.org',
        MAILER: 'console',
        MAIL_SPOOL_DIR: undefined,
        MYCEL_API_KEY: token,
        PLATFORM_DOMAIN: env['PLATFORM_DOMAIN'] ?? 'localhost',
      });
    const admin = systemPrincipal(tenantId, 'conformance');
    const setup = createRuntime(config());
    const key = await setup.invoker.run(useCases.createKey, admin, {
      name: 'conformance',
      capabilities: ['content:read'],
    });
    await setup.close();

    runtime = createRuntime(config(key.token));
    const app = createApp({ invoker: runtime.invoker, authenticate: runtime.authenticateApiKey });
    const get = () =>
      app.request('/v1/content.published.get?type=page&slug=nothing-here', {
        headers: { authorization: `Bearer ${key.token}` },
      });

    // 404: authenticated and authorised, the page just does not exist in this tenant.
    expect((await get()).status).toBe(404);
    expect(await runtime.agentPrincipal()).toMatchObject({
      tenantId,
      actor: { kind: 'agent', keyId: key.id },
      capabilities: ['content:read'],
    });
    const noAdmin = await app.request('/v1/tenant.key.list', {
      headers: { authorization: `Bearer ${key.token}` },
    });
    expect(noAdmin.status).toBe(403);

    await runtime.invoker.run(useCases.revokeKey, admin, { id: key.id });
    expect((await get()).status).toBe(401);
    await expect(runtime.agentPrincipal()).rejects.toMatchObject({ code: 'forbidden' });
  });
});
