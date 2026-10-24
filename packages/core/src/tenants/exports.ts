// Self-service export (TODO #28, brief tenant-self-export; ADR 002 rule 5, ADR 015 rule 7, ADR 019
// rule 8). A tenant administrator asks for an archive with `tenant.export`, a command with effect
// `export` that requires `tenant:admin`, so a suspended tenant can still leave (`guardSuspended`). The command only plans: it
// writes a `queued` row and a `tenant.export` job in one transaction, and the job builds the same
// archive `mycel export` builds (packages/api/src/jobs.ts). One export at a time per tenant: a
// second request while one is queued or running gets that one back.
//
// The archive is the most sensitive copy of a tenant, so downloading is not a use case but a check
// the admin route runs in the operator's own unit of work (`openExportDownload`): a current
// `tenant:admin` membership, a ready and unexpired archive of this tenant, and a five-minute
// signature over tenant and export. Every refusal looks the same (null, a 404 at the route); every
// download writes an audit row. Rejected: a new `tenant:export` capability (an ADR 018 amendment
// for what `tenant:admin` plus the existing effect already says), a presigned bucket URL (no
// membership check at download time, no audit row, and no such thing on the fs store), and
// download through the API or MCP (belongs to the remote MCP session of #25, with its own auth),
// and `requires: 'supporters:export'` (the archive holds members, key hashes and the audit log).

import { z } from 'zod';
import { hashInput, auditActor } from '../audit/model.js';
import '../audit/ports.js';
import { jobKey } from '../jobs/types.js';
import '../jobs/ports.js';
import type { Signer, TransactionContext } from '../ports.js';
import { can } from '../principal.js';
import { defineUseCase } from '../registry.js';
import { actorRef } from '../util/log.js';

export const ExportStatus = z.enum(['queued', 'running', 'ready', 'failed', 'expired']);
export type ExportStatus = z.infer<typeof ExportStatus>;

/** A row of `tenant_exports` (0022). The file's key is derived (`exportArchiveKey`), never stored. */
export interface TenantExportRecord {
  id: string;
  /** `actorRef` of who asked. */
  requestedBy: string;
  requestedAt: Date;
  status: ExportStatus;
  startedAt: Date | null;
  heartbeatAt: Date | null;
  finishedAt: Date | null;
  sizeBytes: number | null;
  sha256: string | null;
  schemaVersion: string | null;
  /** Scrubbed when written. */
  error: string | null;
  expiresAt: Date | null;
}

export interface TenantExportRepository {
  /**
   * A new `queued` row, unless this tenant has one queued or running: then that one, untouched.
   * Atomic against a concurrent request (the partial unique index of 0022).
   */
  request(row: {
    id: string;
    requestedBy: string;
    requestedAt: Date;
  }): Promise<{ record: TenantExportRecord; created: boolean }>;
  get(id: string): Promise<TenantExportRecord | null>;
  /** Newest first. */
  list(limit: number): Promise<TenantExportRecord[]>;
}

declare module '../ports.js' {
  interface TransactionContext {
    exports: TenantExportRepository;
  }
}

/** Where the job writes the archive: outside `tenants/<id>/`, which export and orphan sweep read. */
export const exportArchiveKey = (tenantId: string, exportId: string): string =>
  `exports/${tenantId}/${exportId}.tar`;

/** How long a download link works; the admin page makes a fresh one on every load. */
export const EXPORT_LINK_TTL_MS = 5 * 60 * 1000;

/** How long a ready archive stays by default (EXPORT_RETENTION_DAYS). */
export const DEFAULT_EXPORT_RETENTION_DAYS = 7;

/** At most this many earlier exports on the page and in `tenant.export.list`. */
const LIST_LIMIT = 50;

const payload = (tenantId: string, exportId: string, exp: number) =>
  `export:${tenantId}:${exportId}:${exp}`;

/** `exp` (unix seconds) and `sig` for a download link of one archive of one tenant. */
export async function signExportDownload(
  signer: Signer,
  tenantId: string,
  exportId: string,
  expiresAt: Date
): Promise<{ exp: number; sig: string }> {
  const exp = Math.floor(expiresAt.getTime() / 1000);
  return { exp, sig: await signer.sign(payload(tenantId, exportId, exp)) };
}

async function validSignature(
  signer: Signer,
  tenantId: string,
  exportId: string,
  exp: string | null,
  sig: string | null,
  now: Date
): Promise<boolean> {
  if (!exp || !sig || !/^\d{1,12}$/.test(exp)) return false;
  if (Number(exp) * 1000 <= now.getTime()) return false;
  return (await signer.verify(sig)) === payload(tenantId, exportId, Number(exp));
}

