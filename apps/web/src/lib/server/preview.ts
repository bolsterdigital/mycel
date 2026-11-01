// The admin preview (TODO #11, brief content-editor § A1 § 2, ADR 020 rule 8): one revision of an
// item in one locale through the real renderer, on the platform origin. The admin never runs on
// a tenant hostname (ADR 014), so the site's theme, media and links get their own routes under
// `/admin/<slug>/preview/`, and that prefix is the render model's `base`. Every route checks the
// operator's membership; the item itself is read under the operator's principal (RLS), so
// another site's id is a 404.
//
// References (forms, media, links to other items) are resolved by the same anonymous site reader
// as the public pages: a preview shows what a visitor would see once this revision is published,
// and only the revision differs. Rejected: resolving with the operator's principal (a draft
// linked from the preview would look public), and the tenant's hostname for preview assets (CSP
// and a cross-origin load per image).

import {
  anonymousPrincipal,
  effectiveImages,
  type ContentDocument,
  type TenantInfo,
  type Principal,
  UseCaseError,
  pick,
  useCases,
} from '@mycel/core';
import { renderMeta } from '../blocks/resolve.js';
import { runtime } from './runtime.js';
import { siteTenant, type Site } from './site.js';

/** The response headers of every preview route: never cached, never indexed. */
export const PREVIEW_HEADERS = {
  'cache-control': 'private, no-store',
  'x-robots-tag': 'noindex',
} as const;

export const previewBase = (slug: string): string => `/admin/${slug}/preview`;

/** The tenant's site in the path form, for the theme and the resolver. */
export async function previewSite(tenant: TenantInfo): Promise<Site> {
  return { tenant, form: 'path', access: await runtime().identity.tenantAccess(tenant.id) };
}

/** The visitor a published page is read as (lib/server/public-page.ts). */
export const siteReader = (site: Site) =>
  anonymousPrincipal(siteTenant(site), ['content:read', 'forms:read', 'media:read']);

/**
 * The document header of a revision in one locale, as the public page gets it (#86, #105): lead,
 * hero, an article's header choice and meta line. Authors and section are read as the editor
 * looking at the preview, since those use cases are not open to the anonymous site reader; only
 * the names reach the page, and one that no longer resolves is left out. The date is the live one, or today for what is not live yet: what the line would say if it were published now.
 */
export async function introOf(
  reader: Principal,
  doc: ContentDocument,
  locale: string,
  publishedAt: string | null
) {
  const header = {
    lead: doc.lead?.[locale] ?? null,
    heroImageId: effectiveImages(doc).hero.mediaId,
    heroAlt: doc.heroAlt?.[locale] ?? null,
  };
  if (doc.type !== 'article') return header;
  const { invoker } = runtime();
  const found = async <T>(read: () => Promise<T>): Promise<T | null> => {
    try {
      return await read();
    } catch (e) {
      if (e instanceof UseCaseError && e.code === 'not_found') return null;
      throw e;
    }
  };
  const authors: string[] = [];
  for (const authorId of doc.authorIds) {
    const author = await found(() => invoker.run(useCases.getAuthor, reader, { authorId }));
    if (author) authors.push(author.name);
  }
  const section = doc.sectionId
    ? await found(() =>
        invoker.run(useCases.getSection, reader, { sectionId: doc.sectionId as string })
      )
    : null;
  const { timeZone } = (await invoker.run(useCases.getSiteGeneral, reader, {})).value;
  return {
    ...header,
    header: doc.presentation?.header ?? ('standard' as const),
    meta: renderMeta(
      {
        publishedAt: publishedAt ?? new Date().toISOString(),
        authors,
        section: section ? (pick(section.title, locale, doc.defaultLocale) ?? section.slug) : null,
      },
      locale,
      timeZone
    ),
  };
}
