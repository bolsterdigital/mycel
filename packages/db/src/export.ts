// Tenant export and import (TODO #18d, brief production-and-restore § 12-13; ADR 002 rule 5, ADR
// 015 rule 7, ADR 017). An export is a directory (or a tar of one) with `manifest.json`, one
// `tables/<table>.ndjson` per tenant table and `media/<key>` per file in the blob store. Rows are
// Postgres's own `to_jsonb(row)::text`, so a value comes back bit for bit: microseconds, bigints,
// jsonb and arrays included, and a column added by a later migration needs no code here.
//
// Reading runs as mycel_app under the tenant's context in one repeatable-read transaction: the
// export holds exactly what RLS shows that tenant, consistent across tables, and works for a
// suspended tenant (ADR 015 rule 7). Writing runs in one transaction on the operator connection:
// the event partitions as the owner, the tenant as mycel_platform (`createTenantIn`), the rows as
// mycel_app. The media files go last; a failure removes what was written, so a failed import
// leaves neither a half tenant nor its files.
//
// What does not travel: the operational queues (outbox, jobs, mail_sends, rate_limits,
// login_attempts) and the record of which backups hold an erasure (erasure_backups) are this
// installation's work in progress, not the tenant's data; operator accounts are people who log
// in here, so a membership travels as the address and becomes a pending invitation; the platform
// hostname is this installation's, and custom hostnames arrive unverified (DNS may point
// elsewhere). Those rules, the manifest checks and the purge window are core's
// (`tenants/portability.ts`); this file is the plumbing. Every table of `Database` has its place
// in `TABLES`, so a new table fails to compile until someone decides, and
// export.conformance.test.ts holds the live catalog to the same list.
// Rejected: pg_dump per tenant (no RLS boundary, owner rights, not a documented format), JSON
// built from Kysely rows (Date loses microseconds, bigint becomes a string), and a tar library
// (one more dependency for what the system `tar` does).

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, open, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';
import { sql, type Kysely, type RawBuilder } from 'kysely';
import {
  EXPORT_FILE_WINDOW_MS,
  EXPORT_FORMAT,
  IMPORTED_HOSTNAME,
  UseCaseError,
  checkImportSchema,
  hostnameTravels,
  invitationFromExport,
  mediaKeys,
  verifyExportManifest,
  type BlobStore,
  type ExportManifest,
  type MediaRecord,
  type PlatformConfig,
} from '@mycel/core';
import { uuidv7 } from './ids.js';
import { createTenantIn, getTenant, getTenantBySlug, type PlatformActor } from './platform.js';
import type { Database } from './schema.js';
import { enterTenant, setRole } from './roles.js';

type Trx = Kysely<Database>;

export { EXPORT_FORMAT, type ExportManifest };

/**
 * Every table and view of the schema, by what an export does with it. `export`: the tenant's
 * data, in `EXPORT_ORDER`. `operational`: a queue or counter of this installation. `platform`:
 * not the tenant's rows (the tenant row goes in the manifest, operators as addresses).
 */
export const TABLES = {
  site_settings: 'export',
  connections: 'export',
  connection_intents: 'operational',
  connection_attempts: 'operational',
  // Credentials are encrypted but still installation-bound secrets; an import reconnects.
  connection_credentials: 'operational',
  tenants: 'platform',
  tenant_directory: 'platform',
  operators: 'platform',
  tenant_hostnames: 'export',
  forms: 'export',
  form_submissions: 'export',
  supporters: 'export',
  supporter_admissions: 'export',
  events: 'export',
  authors: 'export',
  sections: 'export',
  patterns: 'export',
  media: 'export',
  media_usages: 'export',
  content_items: 'export',
  content_revisions: 'export',
  assist_settings: 'export',
  assist_suggestions: 'operational',
  assist_usage: 'operational',
  content_item_locales: 'export',
  content_block_refs: 'export',
  tenant_memberships: 'export',
  api_keys: 'export',
  audit_log: 'export',
  erasures: 'export',
  outbox: 'operational',
  jobs: 'operational',
  mail_sends: 'operational',
  rate_limits: 'operational',
  login_attempts: 'operational',
  // Which of this installation's restic snapshots hold a registration (0021): another
  // installation's snapshot ids say nothing about its backups, so an import starts unsecured.
  erasure_backups: 'operational',
  // Archives of earlier exports (0022): an archive in an archive would grow with every export,
  // and the file stays on this installation.
  tenant_exports: 'operational',
} as const satisfies Record<keyof Database, 'export' | 'operational' | 'platform'>;