export const ExportView = z.object({
  id: z.string().guid(),
  status: ExportStatus,
  requestedBy: z.string(),
  requestedAt: z.string().datetime(),
  startedAt: z.string().datetime().nullable(),
  finishedAt: z.string().datetime().nullable(),
  sizeBytes: z.number().int().nonnegative().nullable(),
  sha256: z.string().nullable(),
  schemaVersion: z.string().nullable(),
  error: z.string().nullable(),
  expiresAt: z.string().datetime().nullable(),
});
export type ExportView = z.infer<typeof ExportView>;

const iso = (d: Date | null) => d?.toISOString() ?? null;

/** A ready archive whose time is up reads as expired before the daily job has caught up. */
function effectiveStatus(r: TenantExportRecord, now: Date): ExportStatus {
  return r.status === 'ready' && r.expiresAt && r.expiresAt <= now ? 'expired' : r.status;
}

export const toExportView = (r: TenantExportRecord, now: Date): ExportView => ({
  id: r.id,
  status: effectiveStatus(r, now),
  requestedBy: r.requestedBy,
  requestedAt: r.requestedAt.toISOString(),
  startedAt: iso(r.startedAt),
  finishedAt: iso(r.finishedAt),
  sizeBytes: r.sizeBytes,
  sha256: r.sha256,
  schemaVersion: r.schemaVersion,
  error: r.error,
  expiresAt: iso(r.expiresAt),
});

export const requestExport = defineUseCase({
  name: 'tenant.export',
  kind: 'command',
  description:
    'Ask for a complete archive of this site (content, media, supporters, members, audit log) in the format `mycel import` reads; it is built in the background and can be downloaded from the admin for a limited time. Works while the site is suspended. A request while one is being built returns that one.',
  // More than supporters: members, key hashes, the audit log (registry-rules.ts allows an effect
  // to require `tenant:admin`, which holds `supporters:export` and every other capability).
  requires: 'tenant:admin',
  effect: 'export',
  // ADR 015 rule 7: leaving is never gated by a limit.
  consumes: null,
  authenticatedOnly: true,
  input: z.object({}).strict(),
  output: z.object({ id: z.string().guid(), status: ExportStatus, created: z.boolean() }),
  examples: [{ input: {} }],
  async handler(ctx) {
    const now = ctx.clock.now();
    const { record, created } = await ctx.exports.request({
      id: ctx.ids.next(),
      requestedBy: actorRef(ctx.principal.actor),
      requestedAt: now,
    });
    if (created)
      await ctx.jobs.enqueue({
        type: 'tenant.export',
        key: jobKey('tenant.export', record.id),
        runAt: now,
        payload: { exportId: record.id },
      });
    return { id: record.id, status: record.status, created };
  },
});

export const listExports = defineUseCase({
  name: 'tenant.export.list',
  kind: 'query',
  description:
    'List the archives of this site that were asked for, newest first: status, who asked and when, size, checksum and until when it can be downloaded.',
  requires: 'tenant:admin',
  authenticatedOnly: true,
  input: z.object({}).strict(),
  output: z.object({ exports: z.array(ExportView) }),
  examples: [{ input: {} }],
  async handler(ctx) {
    const now = ctx.clock.now();
    return { exports: (await ctx.exports.list(LIST_LIMIT)).map((r) => toExportView(r, now)) };
  },
});

/** What the download route streams: the blob key, and the record for its headers. */
export interface ExportDownload {
  key: string;
  record: TenantExportRecord;
}

/**
 * The download check, inside the operator's unit of work for this tenant (the membership was read
 * for this request, so a removed member gets nothing). Null for every refusal alike: no
 * `tenant:admin`, an unknown id, another tenant's id, a bad or old signature, an archive that is
 * not ready or has expired. A granted download writes its audit row in this transaction.
 */
export async function openExportDownload(
  ctx: TransactionContext,
  { id, exp, sig }: { id: string; exp: string | null; sig: string | null },
  requestId: string | null = null
): Promise<ExportDownload | null> {
  if (!can(ctx.principal, 'tenant:admin')) return null;
  if (!z.string().guid().safeParse(id).success) return null;
  const now = ctx.clock.now();
  const tenantId = ctx.principal.tenantId;
  if (!(await validSignature(ctx.signer, tenantId, id, exp, sig, now))) return null;
  const record = await ctx.exports.get(id);
  if (!record || effectiveStatus(record, now) !== 'ready') return null;
  const actor = auditActor(ctx.principal.actor);
  await ctx.audit.record({
    id: ctx.ids.next(),
    tenantId,
    occurredAt: now,
    actorKind: actor.kind,
    actorId: actor.id,
    operation: 'tenant.export.download',
    effect: 'export',
    inputHash: await hashInput(ctx.inputHasher, { id }),
    result: 'ok',
    requestId,
    subjectId: id,
  });
  return { key: exportArchiveKey(tenantId, id), record };
}

/** `<slug>-<yyyy-mm-dd>.tar`, from when the archive was finished. */
export const exportFilename = (slug: string, record: TenantExportRecord): string =>
  `${slug}-${(record.finishedAt ?? record.requestedAt).toISOString().slice(0, 10)}.tar`;
