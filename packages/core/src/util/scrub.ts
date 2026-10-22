// Redaction on values, not on paths (brief #17a decision 3): an address inside an error message
// is still an address (ADR 019 rule 8, erasure covers every copy, and a log line is a copy). Lives
// in core because core writes error text into the database (`mail_sends.last_error`) and may not
// import `@mycel/observability`, which reuses this function. Rejected: a path-based redactor
// (pino's `redact`), which never sees `Error: unknown supporter a@b.nl`.

/**
 * Generous on purpose, better too much than too little: any run of non-space, non-delimiter
 * characters on both sides of an `@` (or its URL encoding `%40`), with or without a dot, so
 * `admin@localhost` goes too. Catches plus-addresses, upper case, IDN and an address in a URL
 * query. The price is a package version (`pkg@1.2.3`) now and then; that is acceptable.
 */
const EMAIL = /[^\s<>()[\]{}"',;:/?&=@]+(?:@|%40)[^\s<>()[\]{}"',;:/?&=@]+/giu;
/**
 * An HTTP bearer credential, or one of our API keys on its own (`mycel_` plus 43 characters,
 * operators/model.ts); role names such as `mycel_worker` are too short to match.
 */
const SECRET = /\bBearer\s+[^\s"',;]+|\bmycel_[A-Za-z0-9_-]{32,}/g;

export function scrubText(value: string): string {
  return value.replace(SECRET, '[secret]').replace(EMAIL, '[email]');
}
