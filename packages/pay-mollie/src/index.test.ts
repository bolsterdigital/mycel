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
