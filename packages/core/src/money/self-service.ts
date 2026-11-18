// Donor self-service (ADR 005 rule 6, brief MY-254 PR 3): the giver of a monthly or yearly gift
// sees it and changes the amount, pauses, resumes or stops it, without an account. Who the giver
// is comes from one of two places and never from the input: a signed link from a mail
// (self-service-model.ts), or the reader session of someone signed in on the site (ADR 016 rule
// 6). Both name a supporter of this site; the use cases then reach that supporter's gifts and
// nothing else. A forged, expired or another site's token, an erased giver and a gift of someone
// else are one answer: `not_found`, so the route shows the same page for all of them.
//
// `donation.self.request` mails the link to an address. It answers the same for every address and
// every refusal, like the reader's sign-in (`link-request.ts`): only an address whose supporter
// has a gift on this site gets a mail, at most one a day, and nobody learns who gives.
//
// Pausing stops the charges until resumed. Resuming within the paid period charges at its end, as
// before; resuming after it starts a new run of periods today (`startedAt`, `periodsPaid` 0) and
// charges now, so a long pause never charges the months it skipped.
//
// Rejected: an operator use case with a looser check behind the page (the page would hold the
// permission, not the link), the supporter or tenant in the input (the token says both), and
// charging the skipped periods on a resume (the donor paused them).

import { z } from 'zod';
import { UseCaseError, notFound } from '../errors.js';
import { Locale } from '../i18n/locale.js';
import type { TransactionContext } from '../ports.js';
import { defineUseCase } from '../registry.js';
import { refuseLinkRequest } from '../readers/link-request.js';
import { liveSession } from '../readers/service.js';
import { emailKey } from '../supporters/email-key.js';
import { isTombstone } from '../supporters/erasure.js';
import '../supporters/ports.js';
import { EmailAddress } from '../util/email.js';
import { exampleId } from '../util/ids.js';
import { MAX_PAGE_SIZE } from '../util/page-size.js';
import { Currency, MinorUnits } from './model.js';
import './ports.js';
import {
  SELF_FORM_SCOPE,
  SELF_LINK_REQUESTED,
  SELF_MAIL_COOLDOWN_SECONDS,
  SELF_MIN_FILL_SECONDS,
  SELF_RATE_LIMITS,
  readSelfToken,
  type SelfLinkRequestedProps,
} from './self-service-model.js';
import { lockSupporter } from './service.js';
import {
  Interval,
  SubscriptionKind,
  SubscriptionStatus,
  isSubscriptionFinal,
  type Subscription,
} from './subscription-model.js';
import { cancelAtPeriodEnd, finish, stepSubscription } from './subscription-steps.js';
import type { AccessTier } from '../content/access/model.js';
import '../content/ports.js';

const Timestamp = z.string().datetime({ offset: true });

/** A gift or membership as its giver sees it: no provider, mandate, supporter or ledger. */
export const OwnGift = z.object({
  id: z.string().guid(),
  kind: SubscriptionKind,
  /** A membership: the tier it buys, named in every locale it has (PR 4). */
  tier: z.object({ id: z.string().guid(), name: z.record(z.string(), z.string()) }).nullable(),
  /** A membership that stops at `paidThrough` (choice 10). */
  cancelAtPeriodEnd: z.boolean(),
  status: SubscriptionStatus,
  amount: MinorUnits,
  currency: Currency,
  interval: Interval,
  startedAt: Timestamp.nullable(),
  paidThrough: Timestamp.nullable(),
  nextChargeAt: Timestamp.nullable(),
  failedAttempts: z.number().int().nonnegative(),
});
export type OwnGift = z.infer<typeof OwnGift>;

const ownGift = (s: Subscription, tier: AccessTier | null = null): OwnGift => ({
  id: s.id,
  kind: s.kind,
  tier: tier ? { id: tier.id, name: { ...tier.name } as Record<string, string> } : null,
  cancelAtPeriodEnd: s.cancelAtPeriodEnd,
  status: s.status,
  amount: s.amount,
  currency: s.currency,
  interval: s.interval,
  startedAt: s.startedAt,
  paidThrough: s.paidThrough,
  nextChargeAt: s.nextChargeAt,
  failedAttempts: s.failedAttempts,
});

/** The gifts and memberships the page shows: a pending one was never paid. */
const shown = (s: Subscription): boolean => s.status !== 'pending';

/** `sub` as its giver sees it, with the tier of a membership. */
async function viewOf(ctx: TransactionContext, sub: Subscription): Promise<OwnGift> {
  return ownGift(sub, sub.tierId ? await ctx.accessTiers.get(sub.tierId) : null);
}

