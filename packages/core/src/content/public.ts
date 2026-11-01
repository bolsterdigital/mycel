// The public projection of a page or article (brief #8c § 7): the one query every public
// representation derives from, the HTML of a site, the JSON read route (ADR 012 rule 7) and
// later Markdown and feeds (#9). It reads only an explicitly published revision and returns one
// published locale of it: the other translations in the same revision snapshot, published or
// not, never leave the core (ADR 018 rule 9, ADR 020 rule 8). Restricted items are not served
// here at all; #19 brings the teaser.
//
// The locale is chosen by the caller (the HTML route from its path, the read route from
// `?locale=`), never negotiated from Accept-Language, so a response depends on its URL only and
// a shared cache needs no `Vary`. Without one, the item's default locale if it is published,
// else the first published one; an asked locale that is not published is `not_found`.
//
// The projection itself is `projectDocument`, a pure function the admin preview (#11) shares, so
// a preview shows a draft exactly as this route would show it once published.
//
// Rejected: returning the whole revision and letting the front pick a locale (an unpublished
// English draft would be in the HTML's data and the MCP output), falling back to the latest
// revision when nothing is published (a frontend must never promote a draft on its own), and
// keeping `content.page.get` as an alias (two names for one contract drift apart).

import { z } from 'zod';
import { notFound } from '../errors.js';
import { ARTICLE_HEADERS } from './model.js';
import { Locale } from '../i18n/locale.js';
import { defineUseCase } from '../registry.js';
import { Block, blockLocalized, projectBlock } from './blocks.js';
import { ContentType, Slug, type ContentDocument } from './model.js';
import { EffectiveView, effectiveOf } from './header/effective.js';
import { statusOf } from './lifecycle.js';
import './ports.js';
import '../theme/ports.js';

export const PublishedItem = z.object({
  id: z.string().guid(),
  type: ContentType,
  slug: Slug,
  revisionId: z.string().guid(),
  /** The one locale this projection carries. */
  locale: Locale,
  /** Every locale of the item that is published, for language links. */
  locales: z.array(Locale),
  title: z.string(),
  blocks: z.array(Block),
  publishedAt: z.string().datetime({ offset: true }),
  /** When the published revision was saved; a later draft does not move it. */
  updatedAt: z.string().datetime({ offset: true }),
  /** The image on the item's own page; null without one. */
  heroImageId: z.string().guid().nullable(),
  /** The hero's alt in this locale (#99); null: the hero is decorative. */
  heroAlt: z.string().nullable(),
  /** The item's own image, for cards that link to it; null without one. */
  featuredImageId: z.string().guid().nullable(),
  /**
   * Search and sharing in this locale: the explicit title and description (null: none set) and
   * the share image along the chain (`effective.images.share`).
   */
  seo: z.object({
    title: z.string().nullable(),
    description: z.string().nullable(),
    imageId: z.string().guid().nullable(),
  }),
  /** The introduction in this locale, on pages and articles. */
  lead: z.string().nullable(),
  /** Images and short texts after inheritance (#86), so no reader derives them on its own. */
  effective: EffectiveView,
  corrections: z.array(z.object({ date: z.string().date(), text: z.string() })).optional(),
  authors: z.array(z.object({ id: z.string().guid(), slug: Slug, name: z.string() })).optional(),
  section: z.object({ slug: Slug, name: z.string() }).nullable().optional(),
  /** An article's chosen header (ADR 025 rule 3); a renderer without a hero image shows `standard`. */
  presentation: z.object({ header: z.enum(ARTICLE_HEADERS) }).optional(),
});
export type PublishedItem = z.infer<typeof PublishedItem>;

/**
 * The site-root path of an item in a locale (brief #8c § 8): `/<slug>` for a page, `/` for the
 * page `index`, `/articles/<slug>` for an article, with `/<locale>` in front for every locale but
 * the site's default (ADR 007 rule 3). Absolute URLs are this path through `siteUrl`.
 */
