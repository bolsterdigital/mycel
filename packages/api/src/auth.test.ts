import { describe, expect, it } from 'vitest';
import { DEFAULT_ACCESS, Invoker, buildRegistry, systemPrincipal, useCases } from '@mycel/core';
import {
  FakeClock,
  MemoryIdentityStore,
  MemoryTenants,
  MemoryUnitOfWork,
  probeTenant,
} from '@mycel/core/testing';
import { createApp } from './app.js';
import { createAuthenticator } from './auth.js';

const defaults = { entitlements: DEFAULT_ACCESS.entitlements, tenantStatus: DEFAULT_ACCESS.status };

const TENANT = '01900000-0000-7000-8000-00000000aaaa';

async function setup() {
  const clock = new FakeClock();
  const uow = new MemoryUnitOfWork({ clock });
  const identity = new MemoryIdentityStore(uow.store, new MemoryTenants([probeTenant(TENANT)]));
  const invoker = new Invoker(buildRegistry(), uow);
  const admin = systemPrincipal(TENANT, 'test');
  const key = await invoker.run(useCases.createKey, admin, {
    name: 'test',
    capabilities: ['content:read'],
  });
  const auth = createAuthenticator({
    identity,
    uow,
    clock,
    agentToken: key.token,
    sessionId: 'session-1',
  });
  const app = createApp({ invoker, authenticate: auth.authenticateApiKey });
  const lastUsed = async () =>
    (await invoker.run(useCases.listKeys, admin, {})).keys[0]?.lastUsedAt ?? null;
  return { clock, invoker, admin, key, auth, app, lastUsed };
}

describe('API keys from the table', () => {
  it('builds the principal from the row: its tenant, its id, its capabilities', async () => {
    const { auth, key } = await setup();
    expect(await auth.authenticateApiKey(`Bearer ${key.token}`)).toEqual({
      tenantId: TENANT,
      actor: { kind: 'api-key', keyId: key.id },
      capabilities: ['content:read'],
      ...defaults,
    });
    expect(await auth.agentPrincipal()).toEqual({
      tenantId: TENANT,
      actor: { kind: 'agent', sessionId: 'session-1', keyId: key.id },
      capabilities: ['content:read'],
      ...defaults,
    });
  });

  it('refuses unknown and revoked keys, over HTTP and for the agent, without a restart', async () => {
    const { app, auth, key, invoker, admin } = await setup();
    const get = (token: string) =>
      app.request('/v1/tenant.key.list', { headers: { authorization: `Bearer ${token}` } });
    expect((await get('mycel_nope')).status).toBe(401);
    // The key's own capabilities: content:read is not tenant:admin.
    expect((await get(key.token)).status).toBe(403);

    await invoker.run(useCases.revokeKey, admin, { id: key.id });
    expect((await get(key.token)).status).toBe(401);
    await expect(auth.agentPrincipal()).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('touches last_used_at after authenticating, at most once a minute', async () => {
    const { auth, key, clock, lastUsed } = await setup();
    expect(await lastUsed()).toBeNull();
    await auth.authenticateApiKey(`Bearer ${key.token}`);
    await new Promise((r) => setTimeout(r, 0));
    const first = await lastUsed();
    expect(first).toBe(clock.now().toISOString());
    clock.advance(30_000);
    await auth.authenticateApiKey(`Bearer ${key.token}`);
    await new Promise((r) => setTimeout(r, 0));
    expect(await lastUsed()).toBe(first);
    clock.advance(31_000);
    await auth.agentPrincipal();
    await new Promise((r) => setTimeout(r, 0));
    expect(await lastUsed()).toBe(clock.now().toISOString());
  });

  it('an agent without MYCEL_API_KEY gets a tool error, not a principal', async () => {
    const uow = new MemoryUnitOfWork();
    const bare = createAuthenticator({
      identity: new MemoryIdentityStore(uow.store, new MemoryTenants()),
      uow,
      clock: new FakeClock(),
      sessionId: 's',
    });
    await expect(bare.agentPrincipal()).rejects.toMatchObject({ code: 'forbidden' });
  });
});
