// The registry owns visibility and the safe locale projection. This adapter only resolves public
// image variants and URLs; rejected: reading editorial Person records into Svelte page data.
import { createHash } from 'node:crypto';
import { anonymousPrincipal, contentPath, UseCaseError, useCases } from '@mycel/core';
import { runtimeSource, resolveIntro } from '../../blocks/resolve.js';
import { personPath } from '../../public/person-path.js';
import { personData } from '../../public/structured-data.js';
import { refuse } from '../http/refuse.js';
import { runtime } from '../runtime.js';
import { sitePath, siteTenant, siteUrls, type Site } from '../site.js';
import { ogLocales } from './share-locale.js';
import { siteBrand, siteChrome, siteTheme } from './theme.js';

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
  const source = runtimeSource({ invoker, uow, reader, defaultLocale: site.tenant.defaultLocale });
  // A portrait's adjacent heading names the person; the image itself is decorative.
  const image = async (id: string | null) =>
    (await resolveIntro(source, { lead: null, heroImageId: id, heroAlt: null }, locale)).hero;
  const timeZone = (await invoker.run(useCases.getSiteGeneral, reader, {})).value.timeZone;
  const portrait = await image(result.person.imageId);
  const articles = await Promise.all(
    result.articles.map(async (article) => ({
      ...article,
      href: sitePath(
        site,
        contentPath({ type: 'article', slug: article.slug }, locale, site.tenant.defaultLocale)
      ),
      image: await image(article.featuredImageId),
      date: new Intl.DateTimeFormat(locale, { dateStyle: 'long', timeZone }).format(
        new Date(article.publishedAt)
      ),
    }))
  );
  const absolute = await siteUrls(site);
  const path = personPath(slug, locale, site.tenant.defaultLocale);
  const pageHref = (start: number) => `${sitePath(site, path)}${start ? `?offset=${start}` : ''}`;
  const suffix = offset ? `?offset=${offset}` : '';
  const canonical = absolute(path);
  const share = ogLocales(locale, site.tenant.locales);
  const view = {
    person: result.person,
    portrait,
    articles,
    base: sitePath(site, ''),
    locale,
    head: {
      canonical: canonical + suffix,
      title: result.person.name,
      share,
      description: result.person.bio ?? result.person.role ?? result.person.name,
      alternates: [
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
  const [theme, chrome, brand] = await Promise.all([
    siteTheme(site),
    siteChrome(site),
    siteBrand(site),
  ]);
  const digest = createHash('sha256')
    .update(JSON.stringify({ view, theme: theme.hash, chrome, brand, access: site.access }))
    .digest('base64url');
  return { view, etag: `"person:${digest}"` };
}
