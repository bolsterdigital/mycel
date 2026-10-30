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

/** Every canonical zone, Europe first, then the rest alphabetically: the order a picker shows. */
export function timeZones(): string[] {
  const all = [...known].sort();
  return [
    ...all.filter((z) => z.startsWith('Europe/')),
    ...all.filter((z) => !z.startsWith('Europe/')),
  ];
}
