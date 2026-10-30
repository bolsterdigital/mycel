// Mail intent rows and the janitor against Postgres (ADR 019 rule 6, ADR 011 rule 2, brief #22C).
// The memory adapter proves the send-once protocol; this suite proves what only the database
// can: the claim commits before the provider call and survives a lost response, two deliveries
// racing on two connections make one claim and one provider call, the conditional upsert lets
// exactly one of two simultaneous claims win, `unresolved` shows unknown and abandoned intents,
// the table holds no address, two simultaneous clicks on one link confirm once, and the janitor
// deletes across tenants while the application role cannot.
//
// Skips without DATABASE_URL and APP_DATABASE_URL; in CI that is a failure.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import {
  Invoker,
  anonymousPrincipal,
  buildRegistry,
  mailCorrelation,
  renderConfirmationMail,
  sendOnce,
  signConfirmToken,
  systemPrincipal,
  useCases,
  type MailMessage,
  type Mailer,
} from '@mycel/core';
import {
  FakeInputHasher,
  FakeSigner,
  probeForm,
  FakeDns,
  memoryPlatform,
  runSuffix,
  adminOf,
} from '@mycel/core/testing';
import { createDb, createUnitOfWork, sweepRateLimits, uuidv7, uuidv7Ids } from './index.js';
import { closeTenantWork, requireDatabase, testTenant, migrateSchema } from './testing.js';

const { skip, operator: operatorUrl, app: appUrl } = requireDatabase('app');

/**
 * The provider: accepts every message and keeps the list; `lose` drops the response after
 * acceptance, `down` makes the listing fail, `delayMs` keeps a call in flight.
 */
class FlakyMailer implements Mailer {
  readonly delivered: string[] = [];
  lose = false;
  down = false;
  delayMs = 0;
  async send(_m: MailMessage, key: string) {
    this.delivered.push(key);
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
    if (this.lose) throw new Error('fetch failed: timeout');
    return { providerId: `p-${this.delivered.length}` };
  }
  async lookup() {
    return this.down ? null : { providerIds: this.delivered.map((_k, i) => `p-${i + 1}`) };
  }
}

