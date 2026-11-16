// Wall-clock times of a time zone and the instants they mean, without a library: the admin's
// `datetime-local` fields (`content-admin-publication.ts` re-exports these) and the public
// structured data of an event, which runs in the browser bundle too and so cannot import from
// `lib/server`. Rejected: a date library, a dependency for two functions over `Intl`.

/** Wall-clock parts of `instant` in `zone`, as `YYYY-MM-DDTHH:mm`. */
export function localInput(instant: Date, zone: string): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(instant)
      .map((p) => [p.type, p.value])
  );
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

/**
 * The instant a `datetime-local` value means in `zone`, or `null` for anything else. A time
 * that does not exist (the hour skipped in spring) moves forward by the gap; an hour that occurs
 * twice in autumn takes the first.
 */
export function fromLocalInput(value: string, zone: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!m) return null;
  const [, y, mo, d, h, mi] = m.map(Number) as [number, number, number, number, number, number];
  const wall = Date.UTC(y, mo - 1, d, h, mi);
  if (Number.isNaN(wall) || new Date(wall).getUTCDate() !== d) return null;
  // The zone's offset half a day before and after: a change of offset lies between, never two.
  const offset = (at: number) => Date.parse(`${localInput(new Date(at), zone)}:00Z`) - at;
  const before = wall - offset(wall - 43_200_000);
  const after = wall - offset(wall + 43_200_000);
  const valid = [before, after].filter((t) => localInput(new Date(t), zone) === value);
  return new Date(valid.length ? Math.min(...valid) : before);
}
