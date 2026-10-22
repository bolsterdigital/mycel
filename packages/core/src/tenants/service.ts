// Custom domains of one tenant (ADR 014 rule 3, TODO #14): list, add, verify, make primary and
// remove, all `tenant:admin` and all under RLS as the tenant's own data. The platform hostname is
// made by the platform path that creates the tenant and is never removed here.
//
// Verification proves control, not routing: `_mycel-verify.<hostname>` must carry a TXT record
// with the token. Whether the CNAME points at the platform is reported, never required: if DNS
// does not point at the box, on-demand TLS simply issues nothing (decision 6). `verifyHostname`
// is exported on its own because the periodic re-check (TODO #15) is the same function.
//
// Entitlement: the number of custom domains is a limit. // ADR 015, TODO #16: custom_domains

import { z } from 'zod';
import { UseCaseError } from '../errors.js';
import type { TransactionContext } from '../ports.js';
import { defineUseCase } from '../registry.js';
import { randomToken } from '../util/token.js';
import {
  Hostname,
  dnsInstruction,
  normalizeCustomHostname,
  normalizeHostname,
  platformHostname,
  verificationRecord,
} from './model.js';
import type { HostnameRecord } from './ports.js';
import './ports.js';

const HostnameInput = z.object({ hostname: z.string().trim().min(1).max(300) });

/** The list shape of a record: no token, plus the DNS instruction for a custom hostname. */
function toHostname(ctx: TransactionContext, row: HostnameRecord, slug: string): Hostname {
  const base = {
    hostname: row.hostname,
    kind: row.kind,
    primary: row.primary,
    verifiedAt: row.verifiedAt?.toISOString() ?? null,
  };
  return row.kind === 'custom' && row.verificationToken
    ? {
        ...base,
        dns: dnsInstruction(row.hostname, row.verificationToken, slug, ctx.platform.domain),
      }
    : base;
}

/**
 * The tenant's slug, taken from its platform hostname so the service needs no tenant
 * directory. A tenant always has one (made at creation, never removed).
 */
async function slugOf(ctx: TransactionContext): Promise<string> {
  const rows = await ctx.hostnames.list();
  const platform = rows.find((r) => r.kind === 'platform');
  if (!platform) throw new UseCaseError('conflict', 'this site has no platform hostname');
  return platform.hostname.slice(0, -(ctx.platform.domain.length + 1));
}

async function requireCustom(ctx: TransactionContext, raw: string): Promise<HostnameRecord> {
  const row = await ctx.hostnames.get(normalizeHostname(raw));
  if (!row || row.kind !== 'custom')
    throw new UseCaseError('not_found', 'no custom hostname by that name on this site');
  return row;
}

export const VerifyResult = z.object({
  hostname: z.string(),
  verified: z.boolean(),
  verifiedAt: z.string().datetime().nullable(),
  /** What DNS answered, so the admin sees what is there instead of just "no". */
  found: z.object({ txt: z.array(z.string()), cname: z.string().nullable() }),
  /** Reported, never required: the CNAME names the platform hostname. */
  pointsToPlatform: z.boolean(),
});
export type VerifyResult = z.infer<typeof VerifyResult>;

/**
 * Check the TXT record of a custom hostname: `verifiedAt` is set the first time the token is
 * found and kept afterwards. A later check that finds nothing reports that without changing the
 * state: withdrawing a verification (and what then serves the site) is the periodic job's policy
 * (TODO #15), which calls this same function. A lookup that answers nothing is "not found", not
 * an error.
 */
export async function verifyHostname(
  ctx: TransactionContext,
  row: HostnameRecord
): Promise<VerifyResult> {
  const slug = await slugOf(ctx);
  const [txt, cname] = await Promise.all([
    ctx.dns.txt(verificationRecord(row.hostname)),
    ctx.dns.cname(row.hostname),
  ]);
  const verified = row.verificationToken !== null && txt.includes(row.verificationToken);
  const now = ctx.clock.now();
  let verifiedAt = row.verifiedAt;
  if (verified && !verifiedAt) {
    await ctx.hostnames.setVerified(row.hostname, now);
    verifiedAt = now;
  }
  return {
    hostname: row.hostname,
    verified,
    verifiedAt: verifiedAt?.toISOString() ?? null,
    found: { txt, cname },
    pointsToPlatform: cname === platformHostname(slug, ctx.platform.domain),
  };
}

