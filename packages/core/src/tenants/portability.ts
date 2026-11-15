// The rules of the tenant export format (TODO #18d, #53 PR 4; ADR 002 rule 5, ADR 019 rule 8):
// what a manifest must say before an import trusts a byte of it, and what changes on the way in.
// packages/db/src/portability/export.ts does the plumbing (snapshot, files, tar, rows) and asks these:
//
// * a manifest names only files the format prescribes, and every file matches its digest;
// * an export from a newer schema is refused, an older one is fine (`migrate` is past it);
// * an export needs its tenant, and an import never overwrites one (by id or by slug);
// * a membership arrives as a pending invitation of its address, with only the capabilities this
//   version knows (operator accounts are people who log in here, not data); since format 2 the
//   line also names the member's operator id in the source installation, and every operator id in
//   the imported actors and audit rows is rewritten to the id the invitation resolved to (ADR 035
//   rule 5), except an id this installation erased, whose line is skipped;
// * the platform hostname stays behind and a custom one arrives unverified (DNS may point
//   elsewhere);
// * an export reads its files within half the media purge delay of its tables, or fails.
//
// Rejected: leaving these in the adapter next to the tar plumbing (a second adapter or the
// self-service export job would have to find and copy them), and a Zod schema for the whole
// manifest (the digests already refuse a manifest that does not describe its files, and the
// tenant fields go through `planTenant` like any new tenant).

import type { EntitlementsDocument, TenantStatus } from '../entitlements/model.js';
import { notFound, UseCaseError } from '../errors.js';
import { MEDIA_PURGE_DELAY_MS } from '../media/model.js';
import { Email } from '../operators/model.js';
import { Capability, storedActorJson } from '../principal.js';
import { z } from 'zod';
import type { HostnameKind } from './model.js';

/**
 * Format 2 (ADR 035 rule 5): a membership line carries the source operator id beside the
 * address. An archive of format 1 is refused: no production site exists yet, so there is no older
 * archive to keep importable (Jaap 2026-11-15, the dated addition to ADR 035).
 */
export const EXPORT_FORMAT = 'mycel-tenant-export/2';

export interface ExportManifest {
  format: typeof EXPORT_FORMAT;
  /** The last migration applied to the exporting database. */
  schemaVersion: string;
  mycelVersion: string;
  exportedAt: string;
  tenant: {
    id: string;
    slug: string;
    name: string;
    locales: string[];
    defaultLocale: string;
    /** The stored document, as the hoster wrote it. */
    entitlements: EntitlementsDocument;
    status: TenantStatus;
  };
  tables: Record<string, { file: string; rows: number; sha256: string; columns: string[] }>;
  media: Record<string, { file: string; bytes: number; sha256: string; contentType: string }>;
}

/** How the verification reads an unpacked export; the adapter knows where it lies. */
export interface ExportArchive {
  /** Every entry of the unpacked export as it lies there, without following a link. */
  entries(): Promise<readonly { path: string; regular: boolean }[]>;
  /** The text of `manifest.json`; throws when it cannot be read. */
  manifest(): Promise<string>;
  /** Digest and line count of a table file, as the export computed them. */
  table(file: string): Promise<{ sha256: string; lines: number }>;
  /** Digest of a media file. */
  media(file: string): Promise<string>;
}

const refuse = (message: string) => new UseCaseError('invalid_input', message);
const OperatorId = z.string().guid();

/**
 * The manifest of an export, checked against every file it names. A file name is the one the
 * format prescribes (`tables/<table>.ndjson`, `media/<key>`), never one the manifest chooses: a
 * crafted archive could otherwise name any readable path on this box as media. For the same reason
 * every entry must be a regular file or a directory: a link with the right digest passes every
 * other check, and reading it would read whatever it points at.
 */
export async function verifyExportManifest(
  archive: ExportArchive,
  knownTables: readonly string[]
): Promise<ExportManifest> {
  const irregular = (await archive.entries()).find((entry) => !entry.regular);
  if (irregular) throw refuse(`${irregular.path} is not a regular file`);
  let manifest: ExportManifest;
  try {
    manifest = JSON.parse(await archive.manifest()) as ExportManifest;
  } catch (e) {
    throw refuse(`no readable manifest.json: ${(e as Error).message}`);
  }
  if (manifest.format !== EXPORT_FORMAT)
    throw refuse(`format ${String(manifest.format)} is not ${EXPORT_FORMAT}`);
  for (const [table, entry] of Object.entries(manifest.tables)) {
    if (!knownTables.includes(table))
      throw refuse(`the export has a table this version does not know: ${table}`);
    if (entry.file !== `tables/${table}.ndjson`)
      throw refuse(`${table} names a file outside the format`);
    const found = await archive.table(entry.file);
    if (found.sha256 !== entry.sha256 || found.lines !== entry.rows)
      throw refuse(`${entry.file} does not match the manifest`);
  }
  for (const [key, entry] of Object.entries(manifest.media)) {
    if (!key.startsWith(`tenants/${manifest.tenant.id}/`))
      throw refuse(`media key ${key} is not under the tenant`);
    if (entry.file !== `media/${key}` || key.split('/').some((s) => s === '' || s === '..'))
      throw refuse(`media key ${key} names a file outside the format`);
    if ((await archive.media(entry.file)) !== entry.sha256)
      throw refuse(`${entry.file} does not match the manifest`);
  }
  return manifest;
}

