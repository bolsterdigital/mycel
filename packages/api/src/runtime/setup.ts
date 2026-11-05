// `mycel setup`: the first tenant of an installation in one idempotent, non-interactive run
// (tenant, first operator, custom hostname, DNS instructions), so a self-hoster and CI can script
// it. Split from cli.ts: it runs through the Invoker on ports a test can replace, while cli.ts
// parses arguments and holds connections. Rejected: keeping it in cli.ts, which mixed the one
// use-case flow with the thin platform commands around it.

import {
  Invoker,
  UseCaseError,
  normalizeHostname,
  systemPrincipal,
  useCases,
  type Entitlements,
  type Hostname,
  type TenantStatus,
} from '@mycel/core';

export interface SetupInput {
  slug: string;
  name: string;
  locales: string[];
  operator: string;
  hostname?: string;
}
/** What `setup` needs; the CLI passes Postgres and the runtime, the tests the memory ports. */
export interface SetupDeps {
  tenantBySlug(slug: string): Promise<SetupTenant | null>;
  createTenant(input: { slug: string; name: string; locales: string[] }): Promise<SetupTenant>;
  invoker: Invoker;
  /** The platform origin (PUBLIC_BASE_URL), where the admin lives. */
  platformOrigin: string;
}

export interface SetupTenant {
  id: string;
  slug: string;
  name: string;
  locales: string[];
  status: TenantStatus;
  primaryHostname: string | null;
  entitlements: Entitlements;
}

export interface SetupReport {
  tenant: SetupTenant;
  /** Whether this run changed anything; a second run with the same arguments changes nothing. */
  changed: boolean;
  lines: string[];
}

const isConflict = (e: unknown) => e instanceof UseCaseError && e.code === 'conflict';

function dnsLines(hostname: string, dns: Hostname['dns']): string[] {
  if (!dns) return [`  ${hostname} is verified; nothing to do in DNS`];
  return [
    `  DNS for ${hostname} (docs/reference/hostnames.md):`,
    `    TXT   ${dns.txt.name}  "${dns.txt.value}"`,
    `    CNAME ${dns.cname.name}  ${dns.cname.target}`,
    `  An apex domain cannot take a CNAME at most providers: point its A/AAAA records at this`,
    `  server instead. The TXT record is always required. The worker checks it daily; the admin's`,
    `  Check DNS verifies it right away.`,
  ];
}

/**
 * The first tenant of an installation: create it on the platform path, invite its first operator
 * as a pending `tenant:admin` (they become real at their first login with that address, as in the
 * seed), add a custom hostname and say what DNS needs. Idempotent: what already exists is
 * reported, never changed, so a second run with the same arguments is a no-op.
 */
export async function runSetup(deps: SetupDeps, input: SetupInput): Promise<SetupReport> {
  const lines: string[] = [];
  let changed = false;
  let tenant = await deps.tenantBySlug(input.slug);
  if (tenant) {
    lines.push(`tenant ${tenant.slug} exists (${tenant.id}); left as it is`);
    if (tenant.name !== input.name || tenant.locales.join(',') !== input.locales.join(','))
      lines.push(
        `  note: it has name "${tenant.name}" and locales ${tenant.locales.join(',')}; setup changes neither`
      );
  } else {
    tenant = await deps.createTenant({
      slug: input.slug,
      name: input.name,
      locales: input.locales,
    });
    changed = true;
    lines.push(`created tenant ${tenant.slug} (${tenant.id}) on ${tenant.primaryHostname ?? '-'}`);
  }
  const admin = systemPrincipal(tenant.id, 'cli', {
    entitlements: tenant.entitlements,
    status: tenant.status,
  });

  try {
    await deps.invoker.run(useCases.inviteMember, admin, {
      email: input.operator,
      capabilities: ['tenant:admin'],
    });
    changed = true;
    lines.push(`invited ${input.operator} as tenant:admin (pending until the first login)`);
  } catch (e) {
    if (!isConflict(e)) throw e;
    lines.push(`${input.operator} is already a member; left as it is`);
  }

  const hostname = input.hostname;
  if (hostname) {
    try {
      const added = await deps.invoker.run(useCases.addHostname, admin, {
        hostname,
      });
      changed = true;
      lines.push(
        `added custom hostname ${added.hostname} (unverified)`,
        ...dnsLines(added.hostname, added.dns)
      );
    } catch (e) {
      if (!isConflict(e)) throw e;
      const { hostnames } = await deps.invoker.run(useCases.listHostnames, admin, {});
      const own = hostnames.find(
        (h) => h.kind === 'custom' && h.hostname === normalizeHostname(hostname)
      );
      // Taken by another tenant: the conflict stands and names no owner (ADR 014).
      if (!own) throw e;
      lines.push(
        `custom hostname ${own.hostname} exists; left as it is`,
        ...dnsLines(own.hostname, own.dns)
      );
    }
  }

  lines.push(`admin: ${new URL(`/admin/${tenant.slug}`, deps.platformOrigin).href}`);
  if (!changed) lines.push('nothing changed');
  return { tenant, changed, lines };
}
