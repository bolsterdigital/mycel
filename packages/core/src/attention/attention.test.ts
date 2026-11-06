// The attention use cases over the memory store: who sees which source, what counts
// as new, and that a solved problem leaves the list by itself. The database adapter's half (the
// read state on the membership, the one-statement intent read, the fixed number of queries) is in
// packages/db/src/attention.test.ts.

import { beforeEach, describe, expect, it } from 'vitest';
import type { ConnectionRecord } from '../connections/ports.js';
import type { ConnectionIntent } from '../connections/intents.js';
import { Invoker } from '../invoke.js';
import type { JobRecord } from '../jobs/ports.js';
import type { Capability, Principal } from '../principal.js';
import { FakeClock, MemoryUnitOfWork, TENANT, expectCode, principal } from '../testing/index.js';
import { buildRegistry, useCases } from '../use-cases.js';

const OPERATOR = '01900000-0000-7000-8000-0000000e0001';
const CONNECTION = '01900000-0000-7000-8000-0000000e0c01';
const ADMIN: Capability[] = ['tenant:admin'];
const EDITOR: Capability[] = [
  'content:read',
  'content:write',
  'content:publish',
  'media:read',
  'media:write',
  'ai:assist',
  'forms:read',
  'supporters:read',
];
const minutes = (n: number) => n * 60_000;

