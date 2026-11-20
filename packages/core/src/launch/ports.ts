// The stored half of the launch checklist (0085, ADR 037 rule 2): per site and step, only what a
// person decided. No operator id: who changed it is in the audit row `Invoker.run` writes per
// command, which keeps this table out of operator erasure (ADR 035).

import type { LaunchOwner } from './steps.js';

export interface LaunchStepRecord {
  stepId: string;
  done: boolean;
  /** A warning from a check that someone consciously accepted. */
  acknowledged: boolean;
  /** null: follow the register and the entitlements. */
  applicable: boolean | null;
  /** null: the register's owner. */
  owner: LaunchOwner | null;
  note: string;
  updatedAt: Date;
}

export interface LaunchStepRepository {
  /** Every stored step of this site, including ids the register no longer has. */
  list(): Promise<LaunchStepRecord[]>;
  /** Insert or replace the state of one step. */
  put(record: LaunchStepRecord): Promise<void>;
}

declare module '../ports.js' {
  interface TransactionContext {
    launchSteps: LaunchStepRepository;
  }
}
