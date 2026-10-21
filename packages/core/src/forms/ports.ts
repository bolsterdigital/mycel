import type { FormDefinition, Submission } from './model.js';

export interface FormRepository {
  findById(id: string): Promise<FormDefinition | null>;
  insert(form: FormDefinition): Promise<void>;
}

export interface SubmissionRepository {
  insert(submission: Submission): Promise<void>;
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
