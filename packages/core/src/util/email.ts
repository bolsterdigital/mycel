// One normalisation for every e-mail address the system compares: supporters (ADR 003) and
// operators (TODO #7) both key on it. Trim plus lowercase, nothing cleverer: provider-specific
// rules (dots, plus tags) would merge addresses their owners consider distinct.

export function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}
