// The data boundary is hostile text, not just a normal profile name.
import { expect, it } from 'vitest';
import type { PublishedItem } from '@mycel/core';
import { articleData, jsonLd, personData } from './structured-data.js';
import { personPath } from './person-path.js';

it('escapes closing script tags without changing the JSON value or publishing private fields', () => {
  const hostile = '</script><img src=x onerror=alert(1)>\u2028\u2029';
  const person = {
    id: '00000000-0000-4000-8000-000000000001',
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
