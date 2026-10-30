// Formatting the admin's screens share: sizes and moments, in the reader's locale. Rejected: a
// copy per page, which is how two pages start showing one file's size or one date differently.
import { ui } from '../../i18n/index.js';

/** A byte count in the largest unit that keeps it above one (the media overview and detail). */
export function formatBytes(n: number, locale: string): string {
  const [unit, d] =
    n >= 1024 ** 3
      ? (['gigabyte', 1024 ** 3] as const)
      : n >= 1024 ** 2
        ? (['megabyte', 1024 ** 2] as const)
        : (['kilobyte', 1024] as const);
  return new Intl.NumberFormat(locale, { style: 'unit', unit, maximumFractionDigits: 1 }).format(
    n / d
  );
}

/** A moment as the admin shows it in lists and cards (#87): `text` for the cell, `iso` for the
 * `<time datetime>`, `full` for its title. */
export type When = { text: string; iso: string; full: string };

const DAY_MS = 86_400_000;

/** The calendar day of `at` in `zone`, as a day number, so two moments compare by date there. */
function dayIn(at: Date, zone: string): number {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(at);
  const n = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return Date.UTC(n('year'), n('month') - 1, n('day')) / DAY_MS;
}

// The admin's one way to say when something happened (#87, editor trial 4b-2): a list asks "how
// old is this", not for a timestamp. Relative while that is shorter ("just now", "5 minutes ago",
// "today 14:05", "yesterday 09:12", a weekday within the week), then a short date, with the year
// only outside this one; the full date and time is the title. Words and order come from Intl in
// the admin's locale, the calendar day from the operator's zone, never the server's; `relative:
// false` is the operator's choice of absolute dates (#88). No zone in the text: it is the
// operator's own. Rejected: a date library (Intl has all of it) and relative time for every age
// ("43 days ago" makes the reader count back). "Just now" is catalogue copy: Intl says "now",
// which reads as a state, not a moment.
export function formatWhen(
  instant: string | Date,
  {
    locale,
    zone,
    now = new Date(),
    relative = true,
  }: { locale: string; zone: string; now?: Date; relative?: boolean }
): When {
  const at = typeof instant === 'string' ? new Date(instant) : instant;
  const format = (options: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat(locale, { timeZone: zone, ...options }).format(at);
  const iso = at.toISOString();
  const full = format({ dateStyle: 'full', timeStyle: 'short' });
  const date = (withYear: boolean) =>
    format({ day: 'numeric', month: 'short', ...(withYear ? { year: 'numeric' } : {}) });
  if (!relative) return { text: format({ dateStyle: 'medium', timeStyle: 'short' }), iso, full };

  const words = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  const time = format({ timeStyle: 'short' });
  const ago = now.getTime() - at.getTime();
  const days = dayIn(at, zone) - dayIn(now, zone);
  const year = (d: Date) =>
    new Intl.DateTimeFormat('en', { timeZone: zone, year: 'numeric' }).format(d);
  let text: string;
  if (ago >= 0 && ago < 60_000) text = ui(locale)('admin.when.justNow');
  else if (ago >= 0 && ago < 3_600_000) text = words.format(-Math.floor(ago / 60_000), 'minute');
  else if (days >= -1 && days <= 1) text = `${words.format(days, 'day')} ${time}`;
  else if (days < -1 && days > -7) text = `${format({ weekday: 'long' })} ${time}`;
  else text = date(year(at) !== year(now));
  return { text, iso, full };
}