export type ExportTable = {
  [K in keyof typeof TABLES]: (typeof TABLES)[K] extends 'export' ? K : never;
}[keyof typeof TABLES];

/**
 * Dependency order: a row's foreign keys point at tables earlier in the list (the revision pointer
 * of `content_items` is deferred to commit, 0011). Import writes in this order.
 */
export const EXPORT_ORDER: readonly ExportTable[] = [
  'site_settings',
  'connections',
  'tenant_hostnames',
  'forms',
  'form_submissions',
  'supporters',
  'supporter_admissions',
  'events',
  'authors',
  'sections',
  'patterns',
  'media',
  'media_usages',
  'content_items',
  'content_revisions',
  'assist_settings',
  'content_item_locales',
  'content_block_refs',
  'tenant_memberships',
  'api_keys',
  'audit_log',
  'erasures',
];

const sha256 = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex');

/** The last applied migration, readable by the owner (schema_migrations has no RLS). */
export async function schemaVersion(db: Kysely<Database>): Promise<string> {
  const { rows } = await sql<{ v: string | null }>`
    select max(version) as v from schema_migrations`.execute(db);
  return rows[0]?.v ?? '';
}

/** Insertable columns of a table, from the catalog: generated columns are never written. */
async function columnsOf(db: Kysely<Database>, table: string): Promise<string[]> {
  const { rows } = await sql<{ name: string }>`
    select attname as name from pg_attribute
    where attrelid = ${`public.${table}`}::regclass and attnum > 0 and not attisdropped
      and attgenerated = ''
    order by attnum`.execute(db);
  return rows.map((r) => r.name);
}

/** The rows of one table as export lines; memberships name the operator by address. */
function rowQuery(table: ExportTable) {
  if (table === 'tenant_memberships')
    return sql`
      select ((to_jsonb(m) - 'operator_id') || jsonb_build_object('operator_email', o.email))::text
        as line
      from tenant_memberships m join operators o on o.id = m.operator_id order by 1`;
  return sql`select to_jsonb(t)::text as line from ${sql.table(table)} t order by 1`;
}

/**
 * Every line of every export table, as mycel_app in one repeatable-read snapshot of the tenant.
 * A server-side cursor keeps memory flat for a large event log.
 */
async function readTenant(
  operatorDb: Kysely<Database>,
  tenantId: string,
  each: (table: ExportTable, line: string) => Promise<void> | void
): Promise<Date> {
  return operatorDb
    .transaction()
    .setIsolationLevel('repeatable read')
    .execute(async (trx) => {
      // The first statement takes the snapshot; `now()` is the transaction's start, on the
      // database's clock, whichever statement reads it.
      await enterTenant(trx, tenantId);
      const { rows } = await sql<{ t0: Date }>`select now() as t0`.execute(trx);
      for (const table of EXPORT_ORDER) {
        await sql`declare export_rows no scroll cursor for ${rowQuery(table)}`.execute(trx);
        for (;;) {
          const { rows } = await sql<{ line: string }>`fetch 1000 from export_rows`.execute(trx);
          for (const r of rows) await each(table, r.line);
          if (rows.length < 1000) break;
        }
        await sql`close export_rows`.execute(trx);
      }
      return rows[0]!.t0;
    });
}

/** The fields of a `media` export line that decide its blob keys. */
interface MediaLine {
  id: string;
  content_type: MediaRecord['contentType'];
  variants: MediaRecord['variants'];
  deleted_at: string | null;
}

const run = promisify(execFile);
const isTar = (path: string) => path.endsWith('.tar');

export interface ExportOptions {
  operatorDb: Kysely<Database>;
  blobs: BlobStore;
  slug: string;
  /** A directory (created, must be empty or absent) or a path ending in `.tar`. */
  out: string;
  mycelVersion: string;
  /**
   * Tests only: runs after the tables are read and before the files are, so a test can delete,
   * purge or upload media between the two (export.conformance.test.ts).
   */
  afterSnapshot?: () => Promise<void>;
}

