// One error type for every use case, so each front maps it once: HTTP to a status code and
// Problem Details (RFC 9457), MCP to a tool error, the web app to a page or a form failure.
// Rejected alternative: per-module error classes, which every front would have to enumerate.

export type UseCaseErrorCode =
  | 'not_found'
  | 'forbidden'
  | 'invalid_input'
  | 'conflict'
  // ADR 015 rule 3: an entitlement or limit refuses; rule 7: the tenant is suspended.
  | 'limit_exceeded'
  | 'suspended';

export interface Issue {
  /** Dotted path into the input, e.g. `values.email`. Empty for input-wide problems. */
  path: string;
  /** An i18n message key (ADR 007) or Zod's English default for schema-level problems. */
  message: string;
  /**
   * What the key is about, for a front that names it (`{ id }` of an unknown reference, the
   * `locale` still live). Kept out of the key so the key stays a catalog lookup;
   * rejected: `key:<id>` suffixes, which every front had to split off again.
   */
  params?: Record<string, string>;
}

export class UseCaseError extends Error {
  readonly code: UseCaseErrorCode;
  readonly issues: Issue[];

  constructor(code: UseCaseErrorCode, message: string, issues: Issue[] = []) {
    super(message);
    this.name = 'UseCaseError';
    this.code = code;
    this.issues = issues;
  }
}

/**
 * The one `not_found`: "no <what> with <by>", one wording for every module, so an operator
 * reading an API answer or a log sees the same sentence shape everywhere. Rejected: a wrapper per
 * module, which drifted into two styles ("X not found" and "no X with that id").
 */
export const notFound = (what: string, by = 'that id'): UseCaseError =>
  new UseCaseError('not_found', `no ${what} with ${by}`);