export function contentPath(
  item: { type: ContentType; slug: string },
  locale: string,
  defaultLocale: string
): string {
  const prefix = locale === defaultLocale ? '' : `/${locale}`;
  if (item.type === 'page' && item.slug === 'index') return prefix || '/';
  return `${prefix}${item.type === 'article' ? '/articles' : ''}/${item.slug}`;
}

/**
 * One locale of a document: its title and the blocks reduced to that locale's values. A block
 * that lacks a required value in the locale is left out: a published locale passed
 * `readinessIssues`, so that never happens there, and a preview of an unfinished translation
 * shows what exists instead of an empty block.
 */
export function projectDocument(
  doc: Pick<ContentDocument, 'title' | 'blocks'>,
  locale: string
): { title: string; blocks: Block[] } {
  return {
    title: doc.title[locale] ?? '',
    blocks: doc.blocks
      .filter((b) => blockLocalized(b).every((f) => !f.required || f.value[locale] !== undefined))
      .map((b) => projectBlock(b, locale)),
  };
}

export const getPublished = defineUseCase({
  name: 'content.published.get',
  kind: 'query',
  description:
    'Get the published version of a public page or article in one published locale (the default when none is asked).',
  requires: 'content:read',
  input: z.object({ type: ContentType, slug: Slug, locale: Locale.optional() }),
  output: PublishedItem,
  resource: { uriTemplate: 'mycel://published/{type}/{slug}' },
  examples: [{ input: { type: 'page', slug: 'signup' } }],
  async handler(ctx, { type, slug, locale }) {
    const missing = () => notFound(`published ${type}`, `slug "${slug}"`);
    const item = await ctx.content.findBySlug(type, slug);
    if (!item) throw missing();
    const live = item.publication.filter((s) => statusOf(s) === 'published');
    const published = live.map((s) => s.locale);
    if (!published.length || (locale && !published.includes(locale))) throw missing();
    const chosen =
      locale ?? (published.includes(item.defaultLocale) ? item.defaultLocale : published[0]!);
    const state = live.find((s) => s.locale === chosen)!;
    const revision = await ctx.content.revision(item.id, state.publishedRevisionId!);
    if (!revision) throw missing();
    const doc = revision.document;
    if (doc.access.level !== 'public') throw missing();
    const effective = effectiveOf(doc, chosen, (await ctx.siteSettings.images()).value);
    const base = {
      id: item.id,
      type: item.type,
      slug: item.slug,
      revisionId: revision.id,
      locale: chosen,
      locales: published,
      ...projectDocument(doc, chosen),
      publishedAt: state.publishedAt!.toISOString(),
      updatedAt: revision.createdAt,
      heroImageId: doc.heroImageId ?? null,
      heroAlt: doc.heroAlt?.[chosen] ?? null,
      featuredImageId: doc.featuredImageId ?? null,
      seo: {
        title: doc.seo.title?.[chosen] ?? null,
        description: doc.seo.description?.[chosen] ?? null,
        imageId: effective.images.share.mediaId,
      },
      lead: doc.lead?.[chosen] ?? null,
      effective,
    };
    if (doc.type !== 'article') return base;

    // Authors and section as the public sees them: name and slug, never an author's e-mail.
    // A reference that no longer resolves is left out rather than failing the page.
    const authors = [];
    for (const id of doc.authorIds) {
      const author = await ctx.authors.get(id);
      if (author) authors.push({ id: author.id, slug: author.slug, name: author.name });
    }
    const section = doc.sectionId ? await ctx.sections.get(doc.sectionId) : null;
    return {
      ...base,
      presentation: { header: doc.presentation?.header ?? 'standard' },
      corrections: doc.corrections.flatMap((c) => {
        const text = c.text[chosen];
        return text ? [{ date: c.date, text }] : [];
      }),
      authors,
      section: section
        ? {
            slug: section.slug,
            // A section's title is not part of the item's readiness, so it may lack this locale.
            name:
              section.title[chosen] ??
              section.title[item.defaultLocale] ??
              Object.values(section.title)[0] ??
              section.slug,
          }
        : null,
    };
  },
});
