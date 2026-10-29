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
   * conditional update is what makes `mailing.opt_in.confirm` idempotent (ADR 010 rule 5).
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
  /**
   * Sliding window of one: true when no earlier successful `cooldown` on `key` happened in the
   * last `seconds`, and records this one; false records nothing, so a refused attempt never
   * extends the wait (a bot could otherwise keep a real address closed forever). At most one
   * day: the hourly sweep deletes older windows (brief form-intake § 1); every adapter refuses
   * a longer one with `checkCooldown`.
   */
  cooldown(key: string, seconds: number): Promise<boolean>;
}

/** The longest cooldown a `RateLimiter` remembers: the hourly sweep keeps a day of windows. */
export const MAX_COOLDOWN_SECONDS = 24 * 60 * 60;

/** Throws when `seconds` is outside (0, one day], so memory and Postgres refuse alike. */
export function checkCooldown(seconds: number): void {
  if (!(seconds > 0 && seconds <= MAX_COOLDOWN_SECONDS))
    throw new Error(`cooldown: ${seconds}s is outside (0, one day]`);
}

declare module '../ports.js' {
  interface TransactionContext {
    forms: FormRepository;
    submissions: SubmissionRepository;
    rateLimits: RateLimiter;
  }
}