export const listHostnames = defineUseCase({
  name: 'tenant.hostnames.list',
  kind: 'query',
  description:
    'List the hostnames of this site: the platform hostname and custom domains, with the DNS records a custom domain needs.',
  requires: 'tenant:admin',
  // Strict: an input without fields still refuses what it does not know.
  input: z.object({}).strict(),
  output: z.object({ hostnames: z.array(Hostname) }),
  examples: [{ input: {} }],
  async handler(ctx) {
    const slug = await slugOf(ctx);
    return { hostnames: (await ctx.hostnames.list()).map((r) => toHostname(ctx, r, slug)) };
  },
});

export const addHostname = defineUseCase({
  name: 'tenant.hostnames.add',
  kind: 'command',
  description:
    'Add a custom domain to this site; it serves nothing until its TXT record is verified.',
  requires: 'tenant:admin',
  input: HostnameInput,
  output: Hostname,
  examples: [{ input: { hostname: 'www.example.org' } }],
  async handler(ctx, input) {
    const hostname = normalizeCustomHostname(input.hostname, ctx.platform);
    const slug = await slugOf(ctx);
    const row: Omit<HostnameRecord, 'primary'> = {
      hostname,
      kind: 'custom',
      verificationToken: randomToken(32),
      verifiedAt: null,
      createdAt: ctx.clock.now(),
    };
    // Global uniqueness: the answer never says which site holds the name.
    if (!(await ctx.hostnames.insert(row)))
      throw new UseCaseError('conflict', 'that hostname is already in use');
    return toHostname(ctx, { ...row, primary: false }, slug);
  },
});

export const verifyHostnameUseCase = defineUseCase({
  name: 'tenant.hostnames.verify',
  kind: 'command',
  description:
    'Look up the TXT record of a custom domain and mark it verified when the token is there; reports what DNS answered otherwise.',
  requires: 'tenant:admin',
  input: HostnameInput,
  output: VerifyResult,
  examples: [{ input: { hostname: 'www.example.org' } }],
  async handler(ctx, input) {
    return verifyHostname(ctx, await requireCustom(ctx, input.hostname));
  },
});

export const setPrimaryHostname = defineUseCase({
  name: 'tenant.hostnames.set_primary',
  kind: 'command',
  description:
    'Make a verified hostname the primary one; every other hostname of the site redirects to it.',
  requires: 'tenant:admin',
  input: HostnameInput,
  output: Hostname,
  examples: [{ input: { hostname: 'www.example.org' } }],
  async handler(ctx, input) {
    const hostname = normalizeHostname(input.hostname);
    const row = await ctx.hostnames.get(hostname);
    if (!row) throw new UseCaseError('not_found', 'no hostname by that name on this site');
    if (!row.verifiedAt)
      throw new UseCaseError('conflict', 'a hostname must be verified before it can be primary');
    if (!row.primary) await ctx.hostnames.setPrimary(hostname);
    const slug = await slugOf(ctx);
    return toHostname(ctx, { ...row, primary: true }, slug);
  },
});

export const removeHostname = defineUseCase({
  name: 'tenant.hostnames.remove',
  kind: 'command',
  description:
    'Remove a custom domain from this site; the platform hostname and the primary hostname cannot be removed.',
  requires: 'tenant:admin',
  input: HostnameInput,
  output: z.object({ hostname: z.string() }),
  examples: [{ input: { hostname: 'www.example.org' } }],
  async handler(ctx, input) {
    const row = await requireCustom(ctx, input.hostname);
    if (row.primary)
      throw new UseCaseError('conflict', 'make another hostname primary before removing this one');
    await ctx.hostnames.remove(row.hostname);
    return { hostname: row.hostname };
  },
});