/** Whether `path` exists; refuses a non-empty directory, which a failed export would empty. */
async function emptyOrAbsent(path: string): Promise<boolean> {
  try {
    if ((await readdir(path)).length > 0)
      throw new UseCaseError('invalid_input', `${path} is not empty`);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw e;
  }
}

/**
 * `mycel export <slug> --out <dir|file.tar>`. Complete or nothing (TODO #29A, ADR 019 rule 8):
 * every file of every media row that is live in the table snapshot is in the archive, or the
 * export fails naming the media ids and leaves no directory or tar behind. `media.delete` purges
 * only after MEDIA_PURGE_DELAY_MS, so an export that reads the files within half of that finds
 * them; one that takes longer fails rather than trust it.
 */
export async function exportTenant(options: ExportOptions): Promise<ExportManifest> {
  const tenant = await getTenantBySlug(options.operatorDb, options.slug);
  if (!tenant) throw new UseCaseError('not_found', `no tenant with slug "${options.slug}"`);
  const out = resolve(options.out);
  const existed = isTar(out) ? false : await emptyOrAbsent(out);
  const dir = isTar(out) ? await mkdtemp(join(dirname(out), '.mycel-export-')) : out;
  let complete = false;
  try {
    await mkdir(join(dir, 'tables'), { recursive: true });
    const manifest: ExportManifest = {
      format: EXPORT_FORMAT,
      schemaVersion: await schemaVersion(options.operatorDb),
      mycelVersion: options.mycelVersion,
      exportedAt: new Date().toISOString(),
      tenant: {
        id: tenant.id,
        slug: tenant.slug,
        name: tenant.name,
        locales: tenant.locales,
        defaultLocale: tenant.defaultLocale,
        entitlements: tenant.storedEntitlements,
        status: tenant.status,
      },
      tables: {},
      media: {},
    };
    const files = new Map<
      ExportTable,
      {
        handle: Awaited<ReturnType<typeof open>>;
        hash: ReturnType<typeof createHash>;
        rows: number;
      }
    >();
    for (const table of EXPORT_ORDER)
      files.set(table, {
        handle: await open(join(dir, 'tables', `${table}.ndjson`), 'wx'),
        hash: createHash('sha256'),
        rows: 0,
      });
    // The keys every live media row of the snapshot needs; a soft-deleted row's may be gone.
    const required = new Map<string, string>();
    let t0: Date;
    try {
      t0 = await readTenant(options.operatorDb, tenant.id, async (table, line) => {
        const f = files.get(table)!;
        const text = line + '\n';
        f.hash.update(text);
        f.rows++;
        await f.handle.write(text);
        if (table !== 'media') return;
        const m = JSON.parse(line) as MediaLine;
        if (m.deleted_at === null)
          for (const key of mediaKeys(tenant.id, {
            id: m.id,
            contentType: m.content_type,
            variants: m.variants,
          }))
            required.set(key, m.id);
      });
    } finally {
      for (const f of files.values()) await f.handle.close();
    }
    for (const table of EXPORT_ORDER) {
      const f = files.get(table)!;
      manifest.tables[table] = {
        file: `tables/${table}.ndjson`,
        rows: f.rows,
        sha256: f.hash.digest('hex'),
        columns:
          table === 'tenant_memberships'
            ? ['tenant_id', 'operator_email', 'capabilities', 'created_at']
            : await columnsOf(options.operatorDb, table),
      };
    }

    await options.afterSnapshot?.();

    // The tenant's files: everything under `tenants/<id>/`, whatever the media register says, so
    // a variant the register lost still travels. A file that vanished between `list` and `get`
    // is skipped here and caught below if a live row needs it.
    const keys: string[] = [];
    for await (const { key } of options.blobs.list(`tenants/${tenant.id}/`)) keys.push(key);
    for (const key of keys.sort()) {
      const bytes = await options.blobs.get(key);
      if (!bytes) continue;
      const head = await options.blobs.head(key);
      const file = `media/${key}`;
      await mkdir(dirname(join(dir, file)), { recursive: true });
      await writeFile(join(dir, file), bytes, { flag: 'wx' });
      manifest.media[key] = {
        file,
        bytes: bytes.byteLength,
        sha256: sha256(bytes),
        contentType: head?.contentType ?? 'application/octet-stream',
      };
    }
    const missing = new Set(
      [...required].filter(([key]) => !manifest.media[key]).map(([, mediaId]) => mediaId)
    );
    if (missing.size)
      throw new Error(
        `export of ${tenant.slug}: files of live media are missing, nothing written: ` +
          [...missing].sort().join(', ')
      );
    const { rows } = await sql<{ lag: number }>`
      select extract(epoch from now() - ${t0}::timestamptz) * 1000 as lag`.execute(
      options.operatorDb
    );
    const limitHours = EXPORT_FILE_WINDOW_MS / 3_600_000;
    if (Number(rows[0]?.lag) > EXPORT_FILE_WINDOW_MS)
      throw new Error(
        `export of ${tenant.slug} read its files more than ${limitHours} hours after its ` +
          'tables, past half the purge delay; nothing written'
      );

    await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', {
      flag: 'wx',
    });
    if (isTar(out)) await run('tar', ['-cf', out, '-C', dir, '.']);
    complete = true;
    return manifest;
  } finally {
    if (isTar(out)) await rm(dir, { recursive: true, force: true });
    else if (!complete) {
      await rm(dir, { recursive: true, force: true });
      if (existed) await mkdir(dir);
    }
  }
}

