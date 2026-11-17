// A payment provider's webhook (brief MY-252 PR 3): Mollie posts `id=tr_…` to the URL it was
// given for one payment, which carries a signed capability for exactly that payment. The route
// carries no browser authority and trusts nothing in the body but the reference, which core
// compares with the payment's before it asks Mollie where the payment stands.
// An unknown or forged call gets the same 200 as a real one; only a provider that did not answer
// gets a 503, so Mollie calls again (it retries on any other status).
// Rejected: answering 404 for an unknown capability (an oracle for valid ones) and parsing JSON
// (Mollie sends a form body).
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { receivePaymentWebhook } from '@mycel/core';

export type PaymentWebhookDeps = Parameters<typeof receivePaymentWebhook>[0];

export function createPaymentWebhookApp(deps: PaymentWebhookDeps) {
  const app = new Hono();
  app.use('*', bodyLimit({ maxSize: 4 * 1024 }));
  app.post('/:token', async (c) => {
    const data = new URLSearchParams(await c.req.text());
    const result = await receivePaymentWebhook(deps, c.req.param('token'), data.get('id') ?? '');
    return result === 'retry' ? c.body(null, 503) : c.body(null, 200);
  });
  return app;
}
