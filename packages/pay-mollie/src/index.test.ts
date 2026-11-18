// Mollie's answers come from files in ../fixtures, in the shape of Mollie's v2 API reference
// (create payment, get payment, error object) with placeholder ids and no tenant data. A loopback
// server plays Mollie, so the adapter's real request (path, headers, body, timeout) is exercised
// without a network. A run against Mollie's test mode needs a test key and is not part of CI.
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import {
  MOLLIE_API_KEY,
  MollieError,
  MolliePaymentProvider,
  mollieAmount,
  mollieLocale,
} from './index.js';

const fixture = (name: string) =>
  readFileSync(new URL(`../fixtures/${name}.json`, import.meta.url), 'utf8');

// Synthetic: the form of a test key, nothing a scanner or Mollie would take for one.
const KEY = `test_${'x'.repeat(30)}`;
const PAYMENT = '0194c2a0-0000-7000-8000-000000000001';

interface Seen {
  method: string;
  url: string;
  headers: IncomingMessage['headers'];
  body: string;
}

let server: Server | null = null;
afterEach(
  () => new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()))
);

/** A Mollie on loopback that answers each request with `answer` and records what it got. */
async function mollie(
  answer: (seen: Seen) => { status: number; body?: string; delayMs?: number }
): Promise<{ origin: string; seen: Seen[] }> {
  const seen: Seen[] = [];
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      const request = { method: req.method!, url: req.url!, headers: req.headers, body };
      seen.push(request);
      const { status, body: out, delayMs } = answer(request);
      setTimeout(() => {
        res.writeHead(status, { 'content-type': 'application/hal+json' });
        res.end(out ?? '');
      }, delayMs ?? 0);
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const bound = server.address();
  if (!bound || typeof bound === 'string') throw new Error('no TCP address');
  return { origin: `http://127.0.0.1:${bound.port}`, seen };
}

const provider = (
  origin: string,
  extra: Partial<ConstructorParameters<typeof MolliePaymentProvider>[0]> = {}
) => new MolliePaymentProvider({ apiKey: async () => KEY, origin, ...extra });

const checkout = {
  key: PAYMENT,
  amount: 2500,
  currency: 'EUR',
  description: 'Gift to Probe',
  returnUrl: 'https://probe.example/donation/TOKEN',
  locale: 'nl',
  sequence: 'oneoff' as const,
};

describe('MolliePaymentProvider.createCheckout', () => {
  it('opens a payment with our id as idempotency key and answers open with the checkout', async () => {
    const m = await mollie(() => ({ status: 201, body: fixture('open') }));
    const opened = await provider(m.origin, {
      webhookUrl: async (id) => `https://api.example/hooks/payments/${id}`,
    }).createCheckout(checkout);
    expect(opened).toEqual({
      ref: 'tr_7UhSN1zuXS',
      outcome: 'open',
      raw: 'open',
      checkoutUrl: 'https://www.mollie.com/checkout/select-method/7UhSN1zuXS',
    });
    const [sent] = m.seen;
    expect(sent!.method).toBe('POST');
    expect(sent!.url).toBe('/v2/payments');
    expect(sent!.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(sent!.headers['idempotency-key']).toBe(PAYMENT);
    expect(JSON.parse(sent!.body)).toEqual({
      amount: { currency: 'EUR', value: '25.00' },
      description: 'Gift to Probe',
      redirectUrl: 'https://probe.example/donation/TOKEN',
      webhookUrl: `https://api.example/hooks/payments/${PAYMENT}`,
      locale: 'nl_NL',
      metadata: { mycel_payment: PAYMENT },
    });
  });

  it('leaves out the webhook and the locale when there is none', async () => {
    const m = await mollie(() => ({ status: 201, body: fixture('open') }));
    await provider(m.origin, { webhookUrl: async () => null }).createCheckout({
      ...checkout,
      locale: 'tlh',
    });
    const body = JSON.parse(m.seen[0]!.body);
    expect(body).not.toHaveProperty('webhookUrl');
    expect(body).not.toHaveProperty('locale');
  });

  it('refuses without a key, and never sends a request', async () => {
    const m = await mollie(() => ({ status: 201, body: fixture('open') }));
    await expect(
      provider(m.origin, { apiKey: async () => null }).createCheckout(checkout)
    ).rejects.toThrow(MollieError);
    expect(m.seen).toHaveLength(0);
  });

  it.each(['error-401', 'error-422'])('throws on %s without quoting Mollie', async (name) => {
    const status = Number(name.slice(-3));
    const m = await mollie(() => ({ status, body: fixture(name) }));
    const error = await provider(m.origin)
      .createCheckout(checkout)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MollieError);
    expect((error as MollieError).status).toBe(status);
    expect((error as Error).message).not.toMatch(/minimum|authenticate|test_/);
  });

  it('gives up after the timeout', async () => {
    const m = await mollie(() => ({ status: 201, body: fixture('open'), delayMs: 500 }));
    await expect(provider(m.origin, { timeoutMs: 50 }).createCheckout(checkout)).rejects.toThrow(
      'Mollie did not answer in time'
    );
  });

  it('refuses an answer of another shape', async () => {
    const m = await mollie(() => ({ status: 201, body: '{"resource":"order"}' }));
    await expect(provider(m.origin).createCheckout(checkout)).rejects.toThrow('unknown shape');
  });
});

