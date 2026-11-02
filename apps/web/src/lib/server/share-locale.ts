// The Open Graph form of a content locale. The protocol wants `language_TERRITORY`, and a platform
// ignores what it does not recognise, so `nl` alone would leave a preview without a language. The
// territory is Unicode's likely one (`nl` is `nl_NL`, `en` is `en_US`). Rejected: a table per
// language, which every new tenant locale would have to extend, and a territory as tenant data,
// which no preview shows and which nobody would fill in.

/** `nl` → `nl_NL`, `pt-BR` → `pt_BR`; a language with no likely territory stays as it is. */
export function ogLocale(locale: string): string {
  const { language, region } = new Intl.Locale(locale).maximize();
  return region ? `${language}_${region}` : language;
}

/**
 * This page's locale and the other published ones. Two locales can share a form (`en`, `en-US`);
 * a tag says the page exists in another language, so that one is no alternate of itself.
 */
export function ogLocales(locale: string, published: readonly string[]) {
  const own = ogLocale(locale);
  const others = new Set(published.map(ogLocale));
  others.delete(own);
  return { locale: own, alternates: [...others] };
}
