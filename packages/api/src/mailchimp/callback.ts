// Provider callbacks carry no ambient browser authority. Their version-bound capability can
// only schedule a provider GET; posted status, address and confirmation times are untrusted.
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { queueMailchimpCallback } from '@mycel/core';
export type MailchimpCallbackDeps = Parameters<typeof queueMailchimpCallback>[0];
export function createMailchimpCallbackApp(deps: MailchimpCallbackDeps) {
  const app = new Hono();
  app.use('*', bodyLimit({ maxSize: 16 * 1024 }));
  app.get('/:token', (c) => c.body(null, 204));
  app.post('/:token', async (c) => {
    const data = new URLSearchParams(await c.req.text());
    await queueMailchimpCallback(deps, c.req.param('token'), data.get('data[id]') ?? '');
    return c.body(null, 204);
  });
  return app;
}
