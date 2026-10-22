// The Principal is how tenant context and authorization enter the core. Fronts build it from
// authentication (session, API key, MCP connection); nothing in a request payload may set it
// (ADR 002 rule 3). Capabilities are coarse on purpose; fine-grained rules live in use cases.

import { z } from 'zod';
import {
  DEFAULT_ACCESS,
  Entitlements,
  TenantStatus,
  type TenantAccess,
} from './entitlements/model.js';

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
  'media:read',
  'media:write',
  'tenant:admin',
]);
export type Capability = z.infer<typeof Capability>;

export const Actor = z.discriminatedUnion('kind', [
  // Our stable operator id, never the IdP subject: an operator can move between identity
  // providers, and attribution (ADR 009 rule 9) must survive that.
  z.object({ kind: z.literal('operator'), operatorId: z.string(), email: z.string().email() }),
  z.object({ kind: z.literal('api-key'), keyId: z.string() }),
  // An MCP session acts with exactly one API key's capabilities (ADR 018 rule 5).
  z.object({
    kind: z.literal('agent'),
    sessionId: z.string(),
    keyId: z.string(),
    onBehalfOf: z.string().optional(),
  }),
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
  /**
   * The tenant's effective entitlements and status (ADR 015 rule 3), loaded with the credential
   * before the tenant context exists (`IdentityStore.tenantAccess`, `SiteDirectory.resolve`).
   */
  entitlements: Entitlements,
  tenantStatus: TenantStatus,
});
export type Principal = z.infer<typeof Principal>;

export function can(principal: Principal, capability: Capability): boolean {
  return (
    principal.capabilities.includes(capability) || principal.capabilities.includes('tenant:admin')
  );
}

/**
 * A principal for background work (outbox subscribers, jobs, seed) acting inside one tenant.
 * Caps are enforced at the front door, where growth starts with a person's action (ADR 015
 * rule 7), so background work does not fail on one. A tenant job passes the tenant's current
 * `access` (`tenantJob` in packages/api loads it just before it runs), and a handler that
 * publishes calls `requireActive` first. Without `access` it carries the defaults and `active`,
 * which is no evidence of the tenant's status: outbox subscribers keep the defaults because
 * ingest is not growth (the seat was reserved at the signup) and a confirmation mail belongs to
 * a signup accepted before any suspension.
 */
export function systemPrincipal(
  tenantId: string,
  job: string,
  access: TenantAccess = DEFAULT_ACCESS
): Principal {
  return {
    tenantId,
    actor: { kind: 'system', job },
    capabilities: ['tenant:admin'],
    entitlements: access.entitlements,
    tenantStatus: access.status,
  };
}

/** A tenant id and what the front loaded with it; a bare id means the defaults (tests only). */
export type TenantRef = string | ({ id: string } & TenantAccess);

/**
 * A public visitor. Fronts give it exactly the capabilities the page needs: `content:read` and
 * `forms:read` to render, `forms:write` (and nothing else) to submit. The web front passes the
 * resolved site, which carries its entitlements and status; a bare tenant id is for tests.
 */
export function anonymousPrincipal(
  tenant: TenantRef,
  capabilities: Capability[],
  ipHash?: string
): Principal {
  const access = typeof tenant === 'string' ? DEFAULT_ACCESS : tenant;
  return {
    tenantId: typeof tenant === 'string' ? tenant : tenant.id,
    entitlements: access.entitlements,
    tenantStatus: access.status,
    actor:
      ipHash === undefined
        ? { kind: 'anonymous', channel: 'web' }
        : { kind: 'anonymous', channel: 'web', ipHash },
    capabilities,
  };
}
