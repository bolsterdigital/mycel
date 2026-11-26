// `mycel`: the command line of a self-hoster (TODO #18a, ADR 015 rule 4). Platform operations run
// the same `platformOperations` as the platform API (compose.ts, TODO #74) on the operator
// connection, without a token, because whoever holds DATABASE_URL already holds everything; the
// functions enter `mycel_platform` and `mycel_ops` themselves (0010, 0016), so the CLI and the API
// run under the same grants. `setup` (setup.ts) adds the first tenant, its first operator and a
// custom domain in one idempotent, non-interactive run, so a self-hoster and CI can script it.
// Rejected: calling the platform API over HTTP from here, which would make a self-hoster run the
// API with PLATFORM_API_TOKEN just to change a limit; and prompts, which a script cannot answer.
//
// In the image: `docker compose run --rm worker mycel <command>` (the worker service is the one
// with DATABASE_URL, ADR 011 rule 1). From a checkout: `npm run mycel -- <command>`.

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  AdminRestoreInput,
  ERASURE_UNSECURED_WARN_MS,
  OperatorErasureInput,
  SiteFontFamilyInput,
  SiteFontRole,
  SiteFontStyle,
  SiteFontWeight,
  type TenantStatus,
} from '@mycel/core';
import {
  applyErasures,
  expireExports,
  createDb,
  erasureStatus,
  exportTenant,
  importTenant,
  reapplyOperatorErasures,
  listSiteFontsOf,
  reindexSearch,
  removeSiteFont,
  uploadSiteFontFace,
  type PlatformTenant,
} from '@mycel/db';
import { validateWoff2 } from '@mycel/media-sharp';
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
import { OPS_REFUSALS } from '../platform.js';
import { runSetup, type SetupInput } from './setup.js';
import type { WordpressOptions } from './wordpress.js';

export const USAGE = `usage:
  mycel setup --tenant <slug> --name <name> --operator <e-mail> [--locales nl,en] [--hostname <domain>]
  mycel tenants list
  mycel tenants create <slug> <name> [locales, comma-separated]
  mycel entitlements set <slug> <json document>
  mycel status set <slug> active|suspended
  mycel operators erase <operator-id>
  mycel tenants admin-restore <slug> <e-mail>
  mycel ops summary
  mycel ops list jobs|outbox|mail [<slug>]
  mycel ops retry jobs|outbox <id>
  mycel ops close jobs <id>
  mycel blob init
  mycel export <slug> --out <directory or file.tar>
  mycel import <directory or file.tar> [--slug <slug>]
  mycel erasures apply [--tenant <slug>]
  mycel erasures status [--tenant <slug>]
  mycel search rebuild [--tenant <slug>]
  mycel fonts list --tenant <slug>
  mycel fonts add --tenant <slug> --role heading|body --family <name> --category sans|serif|slab --weight <100-900> [--style normal|italic] --file <face.woff2> --licence-holder <who> --licence-source <foundry or reseller> --licence-domain <host>[,<host>] --self-hosting-allowed [--replace-family]
  mycel fonts remove --tenant <slug> --role heading|body [--weight <100-900> --style normal|italic]
  mycel wordpress plan --file <export.xml> [--brand-tokens <wings-tokens.json>] [--default-locale <nl>] [--featured-header on|off] [--posts-page <wp-id> --posts-per-page <count>] [--json]
  mycel wordpress import --tenant <slug> --file <export.xml> [--brand-tokens <wings-tokens.json>] [--media-dir <uploads>] [--default-locale <nl>] [--featured-header on|off] [--posts-page <wp-id> --posts-per-page <count>] [--into-existing]
  mycel version`;

