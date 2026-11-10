// The erasure register in memory (ADR 019 rule 8, TODO #18d): the same contract as
// packages/db/src/erasures.conformance.test.ts over Postgres, so a suite on MemoryUnitOfWork
// sees what production does. A signup gives every kind of copy: the submission, the outbox
// event, the event log and projection after ingest, and the confirmation's intent and job.

import { beforeEach, describe, expect, it } from 'vitest';
import { Invoker } from '../invoke.js';
import { systemPrincipal } from '../principal.js';
import { buildRegistry, useCases } from '../use-cases.js';
import {
  FakeClock,
  MemoryMailer,
  MemoryTenants,
  MemoryUnitOfWork,
  probeForm,
  probeTenant,
  secureErasures,
  TENANT,
  adminOf,
} from '../testing/index.js';
import { sendOnce } from '../mailing/send-attempts.js';
import { confirmationMailSubscriber } from '../mailing/confirmation.js';
import { ingest, supporterIngestSubscriber, toSupporterEvent } from './service.js';
import { emailKey } from './email-key.js';
import { carriesErasedAddress, tombstoneEmail } from './erasure.js';

const OTHER = '01900000-0000-7000-8000-00000000bbbb';
const FORM = '01900000-0000-7000-8000-00000000f000';

describe('ctx.erasures in memory', () => {
  let uow: MemoryUnitOfWork;

  async function signup(tenant: string, email: string) {
    const start = uow.store.outbox.length;
    const invoker = new Invoker(buildRegistry(), uow);
    await uow.run(adminOf(tenant), (ctx) => ctx.forms.insert(probeForm(FORM)));
    const result = await invoker.run(useCases.submitForm, adminOf(tenant), {
      formId: FORM,
      values: { email, consent: true },
      locale: 'nl',
    });
    if (result.status !== 'accepted') throw new Error(result.status);
    const mail = confirmationMailSubscriber({
      mailer: new MemoryMailer(),
      signer: uow.signer,
      clock: uow.clock,
      tenants: new MemoryTenants([probeTenant(TENANT), probeTenant(OTHER)]),
      uow,
      from: { email: 'noreply@example.org' },
      platform: { platformOrigin: 'https://example.org', siteUrlMode: 'path' },
    });
    // Handled, not drained: the outbox keeps its events, as processed rows stay in Postgres.
    for (const event of uow.store.outbox.slice(start).filter((e) => e.tenantId === tenant)) {
      await supporterIngestSubscriber(uow).handle(event);
      await mail.handle(event);
    }
  }
  const copies = (tenant: string, email: string) => {
    const s = uow.store.for(tenant);
    const text = (v: unknown) => JSON.stringify(v).toLowerCase().includes(email);
    return {
      events: [...s.events.values()].filter(text).length,
      supporters: [...s.projections.values()].filter(text).length,
      submissions: [...s.submissions.values()].filter(text).length,
      outbox: uow.store.outbox.filter((e) => e.tenantId === tenant && text(e)).length,
      jobs: uow.store.jobs.filter((j) => j.tenantId === tenant && text(j)).length,
      erasures: [...s.erasures.values()].filter(text).length,
    };
  };
  const none = { events: 0, supporters: 0, submissions: 0, outbox: 0, jobs: 0, erasures: 0 };

  beforeEach(async () => {
    uow = new MemoryUnitOfWork({ clock: new FakeClock() });
    await signup(TENANT, 'ada@example.org');
    await signup(OTHER, 'ada@example.org');
  });

  it('registers the hash, never the address, once per supporter', async () => {
    const id = (await uow.run(adminOf(), (ctx) => ctx.supporters.getProjection('ada@example.org')))!
      .id;
    await uow.run(adminOf(), (ctx) => ctx.erasures.register(id, 'Ada@Example.org'));
    await uow.run(adminOf(), (ctx) => ctx.erasures.register(id, 'ada@example.org'));
    const register = uow.store.for(TENANT).erasures;
    expect(register.size).toBe(1);
    expect(register.get(id)?.emailHash).toBe(await emailKey(TENANT, 'ada@example.org', 'erasure'));
    expect(copies(TENANT, 'ada@example.org').erasures).toBe(0);
  });

  it('applies to every copy in the tenant, keeps the event count and is idempotent', async () => {
    const s = uow.store.for(TENANT);
    const id = (await uow.run(adminOf(), (ctx) => ctx.supporters.getProjection('ada@example.org')))!
      .id;
    const events = s.events.size;
    expect(s.mailSends.size).toBe(1);
    expect(copies(TENANT, 'ada@example.org')).toMatchObject({
      events: events,
      supporters: 1,
      submissions: 1,
    });

    await uow.run(adminOf(), (ctx) => ctx.erasures.register(id, 'ada@example.org'));
    expect(await uow.run(adminOf(), (ctx) => ctx.erasures.apply())).toBeGreaterThan(0);
    expect(copies(TENANT, 'ada@example.org')).toEqual(none);
    expect(s.events.size).toBe(events);
    expect([...s.events.values()].every((e) => e.email === tombstoneEmail(id))).toBe(true);
    expect(s.projections.get(id)).toMatchObject({ email: tombstoneEmail(id), lists: [] });
    expect(s.mailSends.size).toBe(0);
    expect(uow.store.jobs.filter((j) => j.tenantId === TENANT)).toEqual([]);

    expect(await uow.run(adminOf(), (ctx) => ctx.erasures.apply())).toBe(0);
    // The other tenant's supporter with the same address is untouched.
    expect(copies(OTHER, 'ada@example.org')).toMatchObject({ supporters: 1, submissions: 1 });
  });

  it('keeps prefix and domain-suffix neighbours with all their dependent copies', async () => {
    const neighbours = ['joada@example.org', 'ada@example.org.evil'];
    for (const address of neighbours) await signup(TENANT, address);
    for (const address of ['ada@example.org', ...neighbours]) {
      const job = uow.store.jobs.find((row) => row.tenantId === TENANT)!;
      uow.store.jobs.push({
        ...job,
        id: uow.ids.next(),
        key: uow.ids.next(),
        payload: { nested: [`Contact (${address}), please`] },
      });
      const event = uow.store.outbox.find((row) => row.tenantId === TENANT)!;
      uow.store.outbox.push({
        ...event,
        id: uow.ids.next(),
        type: 'form.mail.planned',
        props: { nested: [`Contact (${address}), please`] },
      });
    }
    const before = neighbours.map((address) => copies(TENANT, address));
    const s = uow.store.for(TENANT);
    const id = (await uow.run(adminOf(), (ctx) => ctx.supporters.getProjection('ada@example.org')))!
      .id;
    await uow.run(adminOf(), (ctx) => ctx.erasures.register(id, 'ADA@example.org'));
    await uow.run(adminOf(), (ctx) => ctx.erasures.apply());
    expect(neighbours.map((address) => copies(TENANT, address))).toEqual(before);
    expect(s.mailSends.size).toBe(2);
    expect(uow.store.jobs.filter((j) => j.tenantId === TENANT)).toHaveLength(4);
  });

  it.each(['\u00a0ANN@Example.org\u00a0', '\ufeffİN@Example.org\ufeff'])(
    'finds restored submission values using core normalisation: %s',
    async (address) => {
      const s = uow.store.for(TENANT);
      const submission = [...s.submissions.values()][0]!;
      submission.values = { email: address };
      s.projections.clear();
      s.events.clear();
      await uow.run(adminOf(), (ctx) =>
        ctx.erasures.register(uow.ids.next(), address.trim().toLowerCase())
      );
      await uow.run(adminOf(), (ctx) => ctx.erasures.apply());
      expect(s.submissions.size).toBe(0);
    }
  );

  it('retains explicit readmission through repeated apply and erases its second lifecycle', async () => {
    const s = uow.store.for(TENANT);
    const old = [...s.projections.values()][0]!;
    const delayed = structuredClone(uow.store.outbox.find((e) => e.tenantId === TENANT)!);
    await uow.run(adminOf(), (ctx) => ctx.erasures.register(old.id, old.email));
    await uow.run(adminOf(), (ctx) => ctx.erasures.apply());
    (uow.clock as FakeClock).advance(86_400_001);
    await signup(TENANT, 'ada@example.org');
    const next = await uow.run(adminOf(), (ctx) => ctx.supporters.getProjection('ada@example.org'));
    expect(next).not.toBeNull();
    expect(next!.id).not.toBe(old.id);
    const newCopies = copies(TENANT, 'ada@example.org');
    await uow.run(adminOf(), (ctx) => ctx.erasures.apply());
    expect(copies(TENANT, 'ada@example.org')).toEqual(newCopies);
    expect(await uow.run(adminOf(), (ctx) => ctx.erasures.apply())).toBe(0);
    delayed.id = uow.ids.next();
    delayed.occurredAt = uow.clock.now();
    await supporterIngestSubscriber(uow).handle(delayed);
    expect(s.projections.get(next!.id)).toEqual(next);
    expect(s.projections.get(old.id)?.email).toBe(tombstoneEmail(old.id));
    (uow.clock as FakeClock).advance(1);
    await uow.run(adminOf(), (ctx) => ctx.erasures.register(next!.id, 'ada@example.org'));
    await uow.run(adminOf(), (ctx) => ctx.erasures.apply());
    expect(copies(TENANT, 'ada@example.org')).toEqual(none);
    expect(s.erasures.size).toBe(2);
    expect(copies(OTHER, 'ada@example.org').supporters).toBe(1);
  });

  it('ignores old and future-dated unproven facts before apply, including old mail claims', async () => {
    const s = uow.store.for(TENANT);
    const old = structuredClone([...s.projections.values()][0]!);
    const queued = structuredClone(uow.store.outbox.find((e) => e.tenantId === TENANT)!);
    await uow.run(adminOf(), (ctx) => ctx.erasures.register(old.id, old.email));
    const late = await toSupporterEvent({
      ...queued,
      occurredAt: new Date('2026-11-01T00:00:00Z'),
    });
    const count = s.events.size;
    expect(await uow.run(adminOf(), (ctx) => ingest(ctx, late))).toBe(false);
    expect(s.events.size).toBe(count);
    const mailer = new MemoryMailer();
    expect(
      await sendOnce({ uow, clock: uow.clock, mailer }, queued, 'test-old-queue', {
        from: { email: 'team@example.org' },
        to: { email: old.email },
        subject: 'Old queue',
        text: 'Private',
        html: '<p>Private</p>',
        stream: 'transactional',
      })
    ).toBe('skipped');
    expect(mailer.sent).toHaveLength(0);
    expect(
      await uow.run(adminOf(), (ctx) =>
        ctx.erasures.admit(old.email, uow.ids.next(), uow.clock.now())
      )
    ).toBeNull();
    (uow.clock as FakeClock).advance(86_400_001);
    // Admission and ingest can precede apply, without reusing or folding the ended id.
    await signup(TENANT, old.email);
    const fresh = (await uow.run(adminOf(), (ctx) => ctx.supporters.getProjection(old.email)))!;
    expect(fresh.id).not.toBe(old.id);
    await uow.run(adminOf(), (ctx) => ctx.erasures.apply());
    expect(s.projections.get(fresh.id)).toEqual(fresh);
    expect(s.projections.get(old.id)?.email).toBe(tombstoneEmail(old.id));
  });

  it('removes restored old copies without a projection and retains readmission evidence', async () => {
    const s = uow.store.for(TENANT);
    const old = structuredClone([...s.projections.values()][0]!);
    const restored = structuredClone([...s.submissions.values()][0]!);
    await uow.run(adminOf(), (ctx) => ctx.erasures.register(old.id, old.email));
    await uow.run(adminOf(), (ctx) => ctx.erasures.apply());
    (uow.clock as FakeClock).advance(86_400_001);
    await signup(TENANT, old.email);
    const fresh = structuredClone(
      await uow.run(adminOf(), (ctx) => ctx.supporters.getProjection(old.email))
    );
    // Crash/restore before an old submission had ever reached the projector.
    s.projections.delete(old.id);
    for (const [id, e] of s.events) if (e.supporter_id === old.id) s.events.delete(id);
    s.submissions.set(restored.id, restored);
    expect(await uow.run(adminOf(), (ctx) => ctx.erasures.apply())).toBeGreaterThan(0);
    expect(s.submissions.has(restored.id)).toBe(false);
    expect(await uow.run(adminOf(), (ctx) => ctx.supporters.getProjection(old.email))).toEqual(
      fresh
    );
    expect(await uow.run(adminOf(), (ctx) => ctx.erasures.apply())).toBe(0);
    expect(s.supporterLifecycles.size).toBe(1);
  });

  it("expires an export archive that may hold the person, and no other site's", async () => {
    const ready = async (tenant: string) => {
      const { record } = await uow.run(adminOf(tenant), (ctx) =>
        ctx.exports.request({ id: uow.ids.next(), requestedBy: 'test', requestedAt: new Date(0) })
      );
      Object.assign(uow.store.for(tenant).exports.get(record.id)!, { status: 'ready' });
      return record.id;
    };
    const mine = await ready(TENANT);
    const theirs = await ready(OTHER);
    const id = (await uow.run(adminOf(), (ctx) => ctx.supporters.getProjection('ada@example.org')))!
      .id;
    await uow.run(adminOf(), (ctx) => ctx.erasures.register(id, 'ada@example.org'));
    await uow.run(adminOf(), (ctx) => ctx.erasures.apply());
    expect(uow.store.for(TENANT).exports.get(mine)).toMatchObject({
      status: 'expired',
      error: 'deleted after an erasure',
    });
    expect(uow.store.for(OTHER).exports.get(theirs)?.status).toBe('ready');
  });

  it('finds a submission whose supporter was never ingested, by the registered hash', async () => {
    const s = uow.store.for(TENANT);
    const id = (await uow.run(adminOf(), (ctx) => ctx.supporters.getProjection('ada@example.org')))!
      .id;
    // As after a restore of a backup older than the ingest: the submission, no projection.
    s.projections.clear();
    s.events.clear();
    await uow.run(adminOf(), (ctx) => ctx.erasures.register(id, 'ada@example.org'));
    await uow.run(adminOf(), (ctx) => ctx.erasures.apply());
    expect(copies(TENANT, 'ada@example.org')).toEqual(none);
  });
});

