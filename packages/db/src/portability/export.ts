// Tenant export and import (TODO #18d, brief production-and-restore § 12-13; ADR 002 rule 5, ADR
// 015 rule 7, ADR 017). An export is a directory (or a tar of one) with `manifest.json`, one
// `tables/<table>.ndjson` per tenant table and `media/<key>` per file in the blob store. Rows are
// Postgres's own `to_jsonb(row)::text`, so a value comes back bit for bit: microseconds, bigints,
// jsonb and arrays included, and a column added by a later migration needs no code here.
//
// Reading runs as mycel_app under the tenant's context in one repeatable-read transaction: the
// export holds exactly what RLS shows that tenant, consistent across tables, and works for a
// suspended tenant (ADR 015 rule 7). The way back in, `importTenant`, is import.ts; it reads
// the catalog and the snapshot from here.
//
// What does not travel: the operational queues (outbox, jobs, mail_sends, rate_limits,
// login_attempts) and the record of which backups hold an erasure (erasure_backups) are this
// installation's work in progress, not the tenant's data; operator accounts are people who log
// in here, so a membership travels as the address and becomes a pending invitation; the platform
// hostname is this installation's, and custom hostnames arrive unverified (DNS may point
// elsewhere). Those rules, the manifest checks and the purge window are core's
// (`tenants/portability.ts`); this file and import.ts are the plumbing. Every table of `Database` has its place
// in `TABLES`, so a new table fails to compile until someone decides, and
// export.conformance.test.ts holds the live catalog to the same list.
// Rejected: pg_dump per tenant (no RLS boundary, owner rights, not a documented format), JSON
// built from Kysely rows (Date loses microseconds, bigint becomes a string), and a tar library
// (one more dependency for what the system `tar` does).

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, open, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { sql, type Kysely } from 'kysely';
import {
  EXPORT_FILE_WINDOW_MS,
  EXPORT_FORMAT,
  UseCaseError,
  exportSource,
  mediaKeys,
  type BlobStore,
  type ExportManifest,
  type MediaRecord,
} from '@mycel/core';
import { getTenantBySlug } from '../platform.js';
import type { Database } from '../infra/schema.js';
import { enterTenant } from '../infra/roles.js';

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
  mailchimp_receipts: 'operational',
  connection_attempts: 'operational',
  // Credentials are encrypted but still installation-bound secrets; an import reconnects.
  connection_credentials: 'operational',
  tenants: 'platform',
  tenant_directory: 'platform',
  operators: 'platform',
  tenant_hostnames: 'export',
  form_feed_settings: 'export',
  form_mail_settings: 'export',
  form_mail_budget: 'operational',
  forms: 'export',
  form_submissions: 'export',
  supporters: 'export',
  supporter_lifecycles: 'export',
  supporter_admissions: 'export',
  events: 'export',
  people: 'export',
  person_groups: 'export',
  person_group_members: 'export',
  sections: 'export',
  patterns: 'export',
  media: 'export',
  media_usages: 'export',
  content_items: 'export',
  content_revisions: 'export',
  // Who has an item open this minute (0038): no site data, and gone within the minute.
  content_presence: 'operational',
  content_bulk_plans: 'export',
  content_bulk_plan_items: 'export',
  content_bulk_runs: 'export',
  content_bulk_effects: 'export',
  assist_settings: 'export',
  assist_suggestions: 'operational',
  assist_usage: 'operational',
  content_item_locales: 'export',
  content_block_refs: 'export',
  tenant_memberships: 'export',
  // Credentials of this installation: a key's hash is all a request needs to match, so a key that
  // travelled would work on the importing side, for whoever wrote or kept the archive. The operator
  // creates new keys there. Rejected: exporting the rows without the hash, which gives an importer
  // names of keys that cannot exist.
  api_keys: 'operational',
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
  'form_feed_settings',
  'form_mail_settings',
  'form_submissions',
  'supporters',
  'supporter_lifecycles',
  'supporter_admissions',
  'events',
  'people',
  'person_groups',
  'person_group_members',
  'sections',
  'patterns',
  'media',
  'media_usages',
  'content_items',
  'content_revisions',
  'content_bulk_plans',
  'content_bulk_plan_items',
  'content_bulk_runs',
  'content_bulk_effects',
  'assist_settings',
  'content_item_locales',
  'content_block_refs',
  'tenant_memberships',
  'audit_log',
  'erasures',
];

export const sha256 = (data: string | Uint8Array) =>
  createHash('sha256').update(data).digest('hex');

/** The last applied migration, readable by the owner (schema_migrations has no RLS). */
export async function schemaVersion(db: Kysely<Database>): Promise<string> {
  const { rows } = await sql<{ v: string | null }>`
    select max(version) as v from schema_migrations`.execute(db);
  return rows[0]?.v ?? '';
}

/** Insertable columns of a table, from the catalog: generated columns are never written. */
export async function columnsOf(db: Kysely<Database>, table: string): Promise<string[]> {
  const { rows } = await sql<{ name: string }>`
    select attname as name from pg_attribute
    where attrelid = ${`public.${table}`}::regclass and attnum > 0 and not attisdropped
      and attgenerated = ''
    order by attnum`.execute(db);
  return rows.map((r) => r.name);
}

/**
 * The rows of one table as export lines; memberships name the operator by address and leave out
 * `attention_seen_at`, a member's reading habit rather than site data (0034).
 */
function rowQuery(table: ExportTable, columns?: readonly string[]) {
  if (columns)
    return sql`select jsonb_build_object(${sql.join(columns.flatMap((c) => [sql`${c}::text`, sql.ref(c)]))})::text as line from ${sql.table(table)} order by 1`;
  if (table === 'tenant_memberships')
    return sql`
      select ((to_jsonb(m) - 'operator_id' - 'attention_seen_at')
              || jsonb_build_object('operator_email', o.email))::text
        as line
      from tenant_memberships m join operators o on o.id = m.operator_id order by 1`;
  return sql`select to_jsonb(t)::text as line from ${sql.table(table)} t order by 1`;
}

/**
 * Every line of every export table, as mycel_app in one repeatable-read snapshot of the tenant.
 * A server-side cursor keeps memory flat for a large event log.
 */
export async function readTenant(
  operatorDb: Kysely<Database>,
  tenantId: string,
  each: (table: ExportTable, line: string) => Promise<void> | void,
  columns?: Partial<Record<ExportTable, readonly string[]>>
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
        await sql`declare export_rows no scroll cursor for ${rowQuery(table, columns?.[table])}`.execute(
          trx
        );
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

export const run = promisify(execFile);
export const isTar = (path: string) => path.endsWith('.tar');

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
  const tenant = exportSource(
    await getTenantBySlug(options.operatorDb, options.slug),
    options.slug
  );
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