describe('MolliePaymentProvider.fetchPayment', () => {
  it.each([
    ['open', 'open', 'open'],
    ['pending', 'open', 'pending'],
    ['paid', 'paid', 'paid'],
    ['partly-refunded', 'paid', 'paid'],
    ['refunded', 'refunded', 'paid (refunded)'],
    ['charged-back', 'charged_back', 'paid (charged back)'],
    ['canceled', 'failed', 'canceled'],
    ['expired', 'expired', 'expired'],
  ] as const)('reads %s as %s', async (name, outcome, raw) => {
    const m = await mollie(() => ({ status: 200, body: fixture(name) }));
    const found = await provider(m.origin).fetchPayment('tr_7UhSN1zuXS');
    expect(found).toMatchObject({ ref: 'tr_7UhSN1zuXS', outcome, raw });
    expect(m.seen[0]!.url).toBe('/v2/payments/tr_7UhSN1zuXS');
    // Only an open payment offers its checkout.
    expect(found!.checkoutUrl === null).toBe(outcome !== 'open');
  });

  it('answers null for a payment Mollie does not know', async () => {
    const m = await mollie(() => ({ status: 404, body: fixture('error-404') }));
    expect(await provider(m.origin).fetchPayment('tr_unknown1')).toBeNull();
  });

  it('does not ask about a reference Mollie never hands out', async () => {
    const m = await mollie(() => ({ status: 200, body: fixture('paid') }));
    expect(await provider(m.origin).fetchPayment('../v2/methods')).toBeNull();
    expect(m.seen).toHaveLength(0);
  });

  it('throws on an unknown status rather than guessing', async () => {
    const body = JSON.stringify({ ...JSON.parse(fixture('paid')), status: 'teleported' });
    const m = await mollie(() => ({ status: 200, body }));
    await expect(provider(m.origin).fetchPayment('tr_7UhSN1zuXS')).rejects.toThrow(MollieError);
  });

  it('throws when Mollie refuses the key', async () => {
    const m = await mollie(() => ({ status: 401, body: fixture('error-401') }));
    await expect(provider(m.origin).fetchPayment('tr_7UhSN1zuXS')).rejects.toThrow(MollieError);
  });
});

// Recurring giving (MY-254 PR 5): fixtures `first-*`, `customer`, `mandate*`, `recurring-pending`
// and `customer-payments-*`, in the shape of Mollie's create-customer, get-mandate, list-mandates
// and list-customer-payments references.
const FIRST = '0194c2a0-0000-7000-8000-000000000002';
const CHARGE_PAYMENT = '0194c2a0-0000-7000-8000-000000000003';
const CHARGE_KEY = 'subscription:0194c2a0-0000-7000-8000-0000000000aa:2026-12-17T21:02:00.000Z:1';
const CUSTOMER = 'cst_8wmqcHMN4U';
const MANDATE = 'mdt_h3gAaD5zP';

const charge = {
  key: CHARGE_KEY,
  paymentId: CHARGE_PAYMENT,
  customerRef: CUSTOMER,
  mandateRef: MANDATE,
  amount: 1000,
  currency: 'EUR',
  description: 'Monthly gift to Probe',
  locale: 'nl',
};

/** Answers by path, so one Mollie can play a flow of several requests. */
const byPath =
  (answers: Record<string, string | { status: number; body: string }>) => (seen: Seen) => {
    const path = seen.url.split('?')[0]!;
    const answer = answers[`${seen.method} ${path}`];
    if (answer === undefined) return { status: 404, body: fixture('error-404') };
    return typeof answer === 'string'
      ? { status: seen.method === 'POST' ? 201 : 200, body: fixture(answer) }
      : answer;
  };

