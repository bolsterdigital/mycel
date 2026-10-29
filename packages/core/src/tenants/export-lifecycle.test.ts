// Property test for the export state machine (TODO #74; testing.md: state machines get property
// tests). Random sequences of requests, job runs, their steps, the daily expiry and time over
// MemoryExportJobs, checked after every op against `exportViolations`; the same sequences run
// through Postgres in packages/db/src/tenant-exports.test.ts. Next to it the fixed points the
// property cannot see: a busy run looks again after one lease, a failed export is never started
// again, and an erasure only expires what may become expired.

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { ERASURE_EXPIRES_EXPORTS } from '../supporters/erasure.js';
import { TENANT, applyExportOp, drawExportOp, exportViolations } from '../testing/index.js';
import { memoryExportLifecycle } from '../testing/memory.js';
import {
  EXPORT_TRANSITIONS,
  ExportStatus,
  canMoveExport,
  claimExport,
  type TenantExportRecord,
} from './exports.js';

const LEASE_MS = 5 * 60 * 1000;

const record = (fields: Partial<TenantExportRecord>): TenantExportRecord => ({
  id: '00000000-0000-4000-8000-000000000001',
  requestedBy: 'property',
  requestedAt: new Date(0),
  status: 'queued',
  startedAt: null,
  heartbeatAt: null,
  finishedAt: null,
  sizeBytes: null,
  sha256: null,
  schemaVersion: null,
  error: null,
  expiresAt: null,
  ...fields,
});

describe('export lifecycle', () => {
  it('keeps every sequence inside the transitions, with one active export at most', async () => {
    await fc.assert(
      fc.asyncProperty(fc.gen(), async (g) => {
        const pick = <T>(xs: readonly T[]): T => g(fc.constantFrom, ...xs);
        const exports = memoryExportLifecycle(TENANT, LEASE_MS);
        const ids: string[] = [];
        let now = Date.UTC(2026, 9, 1);
        for (let i = 0; i < 30; i++) {
          const op = drawExportOp(
            pick,
            ids,
            `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
            LEASE_MS
          );
          if (op.kind === 'advance') {
            now += op.ms;
            continue;
          }
          const before = await exports.rows();
          const out = await applyExportOp(exports, op, new Date(now));
          if (op.kind === 'request' && (out as { created: boolean }).created) ids.push(op.id);
          expect(exportViolations(before, await exports.rows()), JSON.stringify(op)).toEqual([]);
        }
      }),
      { numRuns: 200 }
    );
  });

  it('lets a busy run look again after one lease, and takes over a run whose heartbeat stopped', () => {
    const now = new Date(Date.UTC(2026, 9, 1));
    const alive = record({ status: 'running', startedAt: now, heartbeatAt: new Date(+now - 1000) });
    expect(claimExport(alive, now, LEASE_MS)).toEqual({
      kind: 'busy',
      next: new Date(+now + LEASE_MS),
    });
    const dead = { ...alive, heartbeatAt: new Date(+now - LEASE_MS) };
    expect(claimExport(dead, now, LEASE_MS)).toMatchObject({
      kind: 'start',
      record: { status: 'running', heartbeatAt: now },
    });
  });

  it('never starts a failed, ready or expired export again', () => {
    for (const status of ['failed', 'ready', 'expired'] as const)
      expect(claimExport(record({ status }), new Date(), LEASE_MS)).toEqual({ kind: 'gone' });
    expect(claimExport(null, new Date(), LEASE_MS)).toEqual({ kind: 'gone' });
  });

  it('has a transition list for every status, and an erasure expires only what may expire', () => {
    expect(Object.keys(EXPORT_TRANSITIONS).sort()).toEqual([...ExportStatus.options].sort());
    for (const status of ERASURE_EXPIRES_EXPORTS)
      expect(canMoveExport(status, 'expired')).toBe(true);
  });
});
