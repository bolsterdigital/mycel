// `mycel`: the command line of a self-hoster (TODO #18a, ADR 015 rule 4). Platform operations run
// the same `platformOperations` as the platform API (compose.ts, TODO #74) on the operator
// connection, without a token, because whoever holds DATABASE_URL already holds everything; the
// functions enter `mycel_platform` and `mycel_ops` themselves (0010, 0016), so the CLI and the API
// run under the same grants. `setup` adds the first tenant, its first operator and a custom
// domain in one idempotent, non-interactive run, so a self-hoster and CI can script it.
// Rejected: calling the platform API over HTTP from here, which would make a self-hoster run the
// API with PLATFORM_API_TOKEN just to change a limit; and prompts, which a script cannot answer.
//
// In the image: `docker compose run --rm worker mycel <command>` (the worker service is the one
// with DATABASE_URL, ADR 011 rule 1). From a checkout: `npm run mycel -- <command>`.

import { fileURLToPath } from 'node:url';
import {
  ERASURE_UNSECURED_WARN_MS,
  Invoker,
  UseCaseError,
  normalizeHostname,
  systemPrincipal,
  useCases,
  type Entitlements,
  type Hostname,
  type TenantStatus,
} from '@mycel/core';
import {
  applyErasures,
  expireExports,
  createDb,
  erasureStatus,
  exportTenant,
  importTenant,
  type PlatformTenant,
} from '@mycel/db';
import { ensureS3Bucket } from '@mycel/blob';
import { buildVersion } from '@mycel/observability';
import {
  blobStoreFor,
  createRuntime,
  inputHasherOf,
  loadConfig,
  platformOf,
  platformOperations,
  s3ConfigOf,
} from './compose.js';
import { OPS_REFUSALS } from './platform.js';

export const USAGE = `usage:
  mycel setup --tenant <slug> --name <name> --operator <e-mail> [--locales nl,en] [--hostname <domain>]
  mycel tenants list
  mycel tenants create <slug> <name> [locales, comma-separated]
  mycel entitlements set <slug> <json document>
  mycel status set <slug> active|suspended
  mycel ops summary
  mycel ops list jobs|outbox|mail [<slug>]
  mycel ops retry jobs|outbox <id>
  mycel ops close jobs <id>
  mycel blob init
  mycel export <slug> --out <directory or file.tar>
  mycel import <directory or file.tar> [--slug <slug>]
  mycel erasures apply [--tenant <slug>]
  mycel erasures status [--tenant <slug>]
  mycel version`;

export interface SetupInput {
  slug: string;
  name: string;
  locales: string[];
  operator: string;
  hostname?: string;
}

export type Command =
  | { kind: 'setup'; input: SetupInput }
  | { kind: 'tenants.list' }
  | { kind: 'tenants.create'; slug: string; name: string; locales: string[] }
  | { kind: 'entitlements.set'; slug: string; document: unknown }
  | { kind: 'status.set'; slug: string; status: TenantStatus }
  | { kind: 'ops.summary' }
  | { kind: 'ops.list'; list: 'jobs' | 'outbox' | 'mail'; slug?: string }
  | { kind: 'ops.recover'; action: 'retry' | 'close'; queue: 'jobs' | 'outbox'; id: string }
  | { kind: 'blob.init' }
  | { kind: 'export'; slug: string; out: string }
  | { kind: 'import'; path: string; slug?: string }
  | { kind: 'erasures.apply'; slug?: string }
  | { kind: 'erasures.status'; slug?: string }
  | { kind: 'version' };

/** A command line the parser refuses; the message says what is wrong, then the usage follows. */
export class UsageError extends Error {}

const localesOf = (value: string | undefined) =>
  (value ?? 'nl')
    .split(',')
    .map((l) => l.trim())
    .filter(Boolean);

/** `--key value` and `--key=value`; a flag the command does not take is an error. */
function flags(args: string[], allowed: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const m = /^--([a-z]+)(?:=(.*))?$/.exec(args[i]!);
    if (!m) throw new UsageError(`unexpected argument "${args[i]}"`);
    const key = m[1]!;
    if (!allowed.includes(key)) throw new UsageError(`unknown option --${key}`);
    const value = m[2] ?? args[++i];
    if (value === undefined || value.startsWith('--'))
      throw new UsageError(`--${key} needs a value`);
    out[key] = value;
  }
  return out;
}

