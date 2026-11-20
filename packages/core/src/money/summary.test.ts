// What a site received (`summary.ts`) over the memory adapter: the calendar months in the site's
// zone across a summer-time change, which ledger entries count in which month, currencies kept
// apart, the running subscriptions and the right. That Postgres reads the same entries is the
// adapter-rules scenario (`packages/db/src/money/donation-rule.ts`), with another tenant.

import { beforeEach, describe, expect, it } from 'vitest';
import { Invoker } from '../invoke.js';
import { systemPrincipal, type Principal } from '../principal.js';
import { MemoryUnitOfWork, TENANT, expectCode } from '../testing/index.js';
import { buildRegistry, useCases } from '../use-cases.js';
import { exampleId } from '../util/ids.js';
import { LedgerEntry, type PaymentStatus } from './model.js';
import type { Subscription } from './subscription-model.js';
import { summaryMonths } from './summary.js';

const admin = systemPrincipal(TENANT, 'test');
const as = (...capabilities: Principal['capabilities']): Principal => ({ ...admin, capabilities });
const UNTIL = '2026-11-19T10:00:00.000Z';

describe('summaryMonths', () => {
  it('starts this month and the one before at local midnight on the first', () => {
    const m = summaryMonths(new Date(UNTIL), 'Europe/Amsterdam');
    // 1 November is winter time (UTC+1), 1 October still summer time (UTC+2).
    expect(m.from.toISOString()).toBe('2026-10-31T23:00:00.000Z');
    expect(m.previousFrom.toISOString()).toBe('2026-09-30T22:00:00.000Z');
    const january = summaryMonths(new Date('2027-01-10T12:00:00Z'), 'UTC');
    expect(january.previousFrom.toISOString()).toBe('2026-12-01T00:00:00.000Z');
  });
});

describe('donation.summary.get', () => {
  let uow: MemoryUnitOfWork;
  let invoker: Invoker;
  let n = 0;

  const move = (to: PaymentStatus, amount: number, at: string, currency = 'EUR') =>
    uow.run(admin, (ctx) =>
      ctx.payments.appendLedger(
        LedgerEntry.parse({
          id: exampleId(0x100 + n++),
          paymentId: exampleId(0x200 + n),
          from: null,
          to,
          cause: 'webhook',
          providerStatus: to,
          amount,
          currency,
          at,
          actor: { kind: 'system', job: 'test' },
        })
      )
    );
  const subscribe = (kind: Subscription['kind'], status: Subscription['status']) =>
    uow.run(admin, (ctx) =>
      // Only kind and status matter to the count; the memory adapter stores what it is given.
      ctx.subscriptions.insert({ id: exampleId(0x300 + n++), kind, status } as Subscription)
    );
  const summary = (by = admin, timeZone = 'Europe/Amsterdam') =>
    invoker.run(useCases.getDonationSummary, by, { until: UNTIL, timeZone });

  beforeEach(() => {
    uow = new MemoryUnitOfWork();
    invoker = new Invoker(buildRegistry(), uow);
  });

  it('counts a month by the moment of each ledger entry, refunds off the month they happen', async () => {
    await move('paid', 9900, '2026-09-30T21:59:00Z'); // 30 September, before both months
    await move('paid', 2500, '2026-10-15T09:00:00Z');
    await move('paid', 1000, '2026-10-31T23:30:00Z'); // 1 November, 00:30 in Amsterdam
    await move('refunded', 2500, '2026-11-05T09:00:00Z'); // the October gift, refunded now
    await move('charged_back', 500, '2026-10-20T09:00:00Z');
    await move('open', 7000, '2026-11-10T09:00:00Z'); // no money moved
    await move('paid', 4000, '2026-11-19T10:00:01Z'); // after `until`
    const s = await summary();
    expect(s).toMatchObject({
      from: '2026-10-31T23:00:00.000Z',
      until: UNTIL,
      previousFrom: '2026-09-30T22:00:00.000Z',
      timeZone: 'Europe/Amsterdam',
    });
    expect(s.currencies).toEqual([
      {
        currency: 'EUR',
        month: { net: -1500, returned: 2500, gifts: 1 },
        previousMonth: { net: 2000, returned: 500, gifts: 1 },
      },
    ]);
    // In UTC the 23:30 gift is October's.
    const utc = await summary(admin, 'UTC');
    expect(utc.currencies[0]?.month).toEqual({ net: -2500, returned: 2500, gifts: 0 });
  });

  it('keeps currencies apart and names no currency without money', async () => {
    expect((await summary()).currencies).toEqual([]);
    await move('paid', 1500, '2026-11-02T09:00:00Z', 'USD');
    await move('paid', 2000, '2026-11-02T09:00:00Z');
    expect((await summary()).currencies.map((c) => [c.currency, c.month.net])).toEqual([
      ['EUR', 2000],
      ['USD', 1500],
    ]);
  });

  it('counts the recurring gifts and memberships that run now', async () => {
    await subscribe('donation', 'active');
    await subscribe('donation', 'active');
    await subscribe('donation', 'paused');
    await subscribe('donation', 'pending');
    await subscribe('membership', 'active');
    await subscribe('membership', 'cancelled');
    expect((await summary()).running).toEqual({ donations: 2, memberships: 1 });
  });

  it('asks donations:read', async () => {
    await expectCode(summary(as('supporters:read')), 'forbidden');
    expect((await summary(as('donations:read'))).running).toEqual({ donations: 0, memberships: 0 });
  });
});
