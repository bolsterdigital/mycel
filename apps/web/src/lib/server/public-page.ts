// Loads a public page or article as a render model (brief #8c § 1 and § 7–9): the core returns
// one published locale of the item (`content.published.get`, the locale from the path), the
// resolver fetches every reference the blocks make once, up front, and this module adds what the
// document head and the cache need: the canonical URL, one `hreflang` per published locale plus
// `x-default`, a description, and a strong ETag. The public pages ship no client-side JavaScript
// at all, and nothing here reads a cookie or Accept-Language: the response is a function of the
// URL, which is what makes it cacheable in a shared cache (ADR 018 rule 8).
//
// The ETag is `"<revision>:<locale>:<theme>:<digest>"`. Revision, locale and theme are the brief's
// key; the digest covers what the page shows besides the revision (resolved links and images,
// the head, the site's entitlements and status), so unpublishing a linked item or switching the
// footer credit off also changes the tag. The form's timing token is left out of the digest: it
// is fresh on every render and a revalidated copy keeps an older one, which only makes a post
// less "too fast". Rejected: the brief's three parts alone (a 304 would keep a link to an item
// that is no longer public), and hashing the HTML (it carries that per-request token).

import { createHash } from 'node:crypto';
import { error } from '@sveltejs/kit';
import {
  UseCaseError,
  anonymousPrincipal,
  contentPath,
  useCases,
  type PublishedItem,
  type RichTextDoc,
  type TenantInfo,
} from '@mycel/core';
import type { RenderModel } from '../blocks/model.js';
import { resolveDocument, runtimeSource } from '../blocks/resolve.js';
import type { ContentRoute } from './content-route.js';
import { runtime } from './runtime.js';
import { sitePath, siteTenant, siteUrls, type Site } from './site.js';
import { siteTheme } from './theme.js';

export interface PublicHead {
  canonical: string;
  /** One per published locale, then `x-default`. */
  alternates: { hreflang: string; href: string }[];
  description: string | null;
}

export interface PublicItem {
  tenant: TenantInfo;
  item: PublishedItem;
  locale: string;
  model: RenderModel;
  head: PublicHead;
  /** Strong; see the comment at the top. */
  etag: string;
}

/** A meta description is a sentence or two; longer text is cut at a word. */
const DESCRIPTION_MAX = 300;

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
  const model = await resolveDocument(
    runtimeSource({ invoker, uow, reader, defaultLocale: tenant.defaultLocale }),
    item,
    { base: sitePath(site, ''), fallbackLocale: tenant.defaultLocale }
  );

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
    description: describe(item.lead ?? firstParagraph(model)),
  };

  const theme = await siteTheme(site);
  const digest = createHash('sha256')
    .update(JSON.stringify({ model: withoutTokens(model), head, access: site.access }))
    .digest('base64url')
    .slice(0, 16);
  const etag = `"${item.revisionId}:${locale}:${theme.hash}:${digest}"`;
  return { tenant, item, locale, model, head, etag };
}

function withoutTokens(model: RenderModel): RenderModel {
  return {
    ...model,
    blocks: model.blocks.map((b) =>
      b.type === 'form' && b.form ? { ...b, form: { ...b.form, startedToken: '' } } : b
    ),
  };
}

/** The text of the first paragraph of the first rich-text block, if any. */
function firstParagraph(model: RenderModel): string | null {
  type Node = { type: string; text?: string; content?: Node[] };
  const text = (n: Node): string => n.text ?? (n.content ?? []).map(text).join('');
  for (const b of model.blocks) {
    if (b.type !== 'rich-text') continue;
    const p = (b.doc as RichTextDoc & { content: Node[] }).content.find(
      (n) => n.type === 'paragraph'
    );
    const found = p && text(p).trim();
    if (found) return found;
  }
  return null;
}

function describe(text: string | null): string | null {
  if (!text) return null;
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= DESCRIPTION_MAX) return flat;
  const cut = flat.slice(0, DESCRIPTION_MAX - 1);
  return `${cut.slice(0, cut.lastIndexOf(' ') > 0 ? cut.lastIndexOf(' ') : cut.length)}…`;
}
