// One random sequence of export operations for two property tests (TODO #74; testing.md: state
// machines get property tests): core's own (tenants/export-lifecycle.test.ts, over
// MemoryExportJobs) and Postgres's (packages/db/src/tenant-exports.test.ts, the same sequence
// through the db plumbing and MemoryExportJobs side by side). The draw takes a `pick`, so this
// file needs no fast-check: the tests pass `g(fc.constantFrom, ...xs)`.
// Rejected: a generator per test (the two would drift, and the Postgres test would prove a
// sequence core never saw).

import {
  canMoveExport,
  isActiveExport,
  type ExportClaim,
  type ExportStep,
  type TenantExportRecord,
} from '../tenants/exports.js';

export type ExportOp =
  | { kind: 'request'; id: string }
  | { kind: 'claim'; id: string }
  | { kind: 'step'; id: string; step: ExportStep }
  | { kind: 'expire' }
  | { kind: 'advance'; ms: number };

/** What one adapter does with an op; `rows` sorted by id, `files` sorted. */
export interface ExportLifecycle {
  request(id: string, now: Date): Promise<{ record: TenantExportRecord; created: boolean }>;
  claim(id: string, now: Date): Promise<ExportClaim>;
  step(id: string, step: ExportStep, now: Date): Promise<TenantExportRecord | null>;
  expire(now: Date): Promise<number>;
  rows(): Promise<TenantExportRecord[]>;
  files(): Promise<string[]>;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** The next op: `ids` are the exports asked for so far, `fresh` the id a new request would get. */
export function drawExportOp(
  pick: <T>(xs: readonly T[]) => T,
  ids: readonly string[],
  fresh: string,
  leaseMs: number
): ExportOp {
  const kind = ids.length
    ? pick(['request', 'claim', 'step', 'expire', 'advance'] as const)
    : 'request';
  const id = ids.length ? pick(ids) : fresh;
  if (kind === 'request') return { kind, id: fresh };
  if (kind === 'claim') return { kind, id };
  if (kind === 'expire') return { kind };
  if (kind === 'advance')
    return { kind, ms: pick([1000, leaseMs / 2, leaseMs + 1000, 8 * DAY_MS, 400 * DAY_MS]) };
  const step = pick<ExportStep>([
    { kind: 'heartbeat' },
    {
      kind: 'ready',
      sizeBytes: pick([0, 4096]),
      sha256: pick(['0', 'f']).repeat(64),
      schemaVersion: '0029',
      retentionDays: pick([1, 7]),
    },
    { kind: 'fail', error: 'the archive could not be written' },
  ]);
  return { kind: 'step', id, step };
}

/** Run `op` at `now`; what it returned, for a comparison between adapters. */
export async function applyExportOp(
  adapter: ExportLifecycle,
  op: Exclude<ExportOp, { kind: 'advance' }>,
  now: Date
): Promise<unknown> {
  switch (op.kind) {
    case 'request':
      return adapter.request(op.id, now);
    case 'claim':
      return adapter.claim(op.id, now);
    case 'step':
      return adapter.step(op.id, op.step, now);
    case 'expire':
      return adapter.expire(now);
  }
}

/** What no sequence may break, between the rows before and after one op. */
export function exportViolations(
  before: readonly TenantExportRecord[],
  after: readonly TenantExportRecord[]
): string[] {
  const out: string[] = [];
  const was = new Map(before.map((r) => [r.id, r.status]));
  for (const r of after) {
    const from = was.get(r.id);
    if (from && from !== r.status && !canMoveExport(from, r.status))
      out.push(`${r.id}: ${from} → ${r.status}`);
    if (!from && r.status !== 'queued') out.push(`${r.id}: born ${r.status}`);
    if (r.status === 'running' && (!r.startedAt || !r.heartbeatAt))
      out.push(`${r.id}: running without a start or heartbeat`);
    if (
      r.status === 'ready' &&
      (r.sizeBytes === null ||
        !r.sha256 ||
        !r.schemaVersion ||
        !r.finishedAt ||
        !r.expiresAt ||
        r.expiresAt <= r.finishedAt)
    )
      out.push(`${r.id}: ready without its digest or a future expiry`);
  }
  if (after.filter((r) => isActiveExport(r.status)).length > 1) out.push('two active exports');
  return out;
}
