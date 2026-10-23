// The `mail.reconcile` job against Postgres (brief #22C decision 6): the handler reads the
// outbox event as mycel_worker and uses it only for the job's own tenant, recovers a lost
// response without any outbox redelivery, leaves a suspended tenant alone for a day, and runs
// in the real worker loop where one uncertain message holds up no other job and an exhausted
// job stays findable with its error. The claim-plans-the-job transaction is proven in
// packages/db/src/jobs.conformance.test.ts; the counting in packages/core/src/mailing.
//
// Every job here has a type of this run, and claims are narrowed to those types, so the suite
// never takes real work. Skips without the three database URLs; with E2E_REQUIRED=1 (CI) that
// is a failure.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import {
  RECONCILE_INTERVAL_MS,
  renderConfirmationMail,
  sendOnce,
  systemPrincipal,
  type DomainEvent,
  type JobRecord,
  type MailMessage,
  type Mailer,
} from '@mycel/core';
import {
  FakeDns,
  FakeInputHasher,
  FakeSigner,
  memoryPlatform,
  testPlatformActor,
} from '@mycel/core/testing';
import {
  createDb,
  createIdentityStore,
  createUnitOfWork,
  migrate,
  readOutboxEvent,
  runJobs,
  setStatus,
  upsertTenant,
  uuidv7,
  uuidv7Ids,
} from '@mycel/db';
import { closeTenantWork } from '@mycel/db/testing';
import { mailReconcileJob } from './jobs.js';

const env = process.env;
const ready = !!(env['DATABASE_URL'] && env['APP_DATABASE_URL'] && env['AUTH_DATABASE_URL']);
if (env['E2E_REQUIRED'] === '1' && !ready)
  throw new Error('E2E_REQUIRED=1 but a database URL is not set');

/** Accepts every message and keeps the list; `lose` drops the response, `down` the listing. */
class Provider implements Mailer {
  readonly delivered: string[] = [];
  lose = false;
  down = false;
  async send(_m: MailMessage, key: string) {
    this.delivered.push(key);
    if (this.lose) throw new Error('aborted');
    return { providerId: `p-${this.delivered.length}` };
  }
  async lookup() {
    return this.down ? null : { providerIds: this.delivered.map((_k, i) => `p-${i + 1}`) };
  }
}