export type Command =
  | { kind: 'setup'; input: SetupInput }
  | { kind: 'tenants.list' }
  | { kind: 'tenants.create'; slug: string; name: string; locales: string[] }
  | { kind: 'entitlements.set'; slug: string; document: unknown }
  | { kind: 'status.set'; slug: string; status: TenantStatus }
  | { kind: 'operators.erase'; operatorId: string }
  | { kind: 'tenants.admin-restore'; slug: string; email: string }
  | { kind: 'ops.summary' }
  | { kind: 'ops.list'; list: 'jobs' | 'outbox' | 'mail'; slug?: string }
  | { kind: 'ops.recover'; action: 'retry' | 'close'; queue: 'jobs' | 'outbox'; id: string }
  | { kind: 'blob.init' }
  | { kind: 'export'; slug: string; out: string }
  | { kind: 'import'; path: string; slug?: string }
  | { kind: 'erasures.apply'; slug?: string }
  | { kind: 'erasures.status'; slug?: string }
  | { kind: 'search.rebuild'; slug?: string }
  | { kind: 'fonts.list'; slug: string }
  | {
      kind: 'fonts.add';
      slug: string;
      file: string;
      family: SiteFontFamilyInput;
      weight: number;
      style: SiteFontStyle;
      replaceFamily: boolean;
    }
  | {
      kind: 'fonts.remove';
      slug: string;
      role: SiteFontRole;
      face: { weight: number; style: SiteFontStyle } | null;
    }
  | (WordpressOptions & {
      kind: 'wordpress.plan';
      json: boolean;
    })
  | (WordpressOptions & {
      kind: 'wordpress.import';
      slug: string;
      mediaDir?: string;
      intoExisting: boolean;
    })
  | { kind: 'version' };

/** A command line the parser refuses; the message says what is wrong, then the usage follows. */
export class UsageError extends Error {}

/** `--featured-header on|off`; absent leaves the importer's default (on for a Dreamkit export). */
function featuredHeader(value: string | undefined): { featuredAsHeader?: boolean } {
  if (value === undefined) return {};
  if (value === 'on' || value === 'off') return { featuredAsHeader: value === 'on' };
  throw new UsageError('--featured-header takes on or off');
}

const localesOf = (value: string | undefined) =>
  (value ?? 'nl')
    .split(',')
    .map((l) => l.trim())
    .filter(Boolean);

/**
 * `--key value` and `--key=value`; a flag the command does not take is an error. A key in
 * `switches` takes no value and reads as `'true'`.
 */
function flags(
  args: string[],
  allowed: readonly string[],
  switches: readonly string[] = []
): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const m = /^--([a-z][a-z-]*)(?:=(.*))?$/.exec(args[i]!);
    if (!m) throw new UsageError(`unexpected argument "${args[i]}"`);
    const key = m[1]!;
    if (switches.includes(key) && m[2] === undefined) {
      out[key] = 'true';
      continue;
    }
    if (!allowed.includes(key)) throw new UsageError(`unknown option --${key}`);
    const value = m[2] ?? args[++i];
    if (value === undefined || value.startsWith('--'))
      throw new UsageError(`--${key} needs a value`);
    out[key] = value;
  }
  return out;
}

const RECOVERIES = { retry: ['jobs', 'outbox'], close: ['jobs'] } as const;

const WORDPRESS_FLAGS = [
  'file',
  'default-locale',
  'featured-header',
  'brand-tokens',
  'posts-page',
  'posts-per-page',
] as const;

function wordpressOptions(f: Record<string, string>): Omit<WordpressOptions, 'file'> {
  const id = f['posts-page'];
  const size = f['posts-per-page'];
  if ((id !== undefined) !== (size !== undefined))
    throw new UsageError('--posts-page and --posts-per-page must be used together');
  if (id !== undefined && size !== undefined)
    for (const [flag, value] of [
      ['posts-page', id],
      ['posts-per-page', size],
    ] as const)
      if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value)))
        throw new UsageError(`--${flag} needs a positive integer`);
  return {
    ...(f['brand-tokens'] && { brandTokensFile: f['brand-tokens'] }),
    ...(f['default-locale'] && { defaultLocale: f['default-locale'] }),
    ...featuredHeader(f['featured-header']),
    ...(id && size && { postsPage: { sourceId: Number(id), pageSize: Number(size) } }),
  };
}

/** A value of a font option, parsed by its core schema; a refusal names the option. */
function fontValue<T>(
  schema: { safeParse(v: unknown): { success: true; data: T } | { success: false } },
  flag: string,
  value: unknown
): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new UsageError(`--${flag} is not valid`);
  return parsed.data;
}

