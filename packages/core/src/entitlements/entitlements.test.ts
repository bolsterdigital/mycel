// Entitlements (ADR 015, TODO #16): the document over the defaults, the two checks at their
// boundary, the four consumers, suspension through the Invoker, and the usage read model. The
// registry conformance proves separately that every `consumes` is checked.

import { beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  DEFAULT_ENTITLEMENTS,
  Invoker,
  UseCaseError,
  anonymousPrincipal,
  buildRegistry,
  defineUseCase,
  effectiveEntitlements,
  entitled,
  requireEntitled,
  supporterIngestSubscriber,
  systemPrincipal,
  useCases,
  withinLimit,
  type Entitlements,
  type Principal,
} from '../index.js';
import { CONFIRMATION_COOLDOWN_SECONDS } from '../forms/spam.js';
import { FakeClock, MemoryUnitOfWork, probeForm, probeTenant } from '../testing/index.js';

const TENANT = '01900000-0000-7000-8000-00000000aaaa';
const FORM = '01900000-0000-7000-8000-00000000f000';
const platform = {
  domain: 'mycel.site',
  devHosts: ['localhost'],
  platformOrigin: 'https://admin.example.org',
  siteUrlMode: 'hostnames' as const,
};

const admin = systemPrincipal(TENANT, 'test');
const limited = (overrides: Partial<Entitlements>, p: Principal = admin): Principal => ({
  ...p,
  entitlements: { ...DEFAULT_ENTITLEMENTS, ...overrides },
});
const suspended = (p: Principal = admin): Principal => ({ ...p, tenantStatus: 'suspended' });

const expectCode = async (p: Promise<unknown>, code: string) =>
  expect(p).rejects.toSatisfy((e) => e instanceof UseCaseError && e.code === code);

describe('the entitlements document', () => {
  it('is everything with generous limits when empty', () => {
    expect(effectiveEntitlements({})).toEqual(DEFAULT_ENTITLEMENTS);
    expect(effectiveEntitlements(null)).toEqual(DEFAULT_ENTITLEMENTS);
  });

  it('shows the footer credit by default (ADR 015 rule 5)', () => {
    expect(DEFAULT_ENTITLEMENTS.remove_branding).toBe(false);
    expect(entitled(systemPrincipal(TENANT, 'test'), 'remove_branding')).toBe(false);
  });

  it('takes known valid keys, ignores unknown ones and defaults the rest', () => {
    const e = effectiveEntitlements({
      remove_branding: true,
      'supporters.max': 250,
      'sites.max': 3,
      'future.feature': true,
      blocks: { hero: false, gallery: 'no' },
    });
    expect(e).toEqual({
      ...DEFAULT_ENTITLEMENTS,
      remove_branding: true,
      'supporters.max': 250,
      blocks: { hero: false },
    });
    expect(e).not.toHaveProperty('sites.max');
  });

  it('falls back to the default for a known key with a wrong type', () => {
    expect(effectiveEntitlements({ 'operators.max': '5', api_keys: 'yes' })).toEqual(
      DEFAULT_ENTITLEMENTS
    );
  });
});

describe('the checks', () => {
  it('reads switches and block types, a block being on unless it is false', () => {
    const p = limited({ api_keys: false, blocks: { hero: false } });
    expect(entitled(p, 'api_keys')).toBe(false);
    expect(entitled(p, 'custom_domain')).toBe(true);
    expect(entitled(p, 'blocks.hero')).toBe(false);
    expect(entitled(p, 'blocks.gallery')).toBe(true);
    expect(() => requireEntitled(p, 'api_keys')).toThrow(UseCaseError);
  });

  it('allows reaching a limit and refuses going past it', () => {
    const ctx = { principal: limited({ 'operators.max': 3 }) };
    expect(() => withinLimit(ctx, 'operators.max', 2)).not.toThrow();
    expect(() => withinLimit(ctx, 'operators.max', 3)).toThrow(/operators.max/);
    expect(() => withinLimit(ctx, 'operators.max', 1, 2)).not.toThrow();
    expect(() => withinLimit(ctx, 'operators.max', 1, 3)).toThrow(UseCaseError);
    try {
      withinLimit(ctx, 'operators.max', 3);
    } catch (e) {
      expect(e).toMatchObject({
        code: 'limit_exceeded',
        issues: [{ path: '', message: 'entitlements.limit.operators.max' }],
      });
    }
  });
});