/**
 * The supporter this request acts for: the one a link names, or the signed-in reader's. Throws
 * `not_found` for a token that is no link of this site now, for nobody signed in, and for an
 * erased supporter.
 */
async function giverOf(ctx: TransactionContext, token: string | undefined): Promise<string> {
  const now = ctx.clock.now();
  const { actor, tenantId } = ctx.principal;
  let supporterId: string | null = null;
  if (token)
    supporterId = (await readSelfToken(ctx.signer, token, tenantId, now))?.supporterId ?? null;
  else if (actor.kind === 'reader')
    supporterId = (await liveSession(ctx, actor.sessionId, now))?.supporterId ?? null;
  if (!supporterId) throw notFound('gift');
  const p = await ctx.supporters.getProjectionById(supporterId);
  // A registered erasure ends the link at once, before the worker has applied it.
  if (!p || isTombstone(p.email) || (await ctx.erasures.get(supporterId))) throw notFound('gift');
  return supporterId;
}

const Token = z.string().min(1).max(4000);

export const getOwnGifts = defineUseCase({
  name: 'donation.self.get',
  kind: 'query',
  description:
    'Read your own monthly and yearly gifts on this site, with a link token from a mail or as the signed-in reader: amount, interval, status, until when it is paid and the next charge. A token that is no link of this site now gives not_found.',
  requires: 'content:read',
  actors: ['anonymous', 'reader'],
  input: z.object({ token: Token.optional() }).strict(),
  output: z.object({ gifts: z.array(OwnGift) }),
  examples: [
    { input: { token: 'not-a-signed-token' }, note: 'A forged or expired token is not_found.' },
  ],
  async handler(ctx, { token }) {
    const supporterId = await giverOf(ctx, token);
    const rows = await ctx.subscriptions.list({ supporterId }, 0, MAX_PAGE_SIZE);
    const gifts: OwnGift[] = [];
    for (const row of rows.filter(shown)) gifts.push(await viewOf(ctx, row));
    return { gifts };
  },
});

const Change = z.enum(['amount', 'pause', 'resume', 'cancel']);

export const updateOwnGift = defineUseCase({
  name: 'donation.self.update',
  kind: 'command',
  description:
    'Change your own monthly or yearly gift, with a link token from a mail or as the signed-in reader: a new amount from the next charge, pause (nothing is charged until you resume), resume, or cancel (nothing is charged any more). A membership can only be cancelled, and then stops at the end of the period it is paid for, with access until then. A gift that is not yours, and a token that is no link of this site now, give not_found.',
  requires: 'content:read',
  actors: ['anonymous', 'reader'],
  consumes: null,
  input: z
    .object({
      token: Token.optional(),
      subscriptionId: z.string().guid(),
      action: Change,
      /** The new amount in minor units, for `amount` only. */
      amount: MinorUnits.optional(),
    })
    .strict(),
  output: z.object({ gift: OwnGift }),
  examples: [
    { input: { token: 'signed-link-token', subscriptionId: exampleId(0x1), action: 'pause' } },
    {
      input: {
        token: 'signed-link-token',
        subscriptionId: exampleId(0x1),
        action: 'amount',
        amount: 1500,
      },
    },
  ],
  async handler(ctx, input) {
    if ((input.action === 'amount') !== (input.amount !== undefined))
      throw new UseCaseError('invalid_input', 'amount goes with action "amount" and only with it', [
        { path: 'amount', message: 'amount goes with action "amount" and only with it' },
      ]);
    const supporterId = await giverOf(ctx, input.token);
    // The giver's address before the subscription, the order every other step takes them in.
    if (!(await lockSupporter(ctx, supporterId))) throw notFound('gift');
    const sub = await ctx.subscriptions.lock(input.subscriptionId);
    if (!sub || sub.supporterId !== supporterId || !shown(sub)) throw notFound('gift');
    const now = ctx.clock.now().toISOString();
    const done = async (s: Subscription) => ({ gift: await viewOf(ctx, s) });

    if (input.action === 'cancel') {
      if (isSubscriptionFinal(sub.status) || sub.cancelAtPeriodEnd) return done(sub);
      // A member has paid for the rest of the period: it stops at its end (choice 10).
      if (sub.kind === 'membership' && sub.status === 'active')
        return done(await cancelAtPeriodEnd(ctx, sub, 'donor'));
      return done(await finish(ctx, sub, 'cancelled', 'donor', null));
    }
    // A membership has one price, the tier's, and no pause (choice 12).
    if (sub.kind === 'membership')
      throw new UseCaseError('conflict', 'a membership can only be cancelled');
    if (isSubscriptionFinal(sub.status))
      throw new UseCaseError('conflict', 'this gift has stopped');

    if (input.action === 'pause') {
      if (sub.status === 'paused') return done(sub);
      return done(
        await stepSubscription(
          ctx,
          sub,
          { ...sub, status: 'paused', nextChargeAt: null },
          'paused',
          'donor'
        )
      );
    }

    if (input.action === 'resume') {
      if (sub.status === 'active') return done(sub);
      const within = sub.paidThrough !== null && sub.paidThrough > now;
      const next: Subscription = within
        ? { ...sub, status: 'active', nextChargeAt: sub.paidThrough }
        : {
            ...sub,
            status: 'active',
            startedAt: now,
            periodsPaid: 0,
            paidThrough: now,
            nextChargeAt: now,
            failedAttempts: 0,
          };
      return done(await stepSubscription(ctx, sub, next, 'resumed', 'donor'));
    }

    // A new amount, from the next charge. Not while a charge is under way: its payment is
    // recorded at the amount the subscription has then, which must be the amount charged.
    const amount = input.amount!;
    if (amount === sub.amount) return done(sub);
    const attempts = await ctx.subscriptions.attempts(sub.id);
    if (attempts.some((a) => a.status !== 'done'))
      throw new UseCaseError('conflict', 'a charge is under way; try again in a moment');
    return done(await stepSubscription(ctx, sub, { ...sub, amount }, 'amount-changed', 'donor'));
  },
});

