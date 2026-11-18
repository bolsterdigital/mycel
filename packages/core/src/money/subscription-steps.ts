// What happens to a subscription when one of its payments moves (brief MY-254 PR 1, choices 3-6,
// 15). `reconcile` in `service.ts` calls `onPaymentSettled` after it walked a payment that names a
// subscription, in the same transaction and under the same locks (the giver's address, then the
// payment); this file takes the subscription's lock after those. It imports nothing from
// `service.ts`, so the two do not import each other.
//
// - The first payment `paid`: the mandate it left is recorded, the subscription becomes `active`,
//   the first period starts at `paidAt` and the next charge is due when it ends (choice 4).
// - The first payment `failed` or `expired`: the subscription `ended` (`first-payment`); nothing
//   was promised, so no event.
// - A charge `paid`: one period more, counted from the start so the day of the month stays.
// - A charge `failed`, `expired` or a payment `charged_back` (choice 6): one failed attempt; the
//   dunning policy says when to try again, and after the last one the subscription `ended`
//   (`dunning`). `paidThrough` never goes back.
//
// Each of these is one subscription ledger entry with the payment's cause (rules 1 and 5), and a
// started or ended subscription is one event in the giver's log (choice 15).
//
// Rejected: a second reconcile for subscriptions that asks the provider again (the payment's walk
// is the fact; this only follows it), and ending a subscription on a chargeback at once (a donor
// whose bank reversed one charge gets the same retries as one whose charge failed, choice 6).

import type { TransactionContext } from '../ports.js';
import { storedActor } from '../principal.js';
import { isTombstone } from '../supporters/erasure.js';
import { SupporterEvent } from '../supporters/events.js';
import { SOURCE, appendAndFold } from '../supporters/service.js';
import '../supporters/ports.js';
import { sha1Hex } from '../util/digest.js';
import type { LedgerCause, Payment, PaymentStatus } from './model.js';
import type { ProviderPayment } from './ports.js';
import './ports.js';
import {
  DEFAULT_DUNNING,
  Mandate,
  Subscription,
  SubscriptionLedgerEntry,
  addInterval,
  isSubscriptionFinal,
  nextRetry,
  type SubscriptionCause,
  type SubscriptionStatus,
  type SubscriptionStep,
} from './subscription-model.js';

/**
 * Write `next` with one ledger entry for the step from `current`. The caller holds the
 * subscription's lock (or inserted it in this transaction).
 */
export async function stepSubscription(
  ctx: TransactionContext,
  current: Subscription | null,
  next: Subscription,
  step: SubscriptionStep,
  cause: SubscriptionCause
): Promise<Subscription> {
  const at = ctx.clock.now().toISOString();
  const saved = Subscription.parse({ ...next, updatedAt: at });
  if (current) await ctx.subscriptions.save(saved);
  else await ctx.subscriptions.insert(saved);
  await ctx.subscriptions.appendLedger(
    SubscriptionLedgerEntry.parse({
      id: ctx.ids.next(),
      subscriptionId: saved.id,
      from: current?.status ?? null,
      to: saved.status,
      step,
      cause,
      paidThrough: saved.paidThrough,
      failedAttempts: saved.failedAttempts,
      amount: saved.amount,
      currency: saved.currency,
      at,
      actor: storedActor(ctx.principal.actor),
    })
  );
  return saved;
}

type SubscriptionEvent =
  | 'donation.subscription.started'
  | 'donation.subscription.cancelled'
  | 'donation.subscription.ended';

/**
 * A reference in the giver's log (choice 15). The caller holds the giver's address lock; an
 * erased or unknown giver gets nothing.
 */
export async function appendSubscriptionEvent(
  ctx: TransactionContext,
  sub: Subscription,
  type: SubscriptionEvent,
  extra: Record<string, unknown> = {}
): Promise<void> {
  if (!sub.supporterId) return;
  const p = await ctx.supporters.getProjectionById(sub.supporterId);
  if (!p || isTombstone(p.email) || !(await ctx.erasures.allows(p.email, p.id))) return;
  const at = ctx.clock.now().toISOString();
  const ref = `subscription:${sub.id}`;
  await appendAndFold(ctx, {
    ...SupporterEvent.parse({
      schema: 'wings.supporter-event.v1',
      id: await sha1Hex([SOURCE, ref, type, at].join('|')),
      type,
      email: p.email,
      occurred_at: at,
      source: SOURCE,
      source_site: 'urn:mycel:money',
      source_ref: ref,
      props: {
        subscription_id: sub.id,
        amount: sub.amount,
        currency: sub.currency,
        interval: sub.interval,
        ...extra,
      },
    }),
    supporter_id: p.id,
  });
}

/** End `sub` (`ended`, or `cancelled` by a person), with its event when it had started. */
export async function finish(
  ctx: TransactionContext,
  sub: Subscription,
  to: Extract<SubscriptionStatus, 'cancelled' | 'ended'>,
  cause: SubscriptionCause,
  reason: Subscription['endReason']
): Promise<Subscription> {
  const done = await stepSubscription(
    ctx,
    sub,
    { ...sub, status: to, nextChargeAt: null, endReason: reason },
    to,
    cause
  );
  if (sub.status !== 'pending')
    await appendSubscriptionEvent(
      ctx,
      done,
      to === 'cancelled' ? 'donation.subscription.cancelled' : 'donation.subscription.ended',
      reason ? { reason } : {}
    );
  return done;
}

