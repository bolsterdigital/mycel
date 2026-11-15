// Only the public projection’s alternatives become language choices; x-default is metadata,
// not a third translation. Names are in the target language and hrefs retain host/path forms.
import { describe, expect, it } from 'vitest';
import { languageLinks } from './language-links.js';

describe('languageLinks', () => {
  it('keeps published alternatives and their URLs, without inventing another locale', () => {
    expect(
      languageLinks([
        { hreflang: 'nl', href: '/probe/over' },
        { hreflang: 'en', href: 'https://site.test/en/about' },
        { hreflang: 'x-default', href: '/probe/over' },
      ])
    ).toEqual([
      { locale: 'nl', label: 'Nederlands', href: '/probe/over' },
      { locale: 'en', label: 'English', href: 'https://site.test/en/about' },
    ]);
    expect(languageLinks([])).toEqual([]);
  });
});
