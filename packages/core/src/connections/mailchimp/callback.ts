// The callback is a read trigger, never consent evidence. A signed capability binds it to one
// connection version; provider state is fetched with its stored credential before any mutation.
import { z } from 'zod';
import { defineUseCase } from '../../registry.js';
import { notFound } from '../../errors.js';
import { exampleId } from '../../util/ids.js';
import { active } from '../../entitlements/guards.js';
import { systemPrincipal } from '../../principal.js';
import type { Signer, UnitOfWork } from '../../ports.js';
const Callback = z
  .object({
    domain: z.literal('mailchimp-callback-v1'),
    tenantId: z.string().guid(),
    connectionId: z.string().guid(),
    version: z.number().int().positive(),
  })
  .strict();
export const getMailchimpCallback = defineUseCase({
  name: 'connection.callback.get',
  kind: 'query',
  requires: 'connections:configure',
  description:
    'Get a connection-version-bound callback token which can only trigger provider comparison.',
  input: z.object({ id: z.string().guid() }).strict(),
  output: z.object({ token: z.string() }),
  examples: [{ input: { id: exampleId(1) } }],
  async handler(ctx, { id }) {
    const c = await ctx.connections.get(id);
    if (!c || c.provider !== 'mailchimp' || c.state === 'disconnected')
      throw notFound('connection');
    return {
      token: await ctx.signer.sign(
        JSON.stringify({
          domain: 'mailchimp-callback-v1',
          tenantId: ctx.principal.tenantId,
          connectionId: id,
          version: c.version,
        })
      ),
    };
  },
});
export async function queueMailchimpCallback(
  {
    signer,
    uow,
    access,
  }: {
    signer: Signer;
    uow: UnitOfWork;
    access: (tenantId: string) => Promise<import('../../entitlements/model.js').TenantAccess>;
  },
  token: string,
  memberHash: string
) {
  if (!/^[a-f0-9]{32}$/.test(memberHash) || token.length > 4096) return;
  const raw = await signer.verify(token);
  if (!raw) return;
  let parsed;
  try {
    parsed = Callback.safeParse(JSON.parse(raw));
  } catch {
    return;
  }
  if (!parsed.success) return;
  const p = parsed.data;
  await uow.run(
    systemPrincipal(p.tenantId, 'mailchimp.callback', await access(p.tenantId)),
    async (ctx) => {
      const c = await ctx.connections.get(p.connectionId);
      if (
        !active(ctx.principal) ||
        !c ||
        c.provider !== 'mailchimp' ||
        c.state !== 'active' ||
        c.version !== p.version
      )
        return;
      if (!(await ctx.rateLimits.hit(`mailchimp:callback:${c.id}`, { max: 60, windowSeconds: 60 })))
        return;
      const receipt = await ctx.mailchimpReceipts.forMember(c.id, memberHash);
      if (!receipt) return;
      await ctx.jobs.enqueue({
        type: 'connections.mailchimp.sync',
        key: `mailchimp.callback:${receipt.intentId}:${ctx.ids.next()}`,
        runAt: ctx.clock.now(),
        payload: { intentId: receipt.intentId },
      });
    }
  );
}
