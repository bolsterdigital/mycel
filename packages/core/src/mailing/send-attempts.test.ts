// The send-once contract (ADR 019 rule 6, brief #22C) in memory. The provider stub is the outside
// world (testing.md rule 4): it keeps the list of messages it accepted, can accept a message and
// lose the response, can refuse one, can be slow to list what it accepted, and can be down. The
// claim race against Postgres is in packages/db/src/mailing.test.ts.

import { beforeEach, describe, expect, it } from 'vitest';
import { FakeClock, MemoryUnitOfWork } from '../testing/index.js';
import { renderConfirmationMail } from './confirmation.js';
import {
  CLAIM_LEASE_MS,
  MAX_SEND_ATTEMPTS,
  RECONCILE_GIVE_UP_MS,
  RECONCILE_INTERVAL_MS,
  RECONCILE_LAG_MS,
  claimAttempt,
  reconcileMail,
  sendOnce,
} from './send-attempts.js';
import type { MailMessage, MailWindow, Mailer } from './ports.js';

const TENANT = '01900000-0000-7000-8000-00000000aaaa';
const MINUTE = 60 * 1000;
const PAST_LAG = RECONCILE_LAG_MS + MINUTE;

/**
 * A provider without idempotency keys. `mode`: `ok`; `lost` accepts the message and then the
 * response is lost (an abort after acceptance); `refused` fails before accepting anything.
 * `indexed` false: the listing does not show anything yet. `down`: the listing does not answer.
 */
class FlakyMailer implements Mailer {
  readonly accepted: { id: string; key: string; to: string; subject: string; at: Date }[] = [];
  readonly calls: string[] = [];
  readonly lookups: MailWindow[] = [];
  mode: 'ok' | 'lost' | 'refused' = 'ok';
  indexed = true;
  down = false;
  /** Holds `send` until released, to observe an attempt in flight. */
  gate: Promise<void> | null = null;

  constructor(private readonly clock: FakeClock) {}

  async send(message: MailMessage, key: string): Promise<{ providerId: string }> {
    this.calls.push(key);
    if (this.gate) await this.gate;
    if (this.mode === 'refused') throw new Error('TEM API 503: unavailable');
    const id = this.accept(message, key);
    if (this.mode === 'lost') throw new DOMException('The operation was aborted', 'AbortError');
    return { providerId: id };
  }

  /** A message the provider holds, sent by us or by anything else with the same address. */
  accept(message: MailMessage, key = 'outside'): string {
    const id = `p${this.accepted.length + 1}`;
    const { email } = message.to;
    this.accepted.push({ id, key, to: email, subject: message.subject, at: this.clock.now() });
    return id;
  }

  async lookup(message: MailMessage, window: MailWindow) {
    this.lookups.push(window);
    if (this.down) return null;
    if (!this.indexed) return { providerIds: [] };
    const ids = this.accepted
      .filter(
        (m) =>
          m.to === message.to.email &&
          m.subject === message.subject &&
          m.at >= window.since &&
          m.at <= window.until
      )
      .map((m) => m.id);
    return { providerIds: ids };
  }

  sentFor(key: string): number {
    return this.accepted.filter((m) => m.key === key).length;
  }
}

const message = renderConfirmationMail({
  locale: 'en',
  tenantName: 'Probe',
  confirmUrl: 'https://example.org/probe/confirm?token=x',
  from: { email: 'noreply@example.org' },
  to: 'ada@example.org',
});
const eventA = { id: '01900000-0000-7000-8000-00000000e00a', tenantId: TENANT };
const eventB = { id: '01900000-0000-7000-8000-00000000e00b', tenantId: TENANT };
const keyOf = (e: { id: string }) => `test:${e.id}`;

