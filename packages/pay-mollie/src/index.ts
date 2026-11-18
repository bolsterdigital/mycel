// The Mollie side of a payment (ADR 005 rule 3, briefs MY-252 PR 3 and MY-254 PR 5): this adapter
// owns the Mollie v2 wire format and nothing else. It opens a payment with our payment id as the
// `Idempotency-Key`, reads one back, and answers in the five outcomes the state machine knows with
// Mollie's own word beside it. What a payment means, which steps it may take and what a webhook is
// worth stay in core.
//
// Recurring giving follows Mollie's recurring guide: a subscription's first payment creates a
// customer of its own and opens with `sequenceType: first`; once it is paid, the mandate it left
// is read from the Mandates API and reported with the payment; a later charge is a payment with
// `sequenceType: recurring` against that customer and mandate, with the charge attempt's key as
// `Idempotency-Key` and in the metadata. Mollie cannot look a payment up by metadata, so
// `findCharge` reads every payment of the customer (one per period, so a few pages at most) and
// answers null only when it read them all. Mollie's own Subscriptions API is not used: the charge
// run, dunning and the ledger are core's (ADR 005 rule 5), and two schedulers would charge twice.
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

import type {
  ChargeRequest,
  CheckoutRequest,
  FindChargeRequest,
  PaymentProvider,
  ProviderMandate,
  ProviderPayment,
} from '@mycel/core';
import { z } from 'zod';

export const MOLLIE_API_ORIGIN = 'https://api.mollie.com';

/** The form of a key, checked by core when a site stores one. */
export { MOLLIE_API_KEY } from '@mycel/core';

const Money = z.object({ value: z.string(), currency: z.string() });

const PAYMENT_ID = /^tr_[A-Za-z0-9]+$/;
const CUSTOMER_ID = /^cst_[A-Za-z0-9]+$/;
const MANDATE_ID = /^mdt_[A-Za-z0-9]+$/;

const MolliePayment = z.object({
  resource: z.literal('payment'),
  id: z.string().regex(PAYMENT_ID),
  status: z.string().min(1).max(40),
  amount: Money,
  amountRefunded: Money.optional(),
  amountChargedBack: Money.optional(),
  sequenceType: z.string().optional(),
  customerId: z.string().regex(CUSTOMER_ID).nullish(),
  mandateId: z.string().regex(MANDATE_ID).nullish(),
  // Ours when we made the payment; anything (or nothing) on a payment made elsewhere.
  metadata: z.unknown().optional(),
  _links: z
    .object({ checkout: z.object({ href: z.string().url() }).optional() })
    .passthrough()
    .optional(),
});
type MolliePayment = z.infer<typeof MolliePayment>;

const MollieCustomer = z.object({
  resource: z.literal('customer'),
  id: z.string().regex(CUSTOMER_ID),
});

const MollieMandate = z.object({
  resource: z.literal('mandate'),
  id: z.string().regex(MANDATE_ID),
  status: z.string().min(1).max(40),
  method: z.string().min(1).max(40),
});
type MollieMandate = z.infer<typeof MollieMandate>;

/** A page of a list: the items under `_embedded.<name>`, and where the next page starts. */
const MollieList = <T extends z.ZodTypeAny>(name: string, item: T) =>
  z.object({
    _embedded: z.object({ [name]: z.array(item) }),
    _links: z
      .object({ next: z.object({ href: z.string().url() }).nullish() })
      .passthrough()
      .optional(),
  });

/** How many pages of a customer's payments `findCharge` reads before it gives up uncertain. */
const MAX_PAGES = 20;
const PAGE_SIZE = 250;

