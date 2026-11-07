// Tenant import: an export directory or `.tar` back into this installation (ADR 017; the format,
// the catalog and what travels are described in export.ts). Writing runs in one transaction on
// the operator connection: the event partitions as the owner, the tenant as mycel_platform
// (`createTenantIn`), the rows as mycel_app. The media files go last; a failure removes what was
// written, so a failed import leaves neither a half tenant nor its files. Afterwards the tenant is
// read back as an export and held to the manifest.
// Split from export.ts at `importTenant`, because the two directions share only the catalog and
// the snapshot read. Rejected: keeping one file for both (733 lines, where the import's rules sat
// far from the code that applies them) and a third catalog file (the catalog is the export's
// order; the import only follows it).

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { sql, type Kysely, type RawBuilder } from 'kysely';
import {
  IMPORTED_HOSTNAME,
  checkImportSchema,
  checkImportTarget,
  hostnameTravels,
  invitationFromExport,
  verifyExportManifest,
  type BlobStore,
  type ExportManifest,
  type PlatformConfig,
} from '@mycel/core';
import { uuidv7 } from '../infra/ids.js';
import { createTenantIn, getTenant, getTenantBySlug, type PlatformActor } from '../platform.js';
import type { Database } from '../infra/schema.js';
import { enterTenant, setRole } from '../infra/roles.js';
import {
  EXPORT_ORDER,
  columnsOf,
  isTar,
  readTenant,
  run,
  schemaVersion,
  sha256,
  type ExportTable,
} from './export.js';

type Trx = Kysely<Database>;

/**
 * Tables an older archive still holds and this version never reads back. Its digests are still
 * checked, so the rest of that archive stays verifiable; no row reaches the database.
 */
const RETIRED_TABLES: readonly string[] = ['api_keys'];

/**
 * How each table comes back in. A table added to `EXPORT_ORDER` does not compile until it says, so
 * "copy the rows as they are" is a decision. Rejected: a default, which is how a credential
 * travelled unnoticed.
 */
const IMPORT_RULE = {
  site_settings: 'as-exported',
  connections: 'as-exported',
  tenant_hostnames: 'custom-only',
  forms: 'as-exported',
  form_submissions: 'as-exported',
  supporters: 'as-exported',
  supporter_admissions: 'as-exported',
  events: 'as-exported',
  authors: 'as-exported',
  sections: 'as-exported',
  patterns: 'as-exported',
  media: 'as-exported',
  media_usages: 'as-exported',
  content_items: 'as-exported',
  content_revisions: 'as-exported',
  content_bulk_plans: 'as-exported',
  content_bulk_plan_items: 'as-exported',
  content_bulk_runs: 'as-exported',
  content_bulk_effects: 'as-exported',
  assist_settings: 'as-exported',
  content_item_locales: 'as-exported',
  content_block_refs: 'as-exported',
  tenant_memberships: 'as-invitation',
  audit_log: 'as-exported',
  erasures: 'as-exported',
} as const satisfies Record<ExportTable, 'as-exported' | 'as-invitation' | 'custom-only'>;

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
      entries: async () =>
        (await readdir(dir, { recursive: true, withFileTypes: true })).map((entry) => ({
          path: relative(dir, join(entry.parentPath, entry.name)),
          regular: entry.isFile() || entry.isDirectory(),
        })),
      manifest: () => readFile(join(dir, 'manifest.json'), 'utf8'),
      table: (file) => fileSha256(join(dir, file)),
      media: async (file) => sha256(await readFile(join(dir, file))),
    },
    [...EXPORT_ORDER, ...RETIRED_TABLES]
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
  checkImportTarget(
    {
      id: (await getTenant(operatorDb, manifest.tenant.id)) !== null,
      slug: (await getTenantBySlug(operatorDb, slug)) !== null,
    },
    manifest.tenant.id,
    slug
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
      for (const table of RETIRED_TABLES) {
        const entry = manifest.tables[table];
        if (entry)
          lines.push(`${table}: ${entry.rows} not imported, create new keys on this installation`);
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
  if (IMPORT_RULE[table] === 'as-invitation') {
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
    if (IMPORT_RULE[table] === 'custom-only') {
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
