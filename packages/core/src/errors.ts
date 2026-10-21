// One error type for every use case, so each front maps it once: HTTP to a status code and
// Problem Details (RFC 9457), MCP to a tool error, the web app to a page or a form failure.
// Rejected alternative: per-module error classes, which every front would have to enumerate.

export type UseCaseErrorCode = 'not_found' | 'forbidden' | 'invalid_input' | 'conflict';

export interface Issue {
  /** Dotted path into the input, e.g. `values.email`. Empty for input-wide problems. */
  path: string;
  /** An i18n message key (ADR 007) or Zod's English default for schema-level problems. */
  message: string;
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
