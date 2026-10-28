// Entitlements (ADR 015): what one tenant may use, as data on the tenant. There is one edition;
// a hoster narrows it per tenant with this document, never with code or a plan name. Keys are
// the dotted names ADR 015 rule 2 uses, flat, so `entitlements['supporters.max']` reads like the
// ADR and a check names exactly one key.
//
// Two readings of one document. Written (platform API, CLI) it is strict: a partial document is
// fine, an unknown key or a wrong type is refused. Read (from `tenants.entitlements`) it is
// lenient and merged over the defaults: unknown keys are ignored and missing ones get the
// default, so an older build reads a newer document and an empty document means "everything".
// Rejected: a `plan` name in the document (ADR 015 rule 2, rejected alternatives) and
// `remove_branding` on by default (then no self-host shows the credit that ADR 015 rule 5 turns
// on by default; a self-hoster who does not want it sets `remove_branding: true` with
// `npm run platform`).

import { z } from 'zod';

const Switch = z.boolean();
const Limit = z.number().int().nonnegative();

export const FEATURE_SWITCHES = [
  'mailing.enabled',
  'donations.enabled',
  'custom_domain',
  'api_keys',
  'remove_branding',
  'ai.assist',
] as const;
export type FeatureSwitch = (typeof FEATURE_SWITCHES)[number];

export const LIMITS = [
  'supporters.max',
  'mail.monthly_max',
  'media.storage_max_bytes',
  'operators.max',
  'custom_domains.max',
  'ai.monthly_max',
  'ai.pending_max',
  'ai.operator_hourly_max',
] as const;
export const LimitName = z.enum(LIMITS);
export type LimitName = z.infer<typeof LimitName>;

/** A switch, or one block type: `blocks.hero` is on unless the document says `false`. */
export type FeatureName = FeatureSwitch | `blocks.${string}`;

export const Entitlements = z
  .object({
    'mailing.enabled': Switch,
    'donations.enabled': Switch,
    custom_domain: Switch,
    api_keys: Switch,
    remove_branding: Switch,
    'ai.assist': Switch,
    blocks: z.record(z.string(), Switch),
    'supporters.max': Limit,
    'mail.monthly_max': Limit,
    'media.storage_max_bytes': Limit,
    'operators.max': Limit,
    'custom_domains.max': Limit,
    'ai.monthly_max': Limit,
    'ai.pending_max': Limit,
    'ai.operator_hourly_max': Limit,
  })
  .strict();
export type Entitlements = z.infer<typeof Entitlements>;

/** What a hoster writes: any subset of the keys, each valid, nothing unknown. */
export const EntitlementsDocument = Entitlements.partial();
export type EntitlementsDocument = z.infer<typeof EntitlementsDocument>;

/**
 * Everything on, generous limits, and the footer credit shown (`remove_branding: false`, ADR 015
 * rule 5): a self-hoster never has to think about this (ADR 015 rule 2).
 */
export const DEFAULT_ENTITLEMENTS: Entitlements = Object.freeze({
  'mailing.enabled': true,
  'donations.enabled': true,
  custom_domain: true,
  api_keys: true,
  remove_branding: false,
  'ai.assist': true,
  blocks: Object.freeze({}) as Record<string, boolean>,
  'supporters.max': 100_000,
  'mail.monthly_max': 1_000_000,
  'media.storage_max_bytes': 50 * 1024 ** 3,
  'operators.max': 50,
  'custom_domains.max': 20,
  'ai.monthly_max': 2_000,
  // The assistance throttles (TODO #53): proposals pending in the last ten minutes, and proposals
  // one operator requested in the last hour. The values the code held before they became data.
  'ai.pending_max': 3,
  'ai.operator_hourly_max': 30,
});

/**
 * The effective entitlements of a stored document: each known key that is valid wins, anything
 * else is the default. The document was validated when it was written; leniency here only
 * protects a tenant's site from a hand-edited row or a key a newer build added.
 */
export function effectiveEntitlements(stored: unknown): Entitlements {
  const doc = stored && typeof stored === 'object' ? (stored as Record<string, unknown>) : {};
  const shape = Entitlements.shape;
  const out: Record<string, unknown> = { ...DEFAULT_ENTITLEMENTS, blocks: {} };
  for (const key of Object.keys(shape) as (keyof typeof shape)[]) {
    if (key === 'blocks') continue;
    const parsed = shape[key].safeParse(doc[key]);
    if (parsed.success) out[key] = parsed.data;
  }
  const blocks = doc['blocks'];
  if (blocks && typeof blocks === 'object')
    for (const [type, on] of Object.entries(blocks))
      if (typeof on === 'boolean') (out['blocks'] as Record<string, boolean>)[type] = on;
  return out as Entitlements;
}

/** Not an entitlement (ADR 015 rule 7): set by the hoster, decides whether commands run. */
export const TenantStatus = z.enum(['active', 'suspended']);
export type TenantStatus = z.infer<typeof TenantStatus>;

/** What a front loads with the tenant before a tenant context exists, and puts on the Principal. */
export interface TenantAccess {
  entitlements: Entitlements;
  status: TenantStatus;
}

export const DEFAULT_ACCESS: TenantAccess = Object.freeze({
  entitlements: DEFAULT_ENTITLEMENTS,
  status: 'active' as const,
});