const RECOVERIES = { retry: ['jobs', 'outbox'], close: ['jobs'] } as const;

/** The command an argument vector asks for; throws UsageError for anything else. */
export function parseCommand(argv: readonly string[]): Command {
  const [noun, verb, ...rest] = argv;
  const args = verb === undefined ? [] : [verb, ...rest];
  if (noun === 'setup') {
    const f = flags(args, ['tenant', 'name', 'operator', 'locales', 'hostname']);
    for (const key of ['tenant', 'name', 'operator'])
      if (!f[key]) throw new UsageError(`setup needs --${key}`);
    return {
      kind: 'setup',
      input: {
        slug: f['tenant']!,
        name: f['name']!,
        operator: f['operator']!,
        locales: localesOf(f['locales']),
        ...(f['hostname'] ? { hostname: f['hostname'] } : {}),
      },
    };
  }
  if (noun === 'version' && verb === undefined) return { kind: 'version' };
  if (noun === 'export' && verb && !verb.startsWith('--')) {
    const f = flags(rest, ['out']);
    if (!f['out']) throw new UsageError('export needs --out');
    return { kind: 'export', slug: verb, out: f['out'] };
  }
  if (noun === 'import' && verb && !verb.startsWith('--')) {
    const f = flags(rest, ['slug']);
    return { kind: 'import', path: verb, ...(f['slug'] ? { slug: f['slug'] } : {}) };
  }
  if (noun === 'erasures' && verb === 'apply') {
    const f = flags(rest, ['tenant']);
    return { kind: 'erasures.apply', ...(f['tenant'] ? { slug: f['tenant'] } : {}) };
  }
  if (noun === 'erasures' && verb === 'status') {
    const f = flags(rest, ['tenant']);
    return { kind: 'erasures.status', ...(f['tenant'] ? { slug: f['tenant'] } : {}) };
  }
  if (noun === 'blob' && verb === 'init' && rest.length === 0) return { kind: 'blob.init' };
  if (noun === 'tenants' && verb === 'list' && rest.length === 0) return { kind: 'tenants.list' };
  if (noun === 'tenants' && verb === 'create' && rest[0] && rest[1] && rest.length <= 3)
    return { kind: 'tenants.create', slug: rest[0], name: rest[1], locales: localesOf(rest[2]) };
  if (noun === 'entitlements' && verb === 'set' && rest[0] && rest[1] && rest.length === 2) {
    let document: unknown;
    try {
      document = JSON.parse(rest[1]);
    } catch {
      throw new UsageError('the entitlements document is not valid JSON');
    }
    return { kind: 'entitlements.set', slug: rest[0], document };
  }
  if (noun === 'status' && verb === 'set' && rest[0] && rest[1] && rest.length === 2) {
    const status = rest[1];
    if (status !== 'active' && status !== 'suspended')
      throw new UsageError('status is active or suspended');
    return { kind: 'status.set', slug: rest[0], status };
  }
  if (noun === 'ops' && verb === 'summary' && rest.length === 0) return { kind: 'ops.summary' };
  if (noun === 'ops' && verb === 'list' && rest.length <= 2) {
    const list = rest[0];
    if (list === 'jobs' || list === 'outbox' || list === 'mail')
      return { kind: 'ops.list', list, ...(rest[1] ? { slug: rest[1] } : {}) };
  }
  if (noun === 'ops' && (verb === 'retry' || verb === 'close') && rest[1] && rest.length === 2) {
    const queues: readonly string[] = RECOVERIES[verb];
    const queue = rest[0] as 'jobs' | 'outbox';
    if (queues.includes(queue)) return { kind: 'ops.recover', action: verb, queue, id: rest[1] };
  }
  throw new UsageError(noun ? `unknown command "${argv.join(' ')}"` : 'no command given');
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

/** The version of this build: MYCEL_VERSION from the release image, else the root package.json. */
export const version = (): string => buildVersion();

const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : '-');

const show = (t: PlatformTenant) =>
  `${t.slug}\t${t.status}\t${t.primaryHostname ?? '-'}\t${t.id}\t${JSON.stringify(t.storedEntitlements)}`;