describe('use cases that consume', () => {
  let clock: FakeClock;
  let uow: MemoryUnitOfWork;
  let invoker: Invoker;

  beforeEach(async () => {
    clock = new FakeClock();
    uow = new MemoryUnitOfWork({ clock, platform });
    uow.store.addPlatformHostname(probeTenant(TENANT), platform.domain, clock.now());
    await uow.run(admin, (ctx) => ctx.forms.insert(probeForm(FORM)));
    invoker = new Invoker(buildRegistry(), uow);
  });

  const submit = (email: string, principal: Principal) =>
    invoker.run(useCases.submitForm, principal, {
      formId: FORM,
      values: { email, consent: true },
      locale: 'nl',
    });

  it('forms.submit refuses a new address at the supporter cap and still takes a known one', async () => {
    const one = limited({ 'supporters.max': 1 });
    expect((await submit('a@example.org', one)).status).toBe('accepted');
    await uow.drain([supporterIngestSubscriber(uow)]);
    await expectCode(submit('b@example.org', one), 'limit_exceeded');
    // Past the recipient cooldown (one confirmation per address per day, brief form-intake).
    clock.advance(CONFIRMATION_COOLDOWN_SECONDS * 1000 + 1000);
    expect((await submit('A@example.org', one)).status).toBe('accepted');
  });

  it('forms.submit checks the cap only after the spam gate', async () => {
    const visitor = limited(
      { 'supporters.max': 0 },
      anonymousPrincipal(TENANT, ['forms:write'], 'ip')
    );
    const r = await invoker.run(useCases.submitForm, visitor, {
      formId: FORM,
      values: { email: 'a@example.org', consent: true },
      locale: 'nl',
      spam: { honeypot: 'bot' },
    });
    expect(r).toMatchObject({ status: 'rejected', reason: 'spam' });
  });

  // Review round 1, audit point 3: the projection grows only when the worker ingests, so the
  // cap counts reserved seats too (`ctx.admissions`).
  const seats = () =>
    uow.run(admin, async (ctx) => ({
      admissions: await ctx.admissions.count(),
      supporters: await ctx.usage.supporters(),
    }));

  it('forms.submit admits at most one new address per free seat while the worker stands still', async () => {
    const { supporters } = await seats();
    const capped = limited({ 'supporters.max': supporters + 1 });
    expect((await submit('a@example.org', capped)).status).toBe('accepted');
    await expectCode(submit('b@example.org', capped), 'limit_exceeded');
    // A retry of the same new address (after the recipient cooldown) keeps its seat and takes
    // no second one.
    clock.advance(CONFIRMATION_COOLDOWN_SECONDS * 1000 + 1000);
    expect((await submit('A@example.org', capped)).status).toBe('accepted');
    expect(await seats()).toEqual({ admissions: supporters + 1, supporters });

    await uow.drain([supporterIngestSubscriber(uow)]);
    // Ingest wrote the projection and released the seat in the same transaction.
    expect(await seats()).toEqual({ admissions: supporters + 1, supporters: supporters + 1 });
    expect(await uow.run(admin, (ctx) => ctx.admissions.pending('a@example.org'))).toBe(false);
  });

  it('forms.submit takes a known address at the cap without reserving a seat', async () => {
    await submit('known@example.org', admin);
    await uow.drain([supporterIngestSubscriber(uow)]);
    const { supporters } = await seats();
    const full = limited({ 'supporters.max': supporters });
    clock.advance(CONFIRMATION_COOLDOWN_SECONDS * 1000 + 1000);
    expect((await submit('known@example.org', full)).status).toBe('accepted');
    expect(await uow.run(admin, (ctx) => ctx.admissions.pending('known@example.org'))).toBe(false);
    expect(await seats()).toEqual({ admissions: supporters, supporters });
  });

  it('tenant.members.invite counts members and pending invitations against operators.max', async () => {
    const two = limited({ 'operators.max': 2 });
    const invite = (email: string) =>
      invoker.run(useCases.inviteMember, two, { email, capabilities: ['content:read'] });
    await invite('a@example.org');
    await invite('b@example.org');
    await expectCode(invite('c@example.org'), 'limit_exceeded');
  });

  it('tenant.keys.create needs the api_keys switch', async () => {
    const input = { name: 'Sync', capabilities: ['content:read' as const] };
    await expectCode(
      invoker.run(useCases.createKey, limited({ api_keys: false }), input),
      'limit_exceeded'
    );
    await expect(invoker.run(useCases.createKey, admin, input)).resolves.toHaveProperty('token');
  });

  it('tenant.hostnames.add needs custom_domain and stays within custom_domains.max', async () => {
    const add = (hostname: string, p: Principal) =>
      invoker.run(useCases.addHostname, p, { hostname });
    await expectCode(add('www.example.org', limited({ custom_domain: false })), 'limit_exceeded');
    const one = limited({ 'custom_domains.max': 1 });
    await add('www.example.org', one);
    await expectCode(add('example.org', one), 'limit_exceeded');
  });

  it('tenant.hostnames.add refuses the host of the platform origin', async () => {
    await expectCode(
      invoker.run(useCases.addHostname, admin, { hostname: 'Admin.Example.org' }),
      'invalid_input'
    );
  });
});

