// formatWhen (#87): every rung of the relative ladder at a fixed `now`, in both admin locales and
// in two zones, because the calendar day ("today", "yesterday") is the operator's, not the
// server's.
import { describe, expect, it } from 'vitest';
import { formatWhen } from './format.js';

// Friday 30 October 2026, 14:05 in Amsterdam (CET, UTC+1).
const now = new Date('2026-10-30T13:05:00Z');
const ams = (iso: string, locale = 'nl') =>
  formatWhen(iso, { locale, zone: 'Europe/Amsterdam', now }).text;

describe('formatWhen', () => {
  it('climbs from just now to minutes, today, yesterday and the weekday', () => {
    expect(ams('2026-10-30T13:04:30Z')).toBe('zojuist');
    expect(ams('2026-10-30T12:50:00Z')).toBe('15 minuten geleden');
    expect(ams('2026-10-30T08:12:00Z')).toBe('vandaag 09:12');
    expect(ams('2026-10-29T08:12:00Z')).toBe('gisteren 09:12');
    expect(ams('2026-10-27T15:30:00Z')).toBe('dinsdag 16:30');
  });

  it('gives a short date after a week, with the year only outside this one', () => {
    expect(ams('2026-10-12T10:00:00Z')).toBe('12 okt');
    expect(ams('2025-10-12T10:00:00Z')).toBe('12 okt 2025');
    expect(ams('2026-10-12T10:00:00Z', 'en')).toBe('Oct 12');
    expect(ams('2025-10-12T10:00:00Z', 'en')).toBe('Oct 12, 2025');
  });

  it('speaks English in the English admin', () => {
    expect(ams('2026-10-30T13:04:30Z', 'en')).toBe('just now');
    expect(ams('2026-10-30T12:04:00Z', 'en')).toBe('today 1:04 PM');
    expect(ams('2026-10-29T08:12:00Z', 'en')).toBe('yesterday 9:12 AM');
  });

  it('takes the calendar day from the zone, not the server', () => {
    // 23:30 UTC on the 29th is already the 30th in Amsterdam, still the 29th in UTC.
    const late = '2026-10-29T23:30:00Z';
    expect(ams(late)).toBe('vandaag 00:30');
    expect(formatWhen(late, { locale: 'nl', zone: 'UTC', now }).text).toBe('gisteren 23:30');
  });

  it('names a scheduled moment tomorrow', () => {
    expect(ams('2026-10-31T08:00:00Z')).toBe('morgen 09:00');
  });

  it('keeps the instant and the full date for <time>, and is absolute on request', () => {
    const w = formatWhen('2026-10-12T10:00:00Z', { locale: 'nl', zone: 'Europe/Amsterdam', now });
    expect(w.iso).toBe('2026-10-12T10:00:00.000Z');
    expect(w.full).toBe('maandag 12 oktober 2026 om 12:00');
    expect(
      formatWhen('2026-10-30T12:50:00Z', {
        locale: 'nl',
        zone: 'Europe/Amsterdam',
        now,
        relative: false,
      }).text
    ).toBe('30 okt 2026, 13:50');
  });
});