/**
 * One failed attempt on an active subscription (a charge that failed, a chargeback, a mandate
 * that is gone): try again when the policy says, or end it.
 */
export async function failAttempt(
  ctx: TransactionContext,
  sub: Subscription,
  cause: SubscriptionCause,
  retries: boolean
): Promise<Subscription> {
  const failedAttempts = sub.failedAttempts + 1;
  // Dunning counts from the day the charge was due (choice 5): day 0, +3, +7.
  const retry = sub.paidThrough
    ? nextRetry(DEFAULT_DUNNING, failedAttempts, sub.paidThrough)
    : null;
  if (failedAttempts > DEFAULT_DUNNING.retryAfterDays.length)
    return finish(ctx, { ...sub, failedAttempts }, 'ended', cause, 'dunning');
  return stepSubscription(
    ctx,
    sub,
    // A chargeback leaves the next charge where it was; a failed charge moves it to the retry.
    { ...sub, failedAttempts, nextChargeAt: retries ? retry : sub.nextChargeAt },
    'charge-failed',
    cause
  );
}

async function activate(
  ctx: TransactionContext,
  sub: Subscription,
  payment: Payment,
  reported: ProviderPayment,
  cause: SubscriptionCause
): Promise<void> {
  const at = ctx.clock.now().toISOString();
  let mandateId: string | null = null;
  if (reported.mandate) {
    mandateId = ctx.ids.next();
    await ctx.subscriptions.insertMandate(
      Mandate.parse({
        id: mandateId,
        provider: payment.provider,
        customerRef: reported.mandate.customerRef,
        mandateRef: reported.mandate.mandateRef,
        status: reported.mandate.valid ? 'valid' : 'invalid',
        method: reported.mandate.method,
        supporterId: payment.supporterId,
        createdAt: at,
        updatedAt: at,
      })
    );
  }
  const startedAt = payment.paidAt ?? at;
  const paidThrough = addInterval(startedAt, 1, sub.interval);
  const active = await stepSubscription(
    ctx,
    sub,
    {
      ...sub,
      status: 'active',
      // The ingest of a form gift found or made the supporter while the payment walked.
      supporterId: sub.supporterId ?? payment.supporterId,
      mandateId,
      startedAt,
      periodsPaid: 1,
      paidThrough,
      nextChargeAt: paidThrough,
      failedAttempts: 0,
    },
    'activated',
    cause
  );
  await appendSubscriptionEvent(ctx, active, 'donation.subscription.started');
}

async function renew(
  ctx: TransactionContext,
  sub: Subscription,
  cause: SubscriptionCause
): Promise<void> {
  if (!sub.startedAt) return;
  const periodsPaid = sub.periodsPaid + 1;
  const paidThrough = addInterval(sub.startedAt, periodsPaid, sub.interval);
  await stepSubscription(
    ctx,
    sub,
    {
      ...sub,
      periodsPaid,
      paidThrough,
      nextChargeAt: sub.status === 'active' ? paidThrough : null,
      failedAttempts: 0,
    },
    'renewed',
    cause
  );
}

const FAILS: readonly PaymentStatus[] = ['failed', 'expired', 'charged_back'];

/**
 * Follow `payment`, which has just walked `path` (`reconcile` in `service.ts`), with its
 * subscription. A charge attempt whose payment settled is done.
 */
export async function onPaymentSettled(
  ctx: TransactionContext,
  payment: Payment,
  path: readonly PaymentStatus[],
  cause: LedgerCause,
  reported: ProviderPayment
): Promise<void> {
  if (!payment.subscriptionId || !path.length) return;
  for (const to of path) {
    // Read again per step: a refund after `paid` in one walk sees the renewed subscription.
    const sub = await ctx.subscriptions.lock(payment.subscriptionId);
    if (!sub || isSubscriptionFinal(sub.status)) break;
    if (to === 'paid' && payment.sequence === 'first' && sub.status === 'pending')
      await activate(ctx, sub, payment, reported, cause);
    else if (to === 'paid' && payment.sequence === 'recurring') await renew(ctx, sub, cause);
    else if (FAILS.includes(to) && payment.sequence === 'first' && sub.status === 'pending')
      await finish(ctx, sub, 'ended', cause, 'first-payment');
    else if (FAILS.includes(to) && sub.status === 'active')
      await failAttempt(ctx, sub, cause, to !== 'charged_back');
  }
  if (payment.status === 'open' || payment.status === 'created') return;
  const attempt = await ctx.subscriptions.attemptOfPayment(payment.id);
  if (attempt && attempt.status !== 'done')
    await ctx.subscriptions.saveAttempt({
      ...attempt,
      status: 'done',
      updatedAt: ctx.clock.now().toISOString(),
    });
}
