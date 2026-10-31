// Stuck-work recovery against Postgres (TODO #17c, migration 0016): what the in-memory store
// cannot prove. A tenant administrator sees and recovers only its own exhausted jobs as
// mycel_app; the hoster sees every stuck row as mycel_ops, without payloads, and recovers any
// tenant's (and the platform's own) with one audit row as `platform`. A retried `mail.reconcile`
// from the #22C claim path is claimable and runs again; a closed `hostnames.reverify` frees its
// key; a job whose last attempt still holds the lease is not touched.
//
// Jobs here have keys of their own (`run`); the one claim narrows to `mail.reconcile`, whose real
// rows are planned RECONCILE_LAG_MS ahead and so are never due during a run. Skips without
// DATABASE_URL and APP_DATABASE_URL; in CI that is a failure.

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
import {
  FakeDns,
  FakeInputHasher,
  FakeSigner,
  memoryPlatform,
  runSuffix,
  adminOf,
} from '@mycel/core/testing';
import {
  claimJobs,
  completeJob,
  createDb,
  createUnitOfWork,
  failJob,
  opsCloseJob,
  opsDeadEvents,
  opsJobs,
  opsRetryEvent,
  opsRetryJob,
  opsSummary,
  opsUnresolvedMail,
  uuidv7,
  uuidv7Ids,
  withTenant,
} from '../index.js';
import { asRole } from './roles.js';
import { requireDatabase, testTenant, migrateSchema } from '../testing.js';

const { skip, operator: operatorUrl, app: appUrl } = requireDatabase('app');

const PLATFORM = 'conformance.test';