const SelfRequestInput = z.object({
  email: EmailAddress,
  /** The language of the mail: the locale of the page the form was on. */
  locale: Locale,
  /** As on `reader.signin.request`: the public form posts all three. */
  spam: z
    .object({
      honeypot: z.string().optional(),
      startedToken: z.string().optional(),
      proof: z.string().max(4000).optional(),
    })
    .optional(),
});

export const requestOwnGiftsLink = defineUseCase({
  name: 'donation.self.request',
  kind: 'command',
  description:
    'Ask for a link to manage your monthly or yearly gift on this site, sent to an e-mail address. Always answers accepted: only an address that gives here gets a mail, at most one a day, and the answer never says whether it does.',
  requires: 'content:read',
  actors: ['anonymous', 'reader'],
  input: SelfRequestInput,
  output: z.object({ status: z.literal('accepted') }),
  examples: [
    {
      input: { email: 'donor@example.org', locale: 'nl' },
      note: 'The public form also sends `spam.honeypot` (empty) and `spam.startedToken`; without them nothing is mailed and the answer is the same.',
    },
  ],
  async handler(ctx, input) {
    const accepted = { status: 'accepted' } as const;
    // One line per refusal with a fixed reason, never the address, the IP hash or a token.
    const refuse = (reason: string) => {
      ctx.log.info('donation.self.refused', { reason });
      return accepted;
    };
    const refusal = await refuseLinkRequest(ctx, input.spam, {
      scope: SELF_FORM_SCOPE,
      minFillSeconds: SELF_MIN_FILL_SECONDS,
      limits: SELF_RATE_LIMITS,
    });
    if (refusal) return refuse(refusal);

    await ctx.supporters.lock(input.email);
    const holder = await ctx.supporters.getProjection(input.email);
    if (!holder || isTombstone(holder.email)) return refuse('unknown');
    if (!(await ctx.erasures.allows(input.email, holder.id))) return refuse('erased');
    const gifts = await ctx.subscriptions.list({ supporterId: holder.id }, 0, MAX_PAGE_SIZE);
    if (!gifts.some(shown)) return refuse('no-gift');

    // One mail per address per day, after everything that may refuse for the address.
    const recipient = await emailKey(ctx.principal.tenantId, input.email, 'rate-limit');
    if (
      !(await ctx.rateLimits.cooldown(
        `${SELF_FORM_SCOPE}:${recipient}`,
        SELF_MAIL_COOLDOWN_SECONDS
      ))
    )
      return refuse('recipient-limited');

    const props: SelfLinkRequestedProps = { supporterId: holder.id, locale: input.locale };
    await ctx.events.publish({
      id: ctx.ids.next(),
      type: SELF_LINK_REQUESTED,
      tenantId: ctx.principal.tenantId,
      occurredAt: ctx.clock.now(),
      // The stored actor of a visitor, without the client hash: the event names a supporter.
      actor: { kind: 'anonymous', channel: 'web' },
      props: { ...props },
    });
    return accepted;
  },
});
