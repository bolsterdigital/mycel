// Loads a public page or article as a render model (brief #8c § 1 and § 7–9): the core returns
// one published locale of the item (`content.published.get`, the locale from the path), the
// resolver fetches every reference the blocks make once, up front, and this module adds what the
// document head and the cache need: the canonical URL, one `hreflang` per published locale plus
// `x-default`, a description, the Open Graph title and share image (#66), the editor's
// `noindex` and explicit canonical, and a strong ETag. The public pages ship no client-side JavaScript
// at all, and for a public item nothing here reads a cookie or Accept-Language: the response is a
// function of the URL, which is what makes it cacheable in a shared cache (ADR 018 rule 8).
//
// A restricted item is read as a visitor first, which gives its teaser and a `gate` (ADR 016
// rule 3: the core cut the body before anything here saw it). Only then, and only when the
// request carries a reader cookie, is the item read again as that reader, who gets the whole
// item or the same teaser. So the cookie is never read for a public item, and the references,
// forms, media and collection cards of every page stay those of a visitor: a reader's access
// opens one item's body and nothing around it. A response for which the cookie was read is
// `personal`: no ETag, and the route sends it `private, no-store`. A teaser's ETag says
// `teaser`, and every answer of a restricted item varies on the cookie.
// Rejected: resolving the reader for every page (a session read per public request, and public
// pages would stop being a function of the URL), and deciding from the cookie's presence alone
// (the core decides from the session row and the live grants, on every read).
//
// The ETag is `"<revision>:<locale>:<theme>:<digest>"`. Revision, locale and theme are the brief's
// key; the digest covers what the page shows besides the revision (resolved links and images,
// the head, the site's entitlements and status), so unpublishing a linked item or switching the
// footer credit off also changes the tag. Rejected: the brief's three parts alone (a 304 would
// keep a link to an item that is no longer public), and hashing the HTML.
//
// A campaign card or a form bound to a campaign (ADR 033 rule 6) is in the model with the landing
// page's published revision, its phase and the count it showed, so the digest moves when any of
// them does: a newer landing revision, opening or closing (a window boundary passing included,
// since the phase is evaluated when the page is read) or one more participant. A `full` card
// that renders its form makes the page an item with a form.
//
// An item with a form has no ETag at all, and the route makes it `no-store` (#30A, brief
// form-intake § 5): its HTML carries a signed timing token per render, a 304 would keep an old
// one alive past its 24 hours (a real visitor then posts as spam), and the age of a shared token
// says nothing about how long this visitor took to fill in the form. Rejected: a weak ETag (the
// expired token stays), fetching the token outside the HTML (needs JavaScript, ADR 009), and a
// validator that knows the token's age (a 304 still cannot replace the token).
//
// The dossier boxes (MY-260) are in the digest too: a member published or taken out, or the
// dossier republished, changes what the box shows and so the tag.
//
// The pre-footer zone is part of the page: the zone the published navigation places
// (`site.prefooter.get`), resolved like the page's own blocks, unless the item switches it off.
// Its model is in the digest, and a form in it makes the page an item with a form, as above: a
// newsletter zone makes every page it stands on `no-store`, which is the price of a timing token.

import { createHash } from 'node:crypto';
import {
  SHARE_CARD_HEIGHT,
  SHARE_CARD_WIDTH,
  UseCaseError,
  anonymousPrincipal,
  contentPath,
  useCases,
  type Principal,
  type PublishedItem,
  type TenantInfo,
} from '@mycel/core';
import type { Cookies } from '@sveltejs/kit';
import type { RenderCorrections, RenderIntro, RenderModel } from '../../blocks/model.js';
import { hasForm } from './has-form.js';
import {
  renderEvent,
  renderMeta,
  resolveDocument,
  renderCorrections,
  resolveIntro,
  runtimeSource,
} from '../../blocks/resolve.js';
import type { ContentRoute } from './content-route.js';
import { runtime } from '../runtime.js';
import { articleData, eventData } from '../../public/structured-data.js';
import { personPath } from '../../public/person-path.js';
import { ui } from '../../../i18n/index.js';
import { READER_COOKIE, READER_PATH, readerOfRequest } from './reader.js';
import { ogLocales } from './share-locale.js';
import { sitePath, siteTenant, siteUrls, type Site } from '../site.js';
import { siteBrand, siteChrome, siteNavigation, siteTheme } from './theme.js';
import { cardPlaceholder } from './chrome.js';
import { siteTracker } from './scripts/analytics.js';
import { sitePlacement } from './scripts/integrations.js';
import { refuse } from '#lib/server/http/refuse.js';
import { renderDossiers, type RenderDossiers } from './dossier-box.js';

