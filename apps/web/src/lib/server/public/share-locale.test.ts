import { describe, expect, it } from 'vitest';
import { ogLocale, ogLocales } from './share-locale.js';

describe('the Open Graph locale', () => {
  it('names a territory, keeping the one a locale already has', () => {
    expect(ogLocale('nl')).toBe('nl_NL');
    expect(ogLocale('en')).toBe('en_US');
    expect(ogLocale('de')).toBe('de_DE');
    expect(ogLocale('nl-BE')).toBe('nl_BE');
    expect(ogLocale('pt-BR')).toBe('pt_BR');
  });

  it('keeps every locale the content model accepts, also one Unicode has no data for', () => {
    expect(ogLocale('qqq')).toBe('qqq');
  });

  it('lists the other published locales, not this one', () => {
    expect(ogLocales('nl', ['nl'])).toEqual({ locale: 'nl_NL', alternates: [] });
    expect(ogLocales('en', ['nl', 'en', 'de'])).toEqual({
      locale: 'en_US',
      alternates: ['nl_NL', 'de_DE'],
    });
  });

  it('does not call a locale an alternate of the form it shares', () => {
    expect(ogLocales('en', ['en', 'en-US'])).toEqual({ locale: 'en_US', alternates: [] });
  });
});