describe.skipIf(skip)('mailing conformance', () => {
  const operatorDb = createDb(operatorUrl);
  const appDb = createDb(appUrl);
  // A second pool: two deliveries of one event on two connections, as two workers would.
  const appDb2 = createDb(appUrl);
  const signer = new FakeSigner();
  const clock = { now: () => new Date() };
  const uowOn = (db: typeof appDb) =>
    createUnitOfWork(db, {
      clock,
      ids: uuidv7Ids,
      signer,
      inputHasher: new FakeInputHasher(),
      dns: new FakeDns(),
      platform: memoryPlatform,
    });
  const uow = uowOn(appDb);
  const uow2 = uowOn(appDb2);
  const invoker = new Invoker(buildRegistry(), uow);
  const run = runSuffix();
  /** This suite's subscriber; its reconcile jobs are closed in afterAll. */
  const sub = `test-${run}`;
  // No budget: the provider stub lists at once, and settling is what is under test.
  const deps = (mailer: Mailer, u = uow) => ({ mailer, clock, uow: u, reconcileLagMs: 0 });
  let tenantId = '';
  let formId = '';
  const message = renderConfirmationMail({
    locale: 'en',
    tenantName: 'M',
    confirmUrl: 'http://localhost/m/confirm?token=x',
    from: { email: 'noreply@example.org' },
    to: 'ada@example.org',
  });

  beforeAll(async () => {
    await migrateSchema(operatorUrl);
    tenantId = (await testTenant(operatorDb, `mail-${run}`, { name: 'M' })).id;
    formId = uuidv7();
    await uow.run(adminOf(tenantId), (ctx) => ctx.forms.insert(probeForm(formId)));
  });

  afterAll(async () => {
    await closeTenantWork(operatorDb, [tenantId]);
    await operatorDb.destroy();
    await appDb.destroy();
    await appDb2.destroy();
  });

  it('commits the claim before the provider call and reconciles a lost response', async () => {
    const mailer = new FlakyMailer();
    const event = { id: uuidv7(), tenantId };
    const key = `${sub}:${event.id}`;
    const intent = () => uow.run(adminOf(tenantId), (ctx) => ctx.mailSends.get(key));

    mailer.lose = true;
    expect(await sendOnce(deps(mailer), event, sub, message)).toBe('unknown');
    // The row is there, committed, attempted and not sent: the state a crash would leave, with
    // the lease ended by the failure and the reconcile job planned in the claim's transaction.
    const row = await intent();
    expect(row).toMatchObject({
      subscriber: sub,
      eventId: event.id,
      attempts: 1,
      sentAt: null,
      abandonedAt: null,
      lastError: 'fetch failed: timeout',
      correlation: await mailCorrelation(tenantId, message),
    });
    expect(row?.attemptedAt).toBeInstanceOf(Date);
    expect(row?.claimedUntil?.getTime()).toBeLessThanOrEqual(Date.now());

    // The listing is down: unknown, nothing sent.
    mailer.lose = false;
    mailer.down = true;
    expect(await sendOnce(deps(mailer), event, sub, message)).toBe('unknown');
    mailer.down = false;
    expect(await sendOnce(deps(mailer), event, sub, message)).toBe('reconciled');
    expect(mailer.delivered).toEqual([key]);
    expect(await intent()).toMatchObject({ providerId: 'p-1', attempts: 1 });
    expect((await intent())?.sentAt).toBeInstanceOf(Date);
    expect(await sendOnce(deps(mailer), event, sub, message)).toBe('skipped');
  });

  it('makes one claim and one provider call when two deliveries race on two connections', async () => {
    const mailer = new FlakyMailer();
    mailer.delayMs = 100;
    const event = { id: uuidv7(), tenantId };
    const results = await Promise.all([
      sendOnce(deps(mailer, uow), event, sub, message),
      sendOnce(deps(mailer, uow2), event, sub, message),
    ]);
    expect(results.sort()).toEqual(['deferred', 'sent']);
    expect(mailer.delivered).toEqual([`${sub}:${event.id}`]);
    const row = await uow.run(adminOf(tenantId), (ctx) => ctx.mailSends.get(`${sub}:${event.id}`));
    expect(row).toMatchObject({ attempts: 1, providerId: 'p-1' });
  });

  it('lets exactly one of two simultaneous claims win, for a new intent and a takeover', async () => {
    const key = `${sub}:${uuidv7()}`;
    const intent = { key, subscriber: sub, eventId: uuidv7(), correlation: 'a'.repeat(64) };
    const at = new Date();
    const claim = (u: typeof uow, expected: Date | null, when = at) =>
      u.run(adminOf(tenantId), (ctx) =>
        ctx.mailSends.claim(intent, { at: when, until: new Date(when.getTime() + 1000), expected })
      );
    const fresh = await Promise.all([claim(uow, null), claim(uow2, null)]);
    expect(fresh.filter(Boolean)).toHaveLength(1);

    // Both read the expired attempt and both try to take it over: one does.
    const later = new Date(at.getTime() + 5000);
    const takeover = await Promise.all([claim(uow, at, later), claim(uow2, at, later)]);
    expect(takeover.filter(Boolean)).toHaveLength(1);
    expect(takeover.find(Boolean)).toMatchObject({ attempts: 2, attemptedAt: later });
    // A stale expectation and a running lease both lose.
    expect(await claim(uow, at, new Date(later.getTime() + 5000))).toBeNull();
    expect(await claim(uow, later, new Date(later.getTime() + 500))).toBeNull();
  });

  it('shows unknown and abandoned intents as unresolved, and nothing in flight or sent', async () => {
    const at = new Date();
    const correlation = 'b'.repeat(64);
    const put = (name: string, until: Date) =>
      uow.run(adminOf(tenantId), (ctx) =>
        ctx.mailSends.claim(
          { key: `${sub}:${name}`, subscriber: sub, eventId: uuidv7(), correlation },
          { at, until, expected: null }
        )
      );
    await put('unknown', at);
    await put('abandoned', at);
    await put('flying', new Date(at.getTime() + 60_000));
    await put('sent', at);
    await uow.run(adminOf(tenantId), async (ctx) => {
      await ctx.mailSends.abandon(`${sub}:abandoned`, at);
      await ctx.mailSends.sent(`${sub}:sent`, at, 'p-x');
    });
    const unresolved = await uow.run(adminOf(tenantId), (ctx) =>
      ctx.mailSends.unresolved(new Date())
    );
    const mine = unresolved.filter((m) => m.correlation === correlation);
    expect(mine.map((m) => [m.key, m.abandonedAt !== null]).sort()).toEqual([
      [`${sub}:abandoned`, true],
      [`${sub}:unknown`, false],
    ]);
    const siblings = await uow.run(adminOf(tenantId), (ctx) =>
      ctx.mailSends.siblings(correlation, {
        since: new Date(at.getTime() - 1),
        until: new Date(at.getTime() + 1),
      })
    );
    expect(siblings).toHaveLength(4);
  });

  it('confirms once when two clicks on one link race', async () => {
    const submitted = await invoker.run(useCases.submitForm, adminOf(tenantId), {
      formId,
      values: { email: `race-${run}@example.org`, consent: true },
      locale: 'nl',
    });
    if (submitted.status !== 'accepted') throw new Error(submitted.status);
    const token = await signConfirmToken(
      signer,
      { tenantId, submissionId: submitted.submissionId, list: 'newsletter' },
      clock.now()
    );
    const click = () =>
      invoker.run(useCases.confirmSubscription, anonymousPrincipal(tenantId, ['forms:write']), {
        token,
      });
    const results = await Promise.all([click(), click(), click()]);
    expect(results.map((r) => r.status).sort()).toEqual([
      'already_confirmed',
      'already_confirmed',
      'confirmed',
    ]);
    const { rows } = await sql<{ n: string }>`
      select count(*) as n from outbox where tenant_id = ${tenantId} and type = 'consent.given'
    `.execute(operatorDb);
    expect(Number(rows[0]?.n)).toBe(1);
  });

  it('keeps no address in mail_sends: the correlation is a 64-hex hash', async () => {
    const { rows } = await sql<{ column_name: string }>`
      select column_name from information_schema.columns
      where table_schema = 'public' and table_name = 'mail_sends'`.execute(operatorDb);
    expect(rows.map((r) => r.column_name)).not.toContain('email');
    expect(rows.map((r) => r.column_name)).not.toContain('recipient');

    const event = { id: uuidv7(), tenantId };
    await sendOnce(deps(new FlakyMailer()), event, sub, message);
    const row = await uow.run(adminOf(tenantId), (ctx) => ctx.mailSends.get(`${sub}:${event.id}`));
    expect(row?.correlation).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(row)).not.toContain('ada@example.org');
    // The column refuses anything but a hash.
    await expect(
      uow.run(adminOf(tenantId), (ctx) =>
        ctx.mailSends.claim(
          { key: `${sub}:raw`, subscriber: sub, eventId: uuidv7(), correlation: 'ada@example.org' },
          { at: new Date(), until: new Date(), expected: null }
        )
      )
    ).rejects.toThrow(/check constraint/);
  });

  it('lets only the janitor delete expired rate-limit windows', async () => {
    // Windows from two days ago, written through the real limiter with a clock in the past.
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    const old = createUnitOfWork(appDb, {
      clock: { now: () => twoDaysAgo },
      ids: uuidv7Ids,
      signer,
      inputHasher: new FakeInputHasher(),
      dns: new FakeDns(),
      platform: memoryPlatform,
    });
    await old.run(adminOf(tenantId), (ctx) =>
      ctx.rateLimits.hit(`janitor-${run}`, { max: 5, windowSeconds: 60 })
    );
    await uow.run(adminOf(tenantId), (ctx) =>
      ctx.rateLimits.hit(`janitor-${run}`, { max: 5, windowSeconds: 60 })
    );
    // Order-independent (TODO #17a): the jobs suite sweeps in parallel and may already have
    // removed the old window, so this asserts what survives the sweep, not a count before it.
    const windows = async () =>
      (
        await sql<{ window_start: Date }>`select window_start from rate_limits
          where tenant_id = ${tenantId} and key = ${`janitor-${run}`}`.execute(operatorDb)
      ).rows.map((r) => new Date(r.window_start));

    await expect(
      uow.run(adminOf(tenantId), () => sql`delete from rate_limits`.execute(appDb))
    ).rejects.toThrow(/permission denied/);

    expect(await sweepRateLimits(operatorDb)).toBeGreaterThanOrEqual(0);
    const left = await windows();
    expect(left.some((w) => w < new Date(Date.now() - 24 * 60 * 60 * 1000))).toBe(false);
    expect(left.length).toBe(1);
  });

  // Brief form-intake § 1: the recipient cooldown, one success per key per window.
  it('lets exactly one of five simultaneous cooldowns through, again after the window, per tenant', async () => {
    const key = `cooldown-${run}`;
    const day = 24 * 60 * 60;
    // Five transactions on separate connections at once; the advisory lock serialises them.
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        uow.run(adminOf(tenantId), (ctx) => ctx.rateLimits.cooldown(key, day))
      )
    );
    expect(results.filter(Boolean)).toHaveLength(1);
    // A refusal recorded nothing: still one row.
    const count = async (t: string) =>
      Number(
        (
          await sql<{ n: string }>`select count(*) as n from rate_limits
            where tenant_id = ${t} and key = ${key}`.execute(operatorDb)
        ).rows[0]?.n
      );
    expect(await count(tenantId)).toBe(1);

    // A day and a second later, through a clock in the future.
    const later = createUnitOfWork(appDb, {
      clock: { now: () => new Date(Date.now() + (day + 1) * 1000) },
      ids: uuidv7Ids,
      signer,
      inputHasher: new FakeInputHasher(),
      dns: new FakeDns(),
      platform: memoryPlatform,
    });
    expect(await later.run(adminOf(tenantId), (ctx) => ctx.rateLimits.cooldown(key, day))).toBe(
      true
    );
    expect(await later.run(adminOf(tenantId), (ctx) => ctx.rateLimits.cooldown(key, day))).toBe(
      false
    );

    // Another tenant with the same key has a window of its own (RLS on rate_limits).
    const other = (await testTenant(operatorDb, `mail-b-${run}`, { name: 'M2' })).id;
    expect(
      await uow.run(systemPrincipal(other, 'test'), (ctx) => ctx.rateLimits.cooldown(key, day))
    ).toBe(true);
    expect(await count(other)).toBe(1);

    await expect(
      uow.run(adminOf(tenantId), (ctx) => ctx.rateLimits.cooldown(key, day + 1))
    ).rejects.toThrow(/outside/);
  });
});
