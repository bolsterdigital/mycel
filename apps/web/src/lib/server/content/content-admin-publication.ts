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

import { UseCaseError, altWarnings, readinessIssues, type ContentDocument } from '@mycel/core';
import { issueCopy } from './edit-copy.js';
import { fromLocalInput, localInput } from '../../public/wall-clock.js';
export { fromLocalInput, localInput } from '../../public/wall-clock.js';

/** The time of the schedule form, or a refusal core will word like its own. */
export function instant(at: string, zone: string): string {
  const parsed = fromLocalInput(at, zone);
  if (!parsed)
    throw new UseCaseError('invalid_input', 'no time given', [
      { path: 'at', message: 'admin.content.publication.time-invalid' },
    ]);
  return parsed.toISOString();
}

/**
 * `2026-10-24 09:00`, how the panel names a planned time; with the zone in brackets when it is
 * named (`2026-10-24 09:00 (America/New_York)`): the page names it only where the operator's own
 * zone differs from the site's.
 */
export const localLabel = (instant: Date, zone: string, named = false): string =>
  `${localInput(instant, zone).replace('T', ' ')}${named ? ` (${zone})` : ''}`;

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
  if (head === 'heroImageId') return 'heroImageId';
  if (head === 'heroAlt') return 'heroAlt';
  if (head === 'featuredImageId') return 'featuredImageId';
  if (head === 'featured' && rest[0] === 'title') return `featuredTitle.${rest[1] ?? locale}`;
  if (head === 'featured' && rest[0] === 'description')
    return `featuredDescription.${rest[1] ?? locale}`;
  if (head === 'delivery' && rest[1] === 'subject') return `emailSubject.${rest[2] ?? locale}`;
  if (head === 'authorIds') return 'authors';
  if (head === 'sectionId') return 'sectionId';
  if (head === 'dossiers') return 'dossiers';
  if (head === 'access') return 'level';
  if (head === 'at') return `at.${locale}`;
  if (head === 'event' && rest[0] === 'startsAt') return 'eventStartsAt';
  if (head === 'event' && rest[0] === 'endsAt') return 'eventEndsAt';
  if (head === 'event' && rest[0] === 'location') return `eventLocation.${rest[1] ?? locale}`;
  if (head === 'event' && rest[0] === 'onlineUrl') return 'eventOnlineUrl';
  return null;
}

/**
 * The path of an issue as the editor reads it: a missing translation names its locale
 * (`title.en`), since core reports the field and the refusal is already per locale.
 */
export const issuePath = (path: string, message: string, locale: string): string =>
  message === 'content.publish.missing-translation' ? `${path}.${locale}` : path;

/**
 * What stops a publish in `locale`, with a link to the field where the page has one, and what
 * does not stop it but is still missing: an image placed without a description (ADR 020 rule 3),
 * the same in every locale.
 */
export function readiness(doc: ContentDocument, locale: string) {
  const blockField = (path: string) => {
    const id = doc.blocks[Number(path.split('.')[1])]?.id;
    return id ? `block-${id}` : null;
  };
  return {
    issues: readinessIssues(doc, locale).map((i) => ({
      path: issuePath(i.path, i.message, locale),
      field: i.path.startsWith('blocks.') ? blockField(i.path) : fieldOf(i.path, locale),
      copy: issueCopy(i.message),
    })),
    warnings: altWarnings(doc).map((w) => ({
      path: w.path,
      field: `block-${w.blockId}`,
      copy: issueCopy(w.message),
    })),
  };
}
