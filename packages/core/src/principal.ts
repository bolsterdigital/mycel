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
  'supporters:erase',
  'donations:read',
  'donations:write',
  'mailing:read',
  'mailing:send',
  'money:refund',
  'media:read',
  'media:write',
  'ai:assist',
  'connections:read',
  'connections:configure',
  'connections:credentials',
  'connections:replay',
  'tenant:admin',
]);
export type Capability = z.infer<typeof Capability>;

/**
 * Capabilities no use case requires yet, with the reason. They stay in the schema, because ADR 018
 * rule 5 names them and a stored set may hold one, but granting one limits nothing, so the admin
 * does not offer them as if it did. A test in registry.conformance.test.ts fails when a capability
 * is neither required nor listed here, and when a listed one gets a use case.
 * Rejected: removing them from the enum (a stored member or key would no longer parse), and
 * leaving them on offer with a warning (a choice that does nothing should not be a choice).
 */
export const PLANNED_CAPABILITIES: Readonly<Partial<Record<Capability, string>>> = {
  'supporters:export':
    'no supporter export exists; tenant.export.create requires tenant:admin (ADR 018 rule 5)',
  'donations:read': 'donations (ADR 005) are not built',
  'donations:write': 'donations (ADR 005) are not built',
  'money:refund': 'donations (ADR 005) are not built',
};

/**
 * What a form may offer: everything with a use case behind it, plus what the set being edited
 * already holds, so that saving a member does not silently drop a stored capability.
 */
export const offeredCapabilities = (held: readonly Capability[] = []): Capability[] =>
  Capability.options.filter((c) => !(c in PLANNED_CAPABILITIES) || held.includes(c));

export const Actor = z.discriminatedUnion('kind', [
  // Our stable operator id, never the IdP subject: an operator can move between identity
  // providers, and attribution (ADR 009 rule 9) must survive that. No address (ADR 035 rule 4):
  // the account row holds the current one, and an actor is copied into immutable history. A
  // stored actor of before migration 0053 still parses; zod drops its `email`.
  z.object({ kind: z.literal('operator'), operatorId: z.string() }),
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

/**
 * The one form an actor takes at rest (ADR 035 rule 4): exactly the keys of its kind, so an
 * object that arrived with more (a session decoded into a principal, a test double, an older
 * stored row) cannot carry an address into a revision, plan, key, media row or register. Every
 * adapter that persists an actor writes this; storage.conformance.test.ts holds every stored
 * actor to it. Rejected: trusting the `Actor` type alone, which says nothing about extra keys of
 * the object at run time.
 */
export function storedActor(actor: Actor): Actor {
  switch (actor.kind) {
    case 'operator':
      return { kind: 'operator', operatorId: actor.operatorId };
    case 'api-key':
      return { kind: 'api-key', keyId: actor.keyId };
    case 'agent':
      return actor.onBehalfOf === undefined
        ? { kind: 'agent', sessionId: actor.sessionId, keyId: actor.keyId }
        : {
            kind: 'agent',
            sessionId: actor.sessionId,
            keyId: actor.keyId,
            onBehalfOf: actor.onBehalfOf,
          };
    case 'system':
      return { kind: 'system', job: actor.job };
    case 'anonymous':
      return actor.ipHash === undefined
        ? { kind: 'anonymous', channel: actor.channel }
        : { kind: 'anonymous', channel: actor.channel, ipHash: actor.ipHash };
  }
}

/**
 * The same rule for an actor of unknown shape, as an import reads it from an archive (ADR 035
 * rule 5): an operator keeps its kind and its id and nothing else. Two id spellings exist at rest:
 * `operatorId` in an `Actor`, and `id` in the `{ kind, id }` form of form feeds and connection
 * intents. Anything that is not an operator object comes back as it was.
 */
export function storedActorJson(value: unknown): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return value;
  const v = value as Record<string, unknown>;
  if (v['kind'] !== 'operator') return value;
  const out: Record<string, unknown> = { kind: 'operator' };
  if ('operatorId' in v) out['operatorId'] = v['operatorId'];
  if ('id' in v) out['id'] = v['id'];
  return out;
}

export const Principal = z.object({
  tenantId: z.string().guid(),
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
  return grants(principal.capabilities, capability);
}

/**
 * The same rule over a stored capability set, for work that rechecks an actor's current grants
 * after the request (a membership or API key at dispatch time). One rule, so no two principals
 * can get different answers for the same capability.
 */
export function grants(capabilities: readonly Capability[], capability: Capability): boolean {
  return capabilities.includes(capability) || capabilities.includes('tenant:admin');
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
