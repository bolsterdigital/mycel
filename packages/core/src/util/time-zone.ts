// One rule for a time zone a person or a site chooses (#88): an IANA name the runtime knows,
// so every place that formats a time with it (`Intl.DateTimeFormat`) accepts it. Rejected: a
// fixed offset (`+01:00`), which is wrong for half the year wherever summer time applies, and a
// hand-kept list, which drifts from what the runtime can format.

import { z } from 'zod';

/** Where every site Mycel serves today lives; the default until a site chooses its own. */
export const DEFAULT_TIME_ZONE = 'Europe/Amsterdam';

const known = new Set<string>(Intl.supportedValuesOf('timeZone'));

/**
 * True for a named zone `Intl.DateTimeFormat` accepts: the canonical list plus aliases such as
 * `UTC` or `Europe/Kiev`. Offsets (`+01:00`), which newer runtimes accept too, are refused.
 */
export function isTimeZone(value: string): boolean {
  if (known.has(value)) return true;
  if (!/^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+)*$/.test(value)) return false;
  try {
    new Intl.DateTimeFormat('en', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

export const IanaTimeZone = z.string().min(1).max(64).refine(isTimeZone, 'time-zone.unknown');

/**
 * The wall clock of `zone` at `instant`, as `YYYY-MM-DDTHH:mm`: what a `datetime-local` field
 * shows and what an event's times are stored as (`LocalDateTime`), so "is it over" is a text
 * comparison on the site's own clock. Rejected: converting each event to an instant, which a
 * listing would have to do per row in SQL and in memory alike.
 */
export function wallClock(instant: Date, zone: string): string {
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

/** The calendar date (`YYYY-MM-DD`) of `zone` at `instant`. */
export const localDate = (instant: Date, zone: string): string =>
  wallClock(instant, zone).slice(0, 10);

/**
 * The instant the local `date` (`YYYY-MM-DD`) starts in `zone`. The offset is read twice, so a
 * day whose midnight sits next to a summer-time change still starts at its own midnight.
 */
export function startOfLocalDay(date: string, zone: string): Date {
  const guess = Date.parse(`${date}T00:00:00Z`);
  let at = guess;
  for (let i = 0; i < 2; i++) at = guess - (Date.parse(`${wallClock(new Date(at), zone)}Z`) - at);
  return new Date(at);
}

/** Every canonical zone, Europe first, then the rest alphabetically: the order a picker shows. */
export function timeZones(): string[] {
  const all = [...known].sort();
  return [
    ...all.filter((z) => z.startsWith('Europe/')),
    ...all.filter((z) => !z.startsWith('Europe/')),
  ];
}
