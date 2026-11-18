// Monthly and yearly giving over the ledger (ADR 005 rules 1-7, brief MY-254 PR 1). A
// subscription starts with a first payment the donor makes at the provider, like a one-off gift,
// that also leaves a mandate (`startSubscription`); `subscription-steps.ts` follows that payment
// and every later one. The charge run charges the mandate when a period ends, without the donor:
// money moves that nobody approves at that moment, so every charge follows ADR 019 rule 6.
//
// One charge (`chargeSubscription`) is three transactions. The first locks the subscription, checks
// it is due and has no attempt in flight, and writes the intent row (`charge_attempts`, `pending`)
// with a key that is also the provider's idempotency key. The second only makes the call: the
// provider is built per transaction (a site's key is read in it), and it holds no lock while it
// waits. The third records the payment the provider made (`sent`) and walks it, or, when the call
// threw, marks the attempt `unknown`; a refusal (the provider declined with certainty and made
// nothing, MY-255) closes the attempt and counts as a failed one, so dunning runs. Nothing charges
// a subscription with an attempt in flight; the reconciliation (`reconcileChargeAttempt`) asks the
// provider by key about an attempt, `unknown` or `pending`, once it is a quarter of an hour old,
// and records what it finds, or closes the attempt when the provider made nothing, so the next run
// charges with a new key.
//
// The key is `subscription:<id>:<paidThrough>:<n>`, the n-th attempt for the period that ends at
// `paidThrough`: a dunning retry and a retry after "made nothing" each get a new one, and a repeat
// of the same call never charges twice.
//
// Rejected: the provider call inside the transaction that holds the subscription's lock (a slow
// provider would hold every other step of that subscription), a retry of an `unknown` attempt
// without asking the provider first (ADR 019 rule 6 forbids it), and the attempt number from
// `failedAttempts` (a call that made nothing is no failed attempt, yet needs a new key).

import { z } from 'zod';
import { notFound } from '../errors.js';
import type { TransactionContext, UnitOfWork } from '../ports.js';
import { can, type Principal } from '../principal.js';
import { defineUseCase } from '../registry.js';
import { isTombstone } from '../supporters/erasure.js';
import { exampleId } from '../util/ids.js';
import { MAX_PAGE_SIZE } from '../util/page-size.js';
import { Payment } from './model.js';
import type { ChargeRefusal, ProviderPayment } from './ports.js';
import './ports.js';
import {
  lockSupporter,
  recordPayment,
  startPayment,
  type DonationStart,
  type PaymentStart,
} from './service.js';
import {
  ChargeAttempt,
  Interval,
  Subscription,
  SubscriptionKind,
  SubscriptionLedgerEntry,
  SubscriptionStatus,
  chargeKey,
} from './subscription-model.js';
import { cancelAtPeriodEnd, failAttempt, finish, stepSubscription } from './subscription-steps.js';

/** What starting a subscription needs beyond a one-off gift. */
export interface SubscriptionStart extends DonationStart {
  interval: Interval;
  /** A membership (PR 4): the paid tier it buys and the version of the price it pays. */
  membership?: { tierId: string; priceVersion: number };
}

/**
 * Open the first payment of a monthly or yearly gift, or of a membership, and record the
 * subscription `pending` (`form.submit`). The return page is the one of a one-off gift, by the
 * first payment's token. Throws `conflict` when the provider cannot charge a mandate.
 */
export async function startSubscription(
  ctx: TransactionContext,
  input: SubscriptionStart
): Promise<PaymentStart & { subscriptionId: string }> {
  const subscriptionId = ctx.ids.next();
  const kind = input.membership ? 'membership' : 'donation';
  const started = await startPayment(ctx, input, {
    subscriptionId,
    kind,
    async record(supporterId) {
      const at = ctx.clock.now().toISOString();
      await stepSubscription(
        ctx,
        null,
        Subscription.parse({
          id: subscriptionId,
          kind,
          status: 'pending',
          amount: input.amount,
          currency: input.currency,
          interval: input.interval,
          description: input.description,
          locale: input.locale,
          provider: ctx.paymentProvider!.id,
          supporterId,
          mandateId: null,
          startedAt: null,
          periodsPaid: 0,
          paidThrough: null,
          nextChargeAt: null,
          cancelAtPeriodEnd: false,
          tierId: input.membership?.tierId ?? null,
          priceVersion: input.membership?.priceVersion ?? null,
          campaignId: input.campaignId ?? null,
          failedAttempts: 0,
          endReason: null,
          createdAt: at,
          updatedAt: at,
        }),
        'started',
        'checkout'
      );
    },
  });
  return { ...started, subscriptionId };
}

