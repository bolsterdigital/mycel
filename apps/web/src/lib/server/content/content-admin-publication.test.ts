import { describe, expect, it } from 'vitest';
import {
  fieldOf,
  issuePath,
  fromLocalInput,
  localInput,
  localLabel,
} from './content-admin-publication.js';

const AMS = 'Europe/Amsterdam';

describe('admin time', () => {
  it('reads a form time in the given zone, summer and winter', () => {
    expect(fromLocalInput('2026-07-01T09:00', AMS)?.toISOString()).toBe('2026-07-01T07:00:00.000Z');
    expect(fromLocalInput('2026-12-01T09:00', AMS)?.toISOString()).toBe('2026-12-01T08:00:00.000Z');
    expect(fromLocalInput('2026-07-01T09:00', 'America/New_York')?.toISOString()).toBe(
      '2026-07-01T13:00:00.000Z'
    );
  });

  it('moves a time in the spring gap forward and takes the first of a doubled autumn hour', () => {
    expect(fromLocalInput('2027-03-28T02:30', AMS)?.toISOString()).toBe('2027-03-28T01:30:00.000Z');
    expect(fromLocalInput('2026-10-25T02:30', AMS)?.toISOString()).toBe('2026-10-25T00:30:00.000Z');
  });

  it('refuses what is not a datetime-local value', () => {
    for (const v of ['', '2026-02-30T09:00', '2026-07-01 09:00', '2026-07-01T09:00:00'])
      expect(fromLocalInput(v, AMS)).toBeNull();
  });

  it('round-trips through the form value and names the zone only when asked', () => {
    const at = new Date('2026-11-02T08:15:00Z');
    expect(fromLocalInput(localInput(at, AMS), AMS)).toEqual(at);
    expect(localLabel(at, AMS)).toBe('2026-11-02 09:15');
    expect(localLabel(at, 'Asia/Tokyo', true)).toBe('2026-11-02 17:15 (Asia/Tokyo)');
  });
});

describe('fieldOf', () => {
  it('links an issue to the field of the edit page that fixes it', () => {
    expect(fieldOf('title', 'en')).toBe('title.en');
    expect(fieldOf('lead', 'nl')).toBe('lead.nl');
    expect(fieldOf('featuredImageId', 'nl')).toBe('featuredImageId');
    expect(fieldOf('heroImageId', 'nl')).toBe('heroImageId');
    expect(fieldOf('heroAlt', 'nl')).toBe('heroAlt');
    expect(fieldOf('featured.title.en', 'en')).toBe('featuredTitle.en');
    expect(fieldOf('featured.description', 'nl')).toBe('featuredDescription.nl');
    expect(fieldOf('seo.imageId', 'nl')).toBe('shareImageId');
    expect(fieldOf('seo.title.en', 'en')).toBe('seoTitle.en');
    expect(fieldOf('authorIds', 'nl')).toBe('authors');
    expect(fieldOf('access.tierIds', 'nl')).toBe('level');
    expect(fieldOf('locales', 'en')).toBe('publication-en');
    expect(fieldOf('blocks.0.props.text.en', 'en')).toBeNull();
    expect(issuePath('title', 'content.publish.missing-translation', 'en')).toBe('title.en');
  });
});