describe.skipIf(!ready)('mail.reconcile against Postgres', () => {
  const operatorDb = createDb(env['DATABASE_URL'] ?? '');
  const appDb = createDb(env['APP_DATABASE_URL'] ?? '');
  const authDb = createDb(env['AUTH_DATABASE_URL'] ?? '');
  const clock = { now: () => new Date() };
  const uow = createUnitOfWork(appDb, {
    clock,
    ids: uuidv7Ids,
    signer: new FakeSigner(),
    inputHasher: new FakeInputHasher(),
    dns: new FakeDns(),
    platform: memoryPlatform,
  });
  const identity = createIdentityStore(authDb, uuidv7Ids);
  const run = Math.random().toString(36).slice(2, 8);
  const sub = `test-${run}`;
  const message = renderConfirmationMail({
    locale: 'en',
    tenantName: 'M',
    confirmUrl: 'http://localhost/m/confirm?token=x',
    from: { email: 'noreply@example.org' },
    to: `reconcile-${run}@example.org`,
  });
  let tenantA = '';
  let tenantB = '';

  const handlerFor = (mailer: Mailer) =>
    mailReconcileJob({
      uow,
      identity,
      mailer,
      clock,
      sources: { [sub]: async () => message },
      reconcileLagMs: 0,
      readEvent: (id) => readOutboxEvent(operatorDb, id),
    });
  /** An event in the outbox of `tenant`, of a type no subscriber takes. */
  async function publish(tenant: string): Promise<DomainEvent> {
    const event: DomainEvent = {
      id: uuidv7(),
      type: `conformance.${run}`,
      tenantId: tenant,
      occurredAt: new Date(),
      actor: { kind: 'system', job: 'test' },
      props: {},
    };
    await uow.run(systemPrincipal(tenant, 'test'), (ctx) => ctx.events.publish(event));
    return event;
  }
  const payloadOf = (event: DomainEvent) => ({
    key: `${sub}:${event.id}`,
    subscriber: sub,
    eventId: event.id,
  });
  /** The job as the worker would see it after a claim. */
  const jobFor = (event: DomainEvent, tenantId: string | null = event.tenantId): JobRecord => ({
    id: uuidv7(),
    tenantId,
    type: 'mail.reconcile',
    key: `mail.reconcile:${sub}:${event.id}`,
    runAt: new Date(),
    payload: payloadOf(event),
    attempts: 1,
    maxAttempts: 10,
    claimedAt: new Date(),
    doneAt: null,
    lastError: null,
    createdAt: new Date(),
  });
  const asWorker = <T>(fn: (trx: typeof operatorDb) => Promise<T>) =>
    operatorDb.transaction().execute(async (trx) => {
      await sql`set local role mycel_worker`.execute(trx);
      return fn(trx);
    });
  const byKey = (key: string) =>
    asWorker((trx) =>
      trx.selectFrom('jobs').selectAll().where('key', '=', key).orderBy('id').execute()
    );

  beforeAll(async () => {
    await migrate(env['DATABASE_URL']!, {
      log: () => {},
    });
    const tenant = async (name: string) =>
      (
        await upsertTenant(
          operatorDb,
          { id: uuidv7(), slug: `${name}-${run}`, name, defaultLocale: 'nl', locales: ['nl'] },
          { platformDomain: 'localhost' }
        )
      ).id;
    tenantA = await tenant('mail-a');
    tenantB = await tenant('mail-b');
  });

  afterAll(async () => {
    await closeTenantWork(operatorDb, [tenantA, tenantB]);
    await asWorker((trx) =>
      sql`update jobs set done_at = now()
          where done_at is null
            and (key like ${`mail.reconcile:${sub}:%`} or type like ${`conformance.${run}.%`})`.execute(
        trx
      )
    );
    await Promise.all([operatorDb.destroy(), appDb.destroy(), authDb.destroy()]);
  });

  it("recovers a lost response from the job alone, with the event of the job's own tenant only", async () => {
    const provider = new Provider();
    const event = await publish(tenantA);
    provider.lose = true;
    const deps = { mailer: provider, clock, uow, reconcileLagMs: 0 };
    expect(await sendOnce(deps, event, sub, message)).toBe('unknown');
    const [planned] = await byKey(`mail.reconcile:${sub}:${event.id}`);
    expect(planned).toMatchObject({ tenant_id: tenantA, type: 'mail.reconcile' });

    provider.lose = false;
    const handler = handlerFor(provider);
    // The same event id under another tenant's job: refused before anything is read or sent.
    await expect(handler(jobFor(event, tenantB))).rejects.toThrow(/another tenant/);
    expect(await handler(jobFor(event))).toEqual({});
    expect(provider.delivered).toEqual([`${sub}:${event.id}`]);
    const intent = await uow.run(systemPrincipal(tenantA, 'test'), (ctx) =>
      ctx.mailSends.get(`${sub}:${event.id}`)
    );
    expect(intent).toMatchObject({ providerId: 'p-1', attempts: 1 });
  });

  it('leaves a suspended tenant alone and looks again in a day', async () => {
    const provider = new Provider();
    const event = await publish(tenantB);
    await setStatus(operatorDb, tenantB, 'suspended', testPlatformActor);
    try {
      const before = Date.now();
      const outcome = await handlerFor(provider)(jobFor(event));
      expect(outcome.next!.getTime() - before).toBeGreaterThanOrEqual(24 * 60 * 60 * 1000 - 1000);
      expect(provider.delivered).toEqual([]);
    } finally {
      await setStatus(operatorDb, tenantB, 'active', testPlatformActor);
    }
  });

  it('runs in the worker loop: an uncertain message holds up nothing, an exhausted job stays findable', async () => {
    const provider = new Provider();
    const uncertain = await publish(tenantA);
    provider.lose = true;
    await sendOnce({ mailer: provider, clock, uow, reconcileLagMs: 0 }, uncertain, sub, message);
    provider.lose = false;
    provider.down = true;

    // Three due tenant jobs of this run's types: the uncertain mail, a mail whose event is gone
    // (a programming error, one attempt allowed), and an unrelated job after them.
    const types = { mail: `conformance.${run}.mail`, other: `conformance.${run}.other` };
    const insert = (type: string, key: string, payload: unknown, maxAttempts = 10) =>
      asWorker((trx) =>
        trx
          .insertInto('jobs')
          .values({
            id: uuidv7(),
            tenant_id: tenantA,
            type,
            key,
            run_at: new Date(Date.now() - 1000),
            payload: JSON.stringify(payload),
            max_attempts: maxAttempts,
          })
          .execute()
      );
    const missing = { ...payloadOf(uncertain), eventId: uuidv7() };
    missing.key = `${sub}:${missing.eventId}`;
    await insert(types.mail, `${types.mail}:uncertain`, payloadOf(uncertain));
    await insert(types.mail, `${types.mail}:missing`, missing, 1);
    await insert(types.other, `${types.other}:x`, {});

    const ran: string[] = [];
    const result = await runJobs(
      operatorDb,
      {
        [types.mail]: handlerFor(provider),
        [types.other]: async (job) => void ran.push(job.key),
      },
      { types: [types.mail, types.other] }
    );
    expect(result).toEqual({ claimed: 3, completed: 2, failed: 1, superseded: 0 });
    expect(ran).toEqual([`${types.other}:x`]);
    expect(provider.delivered).toHaveLength(1);

    // The uncertain one is done and planned again at the interval.
    const rows = await byKey(`${types.mail}:uncertain`);
    expect(rows.map((r) => r.done_at === null)).toEqual([false, true]);
    expect(new Date(rows[1]!.run_at).getTime() - Date.now()).toBeGreaterThan(
      RECONCILE_INTERVAL_MS - 60_000
    );
    // The exhausted one: open, out of attempts, with its error, which is what #17 lists.
    const exhausted = await asWorker((trx) =>
      trx
        .selectFrom('jobs')
        .selectAll()
        .where('done_at', 'is', null)
        .where(sql<boolean>`attempts >= max_attempts`)
        .where('key', '=', `${types.mail}:missing`)
        .execute()
    );
    expect(exhausted).toHaveLength(1);
    expect(exhausted[0]!.last_error).toMatch(/outbox event .* not found/);
  });
});