/** Lines of an export file, streamed. */
async function* linesOf(path: string): AsyncGenerator<string> {
  const reader = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  for await (const line of reader) if (line) yield line;
}

async function fileSha256(path: string): Promise<{ sha256: string; lines: number }> {
  const hash = createHash('sha256');
  let lines = 0;
  for await (const line of linesOf(path)) {
    hash.update(line + '\n');
    lines++;
  }
  return { sha256: hash.digest('hex'), lines };
}

/** The manifest of an unpacked export, held to core's rules against the files in `dir`. */
const verifiedManifest = (dir: string): Promise<ExportManifest> =>
  verifyExportManifest(
    {
      manifest: () => readFile(join(dir, 'manifest.json'), 'utf8'),
      table: (file) => fileSha256(join(dir, file)),
      media: async (file) => sha256(await readFile(join(dir, file))),
    },
    EXPORT_ORDER
  );

/** The `occurred_at` range of the exported events, for their partitions. */
async function eventRange(dir: string, manifest: ExportManifest) {
  const entry = manifest.tables['events'];
  if (!entry?.rows) return null;
  let from = '';
  let to = '';
  for await (const line of linesOf(join(dir, entry.file))) {
    const at = new Date((JSON.parse(line) as { occurred_at: string }).occurred_at)
      .toISOString()
      .slice(0, 10);
    if (!from || at < from) from = at;
    if (!to || at > to) to = at;
  }
  return { from, to };
}

export interface ImportOptions {
  operatorDb: Kysely<Database>;
  blobs: BlobStore;
  /** An export directory or `.tar`. */
  path: string;
  /** Import under another slug; the tenant id stays the exported one. */
  slug?: string | undefined;
  platform: Pick<PlatformConfig, 'domain' | 'devHosts' | 'platformOrigin'>;
  by: PlatformActor;
}

export interface ImportReport {
  tenantId: string;
  slug: string;
  lines: string[];
  /** Tables whose content differs from the manifest after import, other than by design. */
  differences: string[];
}

const BATCH = 500;

/** `mycel import <path> [--slug <slug>]`. */
export async function importTenant(options: ImportOptions): Promise<ImportReport> {
  const source = resolve(options.path);
  const dir = isTar(source) ? await mkdtemp(join(tmpdir(), 'mycel-import-')) : source;
  try {
    // A path that is neither a directory nor a .tar has no readable manifest.json, which the
    // verification refuses with the path in its message.
    if (isTar(source)) await run('tar', ['-xf', source, '-C', dir]);
    return await importDirectory(dir, options);
  } finally {
    if (isTar(source)) await rm(dir, { recursive: true, force: true });
  }
}

