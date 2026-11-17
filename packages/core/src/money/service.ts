// One-off donations over the ledger (ADR 005, brief MY-252 PR 1). `donation.create` opens a
// checkout at the provider and records the payment as `open`; `donation.check` asks the provider
// where the payment stands and walks the state machine there, one ledger entry per step. A
// webhook, the donor's return and a scheduled reconciliation all end in that same check: what a
// provider sends is a reason to look, never the answer (rule 4). A check that finds nothing new
// writes nothing, so any of them may come twice or late.
//
// The donor's return is addressed by a signed token instead of the payment id, so the public
// page that shows "thank you" can be given exactly one payment and learns its status and amount,
// nothing about who gave. The supporter is optional here: a known one gets `donation.payment.*`
// in their log when the payment settles, as a reference to the amount (the ledger stays the
// truth); the public form that brings an address with it is the next step of the brief.
//
// Locks: the supporter's address first, then the payment, the order an erasure takes them in
// (it locks the address and then clears `supporter_id` on the payments).
//
// Rejected: recording `created` in a transaction of its own before the provider call (see
// `ports.ts`: a checkout moves no money), a status in the input of `donation.check` (a caller
// with the capability could then mark a payment paid), and reading the amount back from the
// provider (ours is what the donor was shown; a provider that reports another amount is a
// finding for a person, not a number to adopt).

import { z } from 'zod';
import { requireEntitled } from '../entitlements/guards.js';
import { notFound, UseCaseError } from '../errors.js';
import type { TransactionContext } from '../ports.js';
import { storedActor } from '../principal.js';
import { defineUseCase } from '../registry.js';
import { isTombstone } from '../supporters/erasure.js';
import { SupporterEvent } from '../supporters/events.js';
import type { SupporterProjection } from '../supporters/model.js';
import { SOURCE, appendAndFold } from '../supporters/service.js';
import '../supporters/ports.js';
import { sha1Hex } from '../util/digest.js';
import { exampleId } from '../util/ids.js';
import { MAX_PAGE_SIZE } from '../util/page-size.js';
import {
  Currency,
  LedgerCause,
  LedgerEntry,
  MinorUnits,
  Payment,
  PaymentStatus,
  SUPPORTED_CURRENCIES,
  isFinal,
  pathTo,
} from './model.js';
import type { ProviderPayment } from './ports.js';
import './ports.js';

const TOKEN_PREFIX = 'donation:';
/** The place in `returnUrl` where the donor's token goes. */
export const RETURN_TOKEN = '{token}';

const Timestamp = z.string().datetime({ offset: true });

/** What the donor's own page may know of a payment: where it stands and what it was. */
export const DonationOutcome = z.object({
  status: PaymentStatus,
  amount: MinorUnits,
  currency: Currency,
  paidAt: Timestamp.nullable(),
});
export type DonationOutcome = z.infer<typeof DonationOutcome>;

const outcomeOf = (p: Payment): DonationOutcome => ({
  status: p.status,
  amount: p.amount,
  currency: p.currency,
  paidAt: p.paidAt,
});

/** The live supporter, or null: an erased or unknown one gives anonymously. */
async function liveSupporter(
  ctx: TransactionContext,
  supporterId: string
): Promise<SupporterProjection | null> {
  const p = await ctx.supporters.getProjectionById(supporterId);
  if (!p || isTombstone(p.email) || !(await ctx.erasures.allows(p.email, supporterId))) return null;
  return p;
}

/**
 * The same supporter under their address lock, read again after it (ADR 019 rule 3), or null
 * when they went or moved address in between: the payment then settles without an event.
 */
async function lockSupporter(
  ctx: TransactionContext,
  supporterId: string
): Promise<SupporterProjection | null> {
  const before = await liveSupporter(ctx, supporterId);
  if (!before) return null;
  await ctx.supporters.lock(before.email);
  const current = await liveSupporter(ctx, supporterId);
  return current && current.email === before.email ? current : null;
}

/** The supporter's log gets a reference to the settled payment (ADR 005, consequences). */
async function appendDonationEvent(
  ctx: TransactionContext,
  supporter: SupporterProjection,
  payment: Payment,
  type: 'donation.payment.succeeded' | 'donation.payment.failed',
  occurredAt: string
): Promise<void> {
  const sourceRef = `payment:${payment.id}`;
  await appendAndFold(ctx, {
    ...SupporterEvent.parse({
      schema: 'wings.supporter-event.v1',
      id: await sha1Hex([SOURCE, sourceRef, type, occurredAt].join('|')),
      type,
      email: supporter.email,
      occurred_at: occurredAt,
      source: SOURCE,
      source_site: 'urn:mycel:money',
      source_ref: sourceRef,
      props: { payment_id: payment.id, amount: payment.amount, currency: payment.currency },
    }),
    supporter_id: supporter.id,
  });
}

/**
 * Walk `payment` to where the provider says it stands: one ledger entry per step, `paidAt` at
 * `paid`, and the supporter's event at the step that settles it. Returns the payment as it now
 * is; unchanged when the provider reports nothing new or something the table cannot reach.
 */
