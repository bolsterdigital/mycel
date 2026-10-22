// Custom domains of one tenant (ADR 014 rule 3, TODO #14): list, add, verify, make primary and
// remove, all `tenant:admin` and all under RLS as the tenant's own data. The platform hostname is
// made by the platform path that creates the tenant and is never removed here.
//
// Verification proves control, not routing: `_mycel-verify.<hostname>` must carry a TXT record
// with the token. Whether the CNAME points at the platform is reported, never required: if DNS
// does not point at the box, on-demand TLS simply issues nothing (decision 6). `verifyHostname`
// is exported on its own because the daily re-check (`reverifyHostname` in jobs/handlers.ts,
// TODO #15) is the same function; `add` and `verify` plan that re-check in their transaction.
//
// Entitlement: the number of custom domains is a limit. // ADR 015, TODO #16: custom_domains

import { z } from 'zod';
import { UseCaseError } from '../errors.js';
import type { TransactionContext } from '../ports.js';
import { defineUseCase } from '../registry.js';
import { jobKey } from '../jobs/types.js';
import { randomToken } from '../util/token.js';
import {
  Hostname,
  dnsInstruction,
  normalizeCustomHostname,
  normalizeHostname,
  platformHostname,
  verificationRecord,
} from './model.js';
import { DnsUnavailableError, type HostnameRecord } from './ports.js';
import '../jobs/ports.js';

/** How often a custom hostname is re-checked, and after how many misses in a row it lapses. */
export const REVERIFY_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const REVERIFY_MAX_FAILURES = 3;

const HostnameInput = z.object({ hostname: z.string().trim().min(1).max(300) });

/** The list shape of a record: no token, plus the DNS instruction for a custom hostname. */
function toHostname(ctx: TransactionContext, row: HostnameRecord, slug: string): Hostname {
  const base = {
    hostname: row.hostname,
    kind: row.kind,
    primary: row.primary,
    verifiedAt: row.verifiedAt?.toISOString() ?? null,
    lastCheckedAt: row.lastCheckedAt?.toISOString() ?? null,
    checkFailures: row.checkFailures,
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

/**
 * Plan the daily re-check of a custom hostname; a re-check already planned stays as it is. The
 * key carries the tenant: a hostname can be removed here and added by another site before the
 * old job has run, and that job (which finds nothing under its own tenant and plans no next run)
 * must not hold the key the new site's re-check needs.
 */
async function planReverify(ctx: TransactionContext, hostname: string): Promise<void> {
  await ctx.jobs.enqueue({
    type: 'hostnames.reverify',
    key: jobKey('hostnames.reverify', `${ctx.principal.tenantId}:${hostname}`),
    runAt: new Date(ctx.clock.now().getTime() + REVERIFY_INTERVAL_MS),
    payload: { hostname },
  });
}

export const VerifyResult = z.object({
  hostname: z.string(),
  /** False when DNS gave no answer (server failure, time-out): nothing was decided or changed. */
  checked: z.boolean(),
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
 * found and kept afterwards, and a found token resets the run of failed daily checks. A check
 * that finds nothing reports that without changing anything: counting misses and withdrawing a
 * verification is the daily job's policy (`reverifyHostname`), which calls this same function.
 * A name without records is "not found"; DNS that does not answer at all is `checked: false`.
 */
export async function verifyHostname(
  ctx: TransactionContext,
  row: HostnameRecord
): Promise<VerifyResult> {
  const slug = await slugOf(ctx);
  let txt: string[];
  let cname: string | null;
  try {
    [txt, cname] = await Promise.all([
      ctx.dns.txt(verificationRecord(row.hostname)),
      ctx.dns.cname(row.hostname),
    ]);
  } catch (e) {
    if (!(e instanceof DnsUnavailableError)) throw e;
    return {
      hostname: row.hostname,
      checked: false,
      verified: false,
      verifiedAt: row.verifiedAt?.toISOString() ?? null,
      found: { txt: [], cname: null },
      pointsToPlatform: false,
    };
  }
  const verified = row.verificationToken !== null && txt.includes(row.verificationToken);
  const now = ctx.clock.now();
  let verifiedAt = row.verifiedAt;
  if (verified) {
    if (!verifiedAt) {
      await ctx.hostnames.setVerified(row.hostname, now);
      verifiedAt = now;
    }
    await ctx.hostnames.recordCheck(row.hostname, now, 0);
  }
  return {
    hostname: row.hostname,
    checked: true,
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
    const row: Omit<HostnameRecord, 'primary' | 'checkFailures' | 'lastCheckedAt'> = {
      hostname,
      kind: 'custom',
      verificationToken: randomToken(32),
      verifiedAt: null,
      createdAt: ctx.clock.now(),
    };
    // Global uniqueness: the answer never says which site holds the name.
    if (!(await ctx.hostnames.insert(row)))
      throw new UseCaseError('conflict', 'that hostname is already in use');
    await planReverify(ctx, hostname);
    return toHostname(ctx, { ...row, primary: false, checkFailures: 0, lastCheckedAt: null }, slug);
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
    const row = await requireCustom(ctx, input.hostname);
    await planReverify(ctx, row.hostname);
    return verifyHostname(ctx, row);
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
