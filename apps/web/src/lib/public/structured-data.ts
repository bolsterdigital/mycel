// JSON-LD is data, never executable markup. Escape HTML-significant bytes before placing the
// generated script in a head; rejected: raw JSON.stringify, which permits a closing script tag.
import type { PublishedItem, PublicPerson } from '@mycel/core';
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

export function articleData(
  item: PublishedItem,
  canonical: string,
  locale: string,
  defaultLocale: string,
  absolute: (path: string) => string
) {
  if (item.type !== 'article') return null;
  return {
    '@context': 'https://schema.org',
    '@type': 'Article',
    url: canonical,
    headline: item.title,
    datePublished: item.publishedAt,
    dateModified: item.updatedAt,
    inLanguage: locale,
    author: (item.authors ?? []).map((person) => ({
      '@type': 'Person',
      name: person.name,
      ...(person.pageEnabled
        ? { url: absolute(personPath(person.slug, locale, defaultLocale)) }
        : {}),
    })),
  };
}