export interface PublicHead {
  /** The item's own address, or the editor's explicit canonical URL (`seo.canonical`). */
  canonical: string;
  /** `seo.noindex`: the page is served but asks search engines not to index it. */
  noindex: boolean;
  /** One per published locale, then `x-default`. */
  alternates: { hreflang: string; href: string }[];
  description: string | null;
  /** `<title>` and `og:title`: the editor's title for search results, else the document title. */
  title: string;
  /** Open Graph: the page kind, and this locale and the other published ones. */
  share: { type: 'website' | 'article'; locale: string; alternateLocales: string[] };
  /**
   * The share image as an absolute URL of one of its variants, or null. An alt only where the
   * document has one for this image: alt text belongs to a use, not to the file (media/model.ts),
   * and of the uses the share chain can land on only the hero carries one.
   */
  image: { src: string; width: number; height: number; type: string; alt: string | null } | null;
}

/**
 * What stands where the body of a restricted item was left out: why, and for a visitor the way
 * to the sign-in page, which comes back to this address; a signed-in reader without the tier is
 * led to their account. When one of the item's tiers sells a membership, `join` leads to its
 * signup page (MY-254 PR 4) and the sign-in or account link moves under it.
 */
export interface PublicGate {
  prompt: NonNullable<PublishedItem['gate']>['prompt'];
  title: string;
  body: string;
  /** `href` is the link on this site's pages; `path` the same address from the site's root. */
  action: { href: string; path: string; label: string } | null;
  /** Become a member: the tier's signup page. */
  join: { href: string; path: string; label: string; other: string } | null;
}

export interface PublicItem {
  tenant: TenantInfo;
  item: PublishedItem;
  locale: string;
  model: RenderModel;
  /** What sits between the title and the blocks (#86): the lead and the hero image. */
  intro: RenderIntro;
  /** An article's corrections after the body; null without any (and on a teaser). */
  corrections: RenderCorrections | null;
  /** Whether the first letter of the body is a drop cap: an article on a site that wants one. */
  dropCap: boolean;
  head: PublicHead;
  structured: ReturnType<typeof articleData> | ReturnType<typeof eventData>;
  /** The dossier boxes under the body (MY-260), or null. */
  dossiers: RenderDossiers | null;
  /** The zone between the content and the footer, or null. */
  prefooter: PublicZone | null;
  /** Set when the body was left out for this request; the page shows it after the teaser. */
  gate: PublicGate | null;
  /** The item is restricted: every answer at this address varies on the cookie. */
  restricted: boolean;
  /** The reader cookie was read for this answer: never for a shared cache, never a 304. */
  personal: boolean;
  /** Strong, or null for an item with a form or a personal answer; see the comment at the top. */
  etag: string | null;
}

export interface PublicZone {
  /** The accessible name of its `aside`. */
  title: string;
  model: RenderModel;
}

