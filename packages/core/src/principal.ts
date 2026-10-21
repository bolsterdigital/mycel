// The Principal is how tenant context and authorization enter the core. Fronts build it from
// authentication (session, API key, MCP connection); nothing in a request payload may set it
// (ADR 002 rule 3). Capabilities are coarse on purpose; fine-grained rules live in use cases.

import { z } from 'zod';

export const Capability = z.enum([
  'content:read',
  'content:write',
  'content:publish',
  'forms:read',
  'forms:write',
  'supporters:read',
  'supporters:write',
  'supporters:export',
  'donations:read',
  'donations:write',
  'mailing:read',
  'mailing:send',
  'money:refund',
  'tenant:admin',
]);
export type Capability = z.infer<typeof Capability>;

export const Actor = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('operator'), subject: z.string(), email: z.string().email() }),
  z.object({ kind: z.literal('api-key'), keyId: z.string() }),
  z.object({ kind: z.literal('agent'), sessionId: z.string(), onBehalfOf: z.string().optional() }),
  z.object({ kind: z.literal('system'), job: z.string() }),
  // A visitor of a public page. The front derives `ipHash` from the connection (never from the
  // form body) so rate limits and provenance have a key without storing an IP address.
  z.object({
    kind: z.literal('anonymous'),
    channel: z.enum(['web']),
    ipHash: z.string().optional(),
  }),
]);
export type Actor = z.infer<typeof Actor>;

export const Principal = z.object({
  tenantId: z.string().uuid(),
  actor: Actor,
  capabilities: z.array(Capability),
});
export type Principal = z.infer<typeof Principal>;

export function can(principal: Principal, capability: Capability): boolean {
  return (
    principal.capabilities.includes(capability) || principal.capabilities.includes('tenant:admin')
  );
}

/** A principal for background work (outbox subscribers, seed) acting inside one tenant. */
export function systemPrincipal(tenantId: string, job: string): Principal {
  return { tenantId, actor: { kind: 'system', job }, capabilities: ['tenant:admin'] };
}

/**
 * A public visitor. Fronts give it exactly the capabilities the page needs: `content:read` and
 * `forms:read` to render, `forms:write` (and nothing else) to submit.
 */
export function anonymousPrincipal(
  tenantId: string,
  capabilities: Capability[],
  ipHash?: string
): Principal {
  return {
    tenantId,
    actor:
      ipHash === undefined
        ? { kind: 'anonymous', channel: 'web' }
        : { kind: 'anonymous', channel: 'web', ipHash },
    capabilities,
  };
}
