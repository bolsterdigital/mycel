// Fold and identity in memory (ADR 019 rules 1 and 2). The lock is a Postgres property; its test
// is the concurrency case in packages/db/src/supporters.conformance.test.ts.

import { beforeEach, describe, expect, it } from 'vitest';
import { Invoker } from '../invoke.js';
import { systemPrincipal } from '../principal.js';
import { buildRegistry, useCases } from '../use-cases.js';
import { MemoryUnitOfWork } from '../testing/index.js';
import { SupporterEvent, type SupporterEventType } from './events.js';
import { rebuildProjection } from './model.js';
import { ingest } from './service.js';

const TENANT = '01900000-0000-7000-8000-00000000aaaa';
const admin = systemPrincipal(TENANT, 'test');

const event = (
  id: string,
  type: SupporterEventType,
  minute: number,
  props: Record<string, unknown> = {},
  email = 'x@example.org'
) =>
  SupporterEvent.parse({
    schema: 'wings.supporter-event.v1',
    id,
    type,
    email,
    // Mixed offsets on purpose: fold order compares instants, not strings.
    occurred_at:
      minute % 2 === 0
        ? new Date(Date.UTC(2026, 9, 21, 12, minute)).toISOString()
        : `2026-10-21T14:${String(minute).padStart(2, '0')}:00+02:00`,
    source: 'test',
    source_site: 'urn:mycel:test',
    source_ref: id,
    props,
  });

function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) return [[...items]];
  return items.flatMap((item, i) =>
    permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [item, ...rest])
  );
}

describe('supporter fold', () => {
  const events = [
    event('e1', 'newsletter.subscribed', 1, { list: 'news' }),
    event('e2', 'newsletter.unsubscribed', 2, { list: 'news' }),
    event('e3', 'newsletter.subscribed', 3, { list: 'campaign' }),
    // Same instant as e3: the id breaks the tie.
    event('e0', 'newsletter.unsubscribed', 3, { list: 'campaign' }),
  ];

  it.each(permutations(events).map((order) => [order.map((e) => e.id).join(' '), order]))(
    'ingesting in order %s equals a rebuild from the log',
    async (_label, order) => {
      const uow = new MemoryUnitOfWork();
      for (const e of order) await uow.run(admin, (ctx) => ingest(ctx, e));
      const stored = await uow.run(admin, (ctx) => ctx.supporters.getProjection('x@example.org'));
      const log = await uow.run(admin, (ctx) => ctx.supporters.eventsFor(stored!.id));
      expect(stored).toEqual(rebuildProjection(log));
      expect(stored).toMatchObject({
        lists: ['campaign'],
        firstSeen: '2026-10-21T12:01:00.000Z',
        lastActivity: '2026-10-21T12:03:00.000Z',
        appliedThrough: { at: '2026-10-21T12:03:00.000Z', id: 'e3' },
      });
    }
  );

  it('leaves a supporter unsubscribed when an older subscribe arrives late (ADR 019 rule 2)', async () => {
    const uow = new MemoryUnitOfWork();
    await uow.run(admin, (ctx) => ingest(ctx, events[1]!));
    await uow.run(admin, (ctx) => ingest(ctx, events[0]!));
    const stored = await uow.run(admin, (ctx) => ctx.supporters.getProjection('x@example.org'));
    expect(stored?.lists).toEqual([]);
  });

  it('dedups on the event id and keeps one supporter id per address', async () => {
    const uow = new MemoryUnitOfWork();
    expect(await uow.run(admin, (ctx) => ingest(ctx, events[0]!))).toBe(true);
    expect(await uow.run(admin, (ctx) => ingest(ctx, events[0]!))).toBe(false);
    await uow.run(admin, (ctx) => ingest(ctx, events[2]!));
    const ids = [...uow.store.for(TENANT).events.values()].map((e) => e.supporter_id);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(1);
  });
});

describe('supporters.email.change', () => {
  let uow: MemoryUnitOfWork;
  let invoker: Invoker;
  let id: string;

  beforeEach(async () => {
    uow = new MemoryUnitOfWork();
    invoker = new Invoker(buildRegistry(), uow);
    await uow.run(admin, (ctx) =>
      ingest(ctx, event('s1', 'newsletter.subscribed', 1, { list: 'news' }, 'old@example.org'))
    );
    id = (await invoker.run(useCases.getSupporter, admin, { email: 'old@example.org' })).id;
  });

  const change = (newEmail: string) =>
    invoker.run(useCases.changeSupporterEmail, admin, {
      supporterId: id,
      newEmail,
      reason: 'Asked by phone.',
    });

  it('moves the address, keeps the id and the history, and logs the change', async () => {
    const after = await change(' New@Example.org ');
    expect(after).toMatchObject({ id, email: 'new@example.org', lists: ['news'] });
    await expect(
      invoker.run(useCases.getSupporter, admin, { email: 'old@example.org' })
    ).rejects.toMatchObject({ code: 'not_found' });

    const log = await uow.run(admin, (ctx) => ctx.supporters.eventsFor(id));
    expect(log.map((e) => e.type)).toEqual(['newsletter.subscribed', 'supporter.email_changed']);
    expect(log[1]).toMatchObject({
      email: 'old@example.org',
      supporter_id: id,
      props: {
        old_email: 'old@example.org',
        new_email: 'new@example.org',
        reason: 'Asked by phone.',
      },
    });
    expect(rebuildProjection(log)).toEqual(after);

    // New events on the new address fold into the same supporter.
    await uow.run(admin, (ctx) =>
      ingest(ctx, event('s2', 'newsletter.subscribed', 2, { list: 'b' }, 'new@example.org'))
    );
    const again = await invoker.run(useCases.getSupporter, admin, { email: 'new@example.org' });
    expect(again).toMatchObject({ id, lists: ['b', 'news'] });
  });

  it('refuses an address another supporter already has', async () => {
    await uow.run(admin, (ctx) =>
      ingest(ctx, event('t1', 'newsletter.subscribed', 1, { list: 'news' }, 'taken@example.org'))
    );
    await expect(change('taken@example.org')).rejects.toMatchObject({ code: 'conflict' });
  });

  it('is a no-op for the current address and not_found for an unknown id', async () => {
    expect((await change('old@example.org')).email).toBe('old@example.org');
    expect(await uow.run(admin, (ctx) => ctx.supporters.eventsFor(id))).toHaveLength(1);
    await expect(
      invoker.run(useCases.changeSupporterEmail, admin, {
        supporterId: '01900000-0000-7000-8000-0000000fffff',
        newEmail: 'x@example.org',
        reason: 'x',
      })
    ).rejects.toMatchObject({ code: 'not_found' });
  });
});
