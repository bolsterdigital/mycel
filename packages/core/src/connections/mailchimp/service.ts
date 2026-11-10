// Discovery requires credential permission and has a closed result: no credential, member or
// raw provider response is returned. Rejected: embedding provider account reads in the browser.
import { z } from 'zod';
import { defineUseCase } from '../../registry.js';
import { UseCaseError } from '../../errors.js';
export const inspectMailchimpAccount = defineUseCase({
  name: 'connection.mailchimp.test',
  kind: 'command',
  requires: 'connections:credentials',
  description:
    'Inspect a Mailchimp API key, account, audiences and mapping fields without saving it.',
  input: z.object({ secret: z.string().min(1).max(8192) }).strict(),
  output: z.object({
    server: z.string(),
    accountId: z.string(),
    accountName: z.string(),
    audiences: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        fields: z.array(
          z.object({
            tag: z.string(),
            name: z.string(),
            type: z.string(),
            required: z.boolean(),
          })
        ),
      })
    ),
  }),
  examples: [{ input: { secret: 'example-only' } }],
  async handler(ctx, { secret }) {
    try {
      return await ctx.mailchimpDiscovery.inspect(secret);
    } catch {
      throw new UseCaseError('conflict', 'Mailchimp account is unavailable');
    }
  },
});