async function main(argv: string[]): Promise<number> {
  let command: Command;
  try {
    command = parseCommand(argv);
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    console.error(`mycel: ${e.message}\n${USAGE}`);
    return 2;
  }
  if (command.kind === 'version') {
    console.log(version());
    return 0;
  }

  const config = loadConfig();
  if (!config.DATABASE_URL) {
    console.error('mycel: DATABASE_URL (the operator role) must be set (see .env.example)');
    return 1;
  }
  const db = createDb(config.DATABASE_URL);
  // Every mutation writes an audit row as `platform`, actor `cli` (TODO #17b).
  const by = { actorId: 'cli', hasher: inputHasherOf(config) };
  const platform = platformOf(config);
  const store = platformOperations(db, platform, () => by);
  const found = (t: PlatformTenant | null, slug: string) => {
    if (!t) throw new Error(`no tenant with slug "${slug}"`);
    return t;
  };
  const bySlug = async (slug: string) => found(await store.bySlug(slug), slug);
  /** The one tenant `--slug` names, or every tenant. */
  const tenantsOf = async (slug: string | undefined) =>
    slug ? [await bySlug(slug)] : await store.list();
  // Log lines to stderr, so stdout stays the command's output.
  const runtime =
    command.kind === 'setup'
      ? createRuntime(config, {
          service: 'cli',
          writeLog: (line) => void process.stderr.write(line + '\n'),
        })
      : null;

  try {
    switch (command.kind) {
      case 'setup': {
        const report = await runSetup(
          {
            tenantBySlug: store.bySlug,
            createTenant: store.create,
            invoker: runtime!.invoker,
            platformOrigin: platform.platformOrigin,
          },
          command.input
        );
        for (const line of report.lines) console.log(line);
        break;
      }
      case 'blob.init': {
        // The media bucket of a box with the `local-s3` profile starts empty (self-hosting.md).
        const s3 = s3ConfigOf(config);
        if (!s3) console.log('blob: BLOB_STORE is fs; there is no bucket to create');
        else console.log(`blob: bucket ${s3.bucket} ${await ensureS3Bucket(s3)}`);
        break;
      }
      case 'tenants.list':
        for (const t of await store.list()) console.log(show(t));
        break;
      case 'export': {
        // ADR 015 rule 7: never gated, a suspended tenant exports like any other.
        const manifest = await exportTenant({
          operatorDb: db,
          blobs: blobStoreFor(config),
          slug: command.slug,
          out: command.out,
          mycelVersion: version(),
        });
        for (const [table, t] of Object.entries(manifest.tables))
          console.log(`${table}\t${t.rows} rows`);
        console.log(`media\t${Object.keys(manifest.media).length} files`);
        console.log(
          `exported ${manifest.tenant.slug} (${manifest.tenant.id}) at schema ${manifest.schemaVersion} to ${command.out}`
        );
        break;
      }
      case 'import': {
        const report = await importTenant({
          operatorDb: db,
          blobs: blobStoreFor(config),
          path: command.path,
          slug: command.slug,
          platform,
          by,
        });
        for (const line of report.lines) console.log(line);
        for (const line of report.differences) console.error(`  ${line}`);
        if (report.differences.length) return 1;
        console.log(`admin: ${new URL(`/admin/${report.slug}`, platform.platformOrigin).href}`);
        break;
      }
      case 'erasures.apply': {
        // After a restore (docs/self-hosting.md § Restore): the register of the newer backup
        // erases again what the older one brought back. Each tenant in its own transaction.
        const tenants = await tenantsOf(command.slug);
        let total = 0;
        for (const t of tenants) {
          const changed = await applyErasures(db, t.id);
          // Archives the apply expired lose their file now, not at the next daily expire.
          const purged = await expireExports(db, blobStoreFor(config), t.id, new Date());
          total += changed;
          console.log(`${t.slug}\t${changed} rows changed, ${purged} archive(s) deleted`);
        }
        console.log(`erasures: ${total} rows changed in ${tenants.length} tenant(s)`);
        break;
      }
      case 'erasures.status': {
        // TODO #29B: a registration is a completed erasure only once a backup holds it. Exit 1
        // when one has waited longer than ERASURE_UNSECURED_WARN_MS, so a timer can alarm on it.
        const tenants = await tenantsOf(command.slug);
        const now = Date.now();
        let late = 0;
        for (const t of tenants) {
          const s = await erasureStatus(db, t.id);
          const oldest = s.oldestUnsecuredAt;
          if (oldest && now - oldest.getTime() > ERASURE_UNSECURED_WARN_MS) late++;
          console.log(
            `${t.slug}\t${s.registered} registered\t${s.registered - s.secured} not secured` +
              (oldest ? `\toldest since ${oldest.toISOString()}` : '')
          );
        }
        if (late) {
          console.error(
            `erasures: ${late} site(s) with a registration no backup holds after an hour; ` +
              'run the erasures backup (docs/self-hosting.md § Backups)'
          );
          return 1;
        }
        break;
      }
      case 'tenants.create': {
        const { slug, name, locales } = command;
        const t = await store.create({ slug, name, locales });
        console.log(`platform: created tenant ${t.id} (${t.slug})`);
        console.log(show(t));
        break;
      }
      case 'entitlements.set': {
        const t = await bySlug(command.slug);
        const updated = found(await store.setEntitlements(t.id, command.document), t.slug);
        console.log(
          `platform: tenant ${t.id} entitlements set to ${JSON.stringify(updated.storedEntitlements)}`
        );
        console.log(show(updated));
        break;
      }
      case 'status.set': {
        const t = await bySlug(command.slug);
        const updated = found(await store.setStatus(t.id, command.status), t.slug);
        console.log(`platform: tenant ${t.id} status set to ${updated.status}`);
        console.log(show(updated));
        break;
      }
      case 'ops.summary':
        for (const s of await store.ops.summary())
          console.log(
            `${s.slug ?? 'platform'}\tjobs ${s.exhaustedJobs}\toutbox ${s.deadEvents}\tmail unknown ${s.unknownMail}\tabandoned ${s.abandonedMail}`
          );
        break;
      case 'ops.list': {
        const tenantId = command.slug ? (await bySlug(command.slug)).id : undefined;
        let cursor: string | undefined;
        do {
          const q = { tenantId, cursor, limit: 200 };
          let page: { items: string[]; nextCursor: string | null };
          if (command.list === 'jobs') {
            const r = await store.ops.jobs(q);
            page = {
              nextCursor: r.nextCursor,
              items: r.items.map(
                (j) =>
                  `${j.id}\t${j.tenantId ?? 'platform'}\t${j.type}\t${j.attempts}/${j.maxAttempts}\t${iso(j.createdAt)}\t${j.lastError ?? '-'}`
              ),
            };
          } else if (command.list === 'outbox') {
            const r = await store.ops.outbox(q);
            page = {
              nextCursor: r.nextCursor,
              items: r.items.map(
                (e) =>
                  `${e.id}\t${e.tenantId}\t${e.type}\t${e.attempts}\t${e.deliveredTo.join(',') || '-'}\t${e.lastError ?? '-'}`
              ),
            };
          } else {
            const r = await store.ops.mail(q);
            page = {
              nextCursor: r.nextCursor,
              items: r.items.map(
                (m) =>
                  `${m.key}\t${m.tenantId}\t${m.state}\t${m.subscriber}\t${m.attempts}\t${iso(m.attemptedAt)}\t${m.lastError ?? '-'}`
              ),
            };
          }
          for (const line of page.items) console.log(line);
          cursor = page.nextCursor ?? undefined;
        } while (cursor);
        break;
      }
      case 'ops.recover': {
        const { action, queue, id } = command;
        const recover =
          action === 'close'
            ? store.ops.closeJob
            : queue === 'jobs'
              ? store.ops.retryJob
              : store.ops.retryEvent;
        const result = await recover(id);
        if (result === 'ok') console.log(`platform: ${queue} ${id} ${action}: ok`);
        else {
          console.error(`platform: ${queue} ${id}: ${OPS_REFUSALS[result]}`);
          return 1;
        }
        break;
      }
    }
    return 0;
  } catch (e) {
    const issues = (e as { issues?: unknown[] }).issues;
    console.error(
      `mycel: ${(e as Error).message}${issues?.length ? `: ${JSON.stringify(issues)}` : ''}`
    );
    return 1;
  } finally {
    await runtime?.close();
    await db.destroy();
  }
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) process.exitCode = await main(process.argv.slice(2));