/** The subscriptions the charge run charges now, earliest due first, at most `limit`. */
export async function dueSubscriptions(ctx: TransactionContext, limit = 100): Promise<string[]> {
  return (await ctx.subscriptions.due(ctx.clock.now().toISOString(), limit)).map((s) => s.id);
}

/**
 * How long an attempt, `pending` or `unknown`, waits before the reconciliation asks after it: a
 * request whose answer was lost may still land at the provider, and "made nothing" read before it
 * landed would charge the period a second time with a new key (review of MY-254 PR 1).
 */
export const ATTEMPT_RECONCILE_AFTER_MS = 15 * 60 * 1000;

/** The attempts the reconciliation asks after now, at most `limit`. */
export async function staleChargeAttempts(ctx: TransactionContext, limit = 100): Promise<string[]> {
  const before = new Date(ctx.clock.now().getTime() - ATTEMPT_RECONCILE_AFTER_MS).toISOString();
  return (await ctx.subscriptions.stale(before, limit)).map((a) => a.key);
}

/** What one charge run did with one subscription. */
export type ChargeResult =
  | 'charged'
  | 'refused'
  | 'unknown'
  | 'not-due'
  | 'in-flight'
  | 'no-provider'
  | 'failed'
  | 'cancelled';

interface Planned {
  attempt: ChargeAttempt;
  sub: Subscription;
  customerRef: string;
  mandateRef: string;
}

/** The first transaction: decide, and write the intent row. */
async function plan(
  ctx: TransactionContext,
  id: string
): Promise<Planned | Exclude<ChargeResult, 'charged' | 'refused' | 'unknown'>> {
  const seen = await ctx.subscriptions.get(id);
  if (seen?.supporterId) await lockSupporter(ctx, seen.supporterId);
  const sub = await ctx.subscriptions.lock(id);
  const now = ctx.clock.now().toISOString();
  if (!sub || sub.status !== 'active' || !sub.nextChargeAt || sub.nextChargeAt > now)
    return 'not-due';
  const attempts = await ctx.subscriptions.attempts(id);
  if (attempts.some((a) => a.status !== 'done')) return 'in-flight';
  // A membership cancelled for the end of its period ends here instead of charging (choice 10).
  if (sub.cancelAtPeriodEnd) {
    await finish(ctx, sub, 'cancelled', 'charge', null);
    return 'cancelled';
  }
  const provider = ctx.paymentProvider;
  if (!provider?.chargeMandate || provider.id !== sub.provider) {
    ctx.log.warn('subscription.charge.no-provider', { subscriptionId: id, provider: sub.provider });
    return 'no-provider';
  }
  const mandate = sub.mandateId ? await ctx.subscriptions.getMandate(sub.mandateId) : null;
  if (!mandate || mandate.status !== 'valid') {
    // Nothing to charge with is a failed attempt, so the donor hears of it and dunning runs.
    await failAttempt(ctx, sub, 'charge', true);
    return 'failed';
  }
  const prefix = chargeKey(id, sub.paidThrough!, 0).replace(/:0$/, ':');
  const n = attempts.filter((a) => a.key.startsWith(prefix)).length + 1;
  const attempt = ChargeAttempt.parse({
    key: chargeKey(id, sub.paidThrough!, n),
    subscriptionId: id,
    paymentId: ctx.ids.next(),
    status: 'pending',
    createdAt: now,
    updatedAt: now,
  });
  await ctx.subscriptions.insertAttempt(attempt);
  return { attempt, sub, customerRef: mandate.customerRef, mandateRef: mandate.mandateRef };
}