/** The site comes from the hooks (hostname or dev path, ADR 014), never from a route param. */
export async function loadPublicItem(
  site: Site,
  route: Pick<ContentRoute, 'type' | 'slug'>,
  locale: string,
  /** The archive page of an overview (`?p=`); 1 without one. */
  archivePage = 1,
  /** The request's cookies, for a restricted item; without them everyone is a visitor. */
  cookies?: Cookies
): Promise<PublicItem> {
  const { invoker, uow } = runtime();
  const { tenant } = site;
  const reader = anonymousPrincipal(siteTenant(site), ['content:read', 'forms:read', 'media:read']);
  const read = async (as: Principal): Promise<PublishedItem> => {
    try {
      return await invoker.run(useCases.getPublished, as, { ...route, locale });
    } catch (e) {
      if (e instanceof UseCaseError && e.code === 'not_found') refuse(404);
      throw e;
    }
  };
  let item = await read(reader);
  const restricted = item.access !== 'public';
  const personal = restricted && cookies?.get(READER_COOKIE) !== undefined;
  if (personal) {
    const signedIn = await readerOfRequest(cookies!, site);
    if (signedIn) item = await read(signedIn);
  }
  const source = runtimeSource({ invoker, uow, reader, defaultLocale: tenant.defaultLocale });
  const { timeZone } = (await invoker.run(useCases.getSiteGeneral, reader, {})).value;
  const placeholder = await cardPlaceholder(site, sitePath(site, ''));
  const model = await resolveDocument(source, item, {
    base: sitePath(site, ''),
    placeholder,
    fallbackLocale: tenant.defaultLocale,
    page: archivePage,
    path: contentPath(item, locale, tenant.defaultLocale),
    timeZone,
    ...(item.access === 'public' &&
    site.access.entitlements.blocks.video !== false &&
    (await sitePlacement(site)).embeds.includes('bunny-stream')
      ? { videoRoute: `/_video/${locale}/${item.type}/${item.slug}` }
      : {}),
    itemId: item.id,
    ...(item.readerMedia ? { signedMedia: item.readerMedia } : {}),
  });
  // A later page exists only where an overview with an archive still has entries on it.
  if (
    archivePage > 1 &&
    !model.blocks.some((b) => b.type === 'overview' && b.newer !== null && b.entries.length)
  )
    refuse(404);
  const intro = await resolveIntro(
    source,
    {
      lead: item.lead,
      heroImageId: item.effective.images.hero.mediaId,
      heroAlt: item.heroAlt,
      heroPlacement: item.heroPlacement,
      ...(item.type === 'page' && item.presentation
        ? { header: item.presentation.header, action: item.presentation.action ?? null }
        : {}),
      ...(item.type === 'article'
        ? {
            header: item.presentation?.header ?? 'standard',
            ...(item.articleView ? { view: item.articleView, authors: item.authors ?? [] } : {}),
            meta: renderMeta(
              {
                publishedAt: item.publishedAt,
                authors: (item.authors ?? []).map((a) => a.name),
                section: item.section?.name ?? null,
              },
              locale,
              timeZone
            ),
          }
        : {}),
      ...(item.event ? { event: renderEvent(item.event, locale) } : {}),
    },
    locale,
    item.readerMedia
  );
  if (!intro.article && intro.meta && item.authors?.length) {
    const parts = new Intl.ListFormat(locale, { type: 'conjunction' }).formatToParts(
      item.authors.map((a) => a.name)
    );
    let authorIndex = 0;
    const template = ui(locale)('block.meta.by').split('{names}');
    intro.meta.bylineParts = [
      { text: template[0] ?? '' },
      ...parts.map((part) => {
        if (part.type !== 'element') return { text: part.value };
        const author = item.authors![authorIndex++]!;
        return {
          text: part.value,
          ...(author.pageEnabled
            ? { href: sitePath(site, personPath(author.slug, locale, tenant.defaultLocale)) }
            : {}),
        };
      }),
      { text: template[1] ?? '' },
    ];
  }
  const corrections = renderCorrections(item.corrections, locale);
  const theme = await siteTheme(site);
  const dropCap = item.type === 'article' && theme.dropCap === 'articles';

  const url = await siteUrls(site);
  const href = (l: string) => url(contentPath(item, l, tenant.defaultLocale));
  const fallback = item.locales.includes(tenant.defaultLocale)
    ? tenant.defaultLocale
    : item.locales[0]!;
  const { images } = item.effective;
  const shared = ogLocales(locale, item.locales);
  const head: PublicHead = {
    // An explicit canonical replaces only this link: the alternates stay the item's own paths,
    // since they name its translations here, not the address the editor points search to.
    canonical: item.seo.canonical ?? href(locale),
    noindex: item.seo.noindex,
    alternates: [
      ...item.locales.map((l) => ({ hreflang: l, href: href(l) })),
      { hreflang: 'x-default', href: href(fallback) },
    ],
    // The chain in core (effective.ts): own SEO description, featured description, lead, body.
    description: item.effective.seoDescription.text,
    title: item.seo.title ?? item.title,
    share: {
      type: item.type === 'article' ? 'article' : 'website',
      locale: shared.locale,
      alternateLocales: shared.alternates,
    },
    image:
      images.share.source === 'own'
        ? await shareImage(images.share.mediaId, item.seo.imageAlt, reader, url)
        : ((await shareCard(item, reader, url)) ??
          (await shareImage(
            images.share.mediaId,
            images.share.mediaId === images.hero.mediaId ? item.heroAlt : null,
            reader,
            url
          ))),
  };

  // The JSON-LD `url` is the same canonical as the link and og:url, explicit or not: three
  // answers to "which address is this" must agree. Rejected: the item's own address here, which
  // would tell search one URL in the link and another in the structured data.
  const structured =
    articleData(item, head.canonical, locale, tenant.defaultLocale, url) ??
    eventData(item, head.canonical, locale);
  const prefooter =
    item.prefooter === false
      ? null
      : await loadZone(source, reader, locale, {
          base: sitePath(site, ''),
          placeholder,
          fallbackLocale: tenant.defaultLocale,
          path: contentPath(item, locale, tenant.defaultLocale),
          timeZone,
        });
  const gate = item.gate ? gateOf(site, item, locale) : null;
  const dossiers = renderDossiers(item, locale, tenant.defaultLocale, timeZone);
  const page = {
    tenant,
    item,
    locale,
    model,
    intro,
    corrections,
    dropCap,
    head,
    structured,
    dossiers,
    prefooter,
    gate,
    restricted,
    personal,
  };
  if (personal || hasForm(model) || (prefooter && hasForm(prefooter.model)))
    return { ...page, etag: null };
  const chrome = await siteChrome(site);
  const brand = await siteBrand(site);
  // The resolved menus, not only their revision (ADR 036 rule 11): a republished target title or
  // slug changes the header without a navigation revision.
  const navigation = await siteNavigation(site, locale);
  // Measurement on or off adds or removes the pageview tag (analytics.ts).
  const tracker = await siteTracker(site);
  // And so does switching an integration: its player markup and the CSP (integrations.ts).
  const integrations = await sitePlacement(site);
  const digest = createHash('sha256')
    .update(
      JSON.stringify({
        model,
        intro,
        corrections,
        dropCap,
        head,
        structured,
        access: site.access,
        chrome,
        navigation,
        brand,
        dossiers,
        prefooter,
        gate,
        tracker,
        integrations,
      })
    )
    .digest('base64url')
    .slice(0, 16);
  // A teaser is another representation of the revision than the item: its own key.
  const etag = `"${item.revisionId}:${locale}${gate ? ':teaser' : ''}:${theme.hash}:${digest}"`;
  return { ...page, etag };
}

