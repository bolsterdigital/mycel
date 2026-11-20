// What the launch checklist reads and writes (ADR 037). The resolved list is computed on every
// read from the register, the stored state and the site's facts; nothing in it is stored except
// what `LaunchStepPatch` changes. A check's outcome is a code plus parameters, translated by the
// front (ADR 007), so the admin, the API and MCP give the same answer.

import { z } from 'zod';
import { LaunchCheck, LaunchGroup, LaunchOwner, LaunchPhase, LaunchStepId } from './steps.js';

const Timestamp = z.string().datetime({ offset: true });

/** A note on a step: enough for a ticket number and a sentence, not a document. */
export const LAUNCH_NOTE_MAX = 1000;

/** The outcome of a check, before a person's acknowledgement is taken into account. */
export const CheckResult = z.enum(['pass', 'warn', 'fail']);
export type CheckResult = z.infer<typeof CheckResult>;

export const CheckDetail = z.object({
  /** Catalog key under `admin.launch.check.`, e.g. `home-published.missing`. */
  code: z.string(),
  params: z.record(z.string(), z.string()).optional(),
  /** What the finding is about, when it is a list (the forms without a notification). */
  subjects: z.array(z.object({ id: z.string(), label: z.string().nullable() })).optional(),
});
export type CheckDetail = z.infer<typeof CheckDetail>;

export interface CheckOutcome {
  result: CheckResult;
  detail: CheckDetail;
}

/**
 * Where a step stands: ticked by hand (`done`) or not (`open`), a check's outcome, or not
 * applicable (`na`). A `warn` someone acknowledged stays `warn` with `acknowledged: true`.
 */
export const LaunchStepStatus = z.enum(['done', 'open', 'pass', 'warn', 'fail', 'na']);
export type LaunchStepStatus = z.infer<typeof LaunchStepStatus>;

/** Why a step applies or not: the register, the site's entitlements, or a person. */
export const ApplicableSource = z.enum(['default', 'entitlement', 'override']);
export type ApplicableSource = z.infer<typeof ApplicableSource>;

export const LaunchStepView = z.object({
  id: LaunchStepId,
  phase: LaunchPhase,
  kind: z.enum(['manual', 'check']),
  check: LaunchCheck.nullable(),
  group: LaunchGroup.nullable(),
  owner: LaunchOwner,
  ownerOverridden: z.boolean(),
  applicable: z.boolean(),
  applicableSource: ApplicableSource,
  status: LaunchStepStatus,
  /** Counts as finished: ticked, passed, or a warning acknowledged (ADR 037 rule 5). */
  complete: z.boolean(),
  done: z.boolean(),
  acknowledged: z.boolean(),
  detail: CheckDetail.nullable(),
  note: z.string(),
  updatedAt: Timestamp.nullable(),
});
export type LaunchStepView = z.infer<typeof LaunchStepView>;

export const LaunchPhaseView = z.object({
  phase: LaunchPhase,
  /** Applicable steps in this phase and how many of them are complete. */
  total: z.number().int().nonnegative(),
  complete: z.number().int().nonnegative(),
  steps: z.array(LaunchStepView),
});
export type LaunchPhaseView = z.infer<typeof LaunchPhaseView>;

export const LaunchChecklist = z.object({
  phases: z.array(LaunchPhaseView),
  /** Every applicable step in `prepare` and `launch` is complete (ADR 037 rule 5). */
  ready: z.boolean(),
  /** The applicable, incomplete steps of `prepare` and `launch`, in register order. */
  blocking: z.array(LaunchStepId),
  checkedAt: Timestamp,
});
export type LaunchChecklist = z.infer<typeof LaunchChecklist>;

/**
 * A change to one step; absent fields stay as they are. `null` on `owner` or `applicable`
 * returns that field to the register's default.
 */
export const LaunchStepPatch = z
  .object({
    stepId: LaunchStepId,
    done: z.boolean().optional(),
    acknowledged: z.boolean().optional(),
    note: z.string().trim().max(LAUNCH_NOTE_MAX).optional(),
    owner: LaunchOwner.nullable().optional(),
    applicable: z.boolean().nullable().optional(),
  })
  .strict();
export type LaunchStepPatch = z.infer<typeof LaunchStepPatch>;