describe('sendOnce (ADR 019 rule 6)', () => {
  let clock: FakeClock;
  let uow: MemoryUnitOfWork;
  let mailer: FlakyMailer;
  const intent = (e = eventA) => uow.store.for(TENANT).mailSends.get(keyOf(e));
  const send = (e = eventA) => sendOnce({ mailer, clock, uow }, e, 'test', message);
  const reconcile = (e = eventA) => reconcileMail({ mailer, clock, uow }, e, 'test', message);

  beforeEach(() => {
    clock = new FakeClock();
    uow = new MemoryUnitOfWork({ clock });
    mailer = new FlakyMailer(clock);
  });

  it('claims before the provider call, completes after, and plans the reconcile job with the claim', async () => {
    const started = clock.now();
    expect(await send()).toBe('sent');
    expect(mailer.calls).toEqual([keyOf(eventA)]);
    expect(intent()).toMatchObject({
      key: keyOf(eventA),
      subscriber: 'test',
      eventId: eventA.id,
      attemptedAt: started,
      claimedUntil: new Date(started.getTime() + CLAIM_LEASE_MS),
      attempts: 1,
      sentAt: started,
      providerId: 'p1',
      abandonedAt: null,
      lastError: null,
    });
    // A hash, never the address.
    expect(intent()?.correlation).toMatch(/^[0-9a-f]{64}$/);
    expect(uow.store.jobs).toEqual([
      expect.objectContaining({
        tenantId: TENANT,
        type: 'mail.reconcile',
        key: `mail.reconcile:${keyOf(eventA)}`,
        runAt: new Date(started.getTime() + RECONCILE_LAG_MS),
        payload: { key: keyOf(eventA), subscriber: 'test', eventId: eventA.id },
      }),
    ]);
    // Redelivery of the same event: nothing is listed, nothing is sent.
    expect(await send()).toBe('skipped');
    expect(mailer.calls).toHaveLength(1);
    expect(mailer.lookups).toHaveLength(0);
  });

  it('defers a redelivery while an attempt is in flight, with zero provider calls (f)', async () => {
    let release!: () => void;
    mailer.gate = new Promise((r) => (release = r));
    const first = send();
    while (mailer.calls.length === 0) await new Promise((r) => setTimeout(r, 1));
    // Two more deliveries of the same event while the first one talks to the provider.
    expect(await Promise.all([send(), send()])).toEqual(['deferred', 'deferred']);
    release();
    expect(await first).toBe('sent');
    expect(mailer.calls).toHaveLength(1);
    expect(intent()?.attempts).toBe(1);
  });

  it('takes one claim when two deliveries start at the same moment', async () => {
    const results = await Promise.all([send(), send()]);
    expect(results.sort()).toEqual(['deferred', 'sent']);
    expect(mailer.calls).toHaveLength(1);
  });

  describe('two intents with the same recipient and subject (a)', () => {
    it('A done with p1, B refused: the listing [p1] is not B, so B is resent', async () => {
      expect(await send(eventA)).toBe('sent');
      mailer.mode = 'refused';
      expect(await send(eventB)).toBe('unknown');
      expect(intent(eventB)).toMatchObject({ sentAt: null, lastError: 'TEM API 503: unavailable' });

      mailer.mode = 'ok';
      clock.advance(PAST_LAG);
      expect(await send(eventB)).toBe('sent');
      expect(intent(eventB)).toMatchObject({ providerId: 'p2', attempts: 2 });
      expect(mailer.sentFor(keyOf(eventB))).toBe(1);
    });

    it('A done with p1, B lost after acceptance: B adopts p2 without resending', async () => {
      expect(await send(eventA)).toBe('sent');
      mailer.mode = 'lost';
      expect(await send(eventB)).toBe('unknown');
      mailer.mode = 'ok';
      clock.advance(PAST_LAG);
      expect(await send(eventB)).toBe('reconciled');
      expect(intent(eventB)).toMatchObject({ providerId: 'p2', attempts: 1 });
      expect(mailer.calls).toEqual([keyOf(eventA), keyOf(eventB)]);
    });

    it('A and B both unresolved with [p1, p2]: neither can tell which is its own', async () => {
      mailer.mode = 'lost';
      expect(await send(eventA)).toBe('unknown');
      expect(await send(eventB)).toBe('unknown');
      mailer.mode = 'ok';
      clock.advance(PAST_LAG);
      expect(await send(eventA)).toBe('unknown');
      expect(await send(eventB)).toBe('unknown');
      expect(mailer.calls).toHaveLength(2);
      expect(intent(eventA)?.sentAt).toBeNull();
      expect(intent(eventB)?.sentAt).toBeNull();
    });

    it('A lost after acceptance and then abandoned, B refused: B never adopts p1', async () => {
      mailer.mode = 'lost';
      expect(await send(eventA)).toBe('unknown');
      mailer.mode = 'refused';
      expect(await send(eventB)).toBe('unknown');
      mailer.mode = 'ok';
      clock.advance(PAST_LAG);
      // One unaccounted id, two unresolved intents: ambiguous.
      expect(await send(eventB)).toBe('unknown');
      // A is given up; its message p1 still sits at the provider.
      const a = intent(eventA)!;
      uow.store.for(TENANT).mailSends.set(a.key, { ...a, abandonedAt: clock.now() });
      expect(await send(eventB)).toBe('unknown');
      expect(intent(eventB)).toMatchObject({ sentAt: null, providerId: null });
    });

    it('a message from outside mail_sends with the same address and subject keeps B unknown', async () => {
      mailer.accept(message);
      mailer.mode = 'lost';
      expect(await send(eventB)).toBe('unknown');
      clock.advance(PAST_LAG);
      expect(await send(eventB)).toBe('unknown');
      expect(mailer.calls).toHaveLength(1);
    });
  });

  it('after a timeout past acceptance it reconciles once the budget has passed, with no second send (b)', async () => {
    mailer.mode = 'lost';
    expect(await send()).toBe('unknown');
    expect(intent()).toMatchObject({ sentAt: null, lastError: 'The operation was aborted' });
    // The failure ended the lease: unknown at once, not in flight for another minute.
    expect(intent()?.claimedUntil).toEqual(clock.now());
    mailer.mode = 'ok';
    clock.advance(PAST_LAG);
    expect(await send()).toBe('reconciled');
    expect(intent()).toMatchObject({ providerId: 'p1', sentAt: clock.now() });
    expect(mailer.calls).toHaveLength(1);
  });

  it('trusts the listing only after the budget (c)', async () => {
    mailer.mode = 'lost';
    await send();
    mailer.mode = 'ok';
    mailer.indexed = false;
    // Before the budget: unknown without asking, and never a send.
    clock.advance(RECONCILE_LAG_MS - MINUTE);
    expect(await send()).toBe('unknown');
    expect(mailer.lookups).toHaveLength(0);
    // After the budget the listing shows it: reconciled.
    mailer.indexed = true;
    clock.advance(2 * MINUTE);
    expect(await send()).toBe('reconciled');
    expect(mailer.calls).toHaveLength(1);
  });

  it('resends after the budget when the listing is empty, counting the attempt (c)', async () => {
    mailer.mode = 'refused';
    await send();
    mailer.mode = 'ok';
    clock.advance(PAST_LAG);
    expect(await send()).toBe('sent');
    expect(intent()).toMatchObject({ attempts: 2, providerId: 'p1' });
    expect(mailer.calls).toHaveLength(2);
  });

  it('keeps an outage unknown and replans, then abandons after the give-up time (d)', async () => {
    mailer.mode = 'lost';
    await send();
    mailer.mode = 'ok';
    mailer.down = true;
    clock.advance(PAST_LAG);
    expect(await reconcile()).toEqual({
      next: new Date(clock.now().getTime() + RECONCILE_INTERVAL_MS),
    });
    expect(mailer.calls).toHaveLength(1);
    clock.advance(RECONCILE_GIVE_UP_MS);
    expect(await reconcile()).toEqual({});
    expect(intent()?.abandonedAt).toEqual(clock.now());
    expect(mailer.calls).toHaveLength(1);
    // Abandoned is visible and final.
    const unresolved = await uow.run({ tenantId: TENANT } as never, (ctx) =>
      ctx.mailSends.unresolved(clock.now())
    );
    expect(unresolved.map((m) => m.key)).toEqual([keyOf(eventA)]);
    expect(await send()).toBe('abandoned');
  });

  it(`abandons after ${MAX_SEND_ATTEMPTS} attempts proven not to have arrived (e)`, async () => {
    mailer.mode = 'refused';
    expect(await send()).toBe('unknown');
    for (let i = 1; i < MAX_SEND_ATTEMPTS; i += 1) {
      clock.advance(PAST_LAG);
      expect(await send()).toBe('unknown');
    }
    clock.advance(PAST_LAG);
    expect(await reconcile()).toEqual({});
    expect(intent()).toMatchObject({ attempts: MAX_SEND_ATTEMPTS, abandonedAt: clock.now() });
    expect(mailer.calls).toHaveLength(MAX_SEND_ATTEMPTS);
  });

  it('finishes the job on a terminal outcome and honours a configured budget', async () => {
    const lag = 2 * MINUTE;
    mailer.mode = 'lost';
    expect(
      await sendOnce({ mailer, clock, uow, reconcileLagMs: lag }, eventA, 'test', message)
    ).toBe('unknown');
    expect(uow.store.jobs[0]?.runAt).toEqual(new Date(clock.now().getTime() + lag));
    clock.advance(lag);
    expect(
      await reconcileMail({ mailer, clock, uow, reconcileLagMs: lag }, eventA, 'test', message)
    ).toEqual({});
    expect(intent()?.providerId).toBe('p1');
  });

  it('refuses a second claim for what it read, and one during a lease', async () => {
    const intentRow = { key: 'k', subscriber: 'test', eventId: eventA.id, correlation: 'c' };
    const at = clock.now();
    const claim = (expected: Date | null, when = at) =>
      uow.run({ tenantId: TENANT } as never, (ctx) =>
        claimAttempt(ctx, intentRow, { at: when, expected, lagMs: RECONCILE_LAG_MS })
      );
    expect(await claim(null)).toMatchObject({ attempts: 1 });
    // Same expectation, lease still running, and after the lease with a stale expectation.
    expect(await claim(null)).toBeNull();
    const later = new Date(at.getTime() + CLAIM_LEASE_MS);
    expect(await claim(null, later)).toBeNull();
    expect(await claim(at, later)).toMatchObject({ attempts: 2, attemptedAt: later });
    expect(uow.store.jobs).toHaveLength(1);
  });
});
