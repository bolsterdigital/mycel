// The data boundary is hostile text, not just a normal profile name.
import { expect, it } from 'vitest';
import { jsonLd, personData } from './structured-data.js';
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
