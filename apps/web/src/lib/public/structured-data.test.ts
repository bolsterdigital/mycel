// The data boundary is hostile text, not just a normal profile name.
import { expect, it } from 'vitest';
import type { PublishedItem } from '@mycel/core';
import { articleData, eventData, jsonLd, personData, zonedIso } from './structured-data.js';
import { personPath } from './person-path.js';

it('escapes closing script tags without changing the JSON value or publishing private fields', () => {
  const hostile = '</script><img src=x onerror=alert(1)>\u2028\u2029';
  const person = {
    id: '00000000-0000-4000-8000-000000000001',
    kind: 'person' as const,
    slug: 'sam',
    name: hostile,
    bio: 'Bio',
    role: null,
    organisation: null,
    publicEmail: null,
    phone: null,
    imageId: null,
    links: [],
    email: 'SECRET@private.test',
  };
  const value = personData(person, 'https://example.org/people/sam', null);
  const encoded = jsonLd(value);
  expect(encoded).not.toContain('<');
  expect(encoded).not.toContain('SECRET');
  expect(JSON.parse(encoded)).toEqual(value);
  expect(personPath('sam', 'nl', 'nl')).toBe('/people/sam');
  expect(personPath('sam', 'en', 'nl')).toBe('/en/people/sam');
});

it('describes an article as a NewsArticle with its access and section, and escapes its title', () => {
  const hostile = 'Bomen</script><script>alert(1)</script>';
  const item = {
    id: '00000000-0000-4000-8000-000000000002',
    type: 'article',
    slug: 'bomen',
    revisionId: '00000000-0000-4000-8000-000000000003',
    locale: 'nl',
    locales: ['nl'],
    title: hostile,
    blocks: [],
    publishedAt: '2026-11-01T10:00:00.000Z',
    updatedAt: '2026-11-02T10:00:00.000Z',
    access: 'public',
    section: { slug: 'stad', name: 'Stad' },
    authors: [
      { id: '00000000-0000-4000-8000-000000000004', slug: 'sam', name: 'Sam', pageEnabled: false },
    ],
  } as unknown as PublishedItem;
  const url = 'https://example.org/articles/bomen';
  const value = articleData(item, url, 'nl', 'nl', (p) => `https://example.org${p}`)!;
  expect(value).toMatchObject({
    '@type': 'NewsArticle',
    headline: hostile,
    isAccessibleForFree: true,
    articleSection: 'Stad',
    datePublished: '2026-11-01T10:00:00.000Z',
    dateModified: '2026-11-02T10:00:00.000Z',
    author: [{ '@type': 'Person', name: 'Sam' }],
  });
  const encoded = jsonLd(value);
  expect(encoded).not.toContain('</script>');
  expect(encoded).not.toContain('<');
  expect(JSON.parse(encoded)).toEqual(value);
  expect(articleData({ ...item, access: 'members' }, url, 'nl', 'nl', (p) => p)).toMatchObject({
    isAccessibleForFree: false,
  });
  expect(articleData({ ...item, type: 'page' }, url, 'nl', 'nl', (p) => p)).toBeNull();
});

it('describes an event page as an Event with the site’s offset, and nothing else as one', () => {
  expect(zonedIso('2026-12-05T20:00', 'Europe/Amsterdam')).toBe('2026-12-05T20:00:00+01:00');
  expect(zonedIso('2026-07-05T20:00', 'Europe/Amsterdam')).toBe('2026-07-05T20:00:00+02:00');
  expect(zonedIso('2026-12-05T20:00', 'America/New_York')).toBe('2026-12-05T20:00:00-05:00');
  const item = {
    type: 'page',
    title: 'Buurtavond</script>',
    lead: 'Praat mee.',
    event: {
      startsAt: '2026-12-05T20:00',
      endsAt: '2026-12-05T22:00',
      location: 'Buurthuis, Kerkstraat 1',
      onlineUrl: 'https://example.org/live',
      timeZone: 'Europe/Amsterdam',
    },
  } as unknown as PublishedItem;
  const value = eventData(item, 'https://example.org/buurtavond', 'nl');
  expect(value).toMatchObject({
    '@type': 'Event',
    url: 'https://example.org/buurtavond',
    startDate: '2026-12-05T20:00:00+01:00',
    endDate: '2026-12-05T22:00:00+01:00',
    eventAttendanceMode: 'https://schema.org/MixedEventAttendanceMode',
    location: [
      { '@type': 'Place', name: 'Buurthuis, Kerkstraat 1' },
      { '@type': 'VirtualLocation', url: 'https://example.org/live' },
    ],
  });
  expect(jsonLd(value)).not.toContain('<');
  const offline = { ...item, event: { ...item.event!, onlineUrl: null } } as PublishedItem;
  expect(eventData(offline, 'x', 'nl')).toMatchObject({
    eventAttendanceMode: 'https://schema.org/OfflineEventAttendanceMode',
    location: { '@type': 'Place' },
  });
  expect(eventData({ ...item, event: undefined } as PublishedItem, 'x', 'nl')).toBeNull();
});