/** `mycel fonts …` (MY-302): the platform's upload of a site's own heading or body font. */
function fontsCommand(verb: string | undefined, rest: string[]): Command {
  if (verb === 'list') {
    const f = flags(rest, ['tenant']);
    if (!f['tenant']) throw new UsageError('fonts list needs --tenant');
    return { kind: 'fonts.list', slug: f['tenant'] };
  }
  if (verb === 'add') {
    const f = flags(
      rest,
      [
        'tenant',
        'role',
        'family',
        'category',
        'weight',
        'style',
        'file',
        'licence-holder',
        'licence-source',
        'licence-domain',
      ],
      ['self-hosting-allowed', 'replace-family']
    );
    for (const key of [
      'tenant',
      'role',
      'family',
      'category',
      'weight',
      'file',
      'licence-holder',
      'licence-source',
      'licence-domain',
    ])
      if (!f[key]) throw new UsageError(`fonts add needs --${key}`);
    // The uploader's statement that the licence allows self-hosting on these domains (ADR 013).
    if (f['self-hosting-allowed'] !== 'true')
      throw new UsageError(
        'fonts add needs --self-hosting-allowed: confirm that the licence allows self-hosting on these domains'
      );
    const family = SiteFontFamilyInput.safeParse({
      role: f['role'],
      family: f['family'],
      category: f['category'],
      licence: {
        holder: f['licence-holder'],
        source: f['licence-source'],
        domains: f['licence-domain']!.split(',')
          .map((d) => d.trim())
          .filter(Boolean),
      },
    });
    if (!family.success)
      throw new UsageError(
        `fonts add: ${family.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`
      );
    return {
      kind: 'fonts.add',
      slug: f['tenant']!,
      file: f['file']!,
      family: family.data,
      weight: fontValue(SiteFontWeight, 'weight', Number(f['weight'])),
      style: fontValue(SiteFontStyle, 'style', f['style'] ?? 'normal'),
      replaceFamily: f['replace-family'] === 'true',
    };
  }
  if (verb === 'remove') {
    const f = flags(rest, ['tenant', 'role', 'weight', 'style']);
    if (!f['tenant'] || !f['role']) throw new UsageError('fonts remove needs --tenant and --role');
    if ((f['weight'] === undefined) !== (f['style'] === undefined))
      throw new UsageError(
        '--weight and --style name one face together; leave both out to remove the family'
      );
    return {
      kind: 'fonts.remove',
      slug: f['tenant'],
      role: fontValue(SiteFontRole, 'role', f['role']),
      face:
        f['weight'] === undefined
          ? null
          : {
              weight: fontValue(SiteFontWeight, 'weight', Number(f['weight'])),
              style: fontValue(SiteFontStyle, 'style', f['style']),
            },
    };
  }
  throw new UsageError(`unknown command "fonts ${verb ?? ''}"`);
}

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
  if (noun === 'search' && verb === 'rebuild') {
    const f = flags(rest, ['tenant']);
    return { kind: 'search.rebuild', ...(f['tenant'] ? { slug: f['tenant'] } : {}) };
  }
  if (noun === 'fonts') return fontsCommand(verb, rest);
  if (noun === 'wordpress' && verb === 'plan') {
    const f = flags(rest, WORDPRESS_FLAGS, ['json']);
    if (!f['file']) throw new UsageError('wordpress plan needs --file');
    return {
      kind: 'wordpress.plan',
      file: f['file'],
      json: f['json'] === 'true',
      ...wordpressOptions(f),
    };
  }
  if (noun === 'wordpress' && verb === 'import') {
    const f = flags(rest, ['tenant', 'media-dir', ...WORDPRESS_FLAGS], ['into-existing']);
    for (const key of ['tenant', 'file'])
      if (!f[key]) throw new UsageError(`wordpress import needs --${key}`);
    return {
      kind: 'wordpress.import',
      slug: f['tenant']!,
      file: f['file']!,
      intoExisting: f['into-existing'] === 'true',
      ...(f['media-dir'] ? { mediaDir: f['media-dir'] } : {}),
      ...wordpressOptions(f),
    };
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
  if (noun === 'operators' && verb === 'erase' && rest[0] && rest.length === 1)
    return { kind: 'operators.erase', operatorId: rest[0] };
  if (noun === 'tenants' && verb === 'admin-restore' && rest[0] && rest[1] && rest.length === 2)
    return { kind: 'tenants.admin-restore', slug: rest[0], email: rest[1] };
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
  // Reading an export needs no database: a plan is checked before anything is set up.
  // Loaded on demand, so an image or checkout without the importer still runs every other command.
  if (command.kind === 'wordpress.plan') {
    const [{ planOf }, { formatReport }] = await Promise.all([
      import('./wordpress.js'),
      import('@mycel/import-wordpress'),
    ]);
    const result = planOf(command);
    process.stdout.write(
      command.json ? `${JSON.stringify(result, null, 2)}\n` : formatReport(result)
    );
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
    command.kind === 'setup' || command.kind === 'wordpress.import'
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
        // The operator register first (ADR 035 rule 2): installation-wide, so not per --tenant.
        const operators = await reapplyOperatorErasures(db, by);
        for (const r of operators) console.log(`operator ${r.operatorId}\terased again`);
        console.log(`operators: ${operators.length} registered operator(s) erased again`);
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
      case 'wordpress.import': {
        const tenant = await bySlug(command.slug);
        const { importWordpress } = await import('./wordpress.js');
        process.stdout.write(await importWordpress({ invoker: runtime!.invoker, tenant }, command));
        break;
      }
      case 'search.rebuild': {
        // The site search index from the publication rows (content/search.ts): for items
        // published before 0055, or after a change of the token rule. Each tenant in its own
        // transaction; an import of an older archive does this by itself.
        const tenants = await tenantsOf(command.slug);
        for (const t of tenants) {
          const { items, rows } = await reindexSearch(db, t.id);
          console.log(`${t.slug}\t${items} items, ${rows} index rows`);
        }
        console.log(`search: rebuilt in ${tenants.length} tenant(s)`);
        break;
      }
      case 'fonts.list': {
        const t = await bySlug(command.slug);
        const fonts = await listSiteFontsOf(db, t.id);
        if (!fonts.length)
          console.log(`${t.slug}\tno uploaded fonts; the theme's catalogue fonts apply`);
        for (const font of fonts) {
          console.log(
            `${font.role}\t${font.family} (${font.category})\tlicence: ${font.licence.holder}, ${font.licence.source}, ${font.licence.domains.join(' ')}`
          );
          for (const face of font.faces)
            console.log(
              `  ${face.weight} ${face.style}\t${face.bytes} bytes\t${face.sha256.slice(0, 16)}`
            );
        }
        break;
      }
      case 'fonts.add': {
        const t = await bySlug(command.slug);
        const bytes = new Uint8Array(await readFile(command.file));
        const font = await uploadSiteFontFace(
          db,
          t.id,
          {
            family: command.family,
            weight: command.weight,
            style: command.style,
            bytes,
            replaceFamily: command.replaceFamily,
          },
          by,
          validateWoff2
        );
        console.log(
          `${t.slug}\t${font.role} ${font.family}: ${font.faces.map((f) => `${f.weight} ${f.style}`).join(', ')}`
        );
        break;
      }
      case 'fonts.remove': {
        const t = await bySlug(command.slug);
        const removed = await removeSiteFont(db, t.id, command.role, command.face, by);
        console.log(`${t.slug}\t${removed ? 'removed' : 'nothing to remove'}`);
        if (!removed) return 1;
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
      case 'operators.erase': {
        const { operatorId } = OperatorErasureInput.parse({ operatorId: command.operatorId });
        const result = await store.eraseOperator(operatorId);
        const blobs = blobStoreFor(config);
        for (const t of result.tenants) {
          // The archives this erasure expired lose their file now, not at the next daily expire.
          const purged = t.expiredExports
            ? await expireExports(db, blobs, t.tenantId, new Date())
            : 0;
          console.log(
            `${t.slug}\tmembership ${t.membership ? 'removed' : '-'}\t${t.revokedKeys} key(s) revoked\t` +
              `${purged} archive(s) deleted${t.withoutAdmin ? '\tNO ADMIN LEFT' : ''}`
          );
        }
        console.log(
          `platform: operator ${result.operatorId} ` +
            (result.changed ? 'erased' : 'already erased; nothing left to change') +
            (result.alreadyRegistered ? ' (was in the register)' : '')
        );
        const orphaned = result.tenants.filter((t) => t.withoutAdmin);
        for (const t of orphaned)
          console.log(`  ${t.slug} has no admin: mycel tenants admin-restore ${t.slug} <e-mail>`);
        console.log(`note: ${result.note}`);
        break;
      }
      case 'tenants.admin-restore': {
        const t = await bySlug(command.slug);
        const { email } = AdminRestoreInput.parse({ email: command.email });
        const r = await store.restoreAdmin(t.id, email);
        if (!r) throw new Error(`no tenant with slug "${t.slug}"`);
        console.log(
          `platform: ${t.slug} ` +
            (r.kind === 'grant'
              ? `member ${r.operatorId} now holds tenant:admin`
              : `invited ${email} as tenant:admin (pending until the first login, ${r.operatorId})`)
        );
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