/**
 * The third transaction: record the payment the provider made for `key` and walk it, which
 * moves the subscription (`onPaymentSettled`). Nothing when the attempt was recorded already.
 */
async function recordCharge(
  ctx: TransactionContext,
  key: string,
  made: ProviderPayment,
  cause: 'charge' | 'reconcile'
): Promise<void> {
  const seenAttempt = await ctx.subscriptions.getAttempt(key);
  if (!seenAttempt) return;
  const seen = await ctx.subscriptions.get(seenAttempt.subscriptionId);
  const supporter = seen?.supporterId ? await lockSupporter(ctx, seen.supporterId) : null;
  const sub = await ctx.subscriptions.lock(seenAttempt.subscriptionId);
  const attempt = await ctx.subscriptions.getAttempt(key);
  if (!sub || !attempt || attempt.status === 'sent' || attempt.status === 'done') return;
  await ctx.subscriptions.saveAttempt({
    ...attempt,
    status: 'sent',
    updatedAt: ctx.clock.now().toISOString(),
  });
  await recordPayment(
    ctx,
    {
      id: attempt.paymentId,
      kind: sub.kind,
      amount: sub.amount,
      currency: sub.currency,
      description: sub.description,
      locale: sub.locale,
      provider: sub.provider,
      supporterId: supporter && supporter.id === sub.supporterId ? supporter.id : null,
      submissionId: null,
      campaignId: sub.campaignId,
      subscriptionId: sub.id,
      sequence: 'recurring',
    },
    made,
    cause,
    supporter && supporter.id === sub.supporterId ? { supporter } : null
  );
}

/**
 * The third transaction after a refusal: the provider made nothing, so the attempt is closed and
 * the subscription counts a failed attempt, as a failed charge does (dunning, `ended` after the
 * last). Nothing when the attempt was settled already.
 */
async function recordRefusal(
  ctx: TransactionContext,
  key: string,
  refusal: ChargeRefusal
): Promise<void> {
  const seenAttempt = await ctx.subscriptions.getAttempt(key);
  if (!seenAttempt) return;
  const seen = await ctx.subscriptions.get(seenAttempt.subscriptionId);
  if (seen?.supporterId) await lockSupporter(ctx, seen.supporterId);
  const sub = await ctx.subscriptions.lock(seenAttempt.subscriptionId);
  const attempt = await ctx.subscriptions.getAttempt(key);
  if (!sub || !attempt || attempt.status !== 'pending') return;
  ctx.log.warn('subscription.charge.refused', { subscriptionId: sub.id, raw: refusal.raw });
  await ctx.subscriptions.saveAttempt({
    ...attempt,
    status: 'done',
    updatedAt: ctx.clock.now().toISOString(),
  });
  if (sub.status === 'active') await failAttempt(ctx, sub, 'charge', true);
}

async function markUnknown(ctx: TransactionContext, key: string): Promise<void> {
  const attempt = await ctx.subscriptions.getAttempt(key);
  if (attempt?.status === 'pending')
    await ctx.subscriptions.saveAttempt({
      ...attempt,
      status: 'unknown',
      updatedAt: ctx.clock.now().toISOString(),
    });
}

/**
 * Charge one subscription if it is due (the charge run, PR 2's worker job). Runs as `principal`
 * in three transactions of `uow`; without the registry, like the reconciliation of payments: the
 * ledger entries with cause `charge` are its record.
 */
