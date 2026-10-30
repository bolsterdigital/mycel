// A stored timestamp as the ISO string every output schema carries. One helper, because three
// modules had their own `iso` and a dozen sites spelled `?.toISOString() ?? null` inline.
// Rejected: a Zod transform on the output schemas, which would let a `Date` leak through
// every handler until the parse at the end and hide where the conversion happens.

/** `date` as an ISO 8601 string; `null` stays `null`. */
export function iso(date: Date): string;
export function iso(date: Date | null | undefined): string | null;
export function iso(date: Date | null | undefined): string | null {
  return date?.toISOString() ?? null;
}
