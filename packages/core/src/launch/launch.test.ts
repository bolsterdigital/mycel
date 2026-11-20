// The launch checklist over the memory store (ADR 037): the checks as pure functions with a pass,
// warn and fail fixture each, and the use cases for what applies, what counts as complete, when a
// site is ready, and that a site only sees and changes its own list. The Postgres half (RLS, the
// upsert, the fixed number of queries) is in packages/db/src/launch/launch.test.ts.

import { beforeEach, describe, expect, it } from 'vitest';
import { Invoker } from '../invoke.js';
import type { Principal } from '../principal.js';
import { FakeClock, MemoryUnitOfWork, TENANT, expectCode, principal } from '../testing/index.js';
import { exampleId } from '../util/ids.js';
import { buildRegistry, useCases } from '../use-cases.js';
import { LAUNCH_CHECKS, type LaunchFacts } from './evaluate.js';
import type { LaunchChecklist } from './model.js';
import { LAUNCH_STEPS, LaunchCheck } from './steps.js';

const facts = (over: Partial<LaunchFacts> = {}): LaunchFacts => ({
  home: { locales: ['nl', 'en'], published: ['nl', 'en'] },
  members: [{ role: 'admin', pending: false }],
  forms: [{ id: 'f1', label: 'Contact', notifies: true }],
  mollie: { connected: true, mode: 'live' },
  analytics: { domain: 'example.org', hostnameMismatch: false },
  hostnames: [
    { hostname: 'site.mycel.test', kind: 'platform', primary: false, verified: true },
    { hostname: 'example.org', kind: 'custom', primary: true, verified: true },
  ],
  ops: { jobs: 0, mails: 0, erasures: 0 },
  ...over,
});

describe('launch checks', () => {
  const run = (check: LaunchCheck, over: Partial<LaunchFacts>) => LAUNCH_CHECKS[check](facts(over));

  it('passes every check on a site that is ready', () => {
    for (const check of LaunchCheck.options) expect(run(check, {}).result, check).toBe('pass');
  });

  it.each([
    ['home-published', { home: { locales: [], published: [] } }, 'fail', 'home-published.missing'],
    [
      'home-published',
      { home: { locales: ['nl'], published: [] } },
      'fail',
      'home-published.unpublished',
    ],
    [
      'home-published',
      { home: { locales: ['nl', 'en'], published: ['nl'] } },
      'warn',
      'home-published.partly',
    ],
    ['team-ready', { members: [{ role: 'admin', pending: true }] }, 'fail', 'team-ready.nobody'],
    ['team-ready', { members: [{ role: 'author', pending: false }] }, 'fail', 'team-ready.nobody'],
    [
      'team-ready',
      {
        members: [
          { role: 'editor', pending: false },
          { role: 'admin', pending: true },
        ],
      },
      'warn',
      'team-ready.pending',
    ],
    ['form-notifications', { forms: [] }, 'pass', 'form-notifications.none'],
    [
      'form-notifications',
      { forms: [{ id: 'f2', label: null, notifies: false }] },
      'warn',
      'form-notifications.silent',
    ],
    ['payments-connected', { mollie: null }, 'fail', 'payments-connected.missing'],
    [
      'payments-connected',
      { mollie: { connected: false, mode: null } },
      'fail',
      'payments-connected.attention',
    ],
    ['mollie-live', { mollie: null }, 'fail', 'mollie-live.missing'],
    ['mollie-live', { mollie: { connected: true, mode: 'test' } }, 'fail', 'mollie-live.test'],
    ['mollie-live', { mollie: { connected: true, mode: null } }, 'warn', 'mollie-live.unknown'],
    [
      'analytics',
      { analytics: { domain: null, hostnameMismatch: false } },
      'warn',
      'analytics.off',
    ],
    [
      'analytics',
      { analytics: { domain: 'old.org', hostnameMismatch: true } },
      'warn',
      'analytics.mismatch',
    ],
    ['custom-domain', { hostnames: [] }, 'fail', 'custom-domain.missing'],
    [
      'custom-domain',
      { hostnames: [{ hostname: 'example.org', kind: 'custom', primary: true, verified: false }] },
      'fail',
      'custom-domain.unverified',
    ],
    [
      'custom-domain',
      { hostnames: [{ hostname: 'example.org', kind: 'custom', primary: false, verified: true }] },
      'warn',
      'custom-domain.not-primary',
    ],
    ['ops-healthy', { ops: { jobs: 2, mails: 0, erasures: 1 } }, 'warn', 'ops-healthy.attention'],
  ] as const)('%s: %o gives %s', (check, over, result, code) => {
    const outcome = run(check, over as Partial<LaunchFacts>);
    expect(outcome.result).toBe(result);
    expect(outcome.detail.code).toBe(code);
  });

  it('names the forms without a notification and the kinds that ask for attention', () => {
    expect(
      run('form-notifications', {
        forms: [
          { id: 'f1', label: 'Contact', notifies: true },
          { id: 'f2', label: 'Petitie', notifies: false },
        ],
      }).detail
    ).toEqual({
      code: 'form-notifications.silent',
      params: { count: '1' },
      subjects: [{ id: 'f2', label: 'Petitie' }],
    });
    expect(run('ops-healthy', { ops: { jobs: 2, mails: 0, erasures: 1 } }).detail.params).toEqual({
      jobs: '2',
      erasures: '1',
    });
  });

  it('has an evaluation for every check step, and unique step ids', () => {
    const ids = LAUNCH_STEPS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(LAUNCH_STEPS.flatMap((s) => (s.check ? [s.check] : [])).sort()).toEqual(
      [...LaunchCheck.options].sort()
    );
  });
});