async function importDirectory(dir: string, options: ImportOptions): Promise<ImportReport> {
  const { operatorDb } = options;
  const manifest = await verifiedManifest(dir);
  checkImportSchema(manifest.schemaVersion, await schemaVersion(operatorDb));
  const slug = options.slug ?? manifest.tenant.slug;
  // Before anything is written, so the refusal names the tenant rather than its hostname.
  const byId = await getTenant(operatorDb, manifest.tenant.id);
  if (byId || (await getTenantBySlug(operatorDb, slug)))
    throw new UseCaseError(
      'conflict',
      byId
        ? `tenant ${manifest.tenant.id} exists in this database`
        : `a tenant with slug "${slug}" exists`
    );
  const range = await eventRange(dir, manifest);
  const tenantId = manifest.tenant.id;
  const lines: string[] = [];
  const started = new Date();
  const written: string[] = [];

  try {
    await operatorDb.transaction().execute(async (trx) => {
      // Partitions are DDL and the owner's: before the role switch, inside the same transaction.
      if (range)
        await sql`select ensure_event_partitions(${range.from}::date, ${range.to}::date)`.execute(
          trx
        );
      await setRole(trx, 'mycel_platform');
      const tenant = await createTenantIn(
        trx,
        {
          id: tenantId,
          slug,
          name: manifest.tenant.name,
          locales: manifest.tenant.locales,
          defaultLocale: manifest.tenant.defaultLocale,
          entitlements: manifest.tenant.entitlements,
          status: manifest.tenant.status,
        },
        options.platform,
        options.by,
        'tenant.import'
      );
      lines.push(`tenant ${tenant.slug} (${tenant.id}) on ${tenant.primaryHostname ?? '-'}`);
      await enterTenant(trx, tenantId);

      for (const table of EXPORT_ORDER) {
        const entry = manifest.tables[table];
        if (!entry) {
          lines.push(`${table}: not in the export (older schema), 0 rows`);
          continue;
        }
        const { imported, skipped } = await importTable(
          trx,
          table,
          join(dir, entry.file),
          entry.columns
        );
        lines.push(`${table}: ${imported} imported${skipped ? `, ${skipped} skipped` : ''}`);
      }

      // The files last, still inside the transaction: a failure here rolls the rows back too.
      for (const [key, entry] of Object.entries(manifest.media)) {
        written.push(key);
        await options.blobs.put(key, await readFile(join(dir, entry.file)), {
          contentType: entry.contentType,
        });
      }
      lines.push(`media: ${written.length} files`);
    });
  } catch (e) {
    await options.blobs.delete(written).catch(() => {});
    throw e;
  }

  const differences = await compare(operatorDb, dir, manifest, started);
  lines.push(
    differences.length
      ? `fingerprint: ${differences.length} difference(s) with the manifest`
      : `fingerprint: equal to the manifest on ${EXPORT_ORDER.length} tables ` +
          '(platform hostname and verification differ by design)'
  );
  return { tenantId, slug, lines, differences };
}

/**
 * Columns a later migration added as `not null` without a default, derived on import from an
 * export that predates them, the way that migration backfilled them; the row alias is `r`. An
 * older export would otherwise fail on the constraint instead of taking the newer schema.
 */
const DERIVED: Partial<Record<ExportTable, Record<string, RawBuilder<unknown>>>> = {
  // 0020: the consent snapshot, from the form's definition (forms come first in EXPORT_ORDER).
  form_submissions: {
    list: sql`(select f.definition->>'list' from forms f where f.id = r.form_id)`,
    consent_text_version: sql`(select f.definition->>'consentTextVersion' from forms f where f.id = r.form_id)`,
  },
};

