// The Mollie side of a one-off payment (ADR 005 rule 3, brief MY-252 PR 3): this adapter owns the
// Mollie v2 wire format and nothing else. It opens a payment with our payment id as the
// `Idempotency-Key`, reads one back, and answers in the five outcomes the state machine knows with
// Mollie's own word beside it. What a payment means, which steps it may take and what a webhook is
// worth stay in core.
//
// The API key is a tenant's, never the installation's: the composition root hands a function that
// reads the tenant's encrypted `mollie` connection when a call needs it, so a transaction that
// starts no payment never decrypts anything. Every call has a short timeout, because
// `donation.check` holds an address lock, a row lock and a connection while it waits (note (a) of
// MY-252 PR 1). An error never carries Mollie's message: it may quote what we sent.
//
// Rejected: the `@mollie/api-client` SDK (a dependency for two requests, and its errors embed the
// request), a key per installation in env (one site's money would land in another's account), and
// reading `amount` back from Mollie (ours is what the donor was shown; see core `money/service.ts`).

import type { CheckoutRequest, PaymentProvider, ProviderPayment } from '@mycel/core';
import { z } from 'zod';

export const MOLLIE_API_ORIGIN = 'https://api.mollie.com';

/** The form of a key, checked by core when a site stores one. */
export { MOLLIE_API_KEY } from '@mycel/core';

const Money = z.object({ value: z.string(), currency: z.string() });

const MolliePayment = z.object({
  resource: z.literal('payment'),
  id: z.string().regex(/^tr_[A-Za-z0-9]+$/),
  status: z.string().min(1).max(40),
  amount: Money,
  amountRefunded: Money.optional(),
  amountChargedBack: Money.optional(),
  _links: z
    .object({ checkout: z.object({ href: z.string().url() }).optional() })
    .passthrough()
    .optional(),
});
type MolliePayment = z.infer<typeof MolliePayment>;

/** Thrown for every failure; the message names what failed, never what Mollie said. */
export class MollieError extends Error {
  constructor(
    message: string,
    readonly status: number | null = null
  ) {
    super(message);
    this.name = 'MollieError';
  }
}

export interface MolliePaymentProviderOptions {
  /** The tenant's key, read when a call needs it; null when the site has no active connection. */
  apiKey: () => Promise<string | null>;
  /** Where Mollie reports a change of this payment; null leaves it to the reconciliation. */
  webhookUrl?: ((paymentId: string) => Promise<string | null>) | undefined;
  /** Mollie's API origin; a recorded-answer server in tests. */
  origin?: string | undefined;
  timeoutMs?: number | undefined;
  fetch?: typeof fetch | undefined;
}

/** Mollie's locales by language; another language lets Mollie choose from the browser. */
const LOCALES: Readonly<Record<string, string>> = {
  nl: 'nl_NL',
  en: 'en_US',
  de: 'de_DE',
  fr: 'fr_FR',
  es: 'es_ES',
  it: 'it_IT',
  pt: 'pt_PT',
  da: 'da_DK',
  sv: 'sv_SE',
  fi: 'fi_FI',
  pl: 'pl_PL',
  hu: 'hu_HU',
};

export function mollieLocale(locale: string): string | undefined {
  return LOCALES[locale.toLowerCase().split(/[-_]/)[0]!];
}

/** Minor units as Mollie's decimal string. Every currency Mycel takes has two decimals. */
export function mollieAmount(minor: number): string {
  return `${Math.floor(minor / 100)}.${String(minor % 100).padStart(2, '0')}`;
}

const cents = (money: { value: string } | undefined): number =>
  money ? Math.round(Number(money.value) * 100) : 0;

/**
 * Where a Mollie payment stands, in the state machine's words. A refund or chargeback is not a
 * status at Mollie but an amount on a paid payment: a chargeback of any amount is `charged_back`,
 * a refund of the whole amount `refunded`, a partial refund leaves it `paid` (a refund ledger
 * comes with `money:refund`). `pending` and `authorized` are a payment on its way: still `open`.
 */