/** The tenant an export reads, found by its slug; there is nothing to export without one. */
export function exportSource<T>(tenant: T | null, slug: string): T {
  if (!tenant) throw notFound('tenant', `slug "${slug}"`);
  return tenant;
}

/**
 * An import never overwrites: refused when this database has the tenant's id or the slug it
 * would get, before anything is written, so the refusal names the tenant rather than its hostname.
 */
export function checkImportTarget(
  taken: { id: boolean; slug: boolean },
  tenantId: string,
  slug: string
): void {
  if (taken.id) throw new UseCaseError('conflict', `tenant ${tenantId} exists in this database`);
  if (taken.slug) throw new UseCaseError('conflict', `a tenant with slug "${slug}" exists`);
}

/** Migration names sort by their number, so a later schema compares greater. */
export function checkImportSchema(exported: string, current: string): void {
  if (exported > current)
    throw new UseCaseError(
      'conflict',
      `the export is from schema ${exported}, newer than this database (${current}); ` +
        'upgrade this installation first'
    );
}

/**
 * The invitation an exported membership becomes: its address, normalised the way an invite
 * normalises it, and the capabilities this version knows (a newer export may carry more; this
 * one cannot grant what it does not have). Null when the address is not one or no known capability
 * is left, as an invite needs at least one: the line is skipped.
 */
export function invitationFromExport(line: {
  operator_email: unknown;
  capabilities: unknown;
}): { email: string; capabilities: Capability[] } | null {
  const email = Email.safeParse(line.operator_email);
  if (!email.success) return null;
  const listed = Array.isArray(line.capabilities) ? line.capabilities : [];
  const capabilities = [
    ...new Set(listed.filter((c): c is Capability => Capability.safeParse(c).success)),
  ];
  return capabilities.length ? { email: email.data, capabilities } : null;
}

/** An exported membership line as format 2 writes it. */
export interface ExportedMembership {
  operator_id: unknown;
  operator_email: unknown;
  capabilities: unknown;
  created_at: string;
  tenant_id: string;
}

/** What the import does with the membership lines of an archive (ADR 035 rule 5). */
export interface MembershipImportPlan {
  invitations: {
    sourceId: string;
    email: string;
    capabilities: Capability[];
    createdAt: string;
    tenantId: string;
  }[];
  /** Lines whose source id this installation erased: skipped, their history stays anonymous. */
  erased: string[];
  /** Lines without a valid address or a known capability. */
  invalid: number;
}

/**
 * Plan the membership lines: an erased source id is skipped and reported, so an archive does not
 * bring an erased operator back; every other valid line becomes an invitation whose resolved id
 * replaces the source id in the imported history. A source id named twice is refused as a whole:
 * the source installation has one membership per operator, so such an archive was edited, and
 * mapping one id to two people would give one person's history to another.
 */
export function planMembershipImport(
  lines: readonly ExportedMembership[],
  erased: ReadonlySet<string>
): MembershipImportPlan {
  const plan: MembershipImportPlan = { invitations: [], erased: [], invalid: 0 };
  const seen = new Set<string>();
  for (const line of lines) {
    const sourceId = OperatorId.safeParse(line.operator_id);
    if (!sourceId.success) {
      plan.invalid++;
      continue;
    }
    if (seen.has(sourceId.data))
      throw refuse(`tenant_memberships names operator ${sourceId.data} twice`);
    seen.add(sourceId.data);
    if (erased.has(sourceId.data)) {
      plan.erased.push(sourceId.data);
      continue;
    }
    const invitation = invitationFromExport(line);
    if (!invitation) {
      plan.invalid++;
      continue;
    }
    plan.invitations.push({
      sourceId: sourceId.data,
      ...invitation,
      createdAt: line.created_at,
      tenantId: line.tenant_id,
    });
  }
  return plan;
}

/**
 * A stored actor as the import writes it: `storedActorJson` (kind and id, nothing else), with the
 * operator id rewritten from the source installation's to this one's when the archive's
 * membership lines map it. An id without a mapping stays as it is and shows as a former team
 * member (a former member, an erased operator).
 */
export function importedActorJson(value: unknown, ids: ReadonlyMap<string, string>): unknown {
  const actor = storedActorJson(value);
  if (actor === value || typeof actor !== 'object' || actor === null) return actor;
  const out = { ...(actor as Record<string, unknown>) };
  for (const key of ['operatorId', 'id'])
    if (typeof out[key] === 'string' && ids.has(out[key])) out[key] = ids.get(out[key]);
  return out;
}

/** Only a custom hostname travels; the platform hostname is this installation's. */
export const hostnameTravels = (kind: HostnameKind | string): boolean => kind === 'custom';

/** What an imported custom hostname starts as: unverified until its DNS answers here. */
export const IMPORTED_HOSTNAME = {
  verifiedAt: null,
  primary: false,
  checkFailures: 0,
  lastCheckedAt: null,
} as const;

/**
 * An export must read its files within this long of its table snapshot: `media.delete` purges a
 * file only after MEDIA_PURGE_DELAY_MS, so within half of that every live row's file is there.
 */
export const EXPORT_FILE_WINDOW_MS = MEDIA_PURGE_DELAY_MS / 2;
