// The metadata of one page in each of its locales (checklist item localised-metadata): the
// description and Open Graph tags a search result or share preview shows, and the alt of every
// image in the page. Each locale must carry its own: a value copied from another locale passes a
// presence check but reads in the wrong language, so the locales are compared with each other.
// Rejected: asserting the seeded strings, which the corpus would then repeat for every copy edit;
// and a check on the head builder alone, which cannot see the alt of an image inside a block.

import type { Page } from '@playwright/test';

export interface LocaleMetadata {
  locale: string;
  /** The document title the corpus expects in this locale. */
  title: string;
  description: string | null;
  ogTitle: string | null;
  ogDescription: string | null;
  ogUrl: string | null;
  canonical: string | null;
  hreflang: string[];
  /** The `alt` of every image in `main`, in document order; null when the attribute is missing. */
  alts: (string | null)[];
}

/** Read the metadata of the page that is open now. */
export async function localeMetadata(
  page: Page,
  locale: string,
  title: string
): Promise<LocaleMetadata> {
  const read = await page.evaluate(() => {
    const content = (selector: string) =>
      document.querySelector(selector)?.getAttribute('content') ?? null;
    return {
      description: content('meta[name="description"]'),
      ogTitle: content('meta[property="og:title"]'),
      ogDescription: content('meta[property="og:description"]'),
      ogUrl: content('meta[property="og:url"]'),
      canonical: document.querySelector('link[rel="canonical"]')?.getAttribute('href') ?? null,
      hreflang: [...document.querySelectorAll('link[rel="alternate"][hreflang]')].map(
        (link) => link.getAttribute('hreflang') ?? ''
      ),
      alts: [...document.querySelectorAll('main img')].map((img) => img.getAttribute('alt')),
    };
  });
  return { locale, title, ...read };
}

/** One line per rule a locale breaks, alone or compared with another locale of the same page. */
export function localeMetadataProblems(pages: LocaleMetadata[]): string[] {
  const problems: string[] = [];
  const locales = pages.map((page) => page.locale);
  for (const page of pages) {
    const at = `${page.locale}:`;
    if (!page.description?.trim()) problems.push(`${at} no description`);
    if (page.ogDescription !== page.description)
      problems.push(`${at} og:description is not the description`);
    if (page.ogTitle !== page.title) problems.push(`${at} og:title is not the title`);
    if (!page.canonical || page.ogUrl !== page.canonical)
      problems.push(`${at} og:url is not the canonical URL`);
    for (const locale of [...locales, 'x-default'])
      if (!page.hreflang.includes(locale)) problems.push(`${at} no hreflang ${locale}`);
    page.alts.forEach((alt, i) => {
      if (alt === null) problems.push(`${at} image ${i + 1} has no alt`);
    });
  }
  for (const [i, a] of pages.entries())
    for (const b of pages.slice(i + 1)) {
      const pair = `${a.locale}/${b.locale}:`;
      if (a.description && a.description === b.description)
        problems.push(`${pair} same description`);
      if (a.ogTitle && a.ogTitle === b.ogTitle) problems.push(`${pair} same og:title`);
      if (a.alts.length !== b.alts.length) {
        problems.push(`${pair} ${a.alts.length} and ${b.alts.length} images`);
        continue;
      }
      a.alts.forEach((alt, n) => {
        const other = b.alts[n];
        // An empty alt marks a decorative image, which it is in every locale.
        if (!alt !== !other) problems.push(`${pair} image ${n + 1} decorative in one locale only`);
        else if (alt && alt === other) problems.push(`${pair} image ${n + 1} same alt`);
      });
    }
  return problems;
}
