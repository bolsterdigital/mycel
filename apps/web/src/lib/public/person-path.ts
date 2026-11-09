// Profile URLs follow the same URL-owned locale rule as content; rejected: browser negotiation.
export function personPath(slug: string, locale: string, defaultLocale: string): string {
  return `${locale === defaultLocale ? '' : `/${locale}`}/people/${slug}`;
}
