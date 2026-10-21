import type { FormDefinition, Submission } from './model.js';

export interface FormRepository {
  findById(id: string): Promise<FormDefinition | null>;
  insert(form: FormDefinition): Promise<void>;
}

export interface SubmissionRepository {
  insert(submission: Submission): Promise<void>;
  findById(id: string): Promise<Submission | null>;
  /**
   * Record the double opt-in confirmation once: true when this call set `confirmedAt`, false
   * when it was already set (the second click) or the submission does not exist. The single
   * conditional update is what makes `mailing.confirm` idempotent (ADR 010 rule 5).
   */
  confirm(id: string, at: Date): Promise<boolean>;
}

/**
 * Fixed-window counter. `hit` counts this attempt and says whether it is within the limit. It
 * runs in the use case's transaction, so a rejected attempt must still commit: use cases return
 * a `rejected` result instead of throwing.
 */
export interface RateLimiter {
  hit(key: string, limit: { max: number; windowSeconds: number }): Promise<boolean>;
}

declare module '../ports.js' {
  interface TransactionContext {
    forms: FormRepository;
    submissions: SubmissionRepository;
    rateLimits: RateLimiter;
  }
}