export async function chargeSubscription(
  uow: UnitOfWork,
  principal: Principal,
  id: string
): Promise<ChargeResult> {
  const planned = await uow.run(principal, (ctx) => plan(ctx, id));
  if (typeof planned === 'string') return planned;
  const { attempt, sub } = planned;
  let made: ProviderPayment | ChargeRefusal;
  try {
    made = await uow.run(principal, (ctx) => {
      const provider = ctx.paymentProvider;
      if (!provider?.chargeMandate || provider.id !== sub.provider)
        throw new Error('the provider changed between the intent and the call');
      return provider.chargeMandate({
        key: attempt.key,
        paymentId: attempt.paymentId,
        customerRef: planned.customerRef,
        mandateRef: planned.mandateRef,
        amount: sub.amount,
        currency: sub.currency,
        description: sub.description,
        locale: sub.locale,
      });
    });
  } catch {
    // It may or may not have charged: only asking the provider by key can tell.
    await uow.run(principal, async (ctx) => {
      ctx.log.warn('subscription.charge.unknown', { subscriptionId: id, provider: sub.provider });
      await markUnknown(ctx, attempt.key);
    });
    return 'unknown';
  }
  if ('refused' in made) {
    const refusal = made;
    await uow.run(principal, (ctx) => recordRefusal(ctx, attempt.key, refusal));
    return 'refused';
  }
  const payment = made;
  await uow.run(principal, (ctx) => recordCharge(ctx, attempt.key, payment, 'charge'));
  return 'charged';
}

/** What the reconciliation did with one attempt. */
export type AttemptResult = 'recorded' | 'none-made' | 'settled' | 'unreachable' | 'waiting';

/**
 * Ask the provider about an attempt whose call did not come back (ADR 019 rule 6): record the
 * payment it made, or close the attempt when it made none so the next run charges with a new key.
 * An attempt younger than `ATTEMPT_RECONCILE_AFTER_MS` is left `waiting`, whoever asks: its
 * request may not have reached the provider yet.
 */
export async function reconcileChargeAttempt(
  uow: UnitOfWork,
  principal: Principal,
  key: string
): Promise<AttemptResult> {
  const { attempt, before } = await uow.run(principal, async (ctx) => ({
    attempt: await ctx.subscriptions.getAttempt(key),
    before: new Date(ctx.clock.now().getTime() - ATTEMPT_RECONCILE_AFTER_MS).toISOString(),
  }));
  if (!attempt || attempt.status === 'sent' || attempt.status === 'done') return 'settled';
  if (attempt.updatedAt >= before) return 'waiting';
  let found: ProviderPayment | null;
  try {
    found = await uow.run(principal, async (ctx) => {
      const provider = ctx.paymentProvider;
      if (!provider?.findCharge) throw new Error('no provider to ask');
      // An attempt is only written against a valid mandate (`plan`), and a mandate row stays.
      const sub = await ctx.subscriptions.get(attempt.subscriptionId);
      const mandate = sub?.mandateId ? await ctx.subscriptions.getMandate(sub.mandateId) : null;
      if (!mandate) throw new Error('the attempt has no mandate to ask by');
      return provider.findCharge({
        key,
        customerRef: mandate.customerRef,
        mandateRef: mandate.mandateRef,
      });
    });
  } catch {
    await uow.run(principal, async (ctx) => {
      ctx.log.warn('subscription.attempt.unreachable', { subscriptionId: attempt.subscriptionId });
      await markUnknown(ctx, key);
    });
    return 'unreachable';
  }
  if (found) {
    await uow.run(principal, (ctx) => recordCharge(ctx, key, found, 'reconcile'));
    return 'recorded';
  }
  await uow.run(principal, async (ctx) => {
    await ctx.subscriptions.lock(attempt.subscriptionId);
    const current = await ctx.subscriptions.getAttempt(key);
    if (current && (current.status === 'pending' || current.status === 'unknown'))
      await ctx.subscriptions.saveAttempt({
        ...current,
        status: 'done',
        updatedAt: ctx.clock.now().toISOString(),
      });
  });
  return 'none-made';
}

