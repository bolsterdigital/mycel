// Stuck-work recovery against Postgres (TODO #17c, migration 0016): what the in-memory store
// cannot prove. A tenant administrator sees and recovers only its own exhausted jobs as
// mycel_app; the hoster sees every stuck row as mycel_ops, without payloads (its recoveries are
// the open decision, see the last test of the hoster's block). A retried `mail.reconcile`
// from the #22C claim path is claimable and runs again; a closed `hostnames.reverify` frees its
// key; a job whose last attempt still holds the lease is not touched.
//
// Jobs here have keys of their own (`run`); the one claim narrows to `mail.reconcile`, whose real
// rows are planned RECONCILE_LAG_MS ahead and so are never due during a run. Skips without
// DATABASE_URL and APP_DATABASE_URL; with E2E_REQUIRED=1 (CI) that is a failure.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import {
  Invoker,
  RECONCILE_LAG_MS,
  buildRegistry,
  claimAttempt,
  systemPrincipal,
  useCases,
  type JobRecord,
} from '@mycel/core';
import { FakeDns, FakeInputHasher, FakeSigner, memoryPlatform } from '@mycel/core/testing';
import {
  claimJobs,
  completeJob,
  createDb,
  createUnitOfWork,
  failJob,
  migrate,
  opsDeadEvents,
  opsJobs,
  opsSummary,
  opsUnresolvedMail,
  upsertTenant,
  uuidv7,
  uuidv7Ids,
  withTenant,
} from './index.js';

const operatorUrl = process.env['DATABASE_URL'];
const appUrl = process.env['APP_DATABASE_URL'];
if (process.env['E2E_REQUIRED'] === '1' && (!operatorUrl || !appUrl))
  throw new Error('E2E_REQUIRED=1 but DATABASE_URL or APP_DATABASE_URL is not set');

const PLATFORM = 'conformance.test';