describe('MolliePaymentProvider, a first payment', () => {
  it('creates a customer of its own, then opens the payment with sequenceType first', async () => {
    const m = await mollie(
      byPath({ 'POST /v2/customers': 'customer', 'POST /v2/payments': 'first-open' })
    );
    const opened = await provider(m.origin).createCheckout({
      ...checkout,
      key: FIRST,
      amount: 1000,
      sequence: 'first',
    });
    expect(opened).toMatchObject({ ref: 'tr_Fx4nW2kq9P', outcome: 'open' });
    expect(opened.checkoutUrl).toMatch(/^https:\/\/www\.mollie\.com\/checkout\//);
    const [customer, payment] = m.seen;
    expect(customer!.url).toBe('/v2/customers');
    // Its own key: Mollie refuses one key on two endpoints. No name or address goes along.
    expect(customer!.headers['idempotency-key']).toBe(`${FIRST}:customer`);
    expect(JSON.parse(customer!.body)).toEqual({ metadata: { mycel_payment: FIRST } });
    expect(payment!.headers['idempotency-key']).toBe(FIRST);
    expect(JSON.parse(payment!.body)).toMatchObject({
      customerId: CUSTOMER,
      sequenceType: 'first',
      redirectUrl: checkout.returnUrl,
      metadata: { mycel_payment: FIRST },
    });
  });

  it('opens nothing when Mollie refuses the customer', async () => {
    const m = await mollie(
      byPath({ 'POST /v2/customers': { status: 422, body: fixture('error-422') } })
    );
    await expect(
      provider(m.origin).createCheckout({ ...checkout, sequence: 'first' })
    ).rejects.toThrow('Mollie refused the customer');
    expect(m.seen.map((s) => s.url)).toEqual(['/v2/customers']);
  });

  it('a one-off payment makes no customer', async () => {
    const m = await mollie(byPath({ 'POST /v2/payments': 'open' }));
    await provider(m.origin).createCheckout(checkout);
    expect(m.seen.map((s) => s.url)).toEqual(['/v2/payments']);
    expect(JSON.parse(m.seen[0]!.body)).not.toHaveProperty('sequenceType');
  });

  it('reports the mandate a paid first payment names', async () => {
    const m = await mollie(
      byPath({
        'GET /v2/payments/tr_Fx4nW2kq9P': 'first-paid',
        [`GET /v2/customers/${CUSTOMER}/mandates/${MANDATE}`]: 'mandate-valid',
      })
    );
    expect(await provider(m.origin).fetchPayment('tr_Fx4nW2kq9P')).toEqual({
      ref: 'tr_Fx4nW2kq9P',
      outcome: 'paid',
      raw: 'paid',
      checkoutUrl: null,
      mandate: { customerRef: CUSTOMER, mandateRef: MANDATE, method: 'directdebit', valid: true },
    });
  });

  it('finds the valid mandate among the customer’s when the payment names none yet', async () => {
    const m = await mollie(
      byPath({
        'GET /v2/payments/tr_Fx4nW2kq9P': 'first-paid-no-mandate-id',
        [`GET /v2/customers/${CUSTOMER}/mandates`]: 'mandates',
      })
    );
    const found = await provider(m.origin).fetchPayment('tr_Fx4nW2kq9P');
    expect(found!.mandate).toEqual({
      customerRef: CUSTOMER,
      mandateRef: MANDATE,
      method: 'directdebit',
      valid: true,
    });
  });

  it('reports a pending mandate as not valid: Mollie charges only a valid one', async () => {
    const m = await mollie(
      byPath({
        'GET /v2/payments/tr_Fx4nW2kq9P': 'first-paid',
        [`GET /v2/customers/${CUSTOMER}/mandates/${MANDATE}`]: 'mandate-pending',
      })
    );
    const found = await provider(m.origin).fetchPayment('tr_Fx4nW2kq9P');
    expect(found!.mandate!.valid).toBe(false);
  });

  it('asks for no mandate while the first payment is open, nor for a one-off payment', async () => {
    const m = await mollie(
      byPath({
        'GET /v2/payments/tr_Fx4nW2kq9P': 'first-open',
        'GET /v2/payments/tr_7UhSN1zuXS': 'paid',
      })
    );
    expect(await provider(m.origin).fetchPayment('tr_Fx4nW2kq9P')).not.toHaveProperty('mandate');
    expect(await provider(m.origin).fetchPayment('tr_7UhSN1zuXS')).not.toHaveProperty('mandate');
    expect(m.seen).toHaveLength(2);
  });

  it('throws when the mandate cannot be read, so the paid payment is checked again', async () => {
    const m = await mollie(byPath({ 'GET /v2/payments/tr_Fx4nW2kq9P': 'first-paid' }));
    await expect(provider(m.origin).fetchPayment('tr_Fx4nW2kq9P')).rejects.toThrow(
      'Mollie refused the mandate lookup'
    );
  });
});

describe('MolliePaymentProvider.chargeMandate', () => {
  it('charges the mandate with the attempt key as idempotency key and in the metadata', async () => {
    const m = await mollie(byPath({ 'POST /v2/payments': 'recurring-pending' }));
    const made = await provider(m.origin, {
      webhookUrl: async (id) => `https://api.example/hooks/payments/${id}`,
    }).chargeMandate(charge);
    expect(made).toEqual({
      ref: 'tr_Rq7bV3mL2s',
      outcome: 'open',
      raw: 'pending',
      checkoutUrl: null,
    });
    const [sent] = m.seen;
    expect(sent!.headers['idempotency-key']).toBe(CHARGE_KEY);
    expect(JSON.parse(sent!.body)).toEqual({
      amount: { currency: 'EUR', value: '10.00' },
      description: 'Monthly gift to Probe',
      sequenceType: 'recurring',
      customerId: CUSTOMER,
      mandateId: MANDATE,
      webhookUrl: `https://api.example/hooks/payments/${CHARGE_PAYMENT}`,
      metadata: { mycel_payment: CHARGE_PAYMENT, mycel_charge: CHARGE_KEY },
    });
  });

  it('throws on 409, Mollie still handling the same key, as on a timeout', async () => {
    const m = await mollie(() => ({ status: 409, body: '{"status":409,"title":"Conflict"}' }));
    await expect(provider(m.origin).chargeMandate(charge)).rejects.toThrow(MollieError);
  });

  it('sends nothing for a mandate that is not Mollie’s', async () => {
    const m = await mollie(byPath({}));
    await expect(
      provider(m.origin).chargeMandate({ ...charge, customerRef: 'cst_fake/../x' })
    ).rejects.toThrow('not a Mollie mandate');
    expect(m.seen).toHaveLength(0);
  });
});

describe('MolliePaymentProvider.findCharge', () => {
  /** The first page, and `second` for the request that starts from the id the first names. */
  const pages = (second: string) => (seen: Seen) => ({
    status: 200,
    body: fixture(seen.url.includes('from=') ? second : 'customer-payments-1'),
  });

  it('reads the customer’s payments page by page until the one with the key', async () => {
    const m = await mollie(pages('customer-payments-2'));
    const found = await provider(m.origin).findCharge(charge);
    expect(found).toMatchObject({ ref: 'tr_Rq7bV3mL2s', outcome: 'open', raw: 'pending' });
    expect(m.seen.map((s) => s.url)).toEqual([
      `/v2/customers/${CUSTOMER}/payments?limit=250`,
      `/v2/customers/${CUSTOMER}/payments?limit=250&from=tr_Oth3x`,
    ]);
  });

  it('answers null only after the last page', async () => {
    const m = await mollie(pages('customer-payments-2-without'));
    expect(await provider(m.origin).findCharge(charge)).toBeNull();
    expect(m.seen).toHaveLength(2);
  });

  it('throws, never null, when a page cannot be read', async () => {
    const m = await mollie((seen) =>
      seen.url.includes('from=')
        ? { status: 503, body: '' }
        : { status: 200, body: fixture('customer-payments-1') }
    );
    await expect(provider(m.origin).findCharge(charge)).rejects.toThrow(MollieError);
  });

  it('throws, never null, for a customer Mollie no longer knows', async () => {
    const m = await mollie(() => ({ status: 404, body: fixture('error-404') }));
    await expect(provider(m.origin).findCharge(charge)).rejects.toThrow(MollieError);
  });

  it('throws when the pages do not end', async () => {
    const m = await mollie(() => ({ status: 200, body: fixture('customer-payments-1') }));
    await expect(provider(m.origin).findCharge(charge)).rejects.toThrow('more payments');
    expect(m.seen).toHaveLength(20);
  });
});

describe('helpers', () => {
  it('writes minor units as a decimal string', () => {
    expect([100, 2500, 2501, 5_000_000].map(mollieAmount)).toEqual([
      '1.00',
      '25.00',
      '25.01',
      '50000.00',
    ]);
  });

  it('maps a language to a Mollie locale', () => {
    expect([mollieLocale('nl'), mollieLocale('en-GB'), mollieLocale('xx')]).toEqual([
      'nl_NL',
      'en_US',
      undefined,
    ]);
  });

  it('knows a key by its form', () => {
    expect(MOLLIE_API_KEY.test(KEY)).toBe(true);
    expect(MOLLIE_API_KEY.test('live_' + 'a'.repeat(30))).toBe(true);
    expect(MOLLIE_API_KEY.test('access_' + 'a'.repeat(30))).toBe(false);
    expect(MOLLIE_API_KEY.test('test_short')).toBe(false);
  });
});
