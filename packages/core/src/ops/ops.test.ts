import { beforeEach, describe, expect, it } from 'vitest';
import { Invoker } from '../invoke.js';
import type { JobRecord } from '../jobs/ports.js';
import { systemPrincipal, type Principal } from '../principal.js';
import {
  FakeClock,
  MemoryUnitOfWork,
  probeTenant,
  secureErasures,
  TENANT,
  adminOf,
} from '../testing/index.js';
import { buildRegistry, useCases } from '../use-cases.js';
import { buildDiagnosis, keyPrefix } from './model.js';

const OTHER = '01900000-0000-7000-8000-00000000bbbb';

describe('job recovery (TODO #17c)', () => {
  let uow: MemoryUnitOfWork;
  let clock: FakeClock;
  let invoker: Invoker;
  let n = 0;

  /** A job straight into the store, as the worker would have left it. */
  function job(over: Partial<JobRecord> = {}): JobRecord {
    const row: JobRecord = {
      id: `01900000-0000-7000-8000-0000000c${String(++n).padStart(4, '0')}`,
      tenantId: TENANT,
      type: 'mail.reconcile',
      key: `mail.reconcile:confirmation:${n}`,
      runAt: clock.now(),
      payload: { secret: 'never shown' },
      attempts: 10,
      maxAttempts: 10,
      claimedAt: null,
      doneAt: null,
      lastError: 'no event for it',
      createdAt: clock.now(),
      ...over,
    };
    uow.store.jobs.push(row);
    return row;
  }

  beforeEach(() => {
    clock = new FakeClock();
    uow = new MemoryUnitOfWork({ clock });
    uow.store.addPlatformHostname(probeTenant(TENANT), uow.platform.domain);
    invoker = new Invoker(buildRegistry(), uow);
  });

  it('retries an exhausted job: attempts from zero, due now, unclaimed, last error kept', async () => {
    const j = job({ claimedAt: clock.now(), runAt: new Date(0) });
    clock.advance(60_000);
    await expect(invoker.run(useCases.retryJob, adminOf(), { id: j.id })).resolves.toEqual({
      id: j.id,
    });
    expect(j).toMatchObject({
      attempts: 0,
      runAt: clock.now(),
      claimedAt: null,
      doneAt: null,
      lastError: 'no event for it',
    });
  });

  it('closes an exhausted job: done now, last error kept', async () => {
    const j = job();
    await invoker.run(useCases.closeJob, adminOf(), { id: j.id });
    expect(j).toMatchObject({ doneAt: clock.now(), attempts: 10, lastError: 'no event for it' });
  });

  it.each([
    ['retryJob', 'with attempts left', { attempts: 3 }],
    ['retryJob', 'already done', { doneAt: new Date(0) }],
    ['closeJob', 'with attempts left', { attempts: 3 }],
    ['closeJob', 'already done', { doneAt: new Date(0) }],
  ] as const)('%s refuses a job %s with conflict and changes nothing', async (name, _w, over) => {
    const j = job(over);
    const before = { ...j };
    await expect(invoker.run(useCases[name], adminOf(), { id: j.id })).rejects.toMatchObject({
      code: 'conflict',
    });
    expect(j).toEqual(before);
  });

  it("does not find another tenant's job, nor a platform job", async () => {
    for (const tenantId of [OTHER, null]) {
      const j = job({ tenantId });
      await expect(invoker.run(useCases.retryJob, adminOf(), { id: j.id })).rejects.toMatchObject({
        code: 'not_found',
      });
      expect(j.attempts).toBe(10);
    }
  });

  it('audits both recoveries, and needs tenant:admin', async () => {
    const j = job();
    const editor: Principal = { ...adminOf(), capabilities: ['content:write'] };
    await expect(invoker.run(useCases.retryJob, editor, { id: j.id })).rejects.toMatchObject({
      code: 'forbidden',
    });
    await invoker.run(useCases.retryJob, adminOf(), { id: j.id });
    const rows = uow.store.for(TENANT).audit;
    expect(rows.map((r) => [r.operation, r.result, r.subjectId])).toEqual([
      ['ops.job.retry', 'forbidden', null],
      ['ops.job.retry', 'ok', j.id],
    ]);
  });

  it('a failed run after a retry exhausts the job again: no loop', async () => {
    const j = job({ maxAttempts: 2, attempts: 2 });
    await invoker.run(useCases.retryJob, adminOf(), { id: j.id });
    // Two failed claims, as the worker counts them.
    j.attempts += 2;
    const status = await invoker.run(useCases.getOpsStatus, adminOf(), {});
    expect(status.jobs.map((s) => s.id)).toEqual([j.id]);
  });

  describe('ops.status.get', () => {
    it('shows only this tenant’s exhausted jobs, without a payload', async () => {
      const stuck = job();
      job({ attempts: 2 });
      job({ doneAt: new Date(0) });
      job({ tenantId: OTHER });
      job({ tenantId: null });
      const status = await invoker.run(useCases.getOpsStatus, adminOf(), {});
      expect(status.jobs).toEqual([
        {
          id: stuck.id,
          type: 'mail.reconcile',
          key: stuck.key,
          attempts: 10,
          maxAttempts: 10,
          lastError: 'no event for it',
          createdAt: stuck.createdAt.toISOString(),
        },
      ]);
      expect(JSON.stringify(status)).not.toContain('never shown');
    });

    it('shows unknown and abandoned mail, with the latest actions and the diagnosis', async () => {
      const store = uow.store.for(TENANT);
      const at = new Date(clock.now().getTime() - 3600_000);
      const intent = {
        subscriber: 'mailing.confirmation',
        eventId: 'e1',
        attemptedAt: at,
        claimedUntil: at,
        attempts: 1,
        sentAt: null,
        abandonedAt: null,
        providerId: null,
        lastError: 'timeout sending to someone@example.org',
        correlation: 'f'.repeat(64),
      };
      store.mailSends.set('a', { ...intent, key: 'a' });
      store.mailSends.set('b', { ...intent, key: 'b', abandonedAt: clock.now() });
      store.mailSends.set('c', { ...intent, key: 'c', sentAt: clock.now() });
      const j = job();
      await invoker
        .run(useCases.closeJob, adminOf(), { id: job({ attempts: 1 }).id })
        .catch(() => {});
      const status = await invoker.run(useCases.getOpsStatus, adminOf(), {});
      expect(status.mails.map((m) => m.state).sort()).toEqual(['abandoned', 'unknown']);
      expect(status.mails[0]).not.toHaveProperty('correlation');
      expect(status.audit.map((r) => [r.operation, r.result])).toEqual([
        ['ops.job.close', 'conflict'],
      ]);
      expect(status.diagnosis).toContain(`site: probe\n`);
      expect(status.diagnosis).toContain(`- mail.reconcile ${j.key} attempts 10/10`);
      expect(status.diagnosis).toContain('- abandoned mailing.confirmation attempts 1');
      expect(status.diagnosis).not.toContain('@');
      expect(status.diagnosis).not.toContain('f'.repeat(64));
    });

    it('is empty when nothing is stuck', async () => {
      const status = await invoker.run(useCases.getOpsStatus, adminOf(), {});
      expect(status).toMatchObject({ jobs: [], mails: [], audit: [] });
      expect(status.erasures).toEqual({
        registered: 0,
        unsecured: 0,
        oldestUnsecuredAt: null,
        late: false,
      });
      expect(status.diagnosis).toContain('exhausted jobs: 0');
      expect(status.diagnosis).toContain('erasures not in a backup: 0\n');
    });

    it('warns about an erasure no backup holds after an hour, and not before (TODO #29B)', async () => {
      const erased = clock.now();
      await uow.run(adminOf(), (ctx) =>
        ctx.erasures.register('01900000-0000-7000-8000-0000000e0001', 'ada@example.org')
      );
      clock.advance(59 * 60_000);
      let status = await invoker.run(useCases.getOpsStatus, adminOf(), {});
      expect(status.erasures).toEqual({
        registered: 1,
        unsecured: 1,
        oldestUnsecuredAt: erased.toISOString(),
        late: false,
      });
      clock.advance(2 * 60_000);
      status = await invoker.run(useCases.getOpsStatus, adminOf(), {});
      expect(status.erasures.late).toBe(true);
      expect(status.diagnosis).toContain(
        `erasures not in a backup: 1 oldest since ${erased.toISOString()} (late)`
      );
      expect(status.diagnosis).not.toContain('@');

      secureErasures(uow.store, TENANT, 'a'.repeat(64), clock.now());
      status = await invoker.run(useCases.getOpsStatus, adminOf(), {});
      expect(status.erasures).toEqual({
        registered: 1,
        unsecured: 0,
        oldestUnsecuredAt: null,
        late: false,
      });
    });
  });
});