export function outcomeOf(payment: MolliePayment): ProviderPayment {
  const checkoutUrl = payment._links?.checkout?.href ?? null;
  const base = { ref: payment.id, checkoutUrl };
  switch (payment.status) {
    case 'paid':
      if (cents(payment.amountChargedBack) > 0)
        return { ...base, outcome: 'charged_back', raw: 'paid (charged back)' };
      if (cents(payment.amountRefunded) >= cents(payment.amount))
        return { ...base, outcome: 'refunded', raw: 'paid (refunded)' };
      return { ...base, outcome: 'paid', raw: 'paid' };
    case 'open':
    case 'pending':
    case 'authorized':
      return { ...base, outcome: 'open', raw: payment.status };
    case 'expired':
      return { ...base, outcome: 'expired', raw: 'expired' };
    case 'canceled':
    case 'failed':
      return { ...base, outcome: 'failed', raw: payment.status };
    default:
      // A word this adapter does not know yet: nothing moves until someone maps it.
      throw new MollieError(`unknown Mollie status ${payment.status.slice(0, 40)}`);
  }
}

export class MolliePaymentProvider implements PaymentProvider {
  readonly id = 'mollie';
  readonly #origin: string;
  readonly #timeoutMs: number;
  readonly #fetch: typeof fetch;

  constructor(private readonly options: MolliePaymentProviderOptions) {
    this.#origin = (options.origin ?? MOLLIE_API_ORIGIN).replace(/\/$/, '');
    this.#timeoutMs = options.timeoutMs ?? 5000;
    this.#fetch = options.fetch ?? fetch;
  }

  async #key(): Promise<string> {
    const key = await this.options.apiKey();
    if (!key) throw new MollieError('this site has no active Mollie connection');
    return key;
  }

  async #call(path: string, init: RequestInit): Promise<Response> {
    const key = await this.#key();
    try {
      return await this.#fetch(`${this.#origin}${path}`, {
        ...init,
        headers: {
          ...init.headers,
          authorization: `Bearer ${key}`,
          accept: 'application/json',
        },
        signal: AbortSignal.timeout(this.#timeoutMs),
        redirect: 'error',
      });
    } catch {
      throw new MollieError('Mollie did not answer in time');
    }
  }

  async #payment(response: Response): Promise<ProviderPayment> {
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new MollieError('Mollie answered without JSON', response.status);
    }
    const parsed = MolliePayment.safeParse(body);
    if (!parsed.success) throw new MollieError('Mollie answered an unknown shape', response.status);
    return outcomeOf(parsed.data);
  }

  async createCheckout(request: CheckoutRequest): Promise<ProviderPayment> {
    const webhookUrl = (await this.options.webhookUrl?.(request.key)) ?? null;
    const locale = mollieLocale(request.locale);
    const response = await this.#call('/v2/payments', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': request.key },
      body: JSON.stringify({
        amount: { currency: request.currency, value: mollieAmount(request.amount) },
        description: request.description,
        redirectUrl: request.returnUrl,
        ...(webhookUrl ? { webhookUrl } : {}),
        ...(locale ? { locale } : {}),
        metadata: { mycel_payment: request.key },
      }),
    });
    if (response.status !== 201 && response.status !== 200)
      throw new MollieError('Mollie refused the payment', response.status);
    return this.#payment(response);
  }

  async fetchPayment(ref: string): Promise<ProviderPayment | null> {
    // A reference Mollie never hands out is not asked about: it would only cost a request.
    if (!/^tr_[A-Za-z0-9]+$/.test(ref)) return null;
    const response = await this.#call(`/v2/payments/${ref}`, { method: 'GET' });
    if (response.status === 404 || response.status === 410) return null;
    if (response.status !== 200)
      throw new MollieError('Mollie refused the lookup', response.status);
    return this.#payment(response);
  }
}