describe('attention', () => {
  let clock: FakeClock;
  let uow: MemoryUnitOfWork;
  let invoker: Invoker;
  let n = 0;

  const member = (capabilities: Capability[]): Principal => {
    uow.store.for(TENANT).members.set(OPERATOR, { capabilities, createdAt: clock.now() });
    uow.store.operators.set(OPERATOR, {
      id: OPERATOR,
      issuer: null,
      subject: null,
      email: 'lid@example.org',
      emailVerifiedAt: null,
      name: null,
      lastLoginAt: clock.now(),
    });
    return principal({
      actor: { kind: 'operator', operatorId: OPERATOR, email: 'lid@example.org' },
      capabilities,
    });
  };

  function job(over: Partial<JobRecord> = {}): JobRecord {
    const row: JobRecord = {
      id: `01900000-0000-7000-8000-0000000f${String(++n).padStart(4, '0')}`,
      tenantId: TENANT,
      type: 'mail.reconcile',
      key: `mail.reconcile:attention:${n}`,
      runAt: clock.now(),
      payload: {},
      attempts: 10,
      maxAttempts: 10,
      claimedAt: null,
      doneAt: null,
      lastError: 'gave up',
      createdAt: new Date(clock.now().getTime() - minutes(60)),
      failedAt: clock.now(),
      ...over,
    };
    uow.store.jobs.push(row);
    return row;
  }

  function connection(over: Partial<ConnectionRecord> = {}): ConnectionRecord {
    const row: ConnectionRecord = {
      id: CONNECTION,
      provider: 'webhook',
      accountRef: null,
      externalOwner: 'Team',
      maintainer: 'Team',
      purpose: 'CRM',
      direction: 'outbound',
      dataAuthority: 'mycel',
      consentAuthority: 'mycel',
      consentScopes: [],
      formIds: [],
      destination: 'https://crm.example.org/hook',
      contractVersion: '1',
      adapterVersion: '1',
      state: 'active',
      version: 1,
      credentialVersion: 1,
      hasCredential: true,
      createdAt: clock.now(),
      updatedAt: clock.now(),
      ...over,
    };
    uow.store.for(TENANT).connections.set(row.id, row);
    return row;
  }

  function intent(state: ConnectionIntent['state'], at: Date): void {
    const id = `01900000-0000-7000-8000-0000000d${String(++n).padStart(4, '0')}`;
    uow.store.for(TENANT).connectionIntents.set(id, {
      id,
      connectionId: CONNECTION,
      businessId: id,
      connectionVersion: 1,
      credentialVersion: 1,
      source: 'form',
      mappingVersion: '1',
      supporterId: null,
      scope: 'crm',
      actor: { kind: 'system', id: 'test' },
      key: id,
      state,
      failure: state === 'failed' ? 'exhausted' : null,
      attempts: 1,
      revision: 1,
      leaseToken: null,
      leaseUntil: null,
      nextAt: at,
      createdAt: at,
      updatedAt: at,
    });
  }

  const list = (p: Principal) => invoker.run(useCases.listAttention, p, {});
  const summary = (p: Principal) => invoker.run(useCases.getAttentionSummary, p, {});
  const seen = (p: Principal, at: Date = clock.now()) =>
    invoker.run(useCases.updateAttentionSeenAt, p, { at: at.toISOString() });

  beforeEach(() => {
    clock = new FakeClock();
    uow = new MemoryUnitOfWork({ clock });
    invoker = new Invoker(buildRegistry(), uow);
  });

  it('shows an administrator the four sources, newest first, each as new', async () => {
    const j = job();
    clock.advance(minutes(1));
    const s = uow.store.for(TENANT);
    s.erasures.set('sup', {
      emailHash: 'h',
      erasedAt: new Date(clock.now().getTime() - minutes(90)),
      actor: { kind: 'system', job: 'test' },
    });
    connection();
    clock.advance(minutes(1));
    intent('failed', clock.now());

    const { items, summary: sum } = await list(member(ADMIN));
    expect(items.map((i) => [i.key, i.count, i.unread])).toEqual([
      [`connection:${CONNECTION}`, 1, true],
      [`job:${j.id}`, 1, true],
      ['erasure', 1, true],
    ]);
    expect(items[1]).toMatchObject({ detail: 'mail.reconcile', since: j.failedAt!.toISOString() });
    expect(sum).toMatchObject({ total: 3, unread: 3, seenAt: null });
    expect(sum.sources.map((x) => x.source)).toEqual(['job', 'mail', 'erasure', 'connection']);
  });

  it('shows an editor or author nothing of the administrator sources', async () => {
    job();
    connection({ hasCredential: false });
    for (const caps of [EDITOR, ['content:read'] as Capability[]]) {
      await expect(list(member(caps))).resolves.toEqual({
        items: [],
        summary: { total: 0, unread: 0, sources: [], seenAt: null },
      });
    }
  });

  it('counts only what began asking after the list was read, and never moves that back', async () => {
    const admin = member(ADMIN);
    job();
    clock.advance(minutes(1));
    const first = clock.now();
    await expect(seen(admin)).resolves.toEqual({ seenAt: first.toISOString() });
    expect((await summary(admin)).unread).toBe(0);

    clock.advance(minutes(1));
    job();
    await expect(summary(admin)).resolves.toMatchObject({ total: 2, unread: 1 });

    // An older tab sends an older moment: the stored one stays.
    await expect(seen(admin, new Date(first.getTime() - minutes(5)))).resolves.toEqual({
      seenAt: first.toISOString(),
    });
    // A moment in the future is capped at now, so tomorrow's failure is still new.
    await expect(seen(admin, new Date(clock.now().getTime() + minutes(60)))).resolves.toEqual({
      seenAt: clock.now().toISOString(),
    });
    expect((await summary(admin)).unread).toBe(0);
  });

  it('drops a solved problem without anyone marking it', async () => {
    const admin = member(ADMIN);
    const j = job();
    connection({ hasCredential: false });
    expect((await list(admin)).items).toHaveLength(2);
    await invoker.run(useCases.closeJob, admin, { id: j.id });
    uow.store.for(TENANT).connections.set(CONNECTION, connection({ hasCredential: true }));
    expect((await list(admin)).items).toEqual([]);
  });

  it('counts given-up mail as one notification dated by the newest', async () => {
    const s = uow.store.for(TENANT);
    const base = {
      subscriber: 'mailing.confirmation',
      eventId: 'e',
      attemptedAt: clock.now(),
      claimedUntil: null,
      attempts: 3,
      sentAt: null,
      providerId: null,
      lastError: null,
      correlation: null,
    };
    s.mailSends.set('a', { ...base, key: 'a', abandonedAt: clock.now() });
    clock.advance(minutes(3));
    s.mailSends.set('b', { ...base, key: 'b', abandonedAt: clock.now() });
    s.mailSends.set('c', { ...base, key: 'c', abandonedAt: null });
    const { items } = await list(member(ADMIN));
    expect(items).toEqual([
      expect.objectContaining({ key: 'mail', count: 2, since: clock.now().toISOString() }),
    ]);
  });

  it('keeps no read state for a key: all is new, and marking read is refused', async () => {
    job();
    const key = principal({ actor: { kind: 'api-key', keyId: 'k' }, capabilities: ADMIN });
    await expect(summary(key)).resolves.toMatchObject({ unread: 1, seenAt: null });
    await expectCode(seen(key), 'forbidden');
  });
});
