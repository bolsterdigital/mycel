// JSON-LD is data, never executable markup. Escape HTML-significant bytes before placing the
// generated script in a head; rejected: raw JSON.stringify, which permits a closing script tag.
import type { PublishedItem, PublicPerson } from '@mycel/core';
import { fromLocalInput } from './wall-clock.js';
import { personPath } from './person-path.js';

export function jsonLd(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

export function personData(person: PublicPerson, canonical: string, image: string | null) {
  return {
    '@context': 'https://schema.org',
    '@type': 'Person',
    '@id': canonical,
    url: canonical,
    name: person.name,
    ...(person.bio ? { description: person.bio } : {}),
    ...(person.role ? { jobTitle: person.role } : {}),
    ...(person.organisation
      ? { worksFor: { '@type': 'Organization', name: person.organisation } }
      : {}),
    ...(person.publicEmail ? { email: person.publicEmail } : {}),
    ...(person.phone ? { telephone: person.phone } : {}),
    ...(image ? { image } : {}),
    ...(person.links.length ? { sameAs: person.links.map((link) => link.url) } : {}),
  };
}

/**
 * A wall-clock time of `zone` as ISO 8601 with the offset that zone has then
 * (`2026-12-05T20:00:00+01:00`), which search engines ask of an event's dates.
 */
export function zonedIso(local: string, zone: string): string {
  const instant = fromLocalInput(local, zone);
  if (!instant) return local;
  const minutes = Math.round((Date.parse(`${local}:00Z`) - instant.getTime()) / 60_000);
  const sign = minutes < 0 ? '-' : '+';
  const abs = Math.abs(minutes);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${local}:00${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/**
 * An event page as schema.org `Event`: only what the projection released in this locale.
 * Attendance follows from what it has: a place, an online address or both. Null for every other
 * item.
 */
export function eventData(item: PublishedItem, canonical: string, locale: string) {
  const event = item.event;
  if (!event) return null;
  const place = event.location ? { '@type': 'Place', name: event.location } : null;
  const online = event.onlineUrl ? { '@type': 'VirtualLocation', url: event.onlineUrl } : null;
  const mode =
    place && online
      ? 'MixedEventAttendanceMode'
      : online
        ? 'OnlineEventAttendanceMode'
        : 'OfflineEventAttendanceMode';
  const locations = [place, online].filter((l) => l !== null);
  return {
    '@context': 'https://schema.org',
    '@type': 'Event',
    url: canonical,
    name: item.title,
    ...(item.lead ? { description: item.lead } : {}),
    inLanguage: locale,
    startDate: zonedIso(event.startsAt, event.timeZone),
    ...(event.endsAt ? { endDate: zonedIso(event.endsAt, event.timeZone) } : {}),
    eventStatus: 'https://schema.org/EventScheduled',
    eventAttendanceMode: `https://schema.org/${mode}`,
    ...(locations.length ? { location: locations.length === 1 ? locations[0] : locations } : {}),
  };
}

export function articleData(
  item: PublishedItem,
  canonical: string,
  locale: string,
  defaultLocale: string,
  absolute: (path: string) => string
) {
  if (item.type !== 'article') return null;
  // NewsArticle: free access follows the served revision's level, the section is its public
  // name. Only fields the projection already releases; never a body fragment, so a restricted
  // article adds no text here. A restricted one says so and names the part that is not free
  // (ADR 016 rule 5): the reader gate, which stands where that part is for everyone who is not
  // let in, a crawler included, so what a search engine is told is what it gets.
  // `dateModified` is the published revision's save.
  return {
    '@context': 'https://schema.org',
    '@type': 'NewsArticle',
    url: canonical,
    headline: item.title,
    datePublished: item.publishedAt,
    dateModified: item.updatedAt,
    inLanguage: locale,
    isAccessibleForFree: item.access === 'public',
    ...(item.access === 'public'
      ? {}
      : {
          hasPart: {
            '@type': 'WebPageElement',
            isAccessibleForFree: false,
            cssSelector: '.reader-gate',
          },
        }),
    ...(item.section ? { articleSection: item.section.name } : {}),
    // Present only when the projection released them, so never on a teaser.
    ...(item.corrections?.length
      ? {
          correction: item.corrections.map((c) => ({
            '@type': 'CorrectionComment',
            datePublished: c.date,
            text: c.text,
          })),
        }
      : {}),
    author: (item.authors ?? []).map((person) => ({
      '@type': 'Person',
      name: person.name,
      ...(person.pageEnabled
        ? { url: absolute(personPath(person.slug, locale, defaultLocale)) }
        : {}),
    })),
  };
}
