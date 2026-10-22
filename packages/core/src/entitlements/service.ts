// What a tenant may use and how much of it it uses (ADR 015 rules 2 and 6), for the tenant's own
// admin. Both answer from the Principal (which carries the effective entitlements, loaded before
// the tenant context by `mycel_auth`) and from `ctx.usage`; neither ever shows the stored document
// or a price. Setting entitlements is not here: that is the platform API (packages/api,
// platform.ts), outside the registry, because it runs as no tenant (ADR 002 rule 4).

import { z } from 'zod';
import { defineUseCase } from '../registry.js';
import { Entitlements, TenantStatus } from './model.js';
import './ports.js';

const Count = z.number().int().nonnegative();
const Used = z.object({ used: Count, max: Count });

export const TenantUsage = z.object({
  supporters: Used,
  mail: z.object({ usedThisMonth: Count, max: Count }),
  storage: z.object({ usedBytes: Count, maxBytes: Count }),
  operators: Used,
  customDomains: Used,
  status: TenantStatus,
});
export type TenantUsage = z.infer<typeof TenantUsage>;

export const getUsage = defineUseCase({
  name: 'tenant.usage',
  kind: 'query',
  description:
    'Show how much of each limit this site uses: supporters, mail this month, storage, operators and custom domains.',
  requires: 'tenant:admin',
  // Strict: an input without fields still refuses what it does not know.
  input: z.object({}).strict(),
  output: TenantUsage,
  examples: [{ input: {} }],
  async handler(ctx) {
    const e = ctx.principal.entitlements;
    const [supporters, mail, storage, operators, customDomains] = await Promise.all([
      ctx.usage.supporters(),
      ctx.usage.mailsThisMonth(),
      ctx.usage.storageBytes(),
      ctx.usage.operators(),
      ctx.usage.customHostnames(),
    ]);
    return {
      supporters: { used: supporters, max: e['supporters.max'] },
      mail: { usedThisMonth: mail, max: e['mail.monthly_max'] },
      storage: { usedBytes: storage, maxBytes: e['media.storage_max_bytes'] },
      operators: { used: operators, max: e['operators.max'] },
      customDomains: { used: customDomains, max: e['custom_domains.max'] },
      status: ctx.principal.tenantStatus,
    };
  },
});

export const getEntitlements = defineUseCase({
  name: 'tenant.entitlements.get',
  kind: 'query',
  description:
    'Show the effective entitlements of this site: which features are on and every limit, defaults included.',
  requires: 'tenant:admin',
  input: z.object({}).strict(),
  output: Entitlements,
  examples: [{ input: {} }],
  async handler(ctx) {
    return ctx.principal.entitlements;
  },
});
