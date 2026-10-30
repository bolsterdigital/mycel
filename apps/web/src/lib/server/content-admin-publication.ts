// The publication panel of the content admin (TODO #11, brief content-editor § A2): per locale
// what is live, what is pinned for later and what stops a publish, as plain values for the edit
// page. Publishing itself is core's (`content.item.publish` and friends, `content:publish`);
// this module only turns its state into words and a form's local time into an instant.
//
// Times are entered and shown in the admin's time zone: the operator's own, else the site's
// (`adminTimeZone`, lib/server/admin/admin.ts, #88). Every function here takes it as an argument,
// so no page can fall back to a zone of its own. Rejected: the browser's offset (needs
// JavaScript, and two editors in different zones would read one plan differently) and UTC in the
// form (an editor plans 09:00 local, not 07:00 or 08:00 depending on the season).

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
 * `2026-10-24 09:00`, how the panel names a planned time; with the zone in brackets when it is
 * named (`2026-10-24 09:00 (America/New_York)`): the page names it only where the operator's own
 * zone differs from the site's.
 */
export const localLabel = (instant: Date, zone: string, named = false): string =>
  `${localInput(instant, zone).replace('T', ' ')}${named ? ` (${zone})` : ''}`;

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

/**
 * The id of the edit page's field a readiness or reference issue is about, so the panel can link
 * to it; `null` for a path the page has no field for (a block, until brief § B).
 */
export function fieldOf(path: string, locale: string): string | null {
  const [head, ...rest] = path.split('.');
  if (head === 'locales') return `publication-${locale}`;
  if (head === 'title') return `title.${rest[0] ?? locale}`;
  if (head === 'lead') return `lead.${rest[0] ?? locale}`;
  if (head === 'seo' && rest[0] === 'title') return `seoTitle.${rest[1] ?? locale}`;
  if (head === 'seo' && rest[0] === 'description') return `seoDescription.${rest[1] ?? locale}`;
  if (head === 'seo' && rest[0] === 'imageId') return 'shareImageId';
  if (head === 'featuredImageId') return 'featuredImageId';
  if (head === 'authorIds') return 'authors';
  if (head === 'sectionId') return 'sectionId';
  if (head === 'access') return 'level';
  if (head === 'at') return `at.${locale}`;
  return null;
}

/**
 * The path of an issue as the editor reads it: a missing translation names its locale
 * (`title.en`), since core reports the field and the refusal is already per locale.
 */
export const issuePath = (path: string, message: string, locale: string): string =>
  message === 'content.publish.missing-translation' ? `${path}.${locale}` : path;