/** Our charge key on a payment we made, if it is one. */
function chargeKeyOf(payment: MolliePayment): string | null {
  const meta = payment.metadata;
  if (!meta || typeof meta !== 'object') return null;
  const key = (meta as Record<string, unknown>).mycel_charge;
  return typeof key === 'string' ? key : null;
}

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

  /** A POST with an idempotency key; Mollie answers 201, or 200 for a replay. */
  #post(path: string, key: string, body: unknown): Promise<Response> {
    return this.#call(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': key },
      body: JSON.stringify(body),
    });
  }

  async #read<T extends z.ZodTypeAny>(response: Response, shape: T): Promise<z.infer<T>> {
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new MollieError('Mollie answered without JSON', response.status);
    }
    const parsed = shape.safeParse(body);
    if (!parsed.success) throw new MollieError('Mollie answered an unknown shape', response.status);
    return parsed.data;
  }

  /** The payment as core reads it, with the mandate when it is a paid first payment. */
  async #report(payment: MolliePayment): Promise<ProviderPayment> {
    const reported = outcomeOf(payment);
    if (reported.outcome !== 'paid' || payment.sequenceType !== 'first' || !payment.customerId)
      return reported;
    const mandate = await this.#mandate(payment.customerId, payment.mandateId ?? null);
    return mandate ? { ...reported, mandate } : reported;
  }

  /**
   * The mandate a paid first payment left. The payment names it when Mollie has set it; otherwise
   * the customer's newest valid one (the customer is this subscription's own, so it has one).
   * Only `valid` can be charged without the donor: Mollie's guide refuses a `pending` one there.
   */
  async #mandate(customerId: string, mandateId: string | null): Promise<ProviderMandate | null> {
    let mandate: MollieMandate | undefined;
    if (mandateId) {
      const response = await this.#call(`/v2/customers/${customerId}/mandates/${mandateId}`, {
        method: 'GET',
      });
      if (response.status !== 200)
        throw new MollieError('Mollie refused the mandate lookup', response.status);
      mandate = await this.#read(response, MollieMandate);
    } else {
      const response = await this.#call(`/v2/customers/${customerId}/mandates`, { method: 'GET' });
      if (response.status !== 200)
        throw new MollieError('Mollie refused the mandate lookup', response.status);
      const list = await this.#read(response, MollieList('mandates', MollieMandate));
      const mandates = list._embedded.mandates as MollieMandate[];
      mandate = mandates.find((m) => m.status === 'valid') ?? mandates[0];
    }
    if (!mandate) return null;
    return {
      customerRef: customerId,
      mandateRef: mandate.id,
      method: mandate.method,
      valid: mandate.status === 'valid',
    };
  }

  /** A customer of its own for one subscription's first payment; no name or address goes along. */
  async #customer(key: string): Promise<string> {
    const response = await this.#post('/v2/customers', `${key}:customer`, {
      metadata: { mycel_payment: key },
    });
    if (response.status !== 201 && response.status !== 200)
      throw new MollieError('Mollie refused the customer', response.status);
    return (await this.#read(response, MollieCustomer)).id;
  }

  async createCheckout(request: CheckoutRequest): Promise<ProviderPayment> {
    const webhookUrl = (await this.options.webhookUrl?.(request.key)) ?? null;
    const locale = mollieLocale(request.locale);
    const customerId = request.sequence === 'first' ? await this.#customer(request.key) : null;
    const response = await this.#post('/v2/payments', request.key, {
      amount: { currency: request.currency, value: mollieAmount(request.amount) },
      description: request.description,
      redirectUrl: request.returnUrl,
      ...(webhookUrl ? { webhookUrl } : {}),
      ...(locale ? { locale } : {}),
      ...(customerId ? { customerId, sequenceType: 'first' } : {}),
      metadata: { mycel_payment: request.key },
    });
    if (response.status !== 201 && response.status !== 200)
      throw new MollieError('Mollie refused the payment', response.status);
    return outcomeOf(await this.#read(response, MolliePayment));
  }

  async fetchPayment(ref: string): Promise<ProviderPayment | null> {
    // A reference Mollie never hands out is not asked about: it would only cost a request.
    if (!PAYMENT_ID.test(ref)) return null;
    const response = await this.#call(`/v2/payments/${ref}`, { method: 'GET' });
    if (response.status === 404 || response.status === 410) return null;
    if (response.status !== 200)
      throw new MollieError('Mollie refused the lookup', response.status);
    return this.#report(await this.#read(response, MolliePayment));
  }

  /**
   * A recurring payment against the mandate. A 409 is Mollie still handling the same key: it
   * throws like a timeout, and the reconciliation finds the charge by its key later.
   */
  async chargeMandate(request: ChargeRequest): Promise<ProviderPayment> {
    if (!CUSTOMER_ID.test(request.customerRef) || !MANDATE_ID.test(request.mandateRef))
      throw new MollieError('the mandate is not a Mollie mandate');
    const webhookUrl = (await this.options.webhookUrl?.(request.paymentId)) ?? null;
    const response = await this.#post('/v2/payments', request.key, {
      amount: { currency: request.currency, value: mollieAmount(request.amount) },
      description: request.description,
      sequenceType: 'recurring',
      customerId: request.customerRef,
      mandateId: request.mandateRef,
      ...(webhookUrl ? { webhookUrl } : {}),
      metadata: { mycel_payment: request.paymentId, mycel_charge: request.key },
    });
    if (response.status !== 201 && response.status !== 200)
      throw new MollieError('Mollie refused the charge', response.status);
    return outcomeOf(await this.#read(response, MolliePayment));
  }

  /**
   * Every payment of the customer, newest first, until the one with our key. Null only after the
   * last page: a customer Mollie no longer knows, an error or too many pages throw, because the
   * caller would charge again with a new key on null.
   */
  async findCharge(request: FindChargeRequest): Promise<ProviderPayment | null> {
    if (!CUSTOMER_ID.test(request.customerRef))
      throw new MollieError('the mandate is not a Mollie mandate');
    let from: string | null = null;
    for (let page = 0; page < MAX_PAGES; page++) {
      const query = new URLSearchParams({ limit: String(PAGE_SIZE) });
      if (from) query.set('from', from);
      const response = await this.#call(
        `/v2/customers/${request.customerRef}/payments?${query.toString()}`,
        { method: 'GET' }
      );
      if (response.status !== 200)
        throw new MollieError('Mollie refused the payments lookup', response.status);
      const list = await this.#read(response, MollieList('payments', MolliePayment));
      const payments = list._embedded.payments as MolliePayment[];
      const found = payments.find((p) => chargeKeyOf(p) === request.key);
      if (found) return outcomeOf(found);
      const next = list._links?.next?.href;
      if (!next) return null;
      // Our own request for the next page, from the id Mollie names: never a URL it hands us.
      from = new URL(next).searchParams.get('from');
      if (!from || !PAYMENT_ID.test(from)) throw new MollieError('Mollie named no next page');
    }
    throw new MollieError('the customer has more payments than one lookup reads');
  }
}
