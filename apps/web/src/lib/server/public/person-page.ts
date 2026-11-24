// The registry owns visibility and the safe locale projection. This adapter only resolves public
// image variants and URLs; rejected: reading editorial Person records into Svelte page data.
import { cardPlaceholder } from './chrome.js';
import { languageLinks } from '../../public/language-links.js';
import { createHash } from 'node:crypto';
import {
  anonymousPrincipal,
  contentPath,
  type ImagePlacement,
  UseCaseError,
  useCases,
} from '@mycel/core';
import { runtimeSource, resolveIntro, overviewWhen } from '../../blocks/resolve.js';
import { personPath } from '../../public/person-path.js';
import { personData } from '../../public/structured-data.js';
import { refuse } from '../http/refuse.js';
import { runtime } from '../runtime.js';
import { sitePath, siteTenant, siteUrls, type Site } from '../site.js';
import { ogLocales } from './share-locale.js';
import { siteBrand, siteChrome, siteNavigation, siteTheme } from './theme.js';

export async function loadPersonPage(site: Site, slug: string, locale: string, offset: number) {
  const { invoker, uow } = runtime();
  const reader = anonymousPrincipal(siteTenant(site), ['content:read', 'media:read']);
  let result;
  try {
    result = await invoker.run(useCases.getPublicPerson, reader, {
      slug,
      locale,
      offset,
      limit: 9,
    });
  } catch (error) {
    if (error instanceof UseCaseError && error.code === 'not_found') refuse(404);
    throw error;
  }
  if (offset > 0 && offset >= result.total) refuse(404);
  const source = runtimeSource({ invoker, uow, reader, defaultLocale: site.tenant.defaultLocale });
  // A portrait's adjacent heading names the person; the image itself is decorative.
  const image = async (id: string | null, placement?: ImagePlacement) =>
    (
      await resolveIntro(
        source,
        { lead: null, heroImageId: id, heroAlt: null, heroPlacement: placement },
        locale
      )
    ).hero;
  const timeZone = (await invoker.run(useCases.getSiteGeneral, reader, {})).value.timeZone;
  const portrait = await image(result.person.imageId);
  const articles = await Promise.all(
    result.articles.map(async (article) => ({
      ...article,
      href: sitePath(
        site,
        contentPath({ type: 'article', slug: article.slug }, locale, site.tenant.defaultLocale)
      ),
      image: await image(article.featuredImageId, article.featuredPlacement),
      date: overviewWhen({ event: null, date: article.firstPublishedAt }, locale, timeZone).date,
    }))
  );
  const absolute = await siteUrls(site);
  const path = personPath(slug, locale, site.tenant.defaultLocale);
  const pageHref = (start: number) => `${sitePath(site, path)}${start ? `?offset=${start}` : ''}`;
  const suffix = offset ? `?offset=${offset}` : '';
  const canonical = absolute(path);
  const share = ogLocales(locale, site.tenant.locales);
  const view = {
    // A language change starts at that profile’s first page; offsets need not exist there.
    navigationLanguages: languageLinks(
      site.tenant.locales.map((l) => ({
        hreflang: l,
        href: sitePath(site, personPath(slug, l, site.tenant.defaultLocale)),
      }))
    ),
    person: result.person,
    portrait,
    placeholder: await cardPlaceholder(site, sitePath(site, '')),
    articles,
    base: sitePath(site, ''),
    locale,
    head: {
      canonical: canonical + suffix,
      title: result.person.name,
      share,
      description: result.person.bio ?? result.person.role ?? result.person.name,
      alternates: offset
        ? []
        : [
            ...site.tenant.locales.map((l) => ({
              hreflang: l,
              href: absolute(personPath(slug, l, site.tenant.defaultLocale)) + suffix,
            })),
            {
              hreflang: 'x-default',
              href:
                absolute(personPath(slug, site.tenant.defaultLocale, site.tenant.defaultLocale)) +
                suffix,
            },
          ],
      structured: personData(result.person, canonical, portrait ? absolute(portrait.src) : null),
    },
    previous: offset ? pageHref(Math.max(0, offset - 9)) : null,
    next: result.nextOffset === null ? null : pageHref(result.nextOffset),
  };
  const [theme, chrome, navigation, brand] = await Promise.all([
    siteTheme(site),
    siteChrome(site),
    siteNavigation(site, locale),
    siteBrand(site),
  ]);
  const digest = createHash('sha256')
    .update(
      JSON.stringify({ view, theme: theme.hash, chrome, navigation, brand, access: site.access })
    )
    .digest('base64url');
  return { view, etag: `"person:${digest}"` };
}
