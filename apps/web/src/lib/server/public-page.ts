// Loads a public page or article as a render model (brief #8c § 1 and § 7–9): the core returns
// one published locale of the item (`content.published.get`, the locale from the path), the
// resolver fetches every reference the blocks make once, up front, and this module adds what the
// document head and the cache need: the canonical URL, one `hreflang` per published locale plus
// `x-default`, a description, the Open Graph title and share image (#66), and a strong ETag. The public pages ship no client-side JavaScript
// at all, and nothing here reads a cookie or Accept-Language: the response is a function of the
// URL, which is what makes it cacheable in a shared cache (ADR 018 rule 8).
//
// The ETag is `"<revision>:<locale>:<theme>:<digest>"`. Revision, locale and theme are the brief's
// key; the digest covers what the page shows besides the revision (resolved links and images,
// the head, the site's entitlements and status), so unpublishing a linked item or switching the
// footer credit off also changes the tag. Rejected: the brief's three parts alone (a 304 would
// keep a link to an item that is no longer public), and hashing the HTML.
//
// An item with a form has no ETag at all, and the route makes it `no-store` (#30A, brief
// form-intake § 5): its HTML carries a signed timing token per render, a 304 would keep an old
// one alive past its 24 hours (a real visitor then posts as spam), and the age of a shared token
// says nothing about how long this visitor took to fill in the form. Rejected: a weak ETag (the
// expired token stays), fetching the token outside the HTML (needs JavaScript, ADR 009), and a
// validator that knows the token's age (a 304 still cannot replace the token).

import { createHash } from 'node:crypto';
import { error } from '@sveltejs/kit';
import {
  UseCaseError,
  anonymousPrincipal,
  contentPath,
  useCases,
  type Principal,
  type PublishedItem,
  type TenantInfo,
} from '@mycel/core';
import type { RenderIntro, RenderModel } from '../blocks/model.js';
import { renderMeta, resolveDocument, resolveIntro, runtimeSource } from '../blocks/resolve.js';
import type { ContentRoute } from './content-route.js';
import { runtime } from './runtime.js';
import { sitePath, siteTenant, siteUrls, type Site } from './site.js';
import { siteBrand, siteChrome, siteTheme } from './theme.js';

export interface PublicHead {
  canonical: string;
  /** One per published locale, then `x-default`. */
  alternates: { hreflang: string; href: string }[];
  description: string | null;
  /** Open Graph: the explicit share title or the document title, and the page kind. */
  share: { title: string; type: 'website' | 'article' };
  /** The share image as an absolute URL of one of its variants, or null. */
  image: { src: string; width: number; height: number; type: string } | null;
}

export interface PublicItem {
  tenant: TenantInfo;
  item: PublishedItem;
  locale: string;
  model: RenderModel;
  /** What sits between the title and the blocks (#86): the lead and the hero image. */
  intro: RenderIntro;
  /** Whether the first letter of the body is a drop cap: an article on a site that wants one. */
  dropCap: boolean;
  head: PublicHead;
  /** Strong, or null for an item with a form; see the comment at the top. */
  etag: string | null;
}

