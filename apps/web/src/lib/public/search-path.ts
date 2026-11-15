// The site search lives at `/search` in each locale, with the ordinary prefix for a non-default
// one, like content and profiles: the path owns the language. The site navigation builds its
// search entry from this one function. Rejected: a localised segment (`/zoeken`), which would
// make the route depend on a catalog and every reserved slug a per-locale list.
export function searchPath(locale: string, defaultLocale: string): string {
  return `${locale === defaultLocale ? '' : `/${locale}`}/search`;
}
