// An event page's when and where in one locale (brief events-profile), as every public representation carries it:
// the item's own read (`public.ts`) and the cards of an agenda (`overview.ts`). In a module of its
// own so both can import it without importing each other.

import { z } from 'zod';
import { LocalDateTime, type ContentDocument } from '../model.js';

export const PublishedEvent = z.object({
  startsAt: LocalDateTime,
  endsAt: LocalDateTime.nullable(),
  location: z.string().nullable(),
  onlineUrl: z.string().url().nullable(),
  timeZone: z.string(),
});
export type PublishedEvent = z.infer<typeof PublishedEvent>;

/** The event of a document in one locale; null unless it is an event page with a start. */
export function projectEvent(
  doc: ContentDocument,
  locale: string,
  timeZone: string
): PublishedEvent | null {
  if (doc.type !== 'page' || doc.profile !== 'event' || !doc.event?.startsAt) return null;
  const { startsAt, endsAt, location, onlineUrl } = doc.event;
  return {
    startsAt,
    endsAt: endsAt ?? null,
    location: location?.[locale] ?? null,
    onlineUrl: onlineUrl ?? null,
    timeZone,
  };
}