describe('launch checklist', () => {
  let clock: FakeClock;
  let uow: MemoryUnitOfWork;
  let invoker: Invoker;
  const admin = (entitlements = {}) => principal({ entitlements });

  const get = (p: Principal = admin()) => invoker.run(useCases.getLaunchChecklist, p, {});
  const update = (input: Record<string, unknown>, p: Principal = admin()) =>
    invoker.run(useCases.updateLaunchStep, p, input as never);
  const step = (list: LaunchChecklist, id: string) =>
    list.phases.flatMap((p) => p.steps).find((s) => s.id === id)!;

  beforeEach(() => {
    clock = new FakeClock();
    uow = new MemoryUnitOfWork({ clock });
    invoker = new Invoker(buildRegistry(), uow);
  });

  it('lists every step in three phases, with checks evaluated and nothing stored', async () => {
    const list = await get();
    expect(list.phases.map((p) => p.phase)).toEqual(['prepare', 'launch', 'after']);
    expect(list.phases.flatMap((p) => p.steps).map((s) => s.id)).toEqual(
      LAUNCH_STEPS.map((s) => s.id)
    );
    // An empty site: no home page, no team, no domain.
    expect(step(list, 'home-published')).toMatchObject({ status: 'fail', complete: false });
    expect(step(list, 'go-no-go')).toMatchObject({
      status: 'open',
      kind: 'manual',
      updatedAt: null,
    });
    expect(list.ready).toBe(false);
    expect(list.blocking).toContain('home-published');
    expect(uow.store.for(TENANT).launchSteps.size).toBe(0);
  });

  it('leaves a step out when the site lacks its feature, and a person can switch it back on', async () => {
    const without = admin({ 'donations.enabled': false });
    let list = await get(without);
    expect(step(list, 'test-donation')).toMatchObject({
      applicable: false,
      applicableSource: 'entitlement',
      status: 'na',
    });
    expect(list.blocking).not.toContain('test-donation');

    list = await update({ stepId: 'test-donation', applicable: true }, without);
    expect(step(list, 'test-donation')).toMatchObject({
      applicable: true,
      applicableSource: 'override',
      status: 'open',
    });
    expect(list.blocking).toContain('test-donation');

    list = await update({ stepId: 'test-donation', applicable: null }, without);
    expect(step(list, 'test-donation').applicableSource).toBe('entitlement');
  });

  it('keeps a note and another owner, and changes only what the patch names', async () => {
    await update({ stepId: 'go-no-go', note: 'Bestuur besluit op 3 december.', owner: 'shared' });
    clock.advance(60_000);
    const list = await update({ stepId: 'go-no-go', done: true });
    expect(step(list, 'go-no-go')).toMatchObject({
      status: 'done',
      complete: true,
      note: 'Bestuur besluit op 3 december.',
      owner: 'shared',
      ownerOverridden: true,
      updatedAt: clock.now().toISOString(),
    });
    const reset = await update({ stepId: 'go-no-go', owner: null });
    expect(step(reset, 'go-no-go')).toMatchObject({
      owner: 'organisation',
      ownerOverridden: false,
    });
  });

  it('counts an accepted warning as complete, never an accepted failure', async () => {
    // Analytics off is a warning; an empty site has no home page, which fails.
    let list = await update({ stepId: 'analytics', acknowledged: true });
    expect(step(list, 'analytics')).toMatchObject({
      status: 'warn',
      acknowledged: true,
      complete: true,
    });
    list = await update({ stepId: 'home-published', acknowledged: true });
    expect(step(list, 'home-published')).toMatchObject({ status: 'fail', complete: false });
    expect(list.blocking).toContain('home-published');
  });

  it('is ready once every applicable step before and on the day is complete, whatever is after', async () => {
    const p = admin({ 'donations.enabled': false, 'mailing.enabled': false, custom_domain: false });
    for (const s of LAUNCH_STEPS.filter((x) => x.phase !== 'after')) {
      const input = s.check ? { stepId: s.id, applicable: false } : { stepId: s.id, done: true };
      await update(input, p);
    }
    const list = await get(p);
    expect(list.blocking).toEqual([]);
    expect(list.ready).toBe(true);
    const after = list.phases.find((x) => x.phase === 'after')!;
    expect(after.complete).toBe(0);
    expect(after.total).toBeGreaterThan(0);
  });

  it('refuses an unknown step and an overlong note', async () => {
    await expectCode(
      update({ stepId: 'flux-capacitor', done: true }),
      'invalid_input',
      'launch.step.unknown'
    );
    await expectCode(update({ stepId: 'go-no-go', note: 'x'.repeat(1001) }), 'invalid_input');
  });

  it('is for site administrators only, and each site sees its own list', async () => {
    const editor = principal({
      capabilities: ['content:read', 'content:write', 'content:publish'],
    });
    await expectCode(get(editor), 'forbidden');
    await expectCode(update({ stepId: 'go-no-go', done: true }, editor), 'forbidden');

    await update({ stepId: 'go-no-go', done: true, note: 'eigen site' });
    const other = await get(principal({ tenantId: exampleId(0xbbbb) }));
    expect(step(other, 'go-no-go')).toMatchObject({ status: 'open', note: '' });
  });
});
