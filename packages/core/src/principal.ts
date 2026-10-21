// The Principal is how tenant context and authorization enter the core. Fronts build it from
// authentication (session, API key, MCP connection); nothing in a request payload may set it
// (ADR 002 rule 3). Capabilities are coarse on purpose; fine-grained rules live in use cases.

import { z } from 'zod';

export const Capability = z.enum([
  'content:read',
  'content:write',
  'forms:read',
  'forms:write',
  'supporters:read',
  'supporters:write',
  'supporters:export',
  'donations:read',
  'donations:write',
  'mailing:read',
  'mailing:send',
  'tenant:admin',
]);
export type Capability = z.infer<typeof Capability>;

export const Actor = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('operator'), subject: z.string(), email: z.string().email() }),
  z.object({ kind: z.literal('api-key'), keyId: z.string() }),
  z.object({ kind: z.literal('agent'), sessionId: z.string(), onBehalfOf: z.string().optional() }),
  z.object({ kind: z.literal('system'), job: z.string() }),
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