async function reconcile(
  ctx: TransactionContext,
  payment: Payment,
  reported: ProviderPayment,
  cause: LedgerCause,
  supporter: SupporterProjection | null
): Promise<Payment> {
  const path = pathTo(payment.status, reported.outcome);
  if (path === null) {
    // Scalars only: which payment, and the two statuses that do not connect.
    ctx.log.warn('donation.check.unreachable', {
      paymentId: payment.id,
      status: payment.status,
      reported: reported.outcome,
    });
    return payment;
  }
  if (!path.length) return payment;
  const at = ctx.clock.now().toISOString();
  let current = payment;
  for (const to of path) {
    const next: Payment = {
      ...current,
      status: to,
      providerStatus: reported.raw,
      // A payment that can no longer be paid offers no checkout.
      checkoutUrl: to === 'open' ? reported.checkoutUrl : null,
      updatedAt: at,
      paidAt: to === 'paid' ? at : current.paidAt,
    };
    await ctx.payments.appendLedger(
      LedgerEntry.parse({
        id: ctx.ids.next(),
        paymentId: payment.id,
        from: current.status,
        to,
        cause,
        providerStatus: reported.raw,
        amount: payment.amount,
        currency: payment.currency,
        at,
        actor: storedActor(ctx.principal.actor),
      })
    );
    if (supporter && to === 'paid')
      await appendDonationEvent(ctx, supporter, next, 'donation.payment.succeeded', at);
    if (supporter && (to === 'failed' || to === 'expired'))
      await appendDonationEvent(ctx, supporter, next, 'donation.payment.failed', at);
    current = next;
  }
  await ctx.payments.save(current);
  return current;
}

export const createDonation = defineUseCase({
  name: 'donation.create',
  kind: 'command',
  description:
    'Start a one-off donation: opens a checkout at the payment provider for the amount (minor units) and returns where the donor pays (`checkoutUrl`) and the token of their return page. `returnUrl` is where the provider sends the donor afterwards and must contain `{token}`. With `supporterId` the settled payment is noted in that supporter’s log; without it the gift is anonymous. Nothing is paid yet: `donation.check` records the outcome.',
  requires: 'donations:write',
  // A payment is not one of the things a site's limits count.
  consumes: null,
  input: z
    .object({
      amount: MinorUnits,
      currency: Currency,
      description: z.string().trim().min(1).max(140),
      locale: z.string().min(2).max(35),
      returnUrl: z.string().url().max(2000),
      supporterId: z.string().guid().optional(),
    })
    .strict(),
  output: z.object({
    paymentId: z.string().guid(),
    status: PaymentStatus,
    checkoutUrl: z.string().url().nullable(),
    token: z.string(),
  }),
  examples: [
    {
      input: {
        amount: 2500,
        currency: 'EUR',
        description: 'Donation to Probe',
        locale: 'nl',
        returnUrl: 'https://probe.example/donation/{token}',
      },
    },
  ],
  async handler(ctx, input) {
    requireEntitled(ctx.principal, 'donations.enabled');
    const provider = ctx.paymentProvider;
    if (!provider) throw new UseCaseError('conflict', 'no payment provider is configured');
    if (!SUPPORTED_CURRENCIES.includes(input.currency))
      throw new UseCaseError('invalid_input', `currency ${input.currency} is not supported`, [
        { path: 'currency', message: 'donation.currency.unsupported' },
      ]);
    if (!input.returnUrl.includes(RETURN_TOKEN))
      throw new UseCaseError('invalid_input', `returnUrl has no ${RETURN_TOKEN}`, [
        { path: 'returnUrl', message: 'donation.return-url.token-missing' },
      ]);
    if (input.supporterId && !(await liveSupporter(ctx, input.supporterId)))
      throw notFound('supporter');

    const id = ctx.ids.next();
    const token = await ctx.signer.sign(`${TOKEN_PREFIX}${id}`);
    const at = ctx.clock.now().toISOString();
    // The provider first: nothing is stored for a checkout that never opened, and a transaction
    // that fails after this leaves a checkout nobody was sent to (`ports.ts`).
    let opened: ProviderPayment;
    try {
      opened = await provider.createCheckout({
        key: id,
        amount: input.amount,
        currency: input.currency,
        description: input.description,
        returnUrl: input.returnUrl.replace(RETURN_TOKEN, encodeURIComponent(token)),
        locale: input.locale,
      });
    } catch {
      // The provider's message may quote what we sent; the log line names only the adapter.
      ctx.log.warn('donation.create.provider-failed', { provider: provider.id });
      throw new UseCaseError('conflict', 'the payment provider did not open a checkout; retry');
    }
    const created = Payment.parse({
      id,
      kind: 'donation',
      status: 'created',
      amount: input.amount,
      currency: input.currency,
      description: input.description,
      locale: input.locale,
      provider: provider.id,
      providerRef: opened.ref,
      providerStatus: opened.raw,
      checkoutUrl: null,
      supporterId: input.supporterId ?? null,
      createdAt: at,
      updatedAt: at,
      paidAt: null,
    });
    await ctx.payments.insert(created);
    await ctx.payments.appendLedger(
      LedgerEntry.parse({
        id: ctx.ids.next(),
        paymentId: id,
        from: null,
        to: 'created',
        cause: 'checkout',
        providerStatus: opened.raw,
        amount: created.amount,
        currency: created.currency,
        at,
        actor: storedActor(ctx.principal.actor),
      })
    );
    // Usually one step to `open`; a provider that settles at once (or refuses) is walked there.
    const supporter = created.supporterId ? await lockSupporter(ctx, created.supporterId) : null;
    const payment = await reconcile(ctx, created, opened, 'checkout', supporter);
    return { paymentId: id, status: payment.status, checkoutUrl: payment.checkoutUrl, token };
  },
});