describe.skipIf(skip)('stuck-work recovery conformance', () => {
  const operatorDb = createDb(operatorUrl);
  const appDb = createDb(appUrl);
  const run = runSuffix();
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
  const mine: string[] = [];
  const events: string[] = [];

  const asWorker = <T>(fn: (trx: typeof operatorDb) => Promise<T>) =>
    asRole(operatorDb, 'mycel_worker', fn);
  /** A job as the worker left it: exhausted by default, with a payload nobody may read. */
  async function job(
    over: {
      tenant?: string | null;
      type?: string;
      key?: string;
      attempts?: number;
      claimedAt?: Date | null;
      /** Null: the worker died on every attempt and never reported one. */
      lastError?: string | null;
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
          last_error:
            over.lastError === undefined ? 'failed for someone@example.org' : over.lastError,
        })
        .execute()
    );
    mine.push(id);
    return id;
  }
  const read = (id: string) =>
    asWorker((trx) => trx.selectFrom('jobs').selectAll().where('id', '=', id).executeTakeFirst());
  const auditOf = (subject: string) =>
    withTenant(appDb, adminOf(tenantId), (trx) =>
      trx.selectFrom('audit_log').selectAll().where('subject_id', '=', subject).execute()
    );

  beforeAll(async () => {
    await migrateSchema(operatorUrl);
    const tenant = (slug: string) => testTenant(operatorDb, slug, { platformDomain: PLATFORM });
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
      const status = await invoker.run(useCases.getOpsStatus, adminOf(tenantId), {});
      const ids = status.jobs.map((j) => j.id);
      expect(ids).toContain(stuck);
      expect(ids).not.toEqual(expect.arrayContaining([open]));
      for (const other of [open, foreign, platform]) expect(ids).not.toContain(other);
      expect(JSON.stringify(status)).not.toContain(`payload-${run}`);
      expect(JSON.stringify(status)).not.toContain('someone@example.org');
      expect(status.diagnosis).toContain(`site: recovery-${run}`);

      await invoker.run(useCases.retryJob, adminOf(tenantId), { id: stuck });
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

    it('counts its own waiting work per type, not the stuck, the foreign or the platform', async () => {
      const type = `conformance.${run}.waiting`;
      await job({ type, attempts: 0 });
      await job({ type, attempts: 4 });
      await job({ type });
      await job({ type, attempts: 0, tenant: otherId });
      await job({ type, attempts: 0, tenant: null });
      const status = await invoker.run(useCases.getOpsStatus, adminOf(tenantId), {});
      expect(status.waiting.filter((w) => w.type === type)).toEqual([
        { type, count: 2, nextRunAt: expect.any(String) },
      ]);
    });

    it('refuses an open job with conflict and a foreign or platform job as not found', async () => {
      const open = await job({ attempts: 3 });
      await expect(
        invoker.run(useCases.closeJob, adminOf(tenantId), { id: open })
      ).rejects.toMatchObject({
        code: 'conflict',
      });
      for (const tenant of [otherId, null]) {
        const id = await job({ tenant });
        await expect(
          invoker.run(useCases.retryJob, adminOf(tenantId), { id })
        ).rejects.toMatchObject({
          code: 'not_found',
        });
        expect((await read(id))!.attempts).toBe(10);
      }
    });

    it('leaves a job alone while its last attempt holds the lease', async () => {
      const running = await job({ claimedAt: new Date() });
      await expect(
        invoker.run(useCases.retryJob, adminOf(tenantId), { id: running })
      ).rejects.toMatchObject({
        code: 'conflict',
      });
      expect((await read(running))!.attempts).toBe(10);
    });

    it('makes an exhausted mail.reconcile from the #22C claim visible, claimable and run again', async () => {
      // The claim plans `mail.reconcile:<key>` RECONCILE_LAG_MS ahead, in its own transaction.
      const key = `recovery-${run}:${uuidv7()}`;
      await uow.run(adminOf(tenantId), (ctx) =>
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
      const status = await invoker.run(useCases.getOpsStatus, adminOf(tenantId), {});
      expect(status.jobs.find((j) => j.id === planned!.id)).toMatchObject({
        type: 'mail.reconcile',
        lastError: 'no event for it',
      });

      await invoker.run(useCases.retryJob, adminOf(tenantId), { id: planned!.id });
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
      await invoker.run(useCases.closeJob, adminOf(tenantId), { id: stuck });
      expect((await read(stuck))!.done_at).not.toBeNull();
      const planned = await uow.run(adminOf(tenantId), (ctx) =>
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
      await withTenant(appDb, adminOf(tenantId), (trx) =>
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

    const hoster = { actorId: 'conformance', hasher: new FakeInputHasher() };

    it('retries and closes a stuck job of any tenant, one platform audit row each', async () => {
      const stuck = await job();
      expect(await opsRetryJob(operatorDb, stuck, hoster)).toBe('ok');
      expect(await read(stuck)).toMatchObject({
        attempts: 0,
        claimed_at: null,
        done_at: null,
        last_error: 'failed for someone@example.org',
      });
      expect(await auditOf(stuck)).toMatchObject([
        {
          operation: 'platform.ops.job.retry',
          actor_kind: 'platform',
          actor_id: 'conformance',
          result: 'ok',
          tenant_id: tenantId,
        },
      ]);
      // Retried, it is no longer stuck: the next recovery is a conflict and writes no row.
      expect(await opsCloseJob(operatorDb, stuck, hoster)).toBe('not_exhausted');
      expect(await auditOf(stuck)).toHaveLength(1);

      const toClose = await job({ tenant: otherId });
      expect(await opsCloseJob(operatorDb, toClose, hoster)).toBe('ok');
      expect((await read(toClose))!.done_at).not.toBeNull();
    });

    it('recovers a platform job and a job whose worker never reported an error', async () => {
      const platform = await job({ tenant: null });
      expect(await opsRetryJob(operatorDb, platform, hoster)).toBe('ok');
      expect(await read(platform)).toMatchObject({ attempts: 0, tenant_id: null });
      // The case behind 0016's select policy: nothing in `last_error` marks the row as recovered.
      const silent = await job({ lastError: null });
      expect(await opsCloseJob(operatorDb, silent, hoster)).toBe('ok');
      expect(await read(silent)).toMatchObject({ last_error: null });
      expect((await read(silent))!.done_at).not.toBeNull();
    });

    it('refuses what is not stuck: open, running, unknown', async () => {
      const open = await job({ attempts: 3 });
      const running = await job({ claimedAt: new Date() });
      expect(await opsRetryJob(operatorDb, open, hoster)).toBe('not_exhausted');
      expect(await opsCloseJob(operatorDb, running, hoster)).toBe('not_exhausted');
      expect(await opsRetryJob(operatorDb, uuidv7(), hoster)).toBe('not_found');
      expect(await opsRetryEvent(operatorDb, uuidv7(), hoster)).toBe('not_found');
      expect((await read(open))!.attempts).toBe(3);
      expect(await read(running)).toMatchObject({ attempts: 10, done_at: null });
      expect(await auditOf(open)).toEqual([]);
    });

    it('gives a dead event new passes, keeping who already delivered', async () => {
      const id = uuidv7();
      events.push(id);
      await withTenant(appDb, adminOf(tenantId), (trx) =>
        trx
          .insertInto('outbox')
          .values({
            id,
            tenant_id: tenantId,
            type: `conformance.${run}.retry`,
            occurred_at: new Date(),
            actor: JSON.stringify({ kind: 'system', job: 'test' }),
            props: JSON.stringify({}),
            attempts: 10,
            delivered_to: ['already.done'],
            last_error: 'subscriber x failed',
          })
          .execute()
      );
      expect(await opsRetryEvent(operatorDb, id, hoster)).toBe('ok');
      const row = (await asWorker((trx) =>
        trx.selectFrom('outbox').selectAll().where('id', '=', id).executeTakeFirst()
      ))!;
      // Due now with its passes back; a drain elsewhere in the run may already have processed it
      // (no subscriber knows the type), which is the same outcome one step later.
      if (row.processed_at === null) {
        expect(row).toMatchObject({ attempts: 0, last_error: 'subscriber x failed' });
        expect(+new Date(row.available_at)).toBeLessThanOrEqual(Date.now() + 1000);
      }
      expect(row.delivered_to).toContain('already.done');
      expect(await auditOf(id)).toMatchObject([
        { operation: 'platform.ops.outbox.retry', actor_kind: 'platform', result: 'ok' },
      ]);
      expect(await opsRetryEvent(operatorDb, id, hoster)).toBe('not_exhausted');
    });

    it('lists unknown and abandoned mail without the correlation', async () => {
      const at = new Date(Date.now() - 3600_000);
      await withTenant(appDb, adminOf(tenantId), (trx) =>
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
