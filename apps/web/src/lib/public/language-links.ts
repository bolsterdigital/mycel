// Language choices use the same published alternatives as the page head, never guessed slugs.
// Other routes and previews use the locale homes supplied by the chrome. Names are language
// data in their own language, not UI copy. Rejected: flags, which name countries, not languages.
import type { ChromeLanguage } from '../components/chrome.js';

export function languageLinks(
  alternatives: readonly { hreflang: string; href: string }[]
): ChromeLanguage[] {
  return alternatives
    .filter((a) => a.hreflang !== 'x-default')
    .map(({ hreflang: locale, href }) => ({
      locale,
      href,
      label: new Intl.DisplayNames([locale], { type: 'language' }).of(locale) ?? locale,
    }));
}
