// One normalisation for every e-mail address the system compares: supporters (ADR 003) and
// operators (TODO #7) both key on it. Trim plus lowercase, nothing cleverer: provider-specific
// rules (dots, plus tags) would merge addresses their owners consider distinct. Every key
// derived from an address goes through supporters/email-key.ts.

import { z } from 'zod';

export function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * `normalizeEmail` as an input schema. Written with zod's own trim and lowercase rather than a
 * transform, so the JSON Schema of a use case still says `format: email`; a test holds the two
 * equal.
 */
export const EmailAddress = z.string().trim().toLowerCase().email();
