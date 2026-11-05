// A timestamp as Postgres hands it to a query (a Date or, through a raw query, a string) as the
// ISO text the core models carry. Two adapters each kept a copy, one nullable and one not.
// Rejected: a helper in core, which has no reason to know what a driver returns.

export function toIso(value: Date | string): string;
export function toIso(value: Date | string | null): string | null;
export function toIso(value: Date | string | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}