/** Write one table's lines as mycel_app; RLS refuses a row of any other tenant. */
async function importTable(
  trx: Trx,
  table: ExportTable,
  path: string,
  exported: string[]
): Promise<{ imported: number; skipped: number }> {
  let imported = 0;
  let skipped = 0;
  if (table === 'tenant_memberships') {
    // A pending operator per address, as `inviteMember` makes one; they log in again here.
    for await (const line of linesOf(path)) {
      const m = JSON.parse(line) as {
        operator_email: unknown;
        capabilities: unknown;
        created_at: string;
        tenant_id: string;
      };
      const invitation = invitationFromExport(m);
      const { rows } = invitation
        ? await sql<{ id: string | null }>`
            select operator_for_invite(${invitation.email}, ${uuidv7()}::uuid) as id`.execute(trx)
        : { rows: [] };
      const operatorId = rows[0]?.id;
      if (!invitation || !operatorId) {
        skipped++;
        continue;
      }
      await sql`insert into tenant_memberships (tenant_id, operator_id, capabilities, created_at)
                values (${m.tenant_id}, ${operatorId}, ${invitation.capabilities}, ${m.created_at})`.execute(
        trx
      );
      imported++;
    }
    return { imported, skipped };
  }

  const present = new Set(await columnsOf(trx, table));
  const columns = exported.filter((c) => present.has(c));
  const derived = Object.entries(DERIVED[table] ?? {}).filter(
    ([c]) => present.has(c) && !columns.includes(c)
  );
  const list = sql.join([...columns, ...derived.map(([c]) => c)].map((c) => sql.id(c)));
  const values = sql.join([
    ...columns.map((c) => sql`r.${sql.id(c)}`),
    ...derived.map(([, expression]) => expression),
  ]);
  let batch: unknown[] = [];
  const flush = async () => {
    if (!batch.length) return;
    await sql`insert into ${sql.table(table)} (${list})
              select ${values} from jsonb_populate_recordset(null::${sql.table(table)}, ${JSON.stringify(batch)}::jsonb) r`.execute(
      trx
    );
    imported += batch.length;
    batch = [];
  };
  for await (const line of linesOf(path)) {
    const row = JSON.parse(line) as Record<string, unknown>;
    if (table === 'tenant_hostnames') {
      // This installation's platform hostname came with the tenant; a custom one is unverified
      // until its DNS answers here (the daily check, or Check DNS in the admin).
      if (!hostnameTravels(String(row['kind']))) {
        skipped++;
        continue;
      }
      Object.assign(row, {
        verified_at: IMPORTED_HOSTNAME.verifiedAt,
        is_primary: IMPORTED_HOSTNAME.primary,
        check_failures: IMPORTED_HOSTNAME.checkFailures,
        last_checked_at: IMPORTED_HOSTNAME.lastCheckedAt,
      });
    }
    batch.push(row);
    if (batch.length >= BATCH) await flush();
  }
  await flush();
  return { imported, skipped };
}

/**
 * The imported tenant read back as an export and held to the manifest: equal per table, except
 * the hostnames (only the custom names must match) and the import's own audit row.
 */
async function compare(
  operatorDb: Kysely<Database>,
  dir: string,
  manifest: ExportManifest,
  started: Date
): Promise<string[]> {
  const hashes = new Map<ExportTable, { hash: ReturnType<typeof createHash>; rows: number }>();
  const custom: string[] = [];
  await readTenant(operatorDb, manifest.tenant.id, (table, line) => {
    if (table === 'tenant_hostnames') {
      const h = JSON.parse(line) as { kind: string; hostname: string };
      if (h.kind === 'custom') custom.push(h.hostname);
      return;
    }
    if (table === 'audit_log') {
      const a = JSON.parse(line) as { operation: string; occurred_at: string };
      if (a.operation === 'platform.tenant.import' && new Date(a.occurred_at) >= started) return;
    }
    const entry = hashes.get(table) ?? { hash: createHash('sha256'), rows: 0 };
    entry.hash.update(line + '\n');
    entry.rows++;
    hashes.set(table, entry);
  });
  const differences: string[] = [];
  for (const table of EXPORT_ORDER) {
    const expected = manifest.tables[table];
    if (!expected) continue;
    if (table === 'tenant_hostnames') {
      const exported: string[] = [];
      for await (const line of linesOf(join(dir, expected.file))) {
        const h = JSON.parse(line) as { kind: string; hostname: string };
        if (h.kind === 'custom') exported.push(h.hostname);
      }
      if (exported.sort().join() !== custom.sort().join())
        differences.push(
          `tenant_hostnames: custom ${exported.join(',')} exported, ${custom.join(',')} after import`
        );
      continue;
    }
    const got = hashes.get(table);
    const sha = got?.hash.digest('hex') ?? sha256('');
    if (sha !== expected.sha256)
      differences.push(`${table}: ${expected.rows} rows exported, ${got?.rows ?? 0} after import`);
  }
  return differences;
}