/**
 * The prompt of a cut item in this locale. The sign-in page returns to the item's own path; a
 * reader without the tier is led to their account, where the access they do hold is listed.
 */
function gateOf(site: Site, item: PublishedItem, locale: string): PublicGate {
  const t = ui(locale);
  const { prompt, join: joinPath } = item.gate!;
  const join = joinPath
    ? {
        href: sitePath(site, joinPath),
        path: joinPath,
        label: t('reader.gate.join.action'),
        other: t(prompt === 'tier' ? 'reader.gate.join.account' : 'reader.gate.join.signin'),
      }
    : null;
  if (prompt === 'tier')
    return {
      prompt,
      title: t('reader.gate.tier.title'),
      body: t(join ? 'reader.gate.join.body' : 'reader.gate.tier.body'),
      action: {
        href: sitePath(site, READER_PATH),
        path: READER_PATH,
        label: t('reader.gate.tier.action'),
      },
      join,
    };
  const back = contentPath(item, locale, site.tenant.defaultLocale);
  const path = `${READER_PATH}?return=${encodeURIComponent(back)}`;
  return {
    prompt,
    title: t(join ? 'reader.gate.join.title' : 'reader.gate.signin.title'),
    body: t(
      join
        ? 'reader.gate.join.body'
        : item.access === 'tier'
          ? 'reader.gate.signin.tier'
          : 'reader.gate.signin.members'
    ),
    action: {
      href: sitePath(site, path),
      path,
      label: t('reader.gate.signin.action'),
    },
    join,
  };
}

/**
 * The placed zone in this locale with its blocks resolved, or null. Its overview shows page 1
 * whatever `?p=` the host page is on: the archive belongs to the page's own overview.
 */
async function loadZone(
  source: Parameters<typeof resolveDocument>[0],
  reader: Principal,
  locale: string,
  options: Omit<Parameters<typeof resolveDocument>[2], 'page'>
): Promise<PublicZone | null> {
  const { zone } = await runtime().invoker.run(useCases.getPrefooter, reader, { locale });
  if (!zone) return null;
  const model = await resolveDocument(
    source,
    { locale, title: zone.title, blocks: zone.blocks },
    options
  );
  return model.blocks.length ? { title: zone.title, model } : null;
}

/**
 * The generated card of this locale once the job has drawn it, else null and the head
 * shows the inherited image meanwhile. The card shows the title, so the title is its alt.
 */
async function shareCard(
  item: PublishedItem,
  reader: Principal,
  url: (path: string) => string
): Promise<PublicHead['image']> {
  const { card } = await runtime().invoker.run(useCases.getShareCard, reader, {
    itemId: item.id,
    locale: item.locale,
  });
  if (!card) return null;
  return {
    src: url(shareCardPath(item.id, item.locale, card.fingerprint)),
    width: SHARE_CARD_WIDTH,
    height: SHARE_CARD_HEIGHT,
    type: 'image/png',
    alt: item.seo.title ?? item.title,
  };
}

/** The site-root path of a generated card; `_share` can never be a page slug. */
export const shareCardPath = (itemId: string, locale: string, fingerprint: string): string =>
  `/_share/${itemId}/${locale}/${fingerprint}.png`;

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
  alt: string | null,
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
  return {
    src: url(best.path),
    width: best.width!,
    height: best.height!,
    type: 'image/webp',
    alt,
  };
}
