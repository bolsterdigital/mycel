// The re-verification policy of brief #15 decision 8, and how use cases plan it: in-memory ports
// only. Claiming, leases and the role split are Postgres properties (jobs.test.ts).

import { beforeEach, describe, expect, it } from 'vitest';
import {
  Invoker,
  REVERIFY_INTERVAL_MS,
  buildRegistry,
  reverifyHostname,
  systemPrincipal,
  useCases,
  type JobOutcome,
} from '../index.js';
import {
  FakeClock,
  FakeDns,
  MemoryScheduler,
  MemoryUnitOfWork,
  probeTenant,
  TENANT,
} from '../testing/index.js';
import { hostedPlatform } from '../testing/fixtures.js';

const OTHER = '01900000-0000-7000-8000-00000000bbbb';
const platform = hostedPlatform;
const HOST = 'www.example.org';
const DAY = REVERIFY_INTERVAL_MS;

describe('hostname re-verification', () => {
  let clock: FakeClock;
  let dns: FakeDns;
  let uow: MemoryUnitOfWork;
  let invoker: Invoker;
  const admin = systemPrincipal(TENANT, 'test');
  const job = systemPrincipal(TENANT, 'jobs:hostnames.reverify');

  beforeEach(() => {
    clock = new FakeClock();
    dns = new FakeDns();
    uow = new MemoryUnitOfWork({ clock, dns, platform });
    uow.store.addPlatformHostname(probeTenant(TENANT), platform.domain, clock.now());
    invoker = new Invoker(buildRegistry(), uow);
  });

  const hostnames = () => [...uow.store.for(TENANT).hostnames.values()];
  const row = (name = HOST) => uow.store.for(TENANT).hostnames.get(name)!;
  const run = (hostname = HOST): Promise<JobOutcome> =>
    uow.run(job, (ctx) => reverifyHostname(ctx, { hostname }));
  /** Add, publish the token, verify and make primary: a live custom domain. */
  async function live(): Promise<void> {
    const added = await invoker.run(useCases.addHostname, admin, { hostname: HOST });
    dns.txtRecords.set(added.dns!.txt.name, [added.dns!.txt.value]);
    await invoker.run(useCases.verifyHostname, admin, { hostname: HOST });
    await invoker.run(useCases.setPrimaryHostname, admin, { hostname: HOST });
  }
  /** Advance a day and run the job, as the worker would. */
  const nextDay = async () => {
    clock.advance(DAY);
    return run();
  };

  it('plans one re-check a day ahead when a domain is added; verify plans nothing new', async () => {
    await invoker.run(useCases.addHostname, admin, { hostname: HOST });
    await invoker.run(useCases.verifyHostname, admin, { hostname: HOST });
    clock.advance(60_000);
    await invoker.run(useCases.verifyHostname, admin, { hostname: HOST });
    expect(uow.store.jobs).toEqual([
      expect.objectContaining({
        tenantId: TENANT,
        type: 'hostnames.reverify',
        key: `hostnames.reverify:${TENANT}:${HOST}`,
        runAt: new Date(new FakeClock().now().getTime() + DAY),
        payload: { hostname: HOST },
        doneAt: null,
      }),
    ]);
  });

  it('keeps re-checking a hostname that moves to another site while the old job is open', async () => {
    uow.store.addPlatformHostname(probeTenant(OTHER), platform.domain, clock.now());
    const other = systemPrincipal(OTHER, 'test');
    await invoker.run(useCases.addHostname, admin, { hostname: HOST });
    await invoker.run(useCases.removeHostname, admin, { hostname: HOST });
    // The first site's job still holds its key; the second site's add must plan its own.
    await invoker.run(useCases.addHostname, other, { hostname: HOST });
    expect(uow.store.jobs.map((j) => j.tenantId)).toEqual([TENANT, OTHER]);

    clock.advance(DAY);
    expect(await run()).toEqual({});
    const outcome = await uow.run(systemPrincipal(OTHER, 'jobs:hostnames.reverify'), (ctx) =>
      reverifyHostname(ctx, { hostname: HOST })
    );
    expect(outcome.next).toEqual(new Date(clock.now().getTime() + DAY));
  });

  it('resets the run of failures and records the check when the token is found', async () => {
    await live();
    row().checkFailures = 2;
    const outcome = await nextDay();
    expect(row()).toMatchObject({ checkFailures: 0, lastCheckedAt: clock.now(), primary: true });
    expect(row().verifiedAt).not.toBeNull();
    expect(outcome).toEqual({ next: new Date(clock.now().getTime() + DAY) });
  });

  it('keeps the verification through two misses and withdraws it on the third', async () => {
    await live();
    dns.txtRecords.clear();
    await nextDay();
    await nextDay();
    expect(row()).toMatchObject({ checkFailures: 2, primary: true });
    expect(row().verifiedAt).not.toBeNull();

    const outcome = await nextDay();
    expect(row()).toMatchObject({ checkFailures: 3, verifiedAt: null, primary: false });
    // ADR 014 rule 2: the platform hostname serves the site again.
    expect(hostnames().find((h) => h.primary)?.hostname).toBe('probe.mycel.site');
    // Still planned: the record may come back.
    expect(outcome.next).toEqual(new Date(clock.now().getTime() + DAY));
  });

  it('withdraws a non-primary domain without touching the primary', async () => {
    await live();
    await invoker.run(useCases.setPrimaryHostname, admin, { hostname: 'probe.mycel.site' });
    dns.txtRecords.clear();
    for (let i = 0; i < 3; i++) await nextDay();
    expect(row()).toMatchObject({ verifiedAt: null, primary: false });
    expect(hostnames().find((h) => h.primary)?.hostname).toBe('probe.mycel.site');
  });

  it('verifies a withdrawn domain again at the next check once its record is back', async () => {
    await live();
    const token = row().verificationToken!;
    dns.txtRecords.clear();
    for (let i = 0; i < 3; i++) await nextDay();
    expect(row().verifiedAt).toBeNull();
    dns.txtRecords.set(`_mycel-verify.${HOST}`, [token]);
    await nextDay();
    expect(row()).toMatchObject({ verifiedAt: clock.now(), checkFailures: 0 });
    // Primary is the admin's choice again; nothing switches back by itself.
    expect(row().primary).toBe(false);
  });

  it('counts nothing when DNS does not answer, and plans the next check', async () => {
    await live();
    dns.txtRecords.clear();
    await nextDay();
    dns.unavailable.add(`_mycel-verify.${HOST}`);
    for (let i = 0; i < 3; i++) expect((await nextDay()).next).toBeDefined();
    expect(row()).toMatchObject({ checkFailures: 1, primary: true });
    expect(row().verifiedAt).not.toBeNull();
  });

  it('does not count a second miss for a run right after a recorded check', async () => {
    await live();
    dns.txtRecords.clear();
    await nextDay();
    const checkedAt = row().lastCheckedAt!;
    clock.advance(5 * 60_000);
    // A worker that died after the handler committed: the lease frees the job five minutes later.
    expect(await run()).toEqual({ next: new Date(checkedAt.getTime() + DAY) });
    expect(row().checkFailures).toBe(1);
  });

  it('is done without a next run when the hostname was removed', async () => {
    await invoker.run(useCases.addHostname, admin, { hostname: HOST });
    await invoker.run(useCases.removeHostname, admin, { hostname: HOST });
    expect(await nextDay()).toEqual({});
    expect(await run('probe.mycel.site')).toEqual({});
  });

  it('answers checked: false from the admin check when DNS does not answer', async () => {
    await invoker.run(useCases.addHostname, admin, { hostname: HOST });
    dns.unavailable.add(HOST);
    const r = await invoker.run(useCases.verifyHostname, admin, { hostname: HOST });
    expect(r).toMatchObject({ checked: false, verified: false, verifiedAt: null });
    expect(row()).toMatchObject({ checkFailures: 0, lastCheckedAt: null });
  });

  it('shows the last check and the failures in the list', async () => {
    await live();
    dns.txtRecords.clear();
    await nextDay();
    const listed = (await invoker.run(useCases.listHostnames, admin, {})).hostnames;
    expect(listed.find((h) => h.hostname === HOST)).toMatchObject({
      lastCheckedAt: clock.now().toISOString(),
      checkFailures: 1,
    });
  });
});

describe('MemoryScheduler', () => {
  it('keeps one open job per key across tenants and lets a finished one be planned again', async () => {
    const uow = new MemoryUnitOfWork();
    const a = new MemoryScheduler(uow.store, TENANT);
    const b = new MemoryScheduler(uow.store, OTHER);
    const job = {
      type: 'hostnames.reverify' as const,
      key: `hostnames.reverify:${HOST}`,
      runAt: new Date(),
      payload: { hostname: HOST },
    };
    expect(await a.enqueue(job)).toBe(true);
    expect(await a.enqueue(job)).toBe(false);
    expect(await b.enqueue(job)).toBe(false);
    uow.store.jobs[0]!.doneAt = new Date();
    expect(await a.enqueue(job)).toBe(true);
    expect(uow.store.jobs.filter((j) => j.doneAt === null)).toHaveLength(1);
  });
});