describe('the diagnosis to share (brief decision 6)', () => {
  const at = new Date('2026-10-22T12:00:00Z');
  it('redacts an address in a job error and a mail error, and request ids stay ids', () => {
    const text = buildDiagnosis({
      tenantSlug: 'probe',
      at,
      jobs: [
        {
          id: '01900000-0000-7000-8000-0000000c0001',
          type: 'mail.reconcile',
          key: 'mail.reconcile:confirmation:01900000-0000-7000-8000-0000000e0001',
          attempts: 10,
          maxAttempts: 10,
          lastError: 'unknown supporter Jane.Doe+news@Example.org\nat line 3',
          createdAt: at.toISOString(),
        },
      ],
      mails: [
        {
          state: 'unknown',
          subscriber: 'mailing.confirmation',
          attempts: 2,
          attemptedAt: at.toISOString(),
          abandonedAt: null,
          lastError: 'rcpt a%40b.nl refused',
        },
      ],
      erasures: { registered: 3, unsecured: 0, oldestUnsecuredAt: null, late: false },
      failedRequests: ['req-1', 'req-2'],
    });
    expect(text).toBe(
      [
        'site: probe',
        'at: 2026-10-22T12:00:00.000Z',
        'exhausted jobs: 1',
        `- mail.reconcile ${keyPrefix('mail.reconcile:confirmation:01900000-0000-7000-8000-0000000e0001')} attempts 10/10 since 2026-10-22T12:00:00.000Z: unknown supporter [email] at line 3`,
        'unresolved mail: 1',
        '- unknown mailing.confirmation attempts 2 attempted 2026-10-22T12:00:00.000Z: rcpt [email] refused',
        'erasures not in a backup: 0',
        'failed requests: req-1 req-2',
      ].join('\n')
    );
  });

  it('cuts a long key to a prefix', () => {
    expect(keyPrefix('x'.repeat(100))).toBe(`${'x'.repeat(48)}…`);
    expect(keyPrefix('short:key')).toBe('short:key');
  });
});