export const checkDonation = defineUseCase({
  name: 'donation.check',
  kind: 'command',
  description:
    'Ask the payment provider where a donation stands and record it: each change of status is a ledger entry with its cause, and a paid or failed payment is noted in the supporter’s log. Address the payment by `paymentId` or by the donor’s return `token`, never both. Returns the status, amount and currency and nothing about the donor; repeating it changes nothing.',
  requires: 'donations:write',
  input: z
    .object({
      paymentId: z.string().guid().optional(),
      token: z.string().min(1).max(500).optional(),
      cause: LedgerCause.exclude(['checkout']).default('operator'),
    })
    .strict(),
  output: DonationOutcome,
  examples: [{ input: { paymentId: exampleId(0x1), cause: 'reconcile' } }],
  async handler(ctx, { paymentId, token, cause }) {
    if ((paymentId === undefined) === (token === undefined))
      throw new UseCaseError('invalid_input', 'give paymentId or token, not both', [
        { path: 'paymentId', message: 'donation.check.one-address' },
      ]);
    let id = paymentId;
    if (token !== undefined) {
      const payload = await ctx.signer.verify(token);
      // A forged token and an unknown payment answer alike.
      if (!payload?.startsWith(TOKEN_PREFIX)) throw notFound('donation');
      id = payload.slice(TOKEN_PREFIX.length);
    }
    const seen = await ctx.payments.get(id!);
    if (!seen) throw notFound('donation');
    const supporter = seen.supporterId ? await lockSupporter(ctx, seen.supporterId) : null;
    const payment = await ctx.payments.lock(seen.id);
    if (!payment) throw notFound('donation');
    if (isFinal(payment.status)) return outcomeOf(payment);
    const provider = ctx.paymentProvider;
    // Another adapter than the one that opened it cannot speak for this payment.
    if (!provider || provider.id !== payment.provider) return outcomeOf(payment);
    let reported: ProviderPayment | null;
    try {
      reported = await provider.fetchPayment(payment.providerRef);
    } catch {
      ctx.log.warn('donation.check.provider-failed', { provider: provider.id });
      throw new UseCaseError('conflict', 'the payment provider did not answer; retry');
    }
    if (!reported) return outcomeOf(payment);
    // The supporter of the locked row, in case an erasure cleared it between the two reads.
    const giver = payment.supporterId && supporter?.id === payment.supporterId ? supporter : null;
    return outcomeOf(await reconcile(ctx, payment, reported, cause, giver));
  },
});

export const getDonation = defineUseCase({
  name: 'donation.get',
  kind: 'query',
  description:
    'Read one donation by id: amount, currency, status, the provider’s reference and status, the supporter when known, and its ledger, oldest entry first.',
  requires: 'donations:read',
  input: z.object({ paymentId: z.string().guid() }).strict(),
  output: z.object({ donation: Payment, ledger: z.array(LedgerEntry) }),
  examples: [{ input: { paymentId: exampleId(0x1) } }],
  async handler(ctx, { paymentId }) {
    const donation = await ctx.payments.get(paymentId);
    if (!donation) throw notFound('donation');
    return { donation, ledger: await ctx.payments.ledger(paymentId) };
  },
});

export const listDonations = defineUseCase({
  name: 'donation.list',
  kind: 'query',
  description:
    'List the donations of this site, newest first, optionally only those in one status or of one supporter.',
  requires: 'donations:read',
  input: z
    .object({
      status: PaymentStatus.optional(),
      supporterId: z.string().guid().optional(),
      offset: z.number().int().nonnegative().max(100_000).default(0),
      limit: z.number().int().min(1).max(MAX_PAGE_SIZE).default(50),
    })
    .strict(),
  output: z.object({ donations: z.array(Payment), nextOffset: z.number().int().nullable() }),
  examples: [{ input: { status: 'paid' } }],
  async handler(ctx, { status, supporterId, offset, limit }) {
    const rows = await ctx.payments.list({ status, supporterId }, offset, limit + 1);
    return {
      donations: rows.slice(0, limit),
      nextOffset: rows.length > limit ? offset + limit : null,
    };
  },
});
