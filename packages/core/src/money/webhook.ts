// A payment provider's webhook (ADR 005 rule 4, brief MY-252 PR 3): a fact that something
// changed, never what it changed to. The URL the provider calls carries a signed capability for
// exactly one payment of one tenant; what the provider posts is only the reference it uses, and
// that has to match the payment's. Then the same `checkPayment` as the donor's return and the
// reconciliation asks the provider where the payment stands, with cause `webhook`. Anyone may
// call the URL; the worst a replay does is one more provider lookup, and a rate limit per payment
// bounds that.
//
// Called without the registry, like the reconciliation: a webhook is no command and has no
// actor, and the ledger entry with cause `webhook` is its record. Rejected: a capability per
// tenant only (one URL for every payment lets any holder make us look up any payment), looking
// the payment up by the posted reference alone (an anonymous caller would then choose what we
// read), and a queued job per call (Mollie waits for our answer and retries on an error, which is
// the retry we want).

import { z } from 'zod';
import type { Signer, UnitOfWork } from '../ports.js';
import { systemPrincipal } from '../principal.js';
import { UseCaseError } from '../errors.js';
import { checkPayment } from './service.js';
import './ports.js';

const Capability = z
  .object({
    domain: z.literal('payment-webhook-v1'),
    tenantId: z.string().guid(),
    paymentId: z.string().guid(),
  })
  .strict();

/** The system job a webhook runs as; also its rate-limit namespace. */
export const PAYMENT_WEBHOOK_JOB = 'donations.webhook';

/** The capability in the webhook URL of one payment. */
export function paymentWebhookToken(
  signer: Signer,
  tenantId: string,
  paymentId: string
): Promise<string> {
  return signer.sign(JSON.stringify({ domain: 'payment-webhook-v1', tenantId, paymentId }));
}

/**
 * What the route answers: `checked` and `ignored` alike with a success (an unknown or forged
 * call learns nothing), `retry` with an error so the provider calls again later.
 */
export type WebhookResult = 'checked' | 'ignored' | 'retry';

export async function receivePaymentWebhook(
  { signer, uow }: { signer: Signer; uow: UnitOfWork },
  token: string,
  providerRef: string
): Promise<WebhookResult> {
  if (token.length > 4096 || !providerRef || providerRef.length > 200) return 'ignored';
  const raw = await signer.verify(token);
  if (!raw) return 'ignored';
  let capability;
  try {
    capability = Capability.safeParse(JSON.parse(raw));
  } catch {
    return 'ignored';
  }
  if (!capability.success) return 'ignored';
  const { tenantId, paymentId } = capability.data;
  const principal = systemPrincipal(tenantId, PAYMENT_WEBHOOK_JOB);
  const allowed = await uow.run(principal, async (ctx) => {
    const payment = await ctx.payments.get(paymentId);
    if (!payment || payment.providerRef !== providerRef) return false;
    return ctx.rateLimits.hit(`${PAYMENT_WEBHOOK_JOB}:${paymentId}`, {
      max: 30,
      windowSeconds: 60,
    });
  });
  if (!allowed) return 'ignored';
  try {
    // A transaction of its own, so a provider that does not answer leaves the count above.
    await uow.run(principal, (ctx) => checkPayment(ctx, paymentId, 'webhook'));
    return 'checked';
  } catch (error) {
    if (error instanceof UseCaseError && error.code === 'conflict') return 'retry';
    throw error;
  }
}