/** The site comes from the hooks (hostname or dev path, ADR 014), never from a route param. */
export async function loadPublicItem(
  site: Site,
  route: Pick<ContentRoute, 'type' | 'slug'>,
  locale: string
): Promise<PublicItem> {
  const { invoker, uow } = runtime();
  const { tenant } = site;
  const reader = anonymousPrincipal(siteTenant(site), ['content:read', 'forms:read', 'media:read']);
  let item: PublishedItem;
  try {
    item = await invoker.run(useCases.getPublished, reader, { ...route, locale });
  } catch (e) {
    if (e instanceof UseCaseError && e.code === 'not_found') error(404, 'Not found');
    throw e;
  }
  const source = runtimeSource({ invoker, uow, reader, defaultLocale: tenant.defaultLocale });
  const model = await resolveDocument(source, item, {
    base: sitePath(site, ''),
    fallbackLocale: tenant.defaultLocale,
  });
  const intro = await resolveIntro(
    source,
    {
      lead: item.lead,
      heroImageId: item.effective.images.hero.mediaId,
      heroAlt: item.heroAlt,
      ...(item.type === 'article'
        ? {
            header: item.presentation?.header ?? 'standard',
            meta: renderMeta(
              {
                publishedAt: item.publishedAt,
                authors: (item.authors ?? []).map((a) => a.name),
                section: item.section?.name ?? null,
              },
              locale,
              (await invoker.run(useCases.getSiteGeneral, reader, {})).value.timeZone
            ),
          }
        : {}),
    },
    locale
  );
  const theme = await siteTheme(site);
  const dropCap = item.type === 'article' && theme.dropCap === 'articles';

  const url = await siteUrls(site);
  const href = (l: string) => url(contentPath(item, l, tenant.defaultLocale));
  const fallback = item.locales.includes(tenant.defaultLocale)
    ? tenant.defaultLocale
    : item.locales[0]!;
  const head: PublicHead = {
    canonical: href(locale),
    alternates: [
      ...item.locales.map((l) => ({ hreflang: l, href: href(l) })),
      { hreflang: 'x-default', href: href(fallback) },
    ],
    // The chain in core (effective.ts): own SEO description, featured description, lead, body.
    description: item.effective.seoDescription.text,
    share: {
      title: item.seo.title ?? item.title,
      type: item.type === 'article' ? 'article' : 'website',
    },
    image: await shareImage(item.effective.images.share.mediaId, reader, url),
  };

  const page = { tenant, item, locale, model, intro, dropCap, head };
  if (hasForm(model)) return { ...page, etag: null };
  const chrome = await siteChrome(site);
  const brand = await siteBrand(site);
  const digest = createHash('sha256')
    .update(JSON.stringify({ model, intro, dropCap, head, access: site.access, chrome, brand }))
    .digest('base64url')
    .slice(0, 16);
  const etag = `"${item.revisionId}:${locale}:${theme.hash}:${digest}"`;
  return { ...page, etag };
}

/** The widest webp variant up to this width: what the share previews ask for (1200 px). */
const SHARE_WIDTH = 1280;

/**
 * The share image of an item through the site's own variant route, the route an image block's
 * `src` uses. Only a public, ready image has one (ADR 018 rule 7: never a restricted file); the
 * variant is webp, the format every variant is stored in. Rejected: the original (up to 25 MB,
 * past the size the platforms fetch) and a JPEG made for sharing, which is the og-image
 * generator's job (`og:<...>` usages, docs/reference/media.md).
 */
async function shareImage(
  id: string | null,
  reader: Principal,
  url: (path: string) => string
): Promise<PublicHead['image']> {
  if (!id) return null;
  let asset;
  try {
    asset = await runtime().invoker.run(useCases.getMedia, reader, { id });
  } catch (e) {
    if (e instanceof UseCaseError && e.code === 'not_found') return null;
    throw e;
  }
  if (asset.access !== 'public' || asset.kind !== 'image' || asset.state !== 'ready') return null;
  const sized = asset.variants
    .filter((v) => v.format === 'webp' && /^w\d+$/.test(v.name) && v.width && v.height && v.path)
    .sort((a, b) => a.width! - b.width!);
  const best = [...sized].reverse().find((v) => v.width! <= SHARE_WIDTH) ?? sized[0];
  if (!best) return null;
  return { src: url(best.path), width: best.width!, height: best.height!, type: 'image/webp' };
}

/**
 * Whether the page renders a form. The render model is flat: a pattern is copied into the item
 * as plain blocks (content/patterns.ts), so there is no nesting left to walk.
 */
export function hasForm(model: RenderModel): boolean {
  return model.blocks.some((b) => b.type === 'form' && b.form !== null);
}
