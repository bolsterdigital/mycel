import { describe, expect, it } from 'vitest';
import {
  fieldOf,
  issuePath,
  fromLocalInput,
  issueKey,
  localInput,
  localLabel,
} from './content-admin-publication.js';

describe('site time', () => {
  it('reads a form time in the site zone, summer and winter', () => {
    expect(fromLocalInput('2026-07-01T09:00')?.toISOString()).toBe('2026-07-01T07:00:00.000Z');
    expect(fromLocalInput('2026-12-01T09:00')?.toISOString()).toBe('2026-12-01T08:00:00.000Z');
  });

  it('moves a time in the spring gap forward and takes the first of a doubled autumn hour', () => {
    expect(fromLocalInput('2027-03-28T02:30')?.toISOString()).toBe('2027-03-28T01:30:00.000Z');
    expect(fromLocalInput('2026-10-25T02:30')?.toISOString()).toBe('2026-10-25T00:30:00.000Z');
  });

  it('refuses what is not a datetime-local value', () => {
    for (const v of ['', '2026-02-30T09:00', '2026-07-01 09:00', '2026-07-01T09:00:00'])
      expect(fromLocalInput(v)).toBeNull();
  });

  it('round-trips through the form value and names the zone', () => {
    const at = new Date('2026-11-02T08:15:00Z');
    expect(fromLocalInput(localInput(at))).toEqual(at);
    expect(localLabel(at)).toBe('2026-11-02 09:15 (Europe/Amsterdam)');
  });
});

describe('fieldOf', () => {
  it('links an issue to the field of the edit page that fixes it', () => {
    expect(fieldOf('title', 'en')).toBe('title.en');
    expect(fieldOf('lead', 'nl')).toBe('lead.nl');
    expect(fieldOf('seo.title.en', 'en')).toBe('seoTitle.en');
    expect(fieldOf('authorIds', 'nl')).toBe('authors');
    expect(fieldOf('access.tierIds', 'nl')).toBe('level');
    expect(fieldOf('blocks.0.props.text.en', 'en')).toBeNull();
    expect(issuePath('title', 'content.publish.missing-translation', 'en')).toBe('title.en');
    expect(issuePath('authorIds', 'content.publish.author-required', 'en')).toBe('authorIds');
    expect(issueKey('content.reference.author-unknown:abc')).toBe(
      'content.reference.author-unknown'
    );
  });
});
