// Round trips and concurrency inputs, rather than snapshots of the form markup.
import { describe, expect, it } from 'vitest';
import { Person, PersonInput, PersonGroup } from '@mycel/core';
import { fields, personFields, groupFields } from './form.js';
const id = '01900000-0000-7000-8000-000000000001';
const other = '01900000-0000-7000-8000-000000000002';
const stamp = '2026-11-09T12:00:00.000Z';
const post = (values: Record<string, string>) => {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.set(key, value);
  return data;
};
describe('person forms', () => {
  const person = Person.parse({
    id,
    slug: 'sam',
    name: 'Sam',
    bio: { nl: 'Oud', en: 'Keep me' },
    role: { en: 'Writer' },
    email: 'internal@example.test',
    createdAt: stamp,
    updatedAt: stamp,
  });
  it('edits just the posted locale and keeps internal email separate from public contact', () => {
    const data = post({
      name: 'Sam',
      bio: 'Nieuw',
      role: 'Redacteur',
      email: person.email!,
      pagePolicy: 'auto',
    });
    expect(PersonInput.parse(personFields(data, 'nl', person))).toMatchObject({
      bio: { nl: 'Nieuw', en: 'Keep me' },
      role: { nl: 'Redacteur', en: 'Writer' },
      email: person.email,
    });
    expect(personFields(data, 'nl', person).publicEmail).toBeUndefined();
    data.set('bio', '');
    expect(personFields(data, 'nl', person).bio).toEqual({ en: 'Keep me' });
  });
  it('preserves ten existing non-fixed links past the two optional website slots', () => {
    const data = post({
      name: 'Sam',
      pagePolicy: 'auto',
      'link.0.label': 'Website',
      'link.1.label': 'LinkedIn',
    });
    for (let i = 2; i < 12; i++)
      for (const [key, value] of Object.entries({
        kind: 'other',
        label: `Link ${i}`,
        url: `https://example.test/${i}`,
      }))
        data.set(`link.${i}.${key}`, value);
    expect(PersonInput.parse(personFields(data, 'nl')).links).toHaveLength(10);
    data.set('link.0.url', 'https://example.test');
    data.set('link.0.kind', 'website');
    expect(PersonInput.safeParse(personFields(data, 'nl')).success).toBe(false);
  });
  it('keeps the original timestamp and invalid input for the error response', () => {
    const data = post({ baseUpdatedAt: stamp, name: '', publicEmail: 'bad' });
    expect(fields(data)).toEqual({ baseUpdatedAt: stamp, name: '', publicEmail: 'bad' });
  });
  it('keeps other group languages, explicit order and membership removals', () => {
    const group = PersonGroup.parse({
      id,
      name: { nl: 'Team', en: 'Team' },
      personIds: [id, other],
      createdAt: stamp,
      updatedAt: stamp,
    });
    const data = post({
      name: 'Redactie',
      order: '3',
      [`position.${id}`]: '2',
      [`position.${other}`]: '1',
    });
    data.append('personIds', id);
    data.append('personIds', other);
    expect(groupFields(data, 'nl', group)).toEqual({
      name: { nl: 'Redactie', en: 'Team' },
      order: 3,
      personIds: [other, id],
    });
    data.delete('personIds');
    data.append('personIds', other);
    expect(groupFields(data, 'nl', group).personIds).toEqual([other]);
  });
});