describe.skipIf(!operatorUrl || !appUrl)('stuck-work recovery conformance', () => {
  const operatorDb = createDb(operatorUrl ?? '');
  const appDb = createDb(appUrl ?? '');
  const run = Math.random().toString(36).slice(2, 8);
  const uow = createUnitOfWork(appDb, {
    clock: { now: () => new Date() },
    ids: uuidv7Ids,
    signer: new FakeSigner(),
    inputHasher: new FakeInputHasher(),
    dns: new FakeDns(),
    platform: { ...memoryPlatform, domain: PLATFORM },
  });
  const invoker = new Invoker(buildRegistry(), uow);
  let tenantId = '';
  let otherId = '';
  const admin = () => systemPrincipal(tenantId, 'test');
  const mine: string[] = [];
  const events: string[] = [];

  const asWorker = <T>(fn: (trx: typeof operatorDb) => Promise<T>) =>
    operatorDb.transaction().execute(async (trx) => {
      await sql`set local role mycel_worker`.execute(trx);
      return fn(trx);
    });
  /** A job as the worker left it: exhausted by default, with a payload nobody may read. */
  async function job(
    over: {
      tenant?: string | null;
      type?: string;
      key?: string;
      attempts?: number;
      claimedAt?: Date | null;
    } = {}
  ): Promise<string> {
    const id = uuidv7();
    const type = over.type ?? `conformance.${run}.stuck`;
    await asWorker((trx) =>
      trx
        .insertInto('jobs')
        .values({
          id,
          tenant_id: over.tenant === undefined ? tenantId : over.tenant,
          type,
          key: over.key ?? `${type}:${id}`,
          run_at: new Date(Date.now() + 86_400_000),
          payload: JSON.stringify({ secret: `payload-${run}` }),
          attempts: over.attempts ?? 10,
          max_attempts: 10,
          claimed_at: over.claimedAt ?? null,
          last_error: 'failed for someone@example.org',
        })
        .execute()
    );
    mine.push(id);
    return id;
  }
  const read = (id: string) =>
    asWorker((trx) => trx.selectFrom('jobs').selectAll().where('id', '=', id).executeTakeFirst());
  const auditOf = (subject: string) =>
    withTenant(appDb, admin(), (trx) =>
      trx.selectFrom('audit_log').selectAll().where('subject_id', '=', subject).execute()
    );

  beforeAll(async () => {
    await migrate(operatorUrl!, {
      appPassword: process.env['MYCEL_APP_PASSWORD'],
      authPassword: process.env['MYCEL_AUTH_PASSWORD'],
      log: () => {},
    });
    const tenant = (slug: string) =>
      upsertTenant(
        operatorDb,
        { id: uuidv7(), slug, name: slug, defaultLocale: 'nl', locales: ['nl'] },
        { platformDomain: PLATFORM }
      );
    tenantId = (await tenant(`recovery-${run}`)).id;
    otherId = (await tenant(`recovery-other-${run}`)).id;
  });

  afterAll(async () => {
    await asWorker((trx) =>
      trx.updateTable('jobs').set({ done_at: new Date() }).where('id', 'in', mine).execute()
    );
    if (events.length)
      await asWorker((trx) =>
        trx
          .updateTable('outbox')
          .set({ processed_at: new Date() })
          .where('id', 'in', events)
          .execute()
      );
    await operatorDb.destroy();
    await appDb.destroy();
  });

  describe('the tenant administrator (mycel_app)', () => {
    it('sees its own exhausted jobs only, and retries one without the payload leaving', async () => {
      const stuck = await job();
      const open = await job({ attempts: 3 });
      const foreign = await job({ tenant: otherId });
      const platform = await job({ tenant: null });
      const status = await invoker.run(useCases.getOpsStatus, admin(), {});
      const ids = status.jobs.map((j) => j.id);
      expect(ids).toContain(stuck);
      expect(ids).not.toEqual(expect.arrayContaining([open]));
      for (const other of [open, foreign, platform]) expect(ids).not.toContain(other);
      expect(JSON.stringify(status)).not.toContain(`payload-${run}`);
      expect(JSON.stringify(status)).not.toContain('someone@example.org');
      expect(status.diagnosis).toContain(`site: recovery-${run}`);

      await invoker.run(useCases.retryJob, admin(), { id: stuck });
      expect(await read(stuck)).toMatchObject({
        attempts: 0,
        claimed_at: null,
        done_at: null,
        last_error: 'failed for someone@example.org',
      });
      expect(+(await read(stuck))!.run_at).toBeLessThanOrEqual(Date.now() + 1000);
      expect(await auditOf(stuck)).toMatchObject([
        { operation: 'ops.job.retry', result: 'ok', actor_kind: 'system' },
      ]);
    });

    it('refuses an open job with conflict and a foreign or platform job as not found', async () => {
      const open = await job({ attempts: 3 });
      await expect(invoker.run(useCases.closeJob, admin(), { id: open })).rejects.toMatchObject({
        code: 'conflict',
      });
      for (const tenant of [otherId, null]) {
        const id = await job({ tenant });
        await expect(invoker.run(useCases.retryJob, admin(), { id })).rejects.toMatchObject({
          code: 'not_found',
        });
        expect((await read(id))!.attempts).toBe(10);
      }
    });

    it('leaves a job alone while its last attempt holds the lease', async () => {
      const running = await job({ claimedAt: new Date() });
      await expect(invoker.run(useCases.retryJob, admin(), { id: running })).rejects.toMatchObject({
        code: 'conflict',
      });
      expect((await read(running))!.attempts).toBe(10);
    });

    it('makes an exhausted mail.reconcile from the #22C claim visible, claimable and run again', async () => {
      // The claim plans `mail.reconcile:<key>` RECONCILE_LAG_MS ahead, in its own transaction.
      const key = `recovery-${run}:${uuidv7()}`;
      await uow.run(admin(), (ctx) =>
        claimAttempt(
          ctx,
          { key, subscriber: `recovery-${run}`, eventId: uuidv7(), correlation: 'a'.repeat(64) },
          { at: ctx.clock.now(), expected: null, lagMs: RECONCILE_LAG_MS }
        )
      );
      const [planned] = await asWorker((trx) =>
        trx
          .selectFrom('jobs')
          .select('id')
          .where('key', '=', `mail.reconcile:${key}`)
          .where('done_at', 'is', null)
          .execute()
      );
      mine.push(planned!.id);
      await asWorker((trx) =>
        trx
          .updateTable('jobs')
          .set({ attempts: 10, last_error: 'no event for it' })
          .where('id', '=', planned!.id)
          .execute()
      );
      const status = await invoker.run(useCases.getOpsStatus, admin(), {});
      expect(status.jobs.find((j) => j.id === planned!.id)).toMatchObject({
        type: 'mail.reconcile',
        lastError: 'no event for it',
      });

      await invoker.run(useCases.retryJob, admin(), { id: planned!.id });
      const claimed = await claimJobs(operatorDb, { types: ['mail.reconcile'], batchSize: 50 });
      // Anything else that happened to be due goes back as the worker would leave it.
      for (const other of claimed.filter((j) => j.id !== planned!.id))
        await failJob(operatorDb, other, 'released by recovery conformance');
      const ours = claimed.find((j) => j.id === planned!.id) as JobRecord;
      expect(ours).toMatchObject({ attempts: 1 });
      expect(await completeJob(operatorDb, ours)).toBe(true);
      expect((await read(planned!.id))!.done_at).not.toBeNull();
    });

    it('frees the key of a closed hostnames.reverify', async () => {
      const key = `hostnames.reverify:${tenantId}:recovery-${run}.example`;
      const stuck = await job({ type: 'hostnames.reverify', key });
      await invoker.run(useCases.closeJob, admin(), { id: stuck });
      expect((await read(stuck))!.done_at).not.toBeNull();
      const planned = await uow.run(admin(), (ctx) =>
        ctx.jobs.enqueue({
          type: 'hostnames.reverify',
          key,
          runAt: new Date(Date.now() + 86_400_000),
          payload: { hostname: `recovery-${run}.example` },
        })
      );
      expect(planned).toBe(true);
      const [next] = await asWorker((trx) =>
        trx
          .selectFrom('jobs')
          .select('id')
          .where('key', '=', key)
          .where('done_at', 'is', null)
          .execute()
      );
      mine.push(next!.id);
    });
  });

  describe('the hoster (mycel_ops)', () => {
    it('lists stuck jobs of every tenant without a payload, and counts them per tenant', async () => {
      const a = await job();
      const b = await job({ tenant: otherId });
      await job({ attempts: 1 });
      const page = await opsJobs(operatorDb, { tenantId, limit: 200 });
      expect(page.items.map((j) => j.id)).toContain(a);
      expect(page.items.every((j) => j.tenantId === tenantId)).toBe(true);
      expect(page.items[0]).not.toHaveProperty('payload');
      expect(JSON.stringify(page)).not.toContain('@');
      expect((await opsJobs(operatorDb, { tenantId: otherId })).items.map((j) => j.id)).toEqual(
        expect.arrayContaining([b])
      );

      const summary = await opsSummary(operatorDb);
      const ours = summary.find((s) => s.tenantId === tenantId);
      expect(ours).toMatchObject({ slug: `recovery-${run}` });
      expect(ours!.exhaustedJobs).toBe(page.items.length);
    });

    it('pages with a cursor', async () => {
      await job();
      await job();
      const first = await opsJobs(operatorDb, { tenantId, limit: 1 });
      expect(first.items).toHaveLength(1);
      const second = await opsJobs(operatorDb, { tenantId, limit: 1, cursor: first.nextCursor! });
      expect(second.items[0]!.id > first.items[0]!.id).toBe(true);
    });

    it('lists dead outbox events without props or actor', async () => {
      const id = uuidv7();
      events.push(id);
      // Inserted dead as the application would never write it, so no drain picks it up.
      await withTenant(appDb, admin(), (trx) =>
        trx
          .insertInto('outbox')
          .values({
            id,
            tenant_id: tenantId,
            type: `conformance.${run}.event`,
            occurred_at: new Date(),
            actor: JSON.stringify({ kind: 'system', job: 'test' }),
            props: JSON.stringify({ email: 'someone@example.org' }),
            attempts: 10,
            delivered_to: ['already.done'],
            last_error: 'subscriber x failed',
          })
          .execute()
      );
      const dead = await opsDeadEvents(operatorDb, { tenantId });
      expect(dead.items.find((e) => e.id === id)).toMatchObject({
        attempts: 10,
        deliveredTo: ['already.done'],
        lastError: 'subscriber x failed',
      });
      expect(dead.items[0]).not.toHaveProperty('props');
      expect(JSON.stringify(dead)).not.toContain('someone@example.org');
      expect((await opsSummary(operatorDb)).find((s) => s.tenantId === tenantId)).toMatchObject({
        deadEvents: 1,
      });
    });

    // The open decision of TODO #17c (migration 0016): Postgres checks the new row of an UPDATE
    // against the role's SELECT policies, and a recovered row is no longer stuck. When the review
    // has chosen, this test turns into the platform recovery's own tests.
    it('cannot recover a job or an event under the brief-1 policies (open decision)', async () => {
      const stuck = await job();
      const asOps = (q: ReturnType<typeof sql>) =>
        operatorDb.transaction().execute(async (trx) => {
          await sql`set local role mycel_ops`.execute(trx);
          return q.execute(trx);
        });
      await expect(asOps(sql`update jobs set attempts = 0 where id = ${stuck}`)).rejects.toThrow(
        /new row violates row-level security/
      );
      await expect(asOps(sql`update jobs set done_at = now() where id = ${stuck}`)).rejects.toThrow(
        /new row violates row-level security/
      );
      expect((await read(stuck))!.attempts).toBe(10);
    });

    it('lists unknown and abandoned mail without the correlation', async () => {
      const at = new Date(Date.now() - 3600_000);
      await withTenant(appDb, admin(), (trx) =>
        trx
          .insertInto('mail_sends')
          .values(
            (['unknown', 'abandoned', 'sent'] as const).map((s) => ({
              tenant_id: tenantId,
              key: `recovery-${run}:${s}`,
              subscriber: `recovery-${run}`,
              event_id: uuidv7(),
              attempted_at: at,
              claimed_until: at,
              attempts: 1,
              sent_at: s === 'sent' ? at : null,
              abandoned_at: s === 'abandoned' ? at : null,
              last_error: 'refused someone@example.org',
              correlation: 'b'.repeat(64),
            }))
          )
          .execute()
      );
      const mail = await opsUnresolvedMail(operatorDb, { tenantId });
      expect(mail.items.map((m) => [m.key, m.state])).toEqual([
        [`recovery-${run}:abandoned`, 'abandoned'],
        [`recovery-${run}:unknown`, 'unknown'],
      ]);
      expect(JSON.stringify(mail)).not.toContain('b'.repeat(64));
      expect(JSON.stringify(mail)).not.toContain('@');
    });
  });
});