describe('a suspended tenant', () => {
  const exported = defineUseCase({
    name: 'supporters.list.export',
    kind: 'command',
    description: 'Export.',
    requires: 'supporters:export',
    effect: 'export',
    input: z.object({}),
    output: z.object({ ok: z.boolean() }),
    examples: [{ input: {} }],
    handler: async () => ({ ok: true }),
  });
  let uow: MemoryUnitOfWork;
  let invoker: Invoker;

  beforeEach(async () => {
    uow = new MemoryUnitOfWork({ platform });
    uow.store.addPlatformHostname(probeTenant(TENANT), platform.domain);
    await uow.run(admin, (ctx) => ctx.forms.insert(probeForm(FORM)));
    const registry = buildRegistry();
    registry.register(exported);
    invoker = new Invoker(registry, uow);
  });

  it('refuses commands before authorization, even from a principal without the capability', async () => {
    await expectCode(
      invoker.run(useCases.inviteMember, suspended(), {
        email: 'a@example.org',
        capabilities: ['content:read'],
      }),
      'suspended'
    );
    const visitor = suspended(anonymousPrincipal(TENANT, ['forms:write'], 'ip'));
    await expectCode(
      invoker.run(useCases.submitForm, visitor, {
        formId: FORM,
        values: { email: 'a@example.org', consent: true },
        locale: 'nl',
      }),
      'suspended'
    );
    // Suspension answers first; an export still needs its own capability.
    await expectCode(
      invoker.run(useCases.inviteMember, suspended({ ...admin, capabilities: [] }), {
        email: 'a@example.org',
        capabilities: ['content:read'],
      }),
      'suspended'
    );
    await expectCode(
      invoker.call(suspended({ ...admin, capabilities: [] }), exported.name, {}),
      'forbidden'
    );
  });

  it('still answers queries and runs export commands', async () => {
    await expect(invoker.run(useCases.getForm, suspended(), { id: FORM })).resolves.toBeTruthy();
    await expect(invoker.run(useCases.getUsage, suspended(), {})).resolves.toMatchObject({
      status: 'suspended',
    });
    await expect(invoker.call(suspended(), exported.name, {})).resolves.toEqual({ ok: true });
  });
});

describe('tenant.usage and tenant.entitlements.get', () => {
  it('count this tenant only and show the effective limits', async () => {
    const clock = new FakeClock(new Date('2026-10-21T12:00:00.000Z'));
    const uow = new MemoryUnitOfWork({ clock, platform });
    uow.store.addPlatformHostname(probeTenant(TENANT), platform.domain);
    const other = systemPrincipal('01900000-0000-7000-8000-00000000bbbb', 'test');
    const all = new Invoker(buildRegistry(), uow);
    await all.run(useCases.inviteMember, admin, {
      email: 'a@example.org',
      capabilities: ['content:read'],
    });
    await all.run(useCases.inviteMember, other, {
      email: 'b@example.org',
      capabilities: ['content:read'],
    });
    await all.run(useCases.addHostname, admin, { hostname: 'www.example.org' });
    const t = uow.store.for(TENANT).mailSends;
    const send = (key: string, sentAt: Date | null) =>
      t.set(key, {
        key,
        subscriber: 's',
        eventId: key,
        attemptedAt: sentAt,
        sentAt,
        providerId: null,
        lastError: null,
      } as never);
    send('this-month', new Date('2026-10-01T00:00:00.000Z'));
    send('last-month', new Date('2026-09-30T23:59:59.000Z'));
    send('unsent', null);

    const p = limited({ 'operators.max': 5 });
    expect(await all.run(useCases.getUsage, p, {})).toEqual({
      supporters: { used: 0, max: 100_000 },
      mail: { usedThisMonth: 1, max: 1_000_000 },
      storage: { usedBytes: 0, maxBytes: 50 * 1024 ** 3 },
      operators: { used: 1, max: 5 },
      customDomains: { used: 1, max: 20 },
      status: 'active',
    });
    expect(await all.run(useCases.getEntitlements, p, {})).toEqual({
      ...DEFAULT_ENTITLEMENTS,
      'operators.max': 5,
    });
  });
});
