// The time zones a picker offers (TODO #88): every zone the runtime knows, Europe first, each
// named by its IANA name and, where `Intl` has one in the admin's language, its generic name
// ("Europe/Amsterdam · Midden-Europese tijd"). `Intl.DisplayNames` has no time zone type, so the
// generic name comes from `Intl.DateTimeFormat`; without one the IANA name stands alone.
// Rejected: a short hand-picked list, which leaves out the zone of the next site abroad.

import { timeZones } from '@mycel/core';

const cache = new Map<string, { value: string; label: string }[]>();

/** The generic name of `zone` in `locale`, or null when `Intl` only has an offset for it. */
function genericName(zone: string, locale: string): string | null {
  const part = new Intl.DateTimeFormat(locale, { timeZone: zone, timeZoneName: 'longGeneric' })
    .formatToParts(new Date(0))
    .find((p) => p.type === 'timeZoneName')?.value;
  return part && !/^(GMT|UTC)([+-−]|$)/.test(part) ? part : null;
}

export function timeZoneOptions(locale: string): { value: string; label: string }[] {
  let options = cache.get(locale);
  if (!options) {
    options = timeZones().map((zone) => {
      const name = genericName(zone, locale);
      return { value: zone, label: name ? `${zone} · ${name}` : zone };
    });
    cache.set(locale, options);
  }
  return options;
}