// `status` against packages/db/src/erasure-backups.test.ts (TODO #29B): a
// registration is unsecured from the moment it is made until a backup records it, per tenant.
describe('ctx.erasures.status in memory', () => {
  const A = '01900000-0000-7000-8000-0000000e0001';
  const B = '01900000-0000-7000-8000-0000000e0002';

  it('counts what a backup holds, and since when the rest waits', async () => {
    const clock = new FakeClock();
    const uow = new MemoryUnitOfWork({ clock });
    const status = () => uow.run(systemPrincipal(TENANT, 'test'), (ctx) => ctx.erasures.status());
    expect(await status()).toEqual({ registered: 0, secured: 0, oldestUnsecuredAt: null });

    const first = clock.now();
    await uow.run(systemPrincipal(TENANT, 'test'), (ctx) => ctx.erasures.register(A, 'a@x.org'));
    clock.advance(60_000);
    await uow.run(systemPrincipal(OTHER, 'test'), (ctx) => ctx.erasures.register(B, 'b@x.org'));
    expect(await status()).toEqual({ registered: 1, secured: 0, oldestUnsecuredAt: first });

    secureErasures(uow.store, TENANT, 'ab'.repeat(32), clock.now());
    secureErasures(uow.store, TENANT, 'cd'.repeat(32), clock.now());
    expect(await status()).toEqual({ registered: 1, secured: 1, oldestUnsecuredAt: null });
    expect(uow.store.for(TENANT).erasureBackups.get(A)?.snapshotId).toBe('ab'.repeat(32));
    // The other tenant's registration is still waiting.
    await expect(
      uow.run(systemPrincipal(OTHER, 'test'), (ctx) => ctx.erasures.status())
    ).resolves.toMatchObject({ registered: 1, secured: 0 });
  });
});

// These cases define row selection, not general log redaction: a neighbour's row survives.
describe('erasure address boundaries in decoded JSON', () => {
  const addresses = new Set(['ann@example.org']);
  it.each([
    ['ANN@example.org', true],
    ['Contact ann@example.org. Next sentence.', true],
    ['Contact: (ANN@example.org), please', true],
    [{ nested: ['line\nann@example.org\tend'] }, true],
    [{ 'ann@example.org': 'copy in a key' }, true],
    ['joann@example.org', false],
    ['ann@example.org.evil', false],
    ['prefix+ann@example.org', false],
    ['éann@example.org', false],
    ['ann@example.orgé', false],
    ['ann@example.org.𐐀', false],
    ['ann@example.org_ann@example.org', false],
    ['joann@example.org; ann@example.org', true],
    [null, false],
  ])('selects %j only when it carries the whole address (%s)', (value, expected) => {
    expect(carriesErasedAddress(value, addresses)).toBe(expected);
  });
});