export const getSubscription = defineUseCase({
  name: 'donation.subscription.get',
  kind: 'query',
  description:
    'Read one monthly or yearly gift (or membership) by id: amount, interval, status, until when it is paid (`paidThrough`), the next charge, failed attempts, its ledger (oldest entry first) and its payments (newest first). With `supporters:read` also the giver’s address, for a link to their page.',
  requires: 'donations:read',
  input: z.object({ subscriptionId: z.string().guid() }).strict(),
  output: z.object({
    subscription: Subscription,
    ledger: z.array(SubscriptionLedgerEntry),
    payments: z.array(Payment),
    supporter: z.object({ id: z.string().guid(), email: z.string() }).nullable(),
  }),
  examples: [{ input: { subscriptionId: exampleId(0x1) } }],
  async handler(ctx, { subscriptionId }) {
    const subscription = await ctx.subscriptions.get(subscriptionId);
    if (!subscription) throw notFound('subscription');
    const giver =
      subscription.supporterId && can(ctx.principal, 'supporters:read')
        ? await ctx.supporters.getProjectionById(subscription.supporterId)
        : null;
    return {
      subscription,
      ledger: await ctx.subscriptions.ledger(subscriptionId),
      payments: await ctx.payments.list({ subscriptionId }, 0, MAX_PAGE_SIZE),
      supporter: giver && !isTombstone(giver.email) ? { id: giver.id, email: giver.email } : null,
    };
  },
});

export const listSubscriptions = defineUseCase({
  name: 'donation.subscription.list',
  kind: 'query',
  description:
    'List the monthly and yearly gifts and memberships of this site, newest first, optionally only one status, one kind, one supporter or the memberships of one paid tier (`tierId`). With `supporters:read` also the address of each supporter the page names, for a link to their page.',
  requires: 'donations:read',
  input: z
    .object({
      status: SubscriptionStatus.optional(),
      kind: SubscriptionKind.optional(),
      supporterId: z.string().guid().optional(),
      tierId: z.string().guid().optional(),
      offset: z.number().int().nonnegative().max(100_000).default(0),
      limit: z.number().int().min(1).max(MAX_PAGE_SIZE).default(50),
    })
    .strict(),
  output: z.object({
    subscriptions: z.array(Subscription),
    nextOffset: z.number().int().nullable(),
    supporters: z.array(z.object({ id: z.string().guid(), email: z.string() })),
  }),
  examples: [{ input: { status: 'active' } }],
  async handler(ctx, { status, kind, supporterId, tierId, offset, limit }) {
    const rows = await ctx.subscriptions.list(
      { status, kind, supporterId, tierId },
      offset,
      limit + 1
    );
    const subscriptions = rows.slice(0, limit);
    const supporters: { id: string; email: string }[] = [];
    if (can(ctx.principal, 'supporters:read'))
      for (const id of new Set(
        subscriptions.flatMap((s) => (s.supporterId ? [s.supporterId] : []))
      )) {
        const p = await ctx.supporters.getProjectionById(id);
        if (p && !isTombstone(p.email)) supporters.push({ id, email: p.email });
      }
    return { subscriptions, nextOffset: rows.length > limit ? offset + limit : null, supporters };
  },
});

export const cancelSubscription = defineUseCase({
  name: 'donation.subscription.cancel',
  kind: 'command',
  description:
    'Stop a monthly or yearly gift: nothing is charged any more and the giver’s log notes it. A membership instead stops at the end of the period it is paid for (`cancelAtPeriodEnd`), so the member keeps access until then. Cancelling what has already stopped changes nothing.',
  requires: 'donations:write',
  consumes: null,
  input: z.object({ subscriptionId: z.string().guid() }).strict(),
  output: z.object({ subscription: Subscription }),
  examples: [{ input: { subscriptionId: exampleId(0x1) } }],
  async handler(ctx, { subscriptionId }) {
    const seen = await ctx.subscriptions.get(subscriptionId);
    if (!seen) throw notFound('subscription');
    // The giver's address before the subscription, the order every other step takes them in.
    if (seen.supporterId) await lockSupporter(ctx, seen.supporterId);
    const sub = (await ctx.subscriptions.lock(subscriptionId))!;
    if (sub.status === 'cancelled' || sub.status === 'ended' || sub.cancelAtPeriodEnd)
      return { subscription: sub };
    if (sub.kind === 'membership' && sub.status === 'active')
      return { subscription: await cancelAtPeriodEnd(ctx, sub, 'operator') };
    return { subscription: await finish(ctx, sub, 'cancelled', 'operator', null) };
  },
});
