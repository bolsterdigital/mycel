// The handler registry over in-memory ports: a tenant job runs in its tenant's unit of work as a
// system principal with the tenant's current status, a platform job never runs with a tenant,
// and every job type has a handler.
// The platform handlers' SQL is proven in packages/db/src/jobs.conformance.test.ts.

import { describe, expect, it } from 'vitest';
import {
  JobPayloads,
  UseCaseError,
  requireActive,
  type JobRecord,
  type Principal,
} from '@mycel/core';
import {
  FakeClock,
  MemoryIdentityStore,
  MemoryTenants,
  MemoryUnitOfWork,
  probeTenant,
} from '@mycel/core/testing';
import type { createDb } from '@mycel/db';
import { RECURRING_JOBS, jobHandlers, tenantJob } from './jobs.js';

const TENANT = '01900000-0000-7000-8000-00000000aaaa';
// The platform handlers are not called here; the registry only needs the connection's shape.
const operatorDb = {} as ReturnType<typeof createDb>;

const job = (over: Partial<JobRecord>): JobRecord => ({
  id: 'j',
  tenantId: TENANT,
  type: 'hostnames.reverify',
  key: `hostnames.reverify:${TENANT}:www.example.org`,
  runAt: new Date(),
  payload: { hostname: 'www.example.org' },
  attempts: 1,
  maxAttempts: 10,
  claimedAt: new Date(),
  doneAt: null,
  lastError: null,
  createdAt: new Date(),
  ...over,
});

describe('job handlers', () => {
  const clock = new FakeClock();
  const uow = new MemoryUnitOfWork({ clock });
  uow.store.addPlatformHostname(probeTenant(TENANT), 'localhost');
  const identity = new MemoryIdentityStore(uow.store, new MemoryTenants());
  const handlers = jobHandlers({ uow, operatorDb, identity });

  it('has a handler for every job type, and plans only platform types itself', () => {
    expect(Object.keys(handlers).sort()).toEqual(Object.keys(JobPayloads).sort());
    for (const r of RECURRING_JOBS) expect(Object.keys(JobPayloads)).toContain(r.type);
  });

  it('runs a tenant job in its tenant, and refuses one without a tenant or with a bad payload', async () => {
    // The hostname is gone (never added): done, nothing planned.
    expect(await handlers['hostnames.reverify']!(job({}))).toEqual({});
    await expect(handlers['hostnames.reverify']!(job({ tenantId: null }))).rejects.toThrow(
      /tenant job/
    );
    await expect(handlers['hostnames.reverify']!(job({ payload: {} }))).rejects.toThrow();
  });

  it('refuses a platform job that carries a tenant', async () => {
    for (const type of ['events.partitions', 'rate_limits.sweep'])
      await expect(handlers[type]!(job({ type, payload: {} }))).rejects.toThrow(/platform job/);
  });

  // Review round 1 of TODO #16, audit point 4: a scheduled publication must see a suspension
  // that happened after it was planned, so the principal carries the status of the moment.
  it("gives a tenant job the tenant's current status, which requireActive refuses when suspended", async () => {
    const seen: Principal[] = [];
    const handler = tenantJob({ uow, identity }, 'hostnames.reverify', async (ctx) => {
      seen.push(ctx.principal);
      requireActive(ctx.principal);
      return {};
    });

    uow.store.setAccess(TENANT, { status: 'suspended' });
    await expect(handler(job({}))).rejects.toSatisfy(
      (e) => e instanceof UseCaseError && e.code === 'suspended'
    );
    expect(seen.at(-1)?.tenantStatus).toBe('suspended');

    uow.store.setAccess(TENANT, { status: 'active', entitlements: { 'supporters.max': 7 } });
    await expect(handler(job({}))).resolves.toEqual({});
    expect(seen.at(-1)).toMatchObject({
      tenantStatus: 'active',
      entitlements: { 'supporters.max': 7 },
    });
  });
});
