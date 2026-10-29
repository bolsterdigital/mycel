// The job side of self-service export over a Map of rows (TODO #74): what
// packages/db/src/exports.ts does in Postgres (claim, the steps of a run, the daily expiry and
// purge), as the same core decisions, so a property can run one sequence through both and
// compare the rows. No archive is built: a `ready` step takes its digest as given, and the files
// are a set of keys. Rejected: building archives here (the round trip is proven in
// tenant-exports.test.ts; this is about the machine).

import {
  EXPORT_KEEP_ROWS_DAYS,
  PURGED_EXPORT_STATUSES,
  claimExport,
  exportArchiveKey,
  isActiveExport,
  stepExport,
  type ExportClaim,
  type ExportStep,
  type TenantExportRecord,
} from '../../tenants/exports.js';
import type { ExportLifecycle } from '../export-lifecycle.js';
import { memoryExports } from './tenants.js';

const DAY_MS = 24 * 60 * 60 * 1000;

class MemoryExportJobs {
  /** The archive files that exist, by `exportArchiveKey`. */
  readonly files = new Set<string>();
  private readonly purged = new Set<string>();

  constructor(
    readonly tenantId: string,
    readonly rows: Map<string, TenantExportRecord>,
    private readonly leaseMs: number
  ) {}

  claim(id: string, now: Date): ExportClaim {
    const claim = claimExport(this.rows.get(id) ?? null, now, this.leaseMs);
    if (claim.kind === 'start') this.rows.set(id, claim.record);
    return claim;
  }

  /** A step of a run; `ready` stores the file first and drops it when the step did not apply. */
  step(id: string, step: ExportStep, now: Date): TenantExportRecord | null {
    const row = this.rows.get(id);
    const next = row ? stepExport(row, step, now) : null;
    if (next) this.rows.set(id, next);
    if (step.kind === 'ready') {
      if (next) this.files.add(this.key(id));
      else this.files.delete(this.key(id));
    }
    return next;
  }

  /** The daily `tenant.export.expire` of this tenant; the number of files deleted. */
  expire(now: Date): number {
    for (const row of [...this.rows.values()].filter((r) => r.status === 'ready')) {
      const hasFile = this.files.has(this.key(row.id));
      const next = stepExport(row, { kind: 'expire', hasFile }, now);
      if (!next) continue;
      this.rows.set(row.id, next);
      if (!hasFile) this.purged.add(row.id);
    }
    const purge = [...this.rows.values()].filter(
      (r) =>
        (PURGED_EXPORT_STATUSES as readonly string[]).includes(r.status) && !this.purged.has(r.id)
    );
    for (const r of purge) {
      this.files.delete(this.key(r.id));
      this.purged.add(r.id);
    }
    const cutoff = now.getTime() - EXPORT_KEEP_ROWS_DAYS * DAY_MS;
    for (const r of [...this.rows.values()])
      if (r.requestedAt.getTime() < cutoff && !isActiveExport(r.status)) {
        this.rows.delete(r.id);
        this.purged.delete(r.id);
      }
    return purge.length;
  }

  private key(id: string): string {
    return exportArchiveKey(this.tenantId, id);
  }
}

/** `ExportLifecycle` over memory: `ctx.exports.request` and the job side on one Map. */
export function memoryExportLifecycle(tenantId: string, leaseMs: number): ExportLifecycle {
  const rows = new Map<string, TenantExportRecord>();
  const jobs = new MemoryExportJobs(tenantId, rows, leaseMs);
  const requests = memoryExports(rows);
  return {
    request: (id, now) => requests.request({ id, requestedBy: 'property', requestedAt: now }),
    claim: async (id, now) => jobs.claim(id, now),
    step: async (id, step, now) => jobs.step(id, step, now),
    expire: async (now) => jobs.expire(now),
    rows: async () =>
      [...rows.values()].sort((a, b) => a.id.localeCompare(b.id)).map((r) => structuredClone(r)),
    files: async () => [...jobs.files].sort(),
  };
}
